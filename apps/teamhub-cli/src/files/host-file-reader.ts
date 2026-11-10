import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

const FILE_READ_CHUNK_BYTES = 64 * 1024;
export const CONTEXT_FILE_MAX_BYTES = 50 * 1024 * 1024;

export type ContextRuntimeFileErrorCode =
  | "changed"
  | "too_large"
  | "unavailable";

export class ContextRuntimeFileError extends Error {
  override readonly name = "ContextRuntimeFileError";

  constructor(
    readonly code: ContextRuntimeFileErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface RuntimeFileSnapshot {
  readonly content: Uint8Array;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export const normalizeWorkspaceLogicalPath = (value: string): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1_024 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new TypeError(
      "Runtime file path must be a slash-separated workspace-relative path",
    );
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized === "." ||
    normalized !== value ||
    normalized.startsWith("../") ||
    normalized.split("/").some((segment) => segment.length > 255)
  ) {
    throw new TypeError("Runtime file path must be normalized and contained");
  }
  return normalized;
};

export const readExactHostFile = async (
  sourceRootPath: string,
  relativePath: string,
  maxSizeBytes: number,
  signal: AbortSignal,
): Promise<RuntimeFileSnapshot> => {
  assertPositiveInteger(maxSizeBytes, "maxSizeBytes");
  signal.throwIfAborted();
  try {
    const requestedRoot = await lstat(sourceRootPath, { bigint: true });
    if (!requestedRoot.isDirectory() || requestedRoot.isSymbolicLink()) {
      throw unavailable("Runtime file mapping source is unavailable");
    }
    const sourceRoot = await realpath(sourceRootPath);
    const canonicalRoot = await lstat(sourceRoot, { bigint: true });
    if (
      !canonicalRoot.isDirectory() ||
      canonicalRoot.isSymbolicLink() ||
      !sameIdentity(requestedRoot, canonicalRoot)
    ) {
      throw unavailable("Runtime file mapping source is unavailable");
    }

    const witness = await capturePathWitness(sourceRoot, relativePath, signal);
    const handle = await open(
      witness.filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      signal.throwIfAborted();
      const before = await handle.stat({ bigint: true });
      assertUnaliasedFile(before);
      if (before.size > BigInt(maxSizeBytes)) {
        throw new ContextRuntimeFileError(
          "too_large",
          "Runtime file exceeds the upload limit",
        );
      }
      await verifyPinnedPath(sourceRoot, witness, before, signal);
      const content = await readPinnedFile(handle, Number(before.size), signal);
      if (content.byteLength !== Number(before.size)) {
        throw changed();
      }
      const after = await handle.stat({ bigint: true });
      assertUnaliasedFile(after);
      if (
        !sameIdentity(before, after) ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        BigInt(content.byteLength) !== after.size
      ) {
        throw changed();
      }
      await verifyPinnedPath(sourceRoot, witness, after, signal);
      return Object.freeze({
        content,
        sizeBytes: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (
      error instanceof ContextRuntimeFileError ||
      error instanceof TypeError ||
      signal.aborted
    ) {
      throw error;
    }
    if (isUnavailableFileSystemError(error)) {
      throw new ContextRuntimeFileError(
        "unavailable",
        "Runtime file is unavailable",
        { cause: error },
      );
    }
    throw error;
  }
};

const readPinnedFile = async (
  handle: FileHandle,
  expectedSizeBytes: number,
  signal: AbortSignal,
): Promise<Buffer> => {
  // Read one byte beyond the pinned size. A concurrent append is rejected
  // without allowing an unbounded read or allocation before the final stat.
  const buffer = Buffer.allocUnsafe(expectedSizeBytes + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    signal.throwIfAborted();
    const length = Math.min(FILE_READ_CHUNK_BYTES, buffer.byteLength - offset);
    const { bytesRead } = await handle.read(buffer, offset, length, offset);
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  signal.throwIfAborted();
  return buffer.subarray(0, offset);
};

interface BigIntFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

const assertUnaliasedFile = (metadata: {
  readonly nlink: bigint;
  isFile(): boolean;
}): void => {
  if (!metadata.isFile() || metadata.nlink !== 1n) {
    throw unavailable(
      "Runtime file must be a regular file without hardlink aliases",
    );
  }
};

interface PathWitnessEntry extends BigIntFileIdentity {
  readonly path: string;
}

interface PathWitness {
  readonly filePath: string;
  readonly entries: readonly PathWitnessEntry[];
}

const capturePathWitness = async (
  sourceRoot: string,
  relativePath: string,
  signal: AbortSignal,
): Promise<PathWitness> => {
  const segments = relativePath.split("/");
  let current = sourceRoot;
  const entries: PathWitnessEntry[] = [];
  for (const [index, segment] of segments.entries()) {
    signal.throwIfAborted();
    current = path.join(current, segment);
    const metadata = await lstat(current, { bigint: true });
    if (metadata.isSymbolicLink()) {
      throw unavailable("Runtime file path must not contain symbolic links");
    }
    if (index < segments.length - 1 && !metadata.isDirectory()) {
      throw unavailable("Runtime file path is unavailable");
    }
    if (index === segments.length - 1) assertUnaliasedFile(metadata);
    entries.push({ path: current, dev: metadata.dev, ino: metadata.ino });
  }
  return Object.freeze({
    filePath: current,
    entries: Object.freeze(entries),
  });
};

const verifyPinnedPath = async (
  sourceRoot: string,
  witness: PathWitness,
  descriptor: BigIntFileIdentity,
  signal: AbortSignal,
): Promise<void> => {
  signal.throwIfAborted();
  const resolvedFile = await realpath(witness.filePath);
  if (!containsHostPath(sourceRoot, resolvedFile)) {
    throw unavailable("Runtime file escaped its mapping source");
  }
  for (const [index, expected] of witness.entries.entries()) {
    signal.throwIfAborted();
    const current = await lstat(expected.path, { bigint: true });
    if (
      current.isSymbolicLink() ||
      !sameIdentity(expected, current) ||
      (index < witness.entries.length - 1 && !current.isDirectory())
    ) {
      throw changed();
    }
  }
  const currentFile = await lstat(witness.filePath, { bigint: true });
  assertUnaliasedFile(currentFile);
  if (currentFile.isSymbolicLink() || !sameIdentity(descriptor, currentFile)) {
    throw changed();
  }
  // Node has no portable openat(2) traversal. Rechecking every directory and
  // matching the final path to the pinned fd closes ordinary swaps, but a
  // privileged swap-out-and-back between checks remains a platform residual.
};

const sameIdentity = (
  left: BigIntFileIdentity,
  right: BigIntFileIdentity,
): boolean => left.dev === right.dev && left.ino === right.ino;

const containsHostPath = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

const unavailable = (message: string): ContextRuntimeFileError =>
  new ContextRuntimeFileError("unavailable", message);

const changed = (): ContextRuntimeFileError =>
  new ContextRuntimeFileError(
    "changed",
    "Runtime file changed while it was being read",
  );

const isUnavailableFileSystemError = (
  error: unknown,
): error is NodeJS.ErrnoException =>
  error instanceof Error &&
  "code" in error &&
  ["EACCES", "ELOOP", "ENOENT", "ENOTDIR", "EPERM"].includes(
    String(error.code),
  );

const assertPositiveInteger = (value: number, label: string): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
};
