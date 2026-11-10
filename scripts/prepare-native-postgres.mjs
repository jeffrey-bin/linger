#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const SOURCES = Object.freeze({
  postgres: {
    version: "17.10",
    root: "postgresql-17.10",
    url: "https://ftp.postgresql.org/pub/source/v17.10/postgresql-17.10.tar.bz2",
    sha256: "078a03516dcdbdb705fecaf415ea3d13a956c589e46f09fed68a06fb00598c90",
  },
  pgvector: {
    version: "0.8.6",
    root: "pgvector-0.8.6",
    url: "https://codeload.github.com/pgvector/pgvector/tar.gz/refs/tags/v0.8.6",
    sha256: "10bf9938906e5d643bbc4a7eea104b6f57ba4898e5b76b20e60484ea1d5a7f8f",
  },
});
// PostgreSQL's own Windows build needs meson and a full MSVC dependency set.
// Windows uses the EDB binaries the PostgreSQL project links to instead, and
// builds only pgvector against them with MSVC.
export const WINDOWS_POSTGRES = Object.freeze({
  version: "17.10",
  root: "pgsql",
  url: "https://get.enterprisedb.com/postgresql/postgresql-17.10-1-windows-x64-binaries.zip",
  sha256: "f9aafca58e7026a1ef2caeee711acf761671e57904d430adc85f468374f5a821",
  // Only the server and its client tools; never pgAdmin or StackBuilder.
  keep: ["bin", "lib", "share", "include", "server_license.txt"],
});
// The EDB programs link the Visual C++ runtime but the zip leaves it out (the
// EDB installer installs it), so a Windows computer without it cannot start
// PostgreSQL. Ship it beside the programs, from the MSVC toolset that builds
// pgvector. Its redistribution terms allow this application-local copy.
export const WINDOWS_RUNTIME = Object.freeze([
  "msvcp140.dll",
  "vcruntime140.dll",
  "vcruntime140_1.dll",
]);
export async function windowsRuntimeFiles(redistDirectory) {
  if (!redistDirectory)
    throw new Error(
      "The Visual C++ runtime needs VCToolsRedistDir: run from an x64 Native Tools Command Prompt for Visual Studio.",
    );
  const crt = (await readdir(path.join(redistDirectory, "x64")))
    .filter((name) => /^Microsoft\.VC\d+\.CRT$/.test(name))
    .sort()
    .at(-1);
  if (!crt)
    throw new Error("The Visual C++ redistributable directory has no x64 CRT.");
  return WINDOWS_RUNTIME.map((name) =>
    path.join(redistDirectory, "x64", crt, name),
  );
}
export function assertTarget(
  target,
  host = `${process.platform}-${process.arch}`,
) {
  if (!["darwin-arm64", "linux-x64", "win32-x64"].includes(target))
    throw new Error(`Unsupported target: ${target}`);
  if (target !== host)
    throw new Error("Native PostgreSQL must be built on the target host");
  return target;
}
export function verifySource(content, expected) {
  if (createHash("sha256").update(content).digest("hex") !== expected)
    throw new Error("Source checksum mismatch");
}
export function assertArchiveEntries(entries, root) {
  for (const entry of entries) {
    if (
      !entry ||
      entry.startsWith("/") ||
      entry.includes("\\") ||
      entry.split("/").includes("..") ||
      (entry !== root && !entry.startsWith(`${root}/`))
    )
      throw new Error(`Unsafe source archive entry: ${entry}`);
  }
}
export function nativeLibraryChanges(listing, prefix, directory) {
  return listing
    .split("\n")
    .filter((line) => /^\s/.test(line))
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((dependency) => dependency.startsWith(`${prefix}/lib/`))
    .map((dependency) => [
      dependency,
      `@loader_path/${directory === "bin" ? "../lib/" : ""}${path.basename(dependency)}`,
    ]);
}
function run(command, args, cwd, env = {}, capture = false) {
  const result = spawnSync(command, args, {
    windowsHide: true,
    cwd,
    env: { ...process.env, ...env },
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed (${result.status})`);
  return result.stdout;
}
// Windows' bsdtar reads zips and "C:" paths; a GNU tar from Git does neither.
const tar = () =>
  process.platform === "win32"
    ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";
export async function createRuntimeArchive(prefix, archive) {
  // cp gives every file a new inode and dereferences library/timezone aliases.
  // tar -h alone still emits hardlink entries, which secure clients reject.
  const staging = await mkdtemp(path.join(path.dirname(archive), ".archive-"));
  try {
    await cp(prefix, staging, { recursive: true, dereference: true });
    run(tar(), ["-czf", archive, "-C", staging, "."], staging);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
async function download(source, work, name) {
  const archive = path.join(work, name);
  // curl inherits proxy/certificate configuration without a second downloader.
  run(
    "curl",
    [
      "--fail",
      "--location",
      "--silent",
      "--show-error",
      source.url,
      "--output",
      archive,
    ],
    work,
  );
  verifySource(await readFile(archive), source.sha256);
  assertArchiveEntries(
    run(tar(), ["-tf", archive], work, {}, true).trim().split(/\r?\n/),
    source.root,
  );
  return archive;
}
async function licenses(prefix, files) {
  await mkdir(path.join(prefix, "licenses"));
  for (const [from, to] of files)
    await cp(from, path.join(prefix, "licenses", to));
}
async function prepareWindows(work, prefix) {
  const archive = await download(
    WINDOWS_POSTGRES,
    work,
    path.basename(new URL(WINDOWS_POSTGRES.url).pathname),
  );
  run(
    tar(),
    [
      "-xf",
      archive,
      "-C",
      work,
      ...WINDOWS_POSTGRES.keep.map((name) => `pgsql/${name}`),
    ],
    work,
  );
  await rm(archive, { force: true });
  await cp(path.join(work, "pgsql"), prefix, { recursive: true });
  const vector = path.join(work, SOURCES.pgvector.root);
  run(
    tar(),
    [
      "-xf",
      await download(SOURCES.pgvector, work, "pgvector.tar.gz"),
      "-C",
      work,
    ],
    work,
  );
  // Run from an "x64 Native Tools Command Prompt" so cl and nmake are on PATH.
  if (spawnSync("cl", [], { windowsHide: true }).error)
    throw new Error(
      "pgvector for Windows needs MSVC: run from an x64 Native Tools Command Prompt for Visual Studio.",
    );
  run("nmake", ["/NOLOGO", "/F", "Makefile.win"], vector, { PGROOT: prefix });
  run("nmake", ["/NOLOGO", "/F", "Makefile.win", "install"], vector, {
    PGROOT: prefix,
  });
  for (const file of ["lib/vector.dll", "share/extension/vector.control"])
    if (!(await stat(path.join(prefix, file)).catch(() => undefined))?.isFile())
      throw new Error(`pgvector did not install ${file}`);
  for (const file of await windowsRuntimeFiles(process.env.VCToolsRedistDir))
    await cp(file, path.join(prefix, "bin", path.basename(file)));
  await rm(path.join(prefix, "include"), { recursive: true, force: true });
  await licenses(prefix, [
    [path.join(prefix, "server_license.txt"), "postgresql.txt"],
    [path.join(vector, "LICENSE"), "pgvector.txt"],
  ]);
  await rm(path.join(prefix, "server_license.txt"));
  await writeFile(
    path.join(prefix, "licenses/sources.json"),
    JSON.stringify(
      { postgres: WINDOWS_POSTGRES, pgvector: SOURCES.pgvector },
      null,
      2,
    ) + "\n",
  );
}
async function buildFromSource(work, prefix, target) {
  for (const source of Object.values(SOURCES))
    run(
      tar(),
      [
        "-xf",
        await download(
          source,
          work,
          path.basename(new URL(source.url).pathname) +
            (source === SOURCES.pgvector ? ".tar.gz" : ""),
        ),
        "-C",
        work,
      ],
      work,
    );
  const pg = path.join(work, SOURCES.postgres.root);
  const vector = path.join(work, SOURCES.pgvector.root);
  const env = {
    CFLAGS: "-O2",
    LDFLAGS: target.startsWith("linux")
      ? "-Wl,-rpath,\\$$ORIGIN/../lib"
      : "-Wl,-rpath,@loader_path/../lib",
  };
  run(
    "./configure",
    [
      `--prefix=${prefix}`,
      "--without-icu",
      "--without-readline",
      "--without-zlib",
      "--without-lz4",
      "--without-zstd",
    ],
    pg,
    env,
  );
  run("make", ["-j2"], pg);
  run("make", ["install"], pg);
  const pgConfig = `PG_CONFIG=${path.join(prefix, "bin/pg_config")}`;
  run("make", ["-j2", pgConfig, "OPTFLAGS="], vector);
  run("make", ["install", pgConfig], vector);
  await mkdir(path.join(prefix, "licenses"));
  await cp(
    path.join(pg, "COPYRIGHT"),
    path.join(prefix, "licenses/postgresql.txt"),
  );
  await cp(
    path.join(vector, "LICENSE"),
    path.join(prefix, "licenses/pgvector.txt"),
  );
  await writeFile(
    path.join(prefix, "licenses/sources.json"),
    JSON.stringify(SOURCES, null, 2) + "\n",
  );
  if (target.startsWith("darwin")) {
    // PostgreSQL's loader locates extension files relative to its executable.
    // libpq consumers additionally need a relocatable Mach-O dependency.
    for (const directory of ["bin", "lib"])
      for (const name of await readdir(path.join(prefix, directory))) {
        const file = path.join(prefix, directory, name);
        if (!(await stat(file)).isFile()) continue;
        const listing = spawnSync("otool", ["-L", file], {
          encoding: "utf8",
        });
        for (const [dependency, replacement] of nativeLibraryChanges(
          listing.stdout ?? "",
          prefix,
          directory,
        )) {
          run(
            "install_name_tool",
            ["-change", dependency, replacement, file],
            work,
          );
        }
      }
  }
}
export async function prepareNativePostgres({
  output,
  target = `${process.platform}-${process.arch}`,
  baseUrl,
}) {
  assertTarget(target);
  if (!baseUrl || !new URL(baseUrl).protocol.startsWith("http"))
    throw new Error("--base-url requires an HTTP(S) publication directory");
  output = path.resolve(output);
  await mkdir(output, { recursive: true });
  const work = await mkdtemp(path.join(output, ".build-"));
  const prefix = path.join(work, "prefix");
  try {
    if (target === "win32-x64") await prepareWindows(work, prefix);
    else await buildFromSource(work, prefix, target);
    for (const binary of ["postgres", "initdb", "pg_ctl", "createdb", "psql"])
      run(path.join(prefix, "bin", binary), ["--version"], work);
    const pending = path.join(work, "postgres.tar.gz");
    await createRuntimeArchive(prefix, pending);
    const content = await readFile(pending);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const file = `postgres-${SOURCES.postgres.version}-pgvector-${SOURCES.pgvector.version}-${target}-${sha256}.tar.gz`;
    await cp(pending, path.join(output, file));
    const metadata = {
      target,
      url: `${baseUrl.replace(/\/$/, "")}/${file}`,
      sha256,
      bytes: content.length,
      postgresVersion: SOURCES.postgres.version,
      pgvectorVersion: SOURCES.pgvector.version,
    };
    await writeFile(
      path.join(output, `postgres-${target}.json`),
      JSON.stringify(metadata, null, 2) + "\n",
    );
    return metadata;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  const options = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index];
    if (
      !["--output", "--target", "--base-url"].includes(name) ||
      !process.argv[index + 1]
    )
      throw new Error(
        "Usage: prepare-native-postgres.mjs --output PRIVATE_DIRECTORY --base-url PUBLICATION_DIRECTORY [--target HOST]",
      );
    options[name === "--base-url" ? "baseUrl" : name.slice(2)] =
      process.argv[index + 1];
  }
  if (!options.output) throw new Error("--output is required");
  console.log(JSON.stringify(await prepareNativePostgres(options)));
}
