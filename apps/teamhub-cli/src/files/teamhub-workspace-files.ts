import { randomUUID } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  realpath,
  rm,
} from "node:fs/promises";
import path from "node:path";
import {
  createHostFileExclusive,
  isWindowsFileSharingError,
  protectWindowsDirectories,
  replaceHostFile,
  syncHostDirectory,
} from "./host-file-system.js";
import {
  normalizeWorkspaceLogicalPath,
  readExactHostFile,
  CONTEXT_FILE_MAX_BYTES,
} from "./host-file-reader.js";
import {
  TeamHubFileError,
  type TeamHubWorkingCopyStateFiles,
  type TeamHubWorkspaceFiles,
} from "./teamhub-working-copies.js";

export function createHostTeamHubWorkingCopyStateFiles(input: {
  readonly workspacePath: string;
  readonly signal: AbortSignal;
  readonly namespace?: string;
}): TeamHubWorkingCopyStateFiles & {
  /** Pin directories for one operation. */
  withPinnedDirectory<T>(
    operation: (files: TeamHubWorkingCopyStateFiles) => Promise<T>,
  ): Promise<T>;
} {
  const workspace = realpathSync(path.resolve(input.workspacePath));
  if (
    input.namespace !== undefined &&
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.namespace)
  )
    throw invalidStateDirectory();
  const baseDirectory = path.join(workspace, ".teamhub", "files");
  const directory = input.namespace
    ? path.join(baseDirectory, input.namespace)
    : baseDirectory;
  const privateDirectories = [
    ...new Set([path.join(workspace, ".teamhub"), baseDirectory, directory]),
  ];
  let protectedIdentity = "";
  const filename = (root: string, value: string) => {
    if (!/^[0-9a-f]{64}\.json$/u.test(value))
      throw new TeamHubFileError(
        "state_unavailable",
        "TeamHub working-copy metadata path is invalid",
      );
    return path.join(root, value);
  };
  const ensure = async () => {
    input.signal.throwIfAborted();
    if ((await realpath(workspace).catch(() => "")) !== workspace)
      throw invalidStateDirectory();
    const identities = [];
    for (const entry of privateDirectories) {
      await ensurePrivateDirectory(entry);
      const metadata = await lstat(entry, { bigint: true });
      identities.push(`${metadata.dev}:${metadata.ino}`);
    }
    const identity = identities.join("/");
    if (identity !== protectedIdentity) {
      await protectWindowsDirectories(privateDirectories);
      protectedIdentity = identity;
    }
  };
  const createFiles = (
    root: string,
    ensure: () => Promise<void>,
    verify: () => Promise<void>,
  ): TeamHubWorkingCopyStateFiles => ({
    key: directory,
    ensure,
    async read(value, limit) {
      await ensure();
      const target = filename(root, value);
      const metadata = await lstat(target).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (!metadata) return null;
      if (
        metadata.isSymbolicLink() ||
        !metadata.isFile() ||
        metadata.nlink !== 1
      )
        throw invalidStateDirectory();
      // Ordinary paths retain the portable canonical-path checks. A Linux
      // directory descriptor is deliberately read without resolving it away.
      if (root === directory) {
        const snapshot = await readExactHostFile(
          directory,
          value,
          limit,
          input.signal,
        );
        return snapshot.content;
      }
      const content = await readPinnedStateFile(target, limit, input.signal);
      await verify();
      return content;
    },
    async write(value, content) {
      await ensure();
      const temporary = path.join(root, `.${randomUUID()}.tmp`);
      const handle = await open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        input.signal.throwIfAborted();
        await verify();
        await replaceHostFile(temporary, filename(root, value));
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      await syncHostDirectory(root);
    },
  });
  const verify = async () => {
    input.signal.throwIfAborted();
    if ((await realpath(directory).catch(() => "")) !== directory)
      throw invalidStateDirectory();
  };
  return {
    ...createFiles(directory, ensure, verify),
    async withPinnedDirectory(operation) {
      if (process.platform !== "linux") {
        await ensure();
        return operation(createFiles(directory, ensure, verify));
      }
      // Pin each canonical component. Relative checks avoid serial NFS ancestor
      // walks without caching directory identities or following replacement links.
      const handles: FileHandle[] = [];
      const witnesses: { path: string; dev: bigint; ino: bigint }[] = [];
      let active = true;
      const flags =
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
      try {
        let parent = await open(path.parse(directory).root, flags);
        handles.push(parent);
        let current = path.parse(directory).root;
        for (const component of directory.split(path.sep).filter(Boolean)) {
          input.signal.throwIfAborted();
          current = path.join(current, component);
          const relative = `/proc/self/fd/${parent.fd}/${component}`;
          if (privateDirectories.includes(current)) {
            await mkdir(relative, { mode: 0o700 }).catch((error: unknown) => {
              if ((error as NodeJS.ErrnoException).code !== "EEXIST")
                throw error;
            });
          }
          const child = await open(relative, flags).catch(() => {
            throw invalidStateDirectory();
          });
          handles.push(child);
          const { dev, ino } = await child.stat({ bigint: true });
          witnesses.push({ path: relative, dev, ino });
          parent = child;
        }
        const assertActive = () => {
          input.signal.throwIfAborted();
          if (!active) throw invalidStateDirectory();
        };
        const verifyAnchor = async () => {
          assertActive();
          await Promise.all(
            witnesses.map(async (expected) => {
              const named = await lstat(expected.path, { bigint: true });
              if (
                !named.isDirectory() ||
                named.isSymbolicLink() ||
                named.dev !== expected.dev ||
                named.ino !== expected.ino
              )
                throw invalidStateDirectory();
            }),
          );
        };
        await verifyAnchor();
        return await operation({
          ...createFiles(
            `/proc/self/fd/${parent.fd}`,
            verifyAnchor,
            verifyAnchor,
          ),
          // All directories are already open. Each read/write/remove validates
          // their identities, so ensure need not repeat that complete traversal.
          ensure: async () => assertActive(),
        });
      } finally {
        active = false;
        await Promise.all(handles.map((handle) => handle.close()));
      }
    },
  };
}

export function createHostTeamHubWorkspaceFiles(input: {
  readonly workspacePath: string;
  readonly runtimeWorkspacePath: string;
  readonly readOnlyPaths: readonly string[];
  readonly signal: AbortSignal;
  readonly writableMappings?: readonly {
    readonly relativePath: string;
    readonly sourcePath: string;
  }[];
}): TeamHubWorkspaceFiles {
  const root = createSingleRootWorkspaceFiles(input);
  const insensitivePaths =
    process.platform === "win32" ||
    /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(input.runtimeWorkspacePath);
  const mappings = (input.writableMappings ?? [])
    .map((mapping) => ({
      prefix: normalizeWorkspaceLogicalPath(mapping.relativePath),
      files: createSingleRootWorkspaceFiles({
        ...input,
        workspacePath: mapping.sourcePath,
        readOnlyPaths: [],
      }),
    }))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  const resolve = (value: string) => {
    const prefix = input.runtimeWorkspacePath.replace(/[\\/]+$/u, "");
    const normalized = root.normalize(`${prefix}/${value}`);
    const mapping = mappings.find((candidate) =>
      insensitivePaths
        ? normalized
            .toLowerCase()
            .startsWith(`${candidate.prefix.toLowerCase()}/`)
        : normalized.startsWith(`${candidate.prefix}/`),
    );
    return mapping
      ? {
          files: mapping.files,
          relativePath: normalized.slice(mapping.prefix.length + 1),
        }
      : { files: root, relativePath: normalized };
  };
  return {
    normalize: root.normalize,
    async inspect(value) {
      const target = resolve(value);
      return target.files.inspect(target.relativePath);
    },
    async read(value) {
      const target = resolve(value);
      return target.files.read(target.relativePath);
    },
    async install(value, content, expectedSHA256) {
      const target = resolve(value);
      await target.files.install(target.relativePath, content, expectedSHA256);
    },
  };
}

function createSingleRootWorkspaceFiles(input: {
  readonly workspacePath: string;
  readonly runtimeWorkspacePath: string;
  readonly readOnlyPaths: readonly string[];
  readonly signal: AbortSignal;
}): TeamHubWorkspaceFiles {
  const hostRoot = path.resolve(input.workspacePath);
  const windowsPaths = /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(
    input.runtimeWorkspacePath,
  );
  const windowsNames = process.platform === "win32" || windowsPaths;
  const runtimePath = windowsPaths ? path.win32 : path.posix;
  const runtimeRoot = runtimePath.resolve(input.runtimeWorkspacePath);
  const runtimeRoots = [runtimeRoot];
  if (runtimeRoot === hostRoot) runtimeRoots.push(realpathSync(hostRoot));
  const reserved = [".agents", ".teamhub", ...input.readOnlyPaths].map(
    normalizeWorkspaceLogicalPath,
  );
  const validate = (value: string): string => {
    let filePath: string;
    try {
      if (value.split("/").includes(".."))
        throw new TypeError("Parent traversal");
      filePath = normalizeWorkspaceLogicalPath(value);
    } catch {
      throw new TeamHubFileError(
        "invalid_path",
        "File path must be normalized and inside the Runtime workspace",
      );
    }
    if (windowsNames && filePath.split("/").some(invalidWindowsSegment)) {
      throw new TeamHubFileError(
        "invalid_path",
        "File path contains an invalid Windows name",
      );
    }
    const comparisonPath = windowsNames ? filePath.toLowerCase() : filePath;
    if (
      reserved.some((prefix) => {
        const candidate = windowsNames ? prefix.toLowerCase() : prefix;
        return (
          comparisonPath === candidate ||
          comparisonPath.startsWith(`${candidate}/`)
        );
      })
    ) {
      throw new TeamHubFileError(
        "forbidden",
        "CLI files cannot replace a read-only Runtime projection",
      );
    }
    return filePath;
  };
  const inspect = async (value: string) => {
    input.signal.throwIfAborted();
    const filePath = validate(value);
    const rootStat = await lstat(hostRoot, { bigint: true });
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
      throw invalidEntry();
    const canonicalRoot = await realpath(hostRoot);
    const canonicalStat = await lstat(canonicalRoot, { bigint: true });
    if (
      rootStat.dev !== canonicalStat.dev ||
      rootStat.ino !== canonicalStat.ino
    )
      throw changed();
    const parents = [
      {
        filePath: canonicalRoot,
        dev: canonicalStat.dev,
        ino: canonicalStat.ino,
      },
    ];
    let current = canonicalRoot;
    for (const segment of filePath.split("/").slice(0, -1)) {
      input.signal.throwIfAborted();
      current = path.join(current, segment);
      const stat = await lstat(current, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw invalidEntry();
      parents.push({ filePath: current, dev: stat.dev, ino: stat.ino });
    }
    const target = path.join(canonicalRoot, filePath);
    const stat = await lstat(target, { bigint: true }).catch(
      (error: unknown) => {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return null;
        throw error;
      },
    );
    if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw invalidEntry();
    return { target, stat, parents };
  };
  const read: TeamHubWorkspaceFiles["read"] = async (filePath) => {
    const inspected = await inspect(filePath);
    if (!inspected.stat) return null;
    return readExactHostFile(
      hostRoot,
      validate(filePath),
      CONTEXT_FILE_MAX_BYTES,
      input.signal,
    );
  };
  return {
    normalize(value) {
      const absolute = windowsPaths ? value.replaceAll("\\", "/") : value;
      const matchingRoot = runtimeRoots
        .map((root) =>
          (windowsPaths ? root.replaceAll("\\", "/") : root).replace(
            /\/$/u,
            "",
          ),
        )
        .find((root) =>
          windowsPaths
            ? absolute.toLowerCase().startsWith(`${root.toLowerCase()}/`)
            : absolute.startsWith(`${root}/`),
        );
      if (!matchingRoot) {
        throw new TeamHubFileError(
          "invalid_path",
          "File path is outside the Runtime workspace",
        );
      }
      return validate(absolute.slice(matchingRoot.length + 1));
    },
    read,
    async inspect(filePath) {
      const value = await read(filePath);
      return value ? { sha256: value.sha256 } : null;
    },
    async install(filePath, content, expectedSHA256) {
      if (content.byteLength > CONTEXT_FILE_MAX_BYTES) {
        throw new TeamHubFileError("too_large", "File exceeds 50 MiB");
      }
      const inspected = await inspect(filePath);
      const temporary = path.join(
        path.dirname(inspected.target),
        `.teamhub-${randomUUID()}.tmp`,
      );
      const handle = await open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        const verifyTarget = async () => {
          input.signal.throwIfAborted();
          for (const parent of inspected.parents) {
            const stat = await lstat(parent.filePath, { bigint: true });
            if (
              stat.isSymbolicLink() ||
              !stat.isDirectory() ||
              stat.dev !== parent.dev ||
              stat.ino !== parent.ino
            )
              throw changed();
          }
          const current = await read(filePath);
          if ((current?.sha256 ?? null) !== expectedSHA256) throw changed();
          input.signal.throwIfAborted();
        };
        if (expectedSHA256 === null) {
          await verifyTarget();
          // link installs a fully written file and atomically refuses an
          // independently created target; rename would silently overwrite it.
          await createHostFileExclusive(temporary, inspected.target).catch(
            (error: unknown) => {
              if (
                error instanceof Error &&
                "code" in error &&
                error.code === "EEXIST"
              )
                throw changed();
              throw error;
            },
          );
        } else {
          await replaceHostFile(
            temporary,
            inspected.target,
            verifyTarget,
          ).catch((error: unknown) => {
            if (isWindowsFileSharingError(error)) throw fileInUse();
            throw error;
          });
        }
        await syncHostDirectory(path.dirname(inspected.target));
      } finally {
        await rm(temporary, { force: true });
      }
    },
  };
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  const metadata = await lstat(directory);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (await realpath(directory)) !== directory
  )
    throw invalidStateDirectory();
}

const invalidWindowsSegment = (segment: string): boolean =>
  /[<>:"|?*]/u.test(segment) ||
  [...segment].some((character) => character.charCodeAt(0) < 32) ||
  /[. ]$/u.test(segment) ||
  /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu.test(segment);

const invalidStateDirectory = () =>
  new TeamHubFileError(
    "state_unavailable",
    "TeamHub working-copy metadata is unavailable",
  );

const invalidEntry = () =>
  new TeamHubFileError(
    "invalid_path",
    "File path contains a symbolic link or a non-regular entry",
  );
const changed = () =>
  new TeamHubFileError(
    "file_changed",
    "Local file changed while downloading; preserve the changes before trying again",
  );

// Windows keeps a file another program has open, such as an Excel workbook,
// from being replaced until that program closes it.
const fileInUse = () =>
  new TeamHubFileError(
    "file_in_use",
    "Local file is open in another program; close it and try again",
  );

async function readPinnedStateFile(
  filename: string,
  limit: number,
  signal: AbortSignal,
): Promise<Buffer> {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw invalidStateDirectory();
  const handle = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(limit))
      throw invalidStateDirectory();
    const content = Buffer.allocUnsafe(Number(before.size) + 1);
    let offset = 0;
    while (offset < content.byteLength) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(
        content,
        offset,
        Math.min(64 * 1024, content.byteLength - offset),
        offset,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    signal.throwIfAborted();
    const after = await handle.stat({ bigint: true });
    const named = await lstat(filename, { bigint: true });
    if (
      offset !== Number(before.size) ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      after.nlink !== 1n ||
      named.isSymbolicLink() ||
      named.dev !== after.dev ||
      named.ino !== after.ino
    )
      throw invalidStateDirectory();
    return content.subarray(0, offset);
  } finally {
    await handle.close();
  }
}
