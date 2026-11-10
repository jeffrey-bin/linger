import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

// The services Native runs, built by a desktop release from the source package
// it ships (apps/desktop/scripts/build-native-runtime.mjs): Web's production
// files and static host, Node Services bundled with the node_modules it loads
// at runtime. The desktop unpacks them here; with them Native installs no
// packages and runs no development servers. Every target shares the layout.
export const NATIVE_RUNTIME_DIRECTORY = ".simplexai-runtime/offline";
export const NATIVE_RUNTIME_FILES = "files.json";
export const NATIVE_RUNTIME_SCHEMA = 1;
// Records that the runtime matched files.json once, keyed by that file's
// sha256: the desktop writes it after unpacking an archive it verified, and
// checkNativeRuntime after hashing every file. A runtime with a matching
// record is checked by size only; hashing its ~11k files took Windows
// (with Defender scanning each read) about six minutes on every install.
export const NATIVE_RUNTIME_VERIFIED = "verified.json";
// Files hashed or checked at once.
const CONCURRENCY = 16;

export interface NativeRuntimeFile {
  bytes: number;
  sha256: string;
}
export interface NativeRuntime {
  schema: number;
  target: string;
  sourceCommit: string;
  sourceArchiveSha256: string;
  files: Record<string, NativeRuntimeFile>;
}

// Entries the services start from; a runtime without them is not one.
const ENTRIES = [
  "web/static-host.mjs",
  "web/dist/index.html",
  "node-services/dist/main.js",
  "node-services/dist/supervisor.js",
];

const safePath = (file: string) =>
  file.length > 0 &&
  !file.includes("\\") &&
  !file.includes("\0") &&
  !path.posix.isAbsolute(file) &&
  !/^[A-Za-z]:/.test(file) &&
  file.split("/").every((part) => part !== "" && part !== "." && part !== "..");

export function parseNativeRuntime(value: unknown): NativeRuntime {
  const manifest = value as NativeRuntime;
  const valid =
    !!manifest &&
    typeof manifest === "object" &&
    manifest.schema === NATIVE_RUNTIME_SCHEMA &&
    typeof manifest.target === "string" &&
    /^[0-9a-f]{40}$/.test(manifest.sourceCommit ?? "") &&
    /^[0-9a-f]{64}$/.test(manifest.sourceArchiveSha256 ?? "") &&
    !!manifest.files &&
    typeof manifest.files === "object" &&
    Object.entries(manifest.files).every(
      ([file, item]) =>
        safePath(file) &&
        file !== NATIVE_RUNTIME_FILES &&
        file !== NATIVE_RUNTIME_VERIFIED &&
        !!item &&
        /^[0-9a-f]{64}$/.test(item.sha256 ?? "") &&
        Number.isSafeInteger(item.bytes) &&
        item.bytes >= 0,
    ) &&
    ENTRIES.every((entry) => entry in manifest.files);
  if (!valid) throw new Error("Invalid Native runtime manifest.");
  return {
    schema: manifest.schema,
    target: manifest.target,
    sourceCommit: manifest.sourceCommit,
    sourceArchiveSha256: manifest.sourceArchiveSha256,
    files: Object.fromEntries(
      Object.entries(manifest.files).map(([file, { bytes, sha256 }]) => [
        file,
        { bytes, sha256 },
      ]),
    ),
  };
}

async function readManifest(
  directory: string,
): Promise<{ manifest: NativeRuntime; sha256: string } | undefined> {
  let bytes;
  try {
    bytes = await readFile(path.join(directory, NATIVE_RUNTIME_FILES));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  return {
    manifest: parseNativeRuntime(JSON.parse(bytes.toString("utf8"))),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

// The manifest of the runtime in `directory`, or undefined when it has none.
export async function readNativeRuntime(
  directory: string,
): Promise<NativeRuntime | undefined> {
  return (await readManifest(directory))?.manifest;
}

// Records that the runtime in `directory` matches its current files.json.
export async function markNativeRuntimeVerified(
  directory: string,
): Promise<void> {
  const sha256 = createHash("sha256")
    .update(await readFile(path.join(directory, NATIVE_RUNTIME_FILES)))
    .digest("hex");
  const file = path.join(directory, NATIVE_RUNTIME_VERIFIED);
  const staged = `${file}.${process.pid}.tmp`;
  await writeFile(staged, JSON.stringify({ files: sha256 }));
  await rename(staged, file);
}

// Whether the runtime in `directory` was completely unpacked or checked for
// its current files.json. The record is written last, so a runtime whose
// unpacking stopped partway has none.
export async function nativeRuntimeVerified(
  directory: string,
): Promise<boolean> {
  const recorded = await verifiedFor(directory);
  const manifest = await readManifest(directory).catch(() => undefined);
  return recorded !== undefined && recorded === manifest?.sha256;
}

async function verifiedFor(directory: string): Promise<string | undefined> {
  try {
    const record = JSON.parse(
      await readFile(path.join(directory, NATIVE_RUNTIME_VERIFIED), "utf8"),
    ) as { files?: unknown };
    return typeof record.files === "string" ? record.files : undefined;
  } catch {
    return undefined;
  }
}

async function digest(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

// Throws unless every file the manifest lists has its size and, unless
// sizesOnly, its sha256.
export async function verifyNativeRuntime(
  directory: string,
  manifest: NativeRuntime,
  signal?: AbortSignal,
  sizesOnly = false,
): Promise<void> {
  const entries = Object.entries(manifest.files);
  let next = 0;
  const worker = async () => {
    while (next < entries.length) {
      signal?.throwIfAborted();
      const [file, item] = entries[next++]!;
      const location = path.join(directory, ...file.split("/"));
      const info = await stat(location).catch(() => undefined);
      if (
        !info?.isFile() ||
        info.size !== item.bytes ||
        (!sizesOnly && (await digest(location)) !== item.sha256)
      )
        throw new Error(`${file} does not match its Native runtime manifest.`);
    }
  };
  // The first mismatch rejects; the other workers stop at their next file.
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, entries.length) }, () =>
      worker().catch((error: unknown) => {
        next = entries.length;
        throw error;
      }),
    ),
  );
}

// Whether the checkout has a runtime for this computer, built from its own
// source package, that verifies. One that does not is removed, so Native
// installs the checkout's packages and runs its development servers instead.
// A runtime recorded as verified for this files.json is checked by size.
export async function checkNativeRuntime(
  repo: string,
  expected: {
    target?: string;
    signal?: AbortSignal;
    // How the runtime was checked, for the install log.
    checked?: (how: "sizes" | "hashes", files: number) => void;
  } = {},
): Promise<"absent" | "verified" | "removed"> {
  const directory = path.join(repo, NATIVE_RUNTIME_DIRECTORY);
  const target = expected.target ?? `${process.platform}-${process.arch}`;
  try {
    const current = await readManifest(directory);
    if (!current) return "absent";
    const { manifest, sha256 } = current;
    if (manifest.target !== target) throw new Error("another target");
    const recorded = (await verifiedFor(directory)) === sha256;
    await verifyNativeRuntime(directory, manifest, expected.signal, recorded);
    if (!recorded)
      await markNativeRuntimeVerified(directory).catch(() => undefined);
    expected.checked?.(
      recorded ? "sizes" : "hashes",
      Object.keys(manifest.files).length,
    );
    return "verified";
  } catch {
    expected.signal?.throwIfAborted();
    await rm(directory, { recursive: true, force: true });
    return "removed";
  }
}
