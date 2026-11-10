// Bundles main (ESM) and the sandboxed preloads (CJS) into dist/, and builds
// the Go daemon that runs agents. Workspace packages are bundled from source.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { build } from "esbuild";

import { buildDaemon } from "./scripts/build-daemon.mjs";
import { buildTeamhub, TEAMHUB_TARGETS } from "./scripts/build-teamhub.mjs";
import {
  buildRuntime,
  RUNTIME_TARGETS,
} from "./scripts/build-native-runtime.mjs";

const { version } = JSON.parse(await readFile("package.json", "utf8"));
// The platforms this build is for: this machine unless
// LINGER_DESKTOP_DAEMON_TARGETS lists targets, comma-separated (packaging
// builds the one it ships).
const daemonTargets = process.env.LINGER_DESKTOP_DAEMON_TARGETS?.split(
  ",",
).filter(Boolean) ?? [`${process.platform}-${process.arch}`];
// The linger source package that "Run on this computer" installs. Release
// builds pin it, either bundled in the app (LINGER_SOURCE_ARCHIVE_FILE) or
// downloaded; without it the desktop offers only an existing checkout.
const bundledSource = process.env.LINGER_SOURCE_ARCHIVE_FILE;
// Other hosts serving the same file, separated by spaces; the desktop tries
// them in order when the first one fails or stalls.
function mirrors(name, value) {
  const urls = value?.split(/\s+/).filter(Boolean) ?? [];
  for (const url of urls)
    if (!url.startsWith("https://"))
      throw new Error(`${name} must list https URLs: ${url}`);
  return urls.length ? { mirrors: urls } : {};
}
const sourceArchive = await (async () => {
  if (bundledSource) {
    const sha256 = createHash("sha256")
      .update(await readFile(bundledSource))
      .digest("hex");
    return { file: path.join("source", path.basename(bundledSource)), sha256 };
  }
  const url = process.env.LINGER_SOURCE_ARCHIVE_URL;
  const sha256 = process.env.LINGER_SOURCE_ARCHIVE_SHA256;
  if (!url && !sha256) return null;
  if (!url?.startsWith("https://") || !/^[0-9a-f]{64}$/.test(sha256 ?? ""))
    throw new Error(
      "LINGER_SOURCE_ARCHIVE_URL must be https and LINGER_SOURCE_ARCHIVE_SHA256 a sha256 hex digest",
    );
  return {
    url,
    ...mirrors(
      "LINGER_SOURCE_ARCHIVE_MIRRORS",
      process.env.LINGER_SOURCE_ARCHIVE_MIRRORS,
    ),
    sha256,
  };
})();
// The dependency store published beside a downloaded source package for
// this build's platform (scripts/prepare-source-dependencies.mjs). Without it
// the installer fetches the packages from a registry.
const sourceDependencies = (() => {
  const url = process.env.LINGER_SOURCE_DEPENDENCIES_URL;
  const sha256 = process.env.LINGER_SOURCE_DEPENDENCIES_SHA256;
  if (!url && !sha256) return null;
  if (!url?.startsWith("https://") || !/^[0-9a-f]{64}$/.test(sha256 ?? ""))
    throw new Error(
      "LINGER_SOURCE_DEPENDENCIES_URL must be https and LINGER_SOURCE_DEPENDENCIES_SHA256 a sha256 hex digest",
    );
  return {
    url,
    ...mirrors(
      "LINGER_SOURCE_DEPENDENCIES_MIRRORS",
      process.env.LINGER_SOURCE_DEPENDENCIES_MIRRORS,
    ),
    sha256,
  };
})();
const common = {
  bundle: true,
  platform: "node",
  target: "node24",
  sourcemap: true,
  external: ["electron"],
  define: {
    __DESKTOP_VERSION__: JSON.stringify(version),
    __SOURCE_ARCHIVE__: JSON.stringify(sourceArchive),
    __SOURCE_DEPENDENCIES__: JSON.stringify(sourceDependencies),
  },
  logLevel: "warning",
};
// Some bundled dependencies still call require().
const requireShim = {
  js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
};

await Promise.all([
  build({
    ...common,
    entryPoints: ["src/main/index.ts"],
    outfile: "dist/main/index.mjs",
    format: "esm",
    banner: requireShim,
    loader: { ".html": "text", ".png": "binary", ".woff2": "binary" },
  }),
  build({
    ...common,
    entryPoints: ["src/preload/index.ts"],
    outfile: "dist/preload/index.cjs",
    format: "cjs",
  }),
  build({
    ...common,
    entryPoints: ["src/preload/shell.ts"],
    outfile: "dist/preload/shell.cjs",
    format: "cjs",
  }),
  build({
    ...common,
    entryPoints: ["src/preload/setup.ts"],
    outfile: "dist/preload/setup.cjs",
    format: "cjs",
  }),
]);

const run = (script, args, failure) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(failure)),
    );
  });

// The local installer that "Run on this computer" opens. It runs under a
// pinned Node 26 that the desktop downloads, not the app's own Node.
await run(
  "../linger-installer/scripts/build.mjs",
  [],
  "installer build failed",
);
await rm("dist/installer", { recursive: true, force: true });
await cp("../linger-installer/dist", "dist/installer", { recursive: true });
if (bundledSource) {
  await mkdir("dist/installer/source");
  await cp(bundledSource, path.join("dist/installer", sourceArchive.file));
}
// The publisher's pinned localmodels tool, native PostgreSQL sources and
// voice tools (LiveKit and ffmpeg) for this target, as distribution.json; the
// installer reads it beside itself. Native installs need it. The build takes the
// tracked distribution/<target>.json of the one target that has it (macOS
// builds darwin-x64 too, which has none) unless LINGER_DESKTOP_DISTRIBUTION
// names another file.
const tracked = daemonTargets
  .map((target) => path.join("distribution", `${target}.json`))
  .filter((file) => existsSync(file));
const distribution =
  process.env.LINGER_DESKTOP_DISTRIBUTION ||
  (tracked.length === 1 ? tracked[0] : undefined);
if (distribution) {
  const value = JSON.parse(await readFile(distribution, "utf8"));
  if (
    typeof value.platform !== "string" ||
    typeof value.arch !== "string" ||
    !value.localmodelsTool ||
    !Array.isArray(value.nativeSources)
  )
    throw new Error(
      `${distribution} needs platform, arch, localmodelsTool and nativeSources`,
    );
  // The installer refuses a distribution for another computer.
  if (!daemonTargets.includes(`${value.platform}-${value.arch}`))
    throw new Error(
      `${distribution} is for ${value.platform}-${value.arch}, not ${daemonTargets.join(", ")}`,
    );
  const voiceTools = value.voiceTools ?? [];
  if (!Array.isArray(voiceTools))
    throw new Error(`${distribution}: voiceTools must be a list`);
  // A source with a `file` ships in the app (PostgreSQL and the voice tools)
  // from LINGER_NATIVE_POSTGRES_DIR, by default the packaging cache; the
  // build checks it against the pin.
  for (const source of [...value.nativeSources, ...voiceTools]) {
    if (source.file === undefined) continue;
    if (
      typeof source.file !== "string" ||
      !/^native\/[\w.-]+\.tar\.gz$/.test(source.file)
    )
      throw new Error(
        `${distribution}: bundled file must be native/<name>.tar.gz`,
      );
    const from = path.join(
      process.env.LINGER_NATIVE_POSTGRES_DIR ||
        path.join(homedir(), ".cache", "linger-desktop"),
      path.basename(source.file),
    );
    const bytes = await readFile(from).catch(() => {
      throw new Error(
        `${distribution} bundles ${path.basename(source.file)}; put it in LINGER_NATIVE_POSTGRES_DIR (see AGENTS.md)`,
      );
    });
    if (
      bytes.length !== source.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== source.sha256
    )
      throw new Error(`${from} does not match ${distribution}`);
    await mkdir(path.join("dist/installer", path.dirname(source.file)), {
      recursive: true,
    });
    await cp(from, path.join("dist/installer", source.file));
  }
  await writeFile(
    "dist/installer/distribution.json",
    JSON.stringify({
      platform: value.platform,
      arch: value.arch,
      localmodelsTool: value.localmodelsTool,
      nativeSources: value.nativeSources,
      voiceTools,
    }),
  );
}

// TeamHub compiled from the source package for targets that should not
// compile it themselves (Windows); the desktop hands the binaries to Native.
const teamhubTargets = daemonTargets.filter((target) =>
  TEAMHUB_TARGETS.includes(target),
);
// The services Native runs, built from the same package, with the Node.js
// that runs them, so installing Native there needs no network.
const runtimeTargets = daemonTargets.filter((target) =>
  RUNTIME_TARGETS.includes(target),
);
if (sourceArchive && (teamhubTargets.length || runtimeTargets.length)) {
  let archive = bundledSource;
  const work = archive
    ? undefined
    : await mkdtemp(path.join(tmpdir(), "linger-source-"));
  try {
    if (!archive) {
      archive = path.join(work, "source.tar.gz");
      const response = await fetch(sourceArchive.url);
      if (!response.ok)
        throw new Error(`${sourceArchive.url}: HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (
        createHash("sha256").update(bytes).digest("hex") !==
        sourceArchive.sha256
      )
        throw new Error(
          `${sourceArchive.url} does not match LINGER_SOURCE_ARCHIVE_SHA256`,
        );
      await writeFile(archive, bytes);
    }
    for (const target of teamhubTargets) {
      const manifest = await buildTeamhub(target, archive);
      console.log(
        `TeamHub binaries for ${target} from ${manifest.sourceCommit.slice(0, 12)}`,
      );
    }
    for (const target of runtimeTargets) {
      const manifest = await buildRuntime(target, archive);
      console.log(
        `Native runtime for ${target} from ${manifest.sourceCommit.slice(0, 12)}: ${manifest.layout === "directory" ? "a folder" : `${manifest.archive.bytes} bytes`}`,
      );
    }
  } finally {
    if (work) await rm(work, { recursive: true, force: true });
  }
}

// The teamhub CLI that runtimes use to reply, built from the same checkout as
// the server so their API versions match (as the Go daemon bundles it). The
// launcher runs it with the app's own Node, so the computer needs no Node.
await run(
  "../teamhub-cli/scripts/build-cli.mjs",
  ["--outdir", "dist/teamhub-cli"],
  "teamhub CLI build failed",
);
await writeFile(
  "dist/teamhub-cli/teamhub",
  `#!/bin/sh
# Runs the bundled teamhub CLI with the Node built into Linger.
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
app="$dir/../../../../MacOS/Linger"
[ -x "$app" ] || app="$dir/../../../../Linger.exe"
[ -x "$app" ] || app="$dir/../../../../linger"
[ -x "$app" ] || app="\${LINGER_NODE:-node}"
ELECTRON_RUN_AS_NODE=1 exec "$app" --use-env-proxy "$dir/teamhub.js" "$@"
`,
  { mode: 0o755 },
);
// The same for cmd and PowerShell on Windows, which run `teamhub.cmd`; Git
// Bash takes the script above.
await writeFile(
  "dist/teamhub-cli/teamhub.cmd",
  `@echo off\r
setlocal\r
set "app=%~dp0..\\..\\..\\..\\Linger.exe"\r
if not exist "%app%" set "app=node"\r
set ELECTRON_RUN_AS_NODE=1\r
"%app%" --use-env-proxy "%~dp0teamhub.js" %*\r
`,
);

// The Go Local Computer daemon (dist/computer/<platform>-<arch>/) for each
// target.
await buildDaemon(daemonTargets);
