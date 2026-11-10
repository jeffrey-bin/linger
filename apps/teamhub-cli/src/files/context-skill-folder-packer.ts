import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { deflateRawSync } from "node:zlib";
import { parseDocument } from "yaml";
import { ZipFile } from "yazl";
import { isRecord } from "@linger/service-kit";
import {
  type CanonicalSkillPackageFile,
  computeSkillPackageSha256,
} from "./skill-package.js";
import { normalizeWorkspaceLogicalPath } from "./host-file-reader.js";
import { isExcludedPublicationEntry } from "./publication-filter.js";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const CONTROL_CHARACTER = /\p{Cc}/u;
const UNICODE_WHITE_SPACE_EDGES = /^\p{White_Space}+|\p{White_Space}+$/gu;
const PACKAGE_NAME = /^[a-z0-9-]+$/;
const FRONTMATTER_EXTRA_MAX_BYTES = 64 * 1024;
const FRONTMATTER_EXTRA_MAX_DEPTH = 20;
const FRONTMATTER_EXTRA_MAX_VALUES = 4_096;
const FIXED_ZIP_MTIME = new Date(Date.UTC(1980, 0, 1, 0, 0, 0, 0));
const FIXED_ZIP_FILE_MODE = 0o100644;
const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = 1 | (1 << 5);
const DEFLATE_LEVEL = 9;

export interface ContextSkillFolderPackLimits {
  readonly maxArchiveBytes: number;
  readonly maxEntries: number;
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxPathBytes: number;
  readonly maxCompressionRatio: number;
}

export const DEFAULT_CONTEXT_SKILL_FOLDER_PACK_LIMITS: Readonly<ContextSkillFolderPackLimits> =
  Object.freeze({
    maxArchiveBytes: 16 * 1024 * 1024,
    maxEntries: 1_024,
    maxFiles: 256,
    maxFileBytes: 8 * 1024 * 1024,
    maxTotalBytes: 32 * 1024 * 1024,
    maxPathBytes: 1_024,
    maxCompressionRatio: 200,
  });

export type ContextSkillFolderPackErrorCode =
  | "archive_size_exceeded"
  | "changed"
  | "duplicate_entry_path"
  | "entry_count_exceeded"
  | "entry_size_exceeded"
  | "expanded_size_exceeded"
  | "invalid_entry_path"
  | "invalid_folder_path"
  | "invalid_skill_manifest"
  | "missing_skill_manifest"
  | "unavailable"
  | "unsupported_entry_type";

export class ContextSkillFolderPackError extends Error {
  override readonly name = "ContextSkillFolderPackError";

  constructor(
    readonly code: ContextSkillFolderPackErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface PackedContextSkillFolder {
  readonly archive: Uint8Array;
  readonly archiveSha256: string;
  readonly packageSha256: string;
  readonly packageName: string;
  readonly description: string;
  readonly fileCount: number;
  readonly totalBytes: number;
}

interface StableMetadata {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mode: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly nlink: bigint;
}

interface PathWitnessEntry {
  readonly absolutePath: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

interface FolderWitness {
  readonly requestedRootPath: string;
  readonly canonicalRootPath: string;
  readonly folderPath: string;
  readonly pathEntries: readonly PathWitnessEntry[];
}

interface DirectoryName {
  readonly value: string;
  readonly encoded: Buffer;
}

interface DirectoryWitness {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly metadata: StableMetadata;
  readonly encodedNames: readonly Buffer[];
}

interface SnapshotFile extends CanonicalSkillPackageFile {
  readonly absolutePath: string;
  readonly metadata: StableMetadata;
}

interface SnapshotBudget {
  entryCount: number;
  fileCount: number;
  totalBytes: number;
}

interface PathIndex {
  readonly entries: Set<string>;
  readonly files: Set<string>;
  readonly requiredDirectories: Set<string>;
}

interface SkillFrontmatter {
  readonly name: string;
  readonly description: string;
  readonly manifestContent: Uint8Array;
}

interface FrontmatterEnvelope {
  readonly source: string;
  readonly body: string;
}

export const packContextSkillFolder = async (input: {
  readonly playgroundRootPath: string;
  readonly folderPath: string;
  readonly signal: AbortSignal;
  readonly limits?: Partial<ContextSkillFolderPackLimits>;
}): Promise<PackedContextSkillFolder> => {
  input.signal.throwIfAborted();
  const limits = resolveLimits(input.limits);
  const folderPath = normalizeFolderPath(input.folderPath, limits.maxPathBytes);
  if (typeof input.playgroundRootPath !== "string")
    throw new TypeError("A Skill snapshot requires a Host playground root");
  const files = await snapshotHostFolder(
    input.playgroundRootPath,
    folderPath,
    limits,
    input.signal,
  );
  input.signal.throwIfAborted();
  return packSnapshotFiles(files, limits, input.signal);
};

const snapshotHostFolder = async (
  playgroundRootPath: string,
  folderPath: string,
  limits: ContextSkillFolderPackLimits,
  signal: AbortSignal,
): Promise<readonly CanonicalSkillPackageFile[]> => {
  const witness = await captureFolderWitness(
    playgroundRootPath,
    folderPath,
    signal,
  );
  const files: SnapshotFile[] = [];
  const directories: DirectoryWitness[] = [];
  const budget: SnapshotBudget = {
    entryCount: 0,
    fileCount: 0,
    totalBytes: 0,
  };
  const paths: PathIndex = {
    entries: new Set(),
    files: new Set(),
    requiredDirectories: new Set(),
  };

  try {
    await walkDirectory({
      rootPath: witness.folderPath,
      relativePath: "",
      files,
      directories,
      budget,
      paths,
      limits,
      signal,
    });
    files.sort((left, right) => compareUtf8(left.path, right.path));
    await verifySnapshot(witness, files, directories, signal);
  } catch (error) {
    throw normalizeSnapshotError(error, signal);
  }
  return files;
};

/** Shared content validation and canonical ZIP encoding for both placements. */
const packSnapshotFiles = async (
  files: readonly CanonicalSkillPackageFile[],
  limits: ContextSkillFolderPackLimits,
  signal: AbortSignal,
): Promise<PackedContextSkillFolder> => {
  signal.throwIfAborted();
  const manifest = files.find(({ path: filePath }) => filePath === "SKILL.md");
  if (!manifest) {
    throw new ContextSkillFolderPackError(
      "missing_skill_manifest",
      "Skill folder must contain root SKILL.md",
    );
  }
  const frontmatter = parseSkillFrontmatter(manifest.content);
  const canonicalFiles = files.map(({ path: filePath, content }) => ({
    path: filePath,
    content: filePath === "SKILL.md" ? frontmatter.manifestContent : content,
  }));
  const canonicalTotalBytes = canonicalFiles.reduce(
    (total, file) => total + file.content.byteLength,
    0,
  );
  if (frontmatter.manifestContent.byteLength > limits.maxFileBytes) {
    throw new ContextSkillFolderPackError(
      "entry_size_exceeded",
      "Normalized root SKILL.md exceeds the file size limit",
    );
  }
  if (canonicalTotalBytes > limits.maxTotalBytes) {
    throw new ContextSkillFolderPackError(
      "expanded_size_exceeded",
      "Normalized Skill folder exceeds the expanded size limit",
    );
  }
  const packageSha256 = computeSkillPackageSha256(canonicalFiles);
  const archive = await createStableZip(
    canonicalFiles,
    limits.maxArchiveBytes,
    limits.maxCompressionRatio,
  );
  signal.throwIfAborted();

  return Object.freeze({
    archive,
    archiveSha256: createHash("sha256").update(archive).digest("hex"),
    packageSha256,
    packageName: frontmatter.name,
    description: frontmatter.description,
    fileCount: files.length,
    totalBytes: canonicalTotalBytes,
  });
};

const normalizeFolderPath = (value: string, maxPathBytes: number): string => {
  try {
    const normalized = normalizeWorkspaceLogicalPath(value);
    if (
      normalized !== normalized.normalize("NFC") ||
      Buffer.byteLength(normalized, "utf8") > maxPathBytes ||
      CONTROL_CHARACTER.test(normalized)
    ) {
      throw new TypeError("Skill folder path is not canonical");
    }
    return normalized;
  } catch (error) {
    throw new ContextSkillFolderPackError(
      "invalid_folder_path",
      "Skill folder path must be a canonical workspace-relative path",
      { cause: error },
    );
  }
};

const captureFolderWitness = async (
  requestedRootPath: string,
  folderPath: string,
  signal: AbortSignal,
): Promise<FolderWitness> => {
  signal.throwIfAborted();
  try {
    const requestedRoot = await lstat(requestedRootPath, { bigint: true });
    if (!requestedRoot.isDirectory() || requestedRoot.isSymbolicLink()) {
      throw unavailable("Authorized workspace root is unavailable");
    }
    const canonicalRootPath = await realpath(requestedRootPath);
    const canonicalRoot = await lstat(canonicalRootPath, { bigint: true });
    if (
      !canonicalRoot.isDirectory() ||
      canonicalRoot.isSymbolicLink() ||
      !sameIdentity(requestedRoot, canonicalRoot)
    ) {
      throw unavailable("Authorized workspace root is unavailable");
    }

    let currentPath = canonicalRootPath;
    const pathEntries: PathWitnessEntry[] = [];
    for (const segment of folderPath.split("/")) {
      signal.throwIfAborted();
      currentPath = path.join(currentPath, segment);
      const metadata = await lstat(currentPath, { bigint: true });
      if (metadata.isSymbolicLink()) {
        throw new ContextSkillFolderPackError(
          "unsupported_entry_type",
          "Skill folder path must not contain symbolic links",
        );
      }
      if (!metadata.isDirectory()) {
        throw unavailable("Skill folder is unavailable");
      }
      pathEntries.push({
        absolutePath: currentPath,
        dev: metadata.dev,
        ino: metadata.ino,
      });
    }
    const resolvedFolder = await realpath(currentPath);
    if (!containsHostPath(canonicalRootPath, resolvedFolder)) {
      throw unavailable("Skill folder escaped the authorized workspace");
    }
    return Object.freeze({
      requestedRootPath,
      canonicalRootPath,
      folderPath: currentPath,
      pathEntries: Object.freeze(pathEntries),
    });
  } catch (error) {
    if (error instanceof ContextSkillFolderPackError || signal.aborted) {
      throw error;
    }
    throw unavailable("Skill folder is unavailable");
  }
};

const walkDirectory = async (options: {
  readonly rootPath: string;
  readonly relativePath: string;
  readonly files: SnapshotFile[];
  readonly directories: DirectoryWitness[];
  readonly budget: SnapshotBudget;
  readonly paths: PathIndex;
  readonly limits: ContextSkillFolderPackLimits;
  readonly signal: AbortSignal;
}): Promise<void> => {
  options.signal.throwIfAborted();
  const absoluteDirectory = options.relativePath
    ? path.join(options.rootPath, ...options.relativePath.split("/"))
    : options.rootPath;
  const before = await lstat(absoluteDirectory, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw changed(
      `Skill folder directory changed: ${displayPath(options.relativePath)}`,
    );
  }
  const names = await readDirectoryNames(
    absoluteDirectory,
    options.relativePath,
  );
  options.budget.entryCount += names.length;
  if (options.budget.entryCount > options.limits.maxEntries) {
    throw new ContextSkillFolderPackError(
      "entry_count_exceeded",
      `Skill folder contains more than ${options.limits.maxEntries} entries`,
    );
  }

  for (const name of names) {
    options.signal.throwIfAborted();
    const relativePath = options.relativePath
      ? `${options.relativePath}/${name.value}`
      : name.value;
    assertPackagePath(relativePath, options.limits.maxPathBytes);
    const absolutePath = path.join(absoluteDirectory, name.value);
    const metadata = await lstat(absolutePath, { bigint: true });
    if (metadata.isSymbolicLink()) {
      throw new ContextSkillFolderPackError(
        "unsupported_entry_type",
        `Skill folder contains a symbolic link: ${relativePath}`,
      );
    }
    if (metadata.isDirectory()) {
      registerPackagePath(relativePath, true, options.paths);
      await walkDirectory({ ...options, relativePath });
      continue;
    }
    if (!metadata.isFile() || metadata.nlink !== 1n) {
      throw new ContextSkillFolderPackError(
        "unsupported_entry_type",
        `Skill folder contains a non-file or hard-linked entry: ${relativePath}`,
      );
    }
    registerPackagePath(relativePath, false, options.paths);
    options.budget.fileCount += 1;
    if (options.budget.fileCount > options.limits.maxFiles) {
      throw new ContextSkillFolderPackError(
        "entry_count_exceeded",
        `Skill folder contains more than ${options.limits.maxFiles} files`,
      );
    }
    const file = await snapshotFile({
      absolutePath,
      relativePath,
      observed: metadata,
      remainingTotalBytes:
        options.limits.maxTotalBytes - options.budget.totalBytes,
      maxFileBytes: options.limits.maxFileBytes,
      canonicalRootPath: options.rootPath,
      signal: options.signal,
    });
    options.budget.totalBytes += file.content.byteLength;
    options.files.push(file);
  }

  const afterNames = await readDirectoryNames(
    absoluteDirectory,
    options.relativePath,
  );
  const after = await lstat(absoluteDirectory, { bigint: true });
  if (
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    !sameStableMetadata(before, after) ||
    !sameEncodedNames(names, afterNames)
  ) {
    throw changed(
      `Skill folder changed while traversing: ${displayPath(options.relativePath)}`,
    );
  }
  options.directories.push({
    absolutePath: absoluteDirectory,
    relativePath: options.relativePath,
    metadata: stableMetadata(after),
    encodedNames: Object.freeze(afterNames.map(({ encoded }) => encoded)),
  });
};

const readDirectoryNames = async (
  absolutePath: string,
  relativePath: string,
): Promise<readonly DirectoryName[]> => {
  const entries = await readdir(absolutePath, {
    encoding: "buffer",
    withFileTypes: true,
  });
  const names = entries
    .map((entry) => {
      const encoded = Buffer.from(entry.name);
      try {
        return { value: UTF8_DECODER.decode(encoded), encoded };
      } catch (error) {
        throw new ContextSkillFolderPackError(
          "invalid_entry_path",
          `Skill folder contains a non-UTF-8 name below ${displayPath(relativePath)}`,
          { cause: error },
        );
      }
    })
    .filter(
      ({ value }) =>
        !isExcludedPublicationEntry(value) &&
        !(relativePath === "" && value === ".simplexai"),
    );
  names.sort((left, right) => Buffer.compare(left.encoded, right.encoded));
  return names;
};

const snapshotFile = async (options: {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly observed: BigIntStats;
  readonly remainingTotalBytes: number;
  readonly maxFileBytes: number;
  readonly canonicalRootPath: string;
  readonly signal: AbortSignal;
}): Promise<SnapshotFile> => {
  if (options.observed.size > BigInt(options.maxFileBytes)) {
    throw new ContextSkillFolderPackError(
      "entry_size_exceeded",
      `Skill file exceeds ${options.maxFileBytes} bytes: ${options.relativePath}`,
    );
  }
  if (
    options.remainingTotalBytes < 0 ||
    options.observed.size > BigInt(options.remainingTotalBytes)
  ) {
    throw new ContextSkillFolderPackError(
      "expanded_size_exceeded",
      "Skill folder exceeds its total expanded size limit",
    );
  }
  const handle = await open(
    options.absolutePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    options.signal.throwIfAborted();
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      !sameStableMetadata(options.observed, before)
    ) {
      throw changed(
        `Skill file changed before reading: ${options.relativePath}`,
      );
    }
    const resolvedPath = await realpath(options.absolutePath);
    if (!containsHostPath(options.canonicalRootPath, resolvedPath)) {
      throw changed(`Skill file escaped its folder: ${options.relativePath}`);
    }
    const limit = Math.min(options.maxFileBytes, options.remainingTotalBytes);
    const content = await readFileHandleLimited(
      handle,
      limit,
      options.relativePath,
      options.signal,
    );
    const after = await handle.stat({ bigint: true });
    const currentPath = await lstat(options.absolutePath, { bigint: true });
    if (
      !after.isFile() ||
      currentPath.isSymbolicLink() ||
      !currentPath.isFile() ||
      !sameStableMetadata(before, after) ||
      !sameStableMetadata(after, currentPath) ||
      BigInt(content.byteLength) !== after.size
    ) {
      throw changed(
        `Skill file changed while reading: ${options.relativePath}`,
      );
    }
    return {
      path: options.relativePath,
      content,
      absolutePath: options.absolutePath,
      metadata: stableMetadata(after),
    };
  } finally {
    await handle.close();
  }
};

const readFileHandleLimited = async (
  handle: Awaited<ReturnType<typeof open>>,
  limit: number,
  relativePath: string,
  signal: AbortSignal,
): Promise<Buffer> => {
  const buffer = Buffer.allocUnsafe(limit + 1);
  let offset = 0;
  for (;;) {
    signal.throwIfAborted();
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.byteLength - offset,
      null,
    );
    offset += bytesRead;
    if (offset > limit) {
      throw new ContextSkillFolderPackError(
        "entry_size_exceeded",
        `Skill file grew beyond its size limit: ${relativePath}`,
      );
    }
    if (bytesRead === 0) return Buffer.from(buffer.subarray(0, offset));
  }
};

const verifySnapshot = async (
  witness: FolderWitness,
  files: readonly SnapshotFile[],
  directories: readonly DirectoryWitness[],
  signal: AbortSignal,
): Promise<void> => {
  signal.throwIfAborted();
  const requestedRoot = await lstat(witness.requestedRootPath, {
    bigint: true,
  });
  const canonicalRoot = await lstat(witness.canonicalRootPath, {
    bigint: true,
  });
  if (
    requestedRoot.isSymbolicLink() ||
    !requestedRoot.isDirectory() ||
    canonicalRoot.isSymbolicLink() ||
    !canonicalRoot.isDirectory() ||
    !sameIdentity(requestedRoot, canonicalRoot)
  ) {
    throw changed("Authorized workspace root changed while packing Skill");
  }
  for (const entry of witness.pathEntries) {
    signal.throwIfAborted();
    const current = await lstat(entry.absolutePath, { bigint: true });
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      !sameIdentity(entry, current)
    ) {
      throw changed("Skill folder path changed while packing");
    }
  }
  for (const file of files) {
    signal.throwIfAborted();
    const current = await lstat(file.absolutePath, { bigint: true });
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      !sameStableMetadata(file.metadata, current)
    ) {
      throw changed(`Skill file changed after reading: ${file.path}`);
    }
  }
  for (const directory of directories) {
    signal.throwIfAborted();
    const before = await lstat(directory.absolutePath, { bigint: true });
    const names = await readDirectoryNames(
      directory.absolutePath,
      directory.relativePath,
    );
    const after = await lstat(directory.absolutePath, { bigint: true });
    if (
      before.isSymbolicLink() ||
      !before.isDirectory() ||
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      !sameStableMetadata(directory.metadata, before) ||
      !sameStableMetadata(before, after) ||
      !sameEncodedNameBuffers(directory.encodedNames, names)
    ) {
      throw changed(
        `Skill folder changed after traversal: ${displayPath(directory.relativePath)}`,
      );
    }
  }
};

const assertPackagePath = (value: string, maxPathBytes: number): void => {
  if (
    value.length === 0 ||
    value !== value.normalize("NFC") ||
    value.startsWith("/") ||
    value.split("/").some((part) => !part || part === "." || part === "..") ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.posix.normalize(value) !== value ||
    Buffer.byteLength(value, "utf8") > maxPathBytes ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new ContextSkillFolderPackError(
      "invalid_entry_path",
      `Skill folder entry path is invalid: ${value}`,
    );
  }
};

const registerPackagePath = (
  value: string,
  directory: boolean,
  paths: PathIndex,
): void => {
  const collisionKey = value
    .normalize("NFC")
    .toLocaleLowerCase("en-US")
    .normalize("NFC");
  const ancestors = pathAncestors(collisionKey);
  if (
    paths.entries.has(collisionKey) ||
    ancestors.some((ancestor) => paths.files.has(ancestor)) ||
    (!directory && paths.requiredDirectories.has(collisionKey))
  ) {
    throw new ContextSkillFolderPackError(
      "duplicate_entry_path",
      `Skill folder entry conflicts after NFC/case folding: ${value}`,
    );
  }
  paths.entries.add(collisionKey);
  if (!directory) paths.files.add(collisionKey);
  for (const ancestor of ancestors) paths.requiredDirectories.add(ancestor);
};

const pathAncestors = (value: string): string[] => {
  const segments = value.split("/");
  const ancestors: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    ancestors.push(segments.slice(0, index).join("/"));
  }
  return ancestors;
};

const parseSkillFrontmatter = (content: Uint8Array): SkillFrontmatter => {
  let text: string;
  try {
    text = UTF8_DECODER.decode(content);
  } catch (error) {
    throw invalidManifest("Root SKILL.md must be valid UTF-8", error);
  }
  const envelope = extractFrontmatter(text);
  try {
    const document = parseDocument(envelope.source, {
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    });
    if (document.errors.length > 0 || document.warnings.length > 0) {
      throw (
        document.errors[0] ??
        document.warnings[0] ??
        new Error("Invalid YAML frontmatter")
      );
    }
    const value = document.toJS({ maxAliasCount: 100 }) as unknown;
    if (!isRecord(value)) throw new TypeError("frontmatter must be a mapping");
    const sourceName = requireString(value.name, "name");
    const name = validPackageName(sourceName)
      ? sourceName
      : normalizePackageName(sourceName);
    if (!validPackageName(name)) {
      throw new TypeError("frontmatter name is invalid");
    }
    const description = requireString(value.description, "description").replace(
      UNICODE_WHITE_SPACE_EDGES,
      "",
    );
    if (description.length === 0 || [...description].length > 1_024) {
      throw new TypeError("frontmatter description is invalid");
    }
    for (const key of ["license", "allowed-tools"] as const) {
      if (value[key] !== undefined) requireString(value[key], key);
    }
    if (value.compatibility !== undefined) {
      const compatibility = requireString(value.compatibility, "compatibility");
      if ([...compatibility].length > 500) {
        throw new TypeError("frontmatter compatibility is invalid");
      }
    }
    if (value.metadata !== undefined && value.metadata !== null) {
      if (!isRecord(value.metadata)) {
        throw new TypeError("frontmatter metadata must be a mapping");
      }
    }
    validateFrontmatterExtra(value);
    let manifestContent = content;
    if (name !== sourceName) {
      document.set("name", name);
      const normalizedSource = document.toString({ lineWidth: 0 });
      manifestContent = Buffer.from(
        `---\n${normalizedSource.endsWith("\n") ? normalizedSource : `${normalizedSource}\n`}---\n${envelope.body}`,
        "utf8",
      );
    }
    return Object.freeze({ name, description, manifestContent });
  } catch (error) {
    if (error instanceof ContextSkillFolderPackError) throw error;
    throw invalidManifest("Root SKILL.md frontmatter is invalid", error);
  }
};

const extractFrontmatter = (text: string): FrontmatterEnvelope => {
  const lines = text.match(/.*(?:\r\n|\n|\r|$)/g) ?? [];
  if (stripLineEnding(lines[0] ?? "") !== "---") {
    throw invalidManifest("Root SKILL.md must start with frontmatter");
  }
  let offset = lines[0]?.length ?? 0;
  for (const line of lines.slice(1)) {
    if (stripLineEnding(line) === "---") {
      return Object.freeze({
        source: text.slice(lines[0]?.length ?? 0, offset),
        body: text.slice(offset + line.length),
      });
    }
    offset += line.length;
  }
  throw invalidManifest("Root SKILL.md frontmatter is not closed");
};

const stripLineEnding = (value: string): string =>
  value.replace(/(?:\r\n|\n|\r)$/, "");

const validPackageName = (value: string): boolean =>
  value.length >= 1 &&
  value.length <= 64 &&
  !value.startsWith("-") &&
  !value.endsWith("-") &&
  !value.includes("--") &&
  PACKAGE_NAME.test(value);

const normalizePackageName = (value: string): string =>
  value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\p{M}+/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64)
    .replace(/-+$/gu, "");

const validateFrontmatterExtra = (value: Record<string, unknown>): void => {
  const extra = Object.fromEntries(
    Object.entries(value).filter(
      ([key]) => key !== "name" && key !== "description",
    ),
  );
  let valueCount = 0;
  const ancestors = new Set<object>();
  const visit = (candidate: unknown, depth: number): void => {
    valueCount += 1;
    if (
      valueCount > FRONTMATTER_EXTRA_MAX_VALUES ||
      depth > FRONTMATTER_EXTRA_MAX_DEPTH
    ) {
      throw new TypeError("frontmatter extra fields are too complex");
    }
    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "boolean"
    ) {
      return;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw new TypeError("frontmatter extra fields must be valid JSON");
      }
      return;
    }
    if (typeof candidate !== "object") {
      throw new TypeError("frontmatter extra fields must be valid JSON");
    }
    if (ancestors.has(candidate)) {
      throw new TypeError("frontmatter extra fields must not contain cycles");
    }
    ancestors.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, depth + 1);
    } else if (isRecord(candidate)) {
      for (const item of Object.values(candidate)) visit(item, depth + 1);
    } else {
      throw new TypeError("frontmatter extra fields must be valid JSON");
    }
    ancestors.delete(candidate);
  };
  visit(extra, 0);
  const serialized = JSON.stringify(extra);
  if (Buffer.byteLength(serialized, "utf8") > FRONTMATTER_EXTRA_MAX_BYTES) {
    throw new TypeError("frontmatter extra fields are too large");
  }
};

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== "string") {
    throw new TypeError(`frontmatter ${field} must be a string`);
  }
  return value;
};

const createStableZip = async (
  files: readonly CanonicalSkillPackageFile[],
  maxArchiveBytes: number,
  maxCompressionRatio: number,
): Promise<Uint8Array> => {
  const zip = new ZipFile();
  const output = zip.outputStream as Readable;
  const archivePromise = collectZip(output, maxArchiveBytes);
  try {
    for (const file of files) {
      zip.addBuffer(Buffer.from(file.content), file.path, {
        compressionLevel: stableCompressionLevel(
          file.content,
          maxCompressionRatio,
        ),
        forceDosTimestamp: true,
        forceZip64Format: false,
        mode: FIXED_ZIP_FILE_MODE,
        mtime: FIXED_ZIP_MTIME,
      });
    }
    zip.end({ forceZip64Format: false, comment: "" });
    return canonicalizeZipTimestamps(await archivePromise);
  } catch (error) {
    output.destroy();
    await archivePromise.catch(() => undefined);
    throw error;
  }
};

const stableCompressionLevel = (
  content: Uint8Array,
  maxCompressionRatio: number,
): number => {
  if (content.byteLength === 0) return 0;
  const compressed = deflateRawSync(content, { level: DEFLATE_LEVEL });
  if (
    compressed.byteLength >= content.byteLength ||
    compressed.byteLength === 0 ||
    content.byteLength > compressed.byteLength * maxCompressionRatio
  ) {
    return 0;
  }
  return DEFLATE_LEVEL;
};

const canonicalizeZipTimestamps = (archive: Uint8Array): Uint8Array => {
  const encoded = Buffer.from(archive);
  const endOffset = encoded.byteLength - 22;
  if (
    endOffset < 0 ||
    encoded.readUInt32LE(endOffset) !== 0x06054b50 ||
    encoded.readUInt16LE(endOffset + 20) !== 0
  ) {
    throw new TypeError("Stable Skill ZIP has an invalid end record");
  }
  const entryCount = encoded.readUInt16LE(endOffset + 10);
  let centralOffset = encoded.readUInt32LE(endOffset + 16);
  for (let index = 0; index < entryCount; index += 1) {
    if (encoded.readUInt32LE(centralOffset) !== 0x02014b50) {
      throw new TypeError("Stable Skill ZIP has an invalid central directory");
    }
    const localOffset = encoded.readUInt32LE(centralOffset + 42);
    if (encoded.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new TypeError("Stable Skill ZIP has an invalid local header");
    }
    encoded.writeUInt16LE(FIXED_DOS_TIME, localOffset + 10);
    encoded.writeUInt16LE(FIXED_DOS_DATE, localOffset + 12);
    encoded.writeUInt16LE(FIXED_DOS_TIME, centralOffset + 12);
    encoded.writeUInt16LE(FIXED_DOS_DATE, centralOffset + 14);
    centralOffset +=
      46 +
      encoded.readUInt16LE(centralOffset + 28) +
      encoded.readUInt16LE(centralOffset + 30) +
      encoded.readUInt16LE(centralOffset + 32);
  }
  if (centralOffset !== endOffset) {
    throw new TypeError("Stable Skill ZIP central directory size is invalid");
  }
  return new Uint8Array(encoded);
};

const collectZip = async (
  output: Readable,
  maxArchiveBytes: number,
): Promise<Uint8Array> => {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const source of output) {
    const chunk = Buffer.from(source as Uint8Array);
    total += chunk.byteLength;
    if (total > maxArchiveBytes) {
      output.destroy();
      throw new ContextSkillFolderPackError(
        "archive_size_exceeded",
        `Stable Skill ZIP exceeds ${maxArchiveBytes} bytes`,
      );
    }
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks, total));
};

const resolveLimits = (
  overrides: Partial<ContextSkillFolderPackLimits> = {},
): ContextSkillFolderPackLimits => {
  const limits = { ...DEFAULT_CONTEXT_SKILL_FOLDER_PACK_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    const maximum =
      DEFAULT_CONTEXT_SKILL_FOLDER_PACK_LIMITS[
        name as keyof ContextSkillFolderPackLimits
      ];
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
      throw new TypeError(
        `${name} must be a positive integer no greater than ${maximum}`,
      );
    }
  }
  return Object.freeze(limits);
};

const stableMetadata = (value: {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mode: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly nlink: bigint;
}): StableMetadata => ({
  dev: value.dev,
  ino: value.ino,
  size: value.size,
  mode: value.mode,
  mtimeNs: value.mtimeNs,
  ctimeNs: value.ctimeNs,
  nlink: value.nlink,
});

const sameIdentity = (
  left: { readonly dev: bigint; readonly ino: bigint },
  right: { readonly dev: bigint; readonly ino: bigint },
): boolean => left.dev === right.dev && left.ino === right.ino;

const sameStableMetadata = (
  left: StableMetadata,
  right: StableMetadata,
): boolean =>
  sameIdentity(left, right) &&
  left.size === right.size &&
  left.mode === right.mode &&
  left.nlink === right.nlink &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;

const sameEncodedNames = (
  left: readonly DirectoryName[],
  right: readonly DirectoryName[],
): boolean =>
  left.length === right.length &&
  left.every(({ encoded }, index) => {
    const candidate = right[index];
    return candidate !== undefined && encoded.equals(candidate.encoded);
  });

const sameEncodedNameBuffers = (
  left: readonly Buffer[],
  right: readonly DirectoryName[],
): boolean =>
  left.length === right.length &&
  left.every((encoded, index) => {
    const candidate = right[index];
    return candidate !== undefined && encoded.equals(candidate.encoded);
  });

const compareUtf8 = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const containsHostPath = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

const displayPath = (value: string): string => value || ".";

const changed = (message: string): ContextSkillFolderPackError =>
  new ContextSkillFolderPackError("changed", message);

const unavailable = (message: string): ContextSkillFolderPackError =>
  new ContextSkillFolderPackError("unavailable", message);

const invalidManifest = (
  message: string,
  cause?: unknown,
): ContextSkillFolderPackError =>
  new ContextSkillFolderPackError("invalid_skill_manifest", message, {
    cause,
  });

const normalizeSnapshotError = (
  error: unknown,
  signal: AbortSignal,
): unknown => {
  if (
    error instanceof ContextSkillFolderPackError ||
    error instanceof TypeError ||
    signal.aborted
  ) {
    return error;
  }
  if (isFileSystemRaceError(error)) {
    return changed("Skill folder changed while it was being packed");
  }
  return error;
};

const isFileSystemRaceError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return ["EACCES", "ELOOP", "ENOENT", "ENOTDIR", "EPERM"].includes(
    String(error.code),
  );
};
