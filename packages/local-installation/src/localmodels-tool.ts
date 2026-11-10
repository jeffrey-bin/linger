import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, rename, rm, chmod } from "node:fs/promises";
import path from "node:path";
import { x as extract } from "tar";
import { downloadVerified } from "./download.js";
import {
  atomicPrivate,
  privateDirectory,
  withInstanceLock,
  type Instance,
} from "./instance.js";
import { runProcess, type ProcessOptions } from "./process.js";
import {
  validatePublishedServiceSource,
  type PublishedServiceSource,
} from "./published-source.js";
import type { InstallerEvent } from "./events.js";
import { renameRetrying } from "./fs-retry.js";
export type LocalmodelsToolSource = PublishedServiceSource & {
  sourceCommit: string;
  manifestSha256: string;
};
interface ToolManifest {
  schemaVersion: number;
  platform: string;
  arch: string;
  sourceCommit: string;
  python: string;
  moduleDir: string;
  assets: Record<string, string>;
}
type Options = ProcessOptions & { onEvent?: (event: InstallerEvent) => void };
export function validateToolSource(value: unknown): LocalmodelsToolSource {
  const source = validatePublishedServiceSource(value);
  const extra = value as LocalmodelsToolSource;
  if (
    !/^[a-f0-9]{40}$/.test(extra.sourceCommit ?? "") ||
    !/^[a-f0-9]{64}$/.test(extra.manifestSha256 ?? "")
  )
    throw new Error(
      "Upstream tool distribution metadata requires a pinned commit and manifest checksum.",
    );
  return {
    ...source,
    sourceCommit: extra.sourceCommit,
    manifestSha256: extra.manifestSha256,
  };
}
function safeRelative(name: string): boolean {
  return (
    !!name &&
    !name.startsWith("/") &&
    !name.includes("\\") &&
    !name.includes(":") &&
    !name
      .split("/")
      .some(
        (p) =>
          p === ".." ||
          p === "." ||
          !p ||
          [...p].some((c) => c.charCodeAt(0) < 32) ||
          /[. ]$/.test(p) ||
          /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(p),
      )
  );
}
async function digest(file: string) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest("hex");
}
async function regular(root: string, relative: string) {
  if (!safeRelative(relative)) throw new Error("Unsafe upstream tool path.");
  let file = root;
  for (const part of relative.split("/")) {
    file = path.join(file, part);
    const s = await lstat(file);
    if (s.isSymbolicLink())
      throw new Error("Linked upstream tool paths are forbidden.");
  }
  if (!(await lstat(file)).isFile())
    throw new Error("Upstream tool payload must be a regular file.");
  return file;
}
// Size and modification time of each asset when it last matched its
// checksum. An asset whose stamp still matches is not hashed again: the kit
// has ~4.7k files, and hashing them all made every Windows check of this
// computer take over a minute.
type Stamps = Record<string, [size: number, mtimeMs: number]>;
const stampsFile = (directory: string) => `${directory}.verified.json`;
async function readStamps(
  directory: string,
  source: LocalmodelsToolSource,
): Promise<Stamps | undefined> {
  try {
    const value = JSON.parse(await readFile(stampsFile(directory), "utf8")) as {
      manifestSha256?: unknown;
      stamps?: Stamps;
    };
    return value.manifestSha256 === source.manifestSha256 &&
      value.stamps &&
      typeof value.stamps === "object"
      ? value.stamps
      : undefined;
  } catch {
    return undefined;
  }
}
async function writeStamps(
  directory: string,
  source: LocalmodelsToolSource,
  stamps: Stamps,
) {
  await atomicPrivate(
    stampsFile(directory),
    JSON.stringify({ manifestSha256: source.manifestSha256, stamps }),
  ).catch(() => undefined);
}
// Assets hashed at once.
const CONCURRENCY = 16;
async function verify(
  directory: string,
  source: LocalmodelsToolSource,
  known: Stamps = {},
) {
  const manifestFile = await regular(directory, "tool.json");
  const body = await readFile(manifestFile);
  if (createHash("sha256").update(body).digest("hex") !== source.manifestSha256)
    throw new Error("Upstream tool manifest checksum mismatch.");
  const m = JSON.parse(body.toString()) as ToolManifest;
  if (
    m.schemaVersion !== 1 ||
    m.platform !== process.platform ||
    m.arch !== process.arch ||
    m.sourceCommit !== source.sourceCommit ||
    !m.assets ||
    !m.assets[m.python] ||
    !safeRelative(m.moduleDir)
  )
    throw new Error(
      "Upstream tool distribution target or source does not match.",
    );
  const assets = Object.entries(m.assets);
  const stamps: Stamps = {};
  let hashed = 0;
  let next = 0;
  const worker = async () => {
    while (next < assets.length) {
      const [name, expected] = assets[next++]!;
      if (!/^[a-f0-9]{64}$/.test(expected))
        throw new Error("Upstream tool payload checksum mismatch.");
      const file = await regular(directory, name);
      const info = await lstat(file);
      const stamp: [number, number] = [info.size, info.mtimeMs];
      const seen = known[name];
      if (!seen || seen[0] !== stamp[0] || seen[1] !== stamp[1]) {
        hashed += 1;
        if ((await digest(file)) !== expected)
          throw new Error("Upstream tool payload checksum mismatch.");
      }
      stamps[name] = stamp;
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, assets.length) }, () =>
      worker().catch((error: unknown) => {
        next = assets.length;
        throw error;
      }),
    ),
  );
  return {
    python: await regular(directory, m.python),
    moduleDir: path.join(directory, m.moduleDir),
    sourceCommit: m.sourceCommit,
    stamps,
    hashed,
  };
}
const location = (tool: Awaited<ReturnType<typeof verify>>) => ({
  python: tool.python,
  moduleDir: tool.moduleDir,
  sourceCommit: tool.sourceCommit,
});
async function unpack(archive: string, directory: string) {
  let size = 0;
  await extract({
    file: archive,
    cwd: directory,
    strict: true,
    preservePaths: false,
    filter: (name, entry) => {
      const type =
        "type" in entry
          ? entry.type
          : entry.isDirectory()
            ? "Directory"
            : entry.isFile()
              ? "File"
              : "Unsupported";
      const relative = name.replace(/^\.\//, "").replace(/\/$/, "");
      if (!relative) return type === "Directory";
      if (!safeRelative(relative) || !["File", "Directory"].includes(type))
        throw new Error("Unsafe upstream tool archive.");
      size += entry.size;
      if (size > 1024 ** 3)
        throw new Error(
          "Upstream tool archive exceeds its extracted size limit.",
        );
      return true;
    },
  });
}
/**
 * Verified kits are sealed read-only: upstream children that run the kit's
 * Python without -B would otherwise rewrite verified bytecode, and every later
 * verification would fail.
 */
async function setKitMode(directory: string, sealed: boolean) {
  if (process.platform === "win32") return;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await setKitMode(file, sealed);
    else if (sealed && entry.isFile())
      await chmod(file, (await lstat(file)).mode & 0o500);
  }
  await chmod(directory, sealed ? 0o500 : 0o700);
}
async function installedKit(directory: string, source: LocalmodelsToolSource) {
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.platform !== "win32" && info.uid !== process.getuid?.())
  )
    throw new Error("Upstream tool kit must be an owned directory.");
  if (process.platform === "win32") await privateDirectory(directory);
  const tool = await verify(
    directory,
    source,
    await readStamps(directory, source),
  );
  if (process.platform !== "win32" && (info.mode & 0o777) !== 0o500)
    await setKitMode(directory, true);
  if (tool.hashed > 0) await writeStamps(directory, source, tool.stamps);
  return location(tool);
}
async function prepareLocalmodelsTool(
  home: string,
  options: Options = {},
  dependencies: { source?: LocalmodelsToolSource; fetcher?: typeof fetch } = {},
) {
  let source = dependencies.source;
  if (!source) {
    const raw = process.env.LINGER_LOCALMODELS_TOOL_JSON;
    if (!raw)
      throw new Error(
        "Upstream tool distribution metadata is unavailable. Download the current Linger installer.",
      );
    source = validateToolSource(JSON.parse(raw));
  }
  source = validateToolSource(source);
  const base = path.join(path.resolve(home), "tools", "localmodels");
  await privateDirectory(base);
  const directory = path.join(base, source.sha256);
  // Published kits are immutable and renamed into place only after validation.
  // Readers must not compete for the cross-process installation lock.
  try {
    const tool = await installedKit(directory, source);
    if (tool) return tool;
  } catch {
    // An altered kit is replaced below, under the publication lock.
  }
  const lock = path.join(base, "lock");
  await privateDirectory(lock);
  return withInstanceLock({ root: lock } as Instance, async () => {
    let damaged = false;
    try {
      const tool = await installedKit(directory, source);
      if (tool) return tool;
    } catch (error) {
      if (/owned directory/.test((error as Error).message)) throw error;
      damaged = true;
    }
    const signal = options.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    if (damaged) {
      // Re-fetch the same pinned kit; the altered copy is moved aside first so
      // the published path only ever holds a verified kit.
      const invalid = path.join(base, `invalid-${randomUUID()}`);
      // macOS also requires the source directory to be writable when moving
      // a sealed directory. Ownership was checked above; reopen only its root
      // before quarantine, then reopen descendants at the quarantined path.
      if (process.platform !== "win32") await chmod(directory, 0o700);
      await rename(directory, invalid);
      await setKitMode(invalid, false);
      await rm(invalid, { recursive: true, force: true });
    }
    const stage = path.join(base, `pending-${randomUUID()}`);
    await privateDirectory(stage);
    const archive = path.join(base, `${randomUUID()}.tgz`);
    try {
      options.onEvent?.({
        kind: "stage",
        stage: "preflight",
        state: "running",
        message: damaged
          ? "Repairing the model and Harness installation tool…"
          : "Preparing the model and Harness installation tool…",
      });
      await downloadVerified(
        {
          url: source.url,
          mirrors: source.mirrors,
          output: archive,
          algorithm: "sha256",
          digest: source.sha256,
          maxBytes: source.bytes,
          signal,
          onProgress: (completed, total) =>
            options.onEvent?.({
              kind: "stage",
              stage: "preflight",
              state: "running",
              message: "Downloading the model and Harness installation tool…",
              progress: { completed, total, unit: "bytes" },
            }),
        },
        dependencies.fetcher,
      );
      await unpack(archive, stage);
      const tool = await verify(stage, source);
      if (process.platform !== "win32") await chmod(tool.python, 0o700);
      // The kit manifest is private state; publisher bytes stay unchanged for digest checks.
      const body = await readFile(path.join(stage, "tool.json"), "utf8");
      await atomicPrivate(path.join(stage, "tool.json"), body);
      signal.throwIfAborted();
      await renameRetrying(stage, directory, { signal });
      // The rename keeps every stamp, so this checks the published kit
      // without hashing it a second time.
      const verified = await verify(directory, source, tool.stamps);
      await setKitMode(directory, true);
      await writeStamps(directory, source, verified.stamps);
      return location(verified);
    } finally {
      await rm(stage, { recursive: true, force: true });
      await rm(archive, { force: true });
    }
  });
}
type ToolLocation = Awaited<ReturnType<typeof prepareLocalmodelsTool>>;
const preparing = new Map<string, Promise<ToolLocation>>();
export async function ensureLocalmodelsTool(
  home: string,
  options: Options = {},
  dependencies: { source?: LocalmodelsToolSource; fetcher?: typeof fetch } = {},
): Promise<ToolLocation> {
  options.signal?.throwIfAborted();
  const key = `${path.resolve(home)}:${JSON.stringify(dependencies.source ?? process.env.LINGER_LOCALMODELS_TOOL_JSON)}`;
  const running = preparing.get(key);
  if (running) {
    const result = await running;
    options.signal?.throwIfAborted();
    return result;
  }
  const task = prepareLocalmodelsTool(home, options, dependencies);
  preparing.set(key, task);
  try {
    return await task;
  } finally {
    preparing.delete(key);
  }
}
export async function runLocalmodels(
  home: string,
  args: string[],
  options: Options = {},
  dependencies: { run?: typeof runProcess } = {},
) {
  const startedAt = Date.now();
  const tool = await ensureLocalmodelsTool(home, options);
  const checkedAt = Date.now();
  const state = path.join(
    path.resolve(home),
    "runtime",
    "localmodels",
    "state",
  );
  await privateDirectory(state);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    PYTHONPATH: tool.moduleDir,
    LOCALMODELS_STATE: state,
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
  };
  delete env.PYTHONHOME;
  delete env.PYTHONSTARTUP;
  delete env.PYTHONINSPECT;
  let pending = "";
  const onOutput = (chunk: string) => {
    options.onOutput?.(chunk);
    pending += chunk;
    if (pending.length > 65536) pending = pending.slice(-65536);
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        args[0] === "harness" &&
        args[1] === "apply" &&
        value?.kind === "stage"
      ) {
        const messages: Record<string, string> = {
          "extract:running":
            "Extracting Harness files and applying private permissions…",
          "verify:running": "Verifying the installed Harness executable…",
          "install:running": "Installing the selected Harness…",
          "install:succeeded":
            "Harness files installed; checking runtime status…",
          "reuse:succeeded":
            "Reusing the existing Harness; checking runtime status…",
        };
        const message =
          messages[`${String(value.stage)}:${String(value.state)}`];
        if (message)
          options.onEvent?.({
            kind: "stage",
            stage: "runtime",
            state: "running",
            message,
          });
        continue;
      }
      if (
        !value ||
        value.kind !== "progress" ||
        value.unit !== "bytes" ||
        typeof value.completed !== "number" ||
        !Number.isSafeInteger(value.completed) ||
        value.completed < 0 ||
        typeof value.total !== "number" ||
        !Number.isSafeInteger(value.total) ||
        value.total <= 0 ||
        value.completed > value.total
      )
        continue;
      options.onEvent?.({
        kind: "stage",
        stage: "runtime",
        state: "running",
        message:
          args[0] === "gateway"
            ? "Downloading the application model gateway…"
            : "Downloading the selected Harness…",
        progress: {
          completed: value.completed,
          total: value.total,
          unit: "bytes",
        },
      });
    }
  };
  const result = await (dependencies.run ?? runProcess)(
    tool.python,
    ["-P", "-s", "-m", "localmodels", ...args],
    { ...options, cwd: tool.moduleDir, env, onOutput },
  );
  const seconds = (ms: number) => (ms / 1000).toFixed(1);
  options.onEvent?.({
    kind: "log",
    message: `localmodels ${args.slice(0, 2).join(" ")}: tool checked in ${seconds(checkedAt - startedAt)}s, ran in ${seconds(Date.now() - checkedAt)}s.\n`,
  });
  return result;
}
export async function readPublishedTool(
  file: string,
): Promise<LocalmodelsToolSource | undefined> {
  let value: { platform?: unknown; arch?: unknown; localmodelsTool?: unknown };
  try {
    value = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (value.localmodelsTool === undefined) return;
  if (value.platform !== process.platform || value.arch !== process.arch)
    throw new Error(
      "Upstream tool distribution target does not match this computer.",
    );
  return validateToolSource(value.localmodelsTool);
}
