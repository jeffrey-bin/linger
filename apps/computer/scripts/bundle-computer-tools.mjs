import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import tar from "tar-stream";
import yauzl from "yauzl";

const computerRoot = fileURLToPath(new URL("../", import.meta.url));
export const COMPUTER_TOOL_VERSIONS = Object.freeze({
  playwright: "0.0.83",
  pi: "1.2.0",
  cua: "0.35.4",
});
// Pinned Cua desktop drivers per release target. Windows drives the signed-in
// desktop through the standalone driver; it needs no app bundle or SDK.
const cuaArchive = (name, sha256, entry, required) =>
  Object.freeze({
    name,
    sha256,
    url: `https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.35.4/${name}`,
    root: `${name.replace(/\.(tar\.gz|zip)$/u, "")}/`,
    entry,
    required,
  });
const darwinCua = cuaArchive(
  "cua-driver-rs-0.35.4-darwin-universal.tar.gz",
  "97d5ea2fd446331947c717c433d4cf5aae063f4824e1ba24303c4696184ec52e",
  "cua/cua-driver",
  ["cua/cua-driver", "cua/CuaDriver.app/Contents/MacOS/cua-driver"],
);
export const CUA_ARCHIVES = Object.freeze({
  "darwin-arm64": darwinCua,
  "darwin-x64": darwinCua,
  "win32-x64": cuaArchive(
    "cua-driver-rs-0.35.4-windows-x86_64.zip",
    "823ca4b340ca85301dd65f116cfb26282c40a66f1fc465a225ee103b6b74af5b",
    "cua/cua-driver.exe",
    ["cua/cua-driver.exe"],
  ),
  "win32-arm64": cuaArchive(
    "cua-driver-rs-0.35.4-windows-arm64.zip",
    "fdbbbc27f814bb850c359268f977a61d0fbd89eb1d2776e3762d36f1a752dd02",
    "cua/cua-driver.exe",
    ["cua/cua-driver.exe"],
  ),
});
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

async function packageRoot(name, from) {
  const require = createRequire(pathToFileURL(path.join(from, "package.json")));
  for (const directory of require.resolve.paths(name) ?? []) {
    const candidate = path.join(directory, name);
    const manifest = await readFile(
      path.join(candidate, "package.json"),
      "utf8",
    )
      .then(JSON.parse)
      .catch(() => null);
    if (manifest?.name === name) return realpath(candidate);
  }
  throw new Error(`Cannot resolve tool package ${name}`);
}

// Preserve upstream modules and dynamic resources. Resolution uses only this
// worktree's frozen installation; no npx, npm install, or runtime download.
async function stagePackages(destination) {
  const installed = new Map();
  const versions = [];
  async function copyPackage(name, from, parent, ancestors = new Map()) {
    const source = await packageRoot(name, from);
    if (ancestors.has(source)) return;
    const manifest = JSON.parse(
      await readFile(path.join(source, "package.json"), "utf8"),
    );
    const rootPath = path.join(destination, "node_modules", name);
    let target = rootPath;
    if (installed.has(rootPath)) {
      if (installed.get(rootPath) === source) return;
      target = path.join(parent, "node_modules", name);
    }
    if (installed.get(target) === source) return;
    if (installed.has(target))
      throw new Error(`Conflicting tool dependency ${name}`);
    installed.set(target, source);
    await cp(source, target, {
      recursive: true,
      dereference: false,
      filter: (entry) => {
        const parts = path.relative(source, entry).split(path.sep);
        return (
          !parts.some((part) =>
            [
              "node_modules",
              ".git",
              "test",
              "tests",
              "__tests__",
              "docs",
              "examples",
            ].includes(part),
          ) && !/\.(?:map|d\.[cm]?ts)$/u.test(entry)
        );
      },
    });
    versions.push({
      name,
      version: manifest.version,
      path: path.relative(destination, target).split(path.sep).join("/"),
    });
    const next = new Map(ancestors);
    next.set(source, target);
    const required = manifest.dependencies ?? {};
    const optional = manifest.optionalDependencies ?? {};
    for (const dependency of [
      ...new Set([...Object.keys(required), ...Object.keys(optional)]),
    ].sort()) {
      if (dependency in optional) {
        try {
          await packageRoot(dependency, source);
        } catch {
          continue;
        }
      }
      await copyPackage(dependency, source, target, next);
    }
  }
  for (const [name, version] of [
    ["@playwright/mcp", COMPUTER_TOOL_VERSIONS.playwright],
    ["@earendil-works/pi-coding-agent", COMPUTER_TOOL_VERSIONS.pi],
  ]) {
    const source = await packageRoot(name, computerRoot);
    const manifest = JSON.parse(
      await readFile(path.join(source, "package.json"), "utf8"),
    );
    if (manifest.version !== version)
      throw new Error(`Expected ${name}@${version}`);
    await copyPackage(name, computerRoot, destination);
  }
  return versions.sort((a, b) => a.path.localeCompare(b.path));
}

async function ensureCuaArchive(release, cacheDirectory) {
  await mkdir(cacheDirectory, { recursive: true });
  const archive = path.join(cacheDirectory, release.name);
  const valid = async () => sha256(await readFile(archive)) === release.sha256;
  try {
    if (await valid()) return archive;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const partial = `${archive}.${process.pid}.partial`;
  try {
    const response = await fetch(release.url, {
      // This pinned release is about 80 MiB. CI can reach GitHub over a slow
      // link; bound the complete transfer without requiring a fast mirror.
      signal: AbortSignal.timeout(30 * 60_000),
    });
    if (!response.ok || !response.body)
      throw new Error("Cua release download failed");
    await pipeline(
      response.body,
      createWriteStream(partial, { mode: 0o600, flags: "wx" }),
    );
    if (sha256(await readFile(partial)) !== release.sha256)
      throw new Error("Cua release checksum mismatch");
    await rename(partial, archive);
  } finally {
    await rm(partial, { force: true });
  }
  return archive;
}

// The MCP proxy and signed app are the only macOS Cua execution paths; the
// standalone driver is the only Windows one. SDK libraries, Node bindings, the
// UIA and cursor-theme helpers, and headers are not loaded, so they are not
// shipped.
const keptCuaFile = (relative) =>
  relative.startsWith("CuaDriver.app/") ||
  relative === "CuaDriver.app" ||
  [
    "cua-driver",
    "cua-driver.exe",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
  ].includes(relative);

const cuaRelativePath = (release, name) => {
  if (!name.startsWith(release.root))
    throw new Error("Unexpected Cua archive root");
  const relative = name.slice(release.root.length).replace(/\/$/u, "");
  if (
    relative &&
    (relative
      .split("/")
      .some((part) => !part || part === "." || part === "..") ||
      relative.includes("\\"))
  )
    throw new Error("Unsafe Cua archive path");
  return relative;
};

async function extractCuaZip(release, archive, destination) {
  const zip = await promisify(yauzl.open)(archive, {
    lazyEntries: true,
    decodeStrings: true,
  });
  try {
    await new Promise((resolve, reject) => {
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (entry) => {
        (async () => {
          const relative = cuaRelativePath(release, entry.fileName);
          const directory = entry.fileName.endsWith("/");
          if (!relative || directory || !keptCuaFile(relative)) return;
          // Unix mode bits in the high word mark links; refuse them.
          if (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000)
            throw new Error("Cua archive links are not permitted");
          const target = path.join(destination, relative);
          await mkdir(path.dirname(target), { recursive: true });
          const stream = await promisify(zip.openReadStream.bind(zip))(entry);
          await pipeline(
            stream,
            createWriteStream(target, {
              flags: "wx",
              mode: relative.endsWith(".exe") ? 0o755 : 0o644,
            }),
          );
        })().then(() => zip.readEntry(), reject);
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
}

async function extractCua(release, archive, destination) {
  if (release.name.endsWith(".zip"))
    return extractCuaZip(release, archive, destination);
  const extract = tar.extract();
  extract.on("entry", (header, stream, next) => {
    (async () => {
      const relative = cuaRelativePath(release, header.name);
      if (!relative || !keptCuaFile(relative)) {
        stream.resume();
        return;
      }
      const target = path.join(destination, relative);
      if (header.type === "directory") {
        await mkdir(target, { recursive: true });
        stream.resume();
        return;
      }
      if (header.type !== "file")
        throw new Error("Cua archive links are not permitted");
      await mkdir(path.dirname(target), { recursive: true });
      await pipeline(
        stream,
        createWriteStream(target, {
          flags: "wx",
          mode: header.mode & 0o111 ? 0o755 : 0o644,
        }),
      );
    })().then(next, (error) => extract.destroy(error));
  });
  await pipeline(createReadStream(archive), createGunzip(), extract);
}

async function assetFiles(root, relative = "") {
  const files = [];
  for (const entry of (await readdir(path.join(root, relative))).sort()) {
    const name = path.posix.join(relative, entry);
    const info = await lstat(path.join(root, name));
    if (info.isSymbolicLink())
      throw new Error(`Tool asset links are not permitted: ${name}`);
    if (info.isDirectory()) files.push(...(await assetFiles(root, name)));
    else if (info.isFile()) {
      const data = await readFile(path.join(root, name));
      files.push({
        path: name,
        size_bytes: data.length,
        sha256: sha256(data),
        mode: info.mode & 0o111 ? 0o755 : 0o644,
      });
    } else throw new Error(`Unsupported tool asset: ${name}`);
  }
  return files;
}

export async function stageComputerTools(
  bundle,
  {
    target = `${process.platform}-${process.arch}`,
    cacheDirectory = path.join(os.homedir(), ".cache/linger-computer-tools"),
  } = {},
) {
  const root = path.join(bundle, "cli/computer-tools");
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const packages = await stagePackages(root);
  await mkdir(path.join(root, "extensions"), { recursive: true });
  await cp(
    path.join(computerRoot, "tools/pi-mcp.mjs"),
    path.join(root, "extensions/pi-mcp.mjs"),
  );
  const cua = CUA_ARCHIVES[target];
  if (cua)
    await extractCua(
      cua,
      await ensureCuaArchive(cua, cacheDirectory),
      path.join(root, "cua"),
    );
  const assets = await assetFiles(root);
  const manifest = {
    schema_version: 1,
    versions: COMPUTER_TOOL_VERSIONS,
    target,
    playwright_entry: "node_modules/@playwright/mcp/cli.js",
    pi_extension: "extensions/pi-mcp.mjs",
    cua_entry: cua?.entry ?? "",
    packages,
    assets,
    artifact_sha256: sha256(JSON.stringify(assets)),
  };
  await writeFile(
    path.join(root, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

export async function validatedComputerToolAssets(bundle, target) {
  const root = path.join(bundle, "cli/computer-tools");
  const manifest = JSON.parse(
    await readFile(path.join(root, "manifest.json"), "utf8"),
  );
  if (
    manifest.schema_version !== 1 ||
    manifest.target !== target ||
    JSON.stringify(manifest.versions) !==
      JSON.stringify(COMPUTER_TOOL_VERSIONS) ||
    !Array.isArray(manifest.assets) ||
    sha256(JSON.stringify(manifest.assets)) !== manifest.artifact_sha256
  )
    throw new Error("Invalid Computer tool manifest");
  if (
    manifest.playwright_entry !== "node_modules/@playwright/mcp/cli.js" ||
    manifest.pi_extension !== "extensions/pi-mcp.mjs" ||
    manifest.cua_entry !== (CUA_ARCHIVES[target]?.entry ?? "")
  )
    throw new Error("Invalid Computer tool entrypoints");
  const actual = await assetFiles(root);
  const expected = manifest.assets;
  const withoutManifest = actual.filter(
    (asset) => asset.path !== "manifest.json",
  );
  if (JSON.stringify(withoutManifest) !== JSON.stringify(expected))
    throw new Error("Computer tool assets do not match their manifest");
  for (const required of [
    manifest.playwright_entry,
    manifest.pi_extension,
    ...(CUA_ARCHIVES[target]?.required ?? []),
  ]) {
    if (!required || !expected.some((asset) => asset.path === required))
      throw new Error("Computer tool entrypoint is missing");
  }
  return [
    "cli/computer-tools/manifest.json",
    ...expected.map((asset) => `cli/computer-tools/${asset.path}`),
  ];
}
