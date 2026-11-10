#!/usr/bin/env node
// Builds the archive of what Native voice runs beside the services: the
// LiveKit server and ffmpeg/ffprobe for one target, with their licenses and
// where each came from (voice-tools.json). Every input is pinned by sha256.
//
//   node scripts/prepare-native-voice-tools.mjs --target T --output DIR
//
// Runs on Linux with GNU tar, curl and Docker, for every target:
// - LiveKit: the official release for Linux and Windows. LiveKit publishes no
//   macOS binary, so Apple silicon builds the same tag from source with the
//   pinned Go, as the release does (CGO off, ./cmd/server); Go's linker gives
//   it the ad-hoc signature arm64 macOS requires.
// - ffmpeg: Linux and Windows build FFmpeg from its release source in the
//   pinned Alpine image, static, LGPL (no GPL, no version3, no nonfree, no
//   external libraries). macOS uses the LGPL build of serversideup, whose
//   release is signed by the linker too; a Mac SDK cannot build on Linux.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const LIVEKIT = Object.freeze({
  version: "1.13.6",
  license: "Apache-2.0",
  releases: {
    "linux-x64": {
      url: "https://github.com/livekit/livekit/releases/download/v1.13.6/livekit_1.13.6_linux_amd64.tar.gz",
      sha256:
        "2b61abef2b9ba14b4b8ca38b37de9a37ffc682b9931d5fc03ceca2f0b77d3e33",
    },
    "win32-x64": {
      url: "https://github.com/livekit/livekit/releases/download/v1.13.6/livekit_1.13.6_windows_amd64.zip",
      sha256:
        "9df299b6c6c32f1be88d3d106a9a63f8f921b424b353cc59f57d6b84532a4475",
    },
  },
  source: {
    url: "https://codeload.github.com/livekit/livekit/tar.gz/refs/tags/v1.13.6",
    sha256: "7339d5b6f5bcc73579a516c7f18f803a708b9be7514b987a8445f2d06b4defd4",
    root: "livekit-1.13.6",
  },
  // The Go of the repository (package.json goVersion); LiveKit needs 1.26.
  go: "1.26.5",
});
// go-osstat reads macOS CPU counters only with cgo, which a cross-compiled
// build has not, and LiveKit refuses to start without them. The vendored copy
// gets this file, so LiveKit sees an idle CPU: it only uses the figure to
// spread rooms over servers, and Native runs one.
export const DARWIN_CPU_STUB = `//go:build darwin && !cgo

package cpu

import "time"

// Stats represents cpu statistics for darwin
type Stats struct {
\tUser, System, Idle, Nice, Total uint64
}

// Get reports an idle CPU: the counters need cgo (patched for Linger).
func Get() (*Stats, error) {
\tticks := uint64(time.Now().UnixNano() / int64(10*time.Millisecond))
\treturn &Stats{Idle: ticks, Total: ticks}, nil
}
`;
export const FFMPEG = Object.freeze({
  version: "8.1.2",
  license: "LGPL-2.1-or-later",
  source: {
    url: "https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz",
    sha256: "464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c",
    root: "ffmpeg-8.1.2",
  },
  // The image TeamHub's Dockerfile builds in.
  image:
    "alpine:3.22@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f",
  darwin: {
    url: "https://github.com/serversideup/ffmpeg-lgpl-builds/releases/download/v8.1.2-27/ffmpeg-8.1.2-aarch64-apple-darwin.tar.gz",
    sha256: "ac0babf65798bf681da1dc81c4fe4ae049d0d26e161410174b0e120e3e783332",
    license: "LGPL-2.1-only",
    // Kept beside COPYING: what it was built from, and its static OpenSSL.
    notices: ["SOURCE.txt", "FFMPEG-LICENSE.md", "OPENSSL-LICENSE"],
  },
});
// Every native component, nothing from outside FFmpeg: the build never
// becomes GPL and needs no library at runtime.
export const FFMPEG_CONFIGURE = Object.freeze([
  "--disable-gpl",
  "--disable-nonfree",
  "--disable-version3",
  "--disable-autodetect",
  "--disable-network",
  "--disable-debug",
  "--disable-doc",
  "--disable-ffplay",
  "--enable-static",
  "--disable-shared",
  "--extra-ldflags=-static",
  "--pkg-config-flags=--static",
]);
// What the voice workers (capture-recorder.ts) and TeamHub (voicemedia)
// ask ffmpeg for; the build fails without one of them.
export const FFMPEG_NEEDS = Object.freeze({
  encoders: ["aac", "pcm_s16le"],
  decoders: ["aac", "mp3", "opus", "pcm_s16le", "vorbis", "flac"],
  muxers: ["hls", "mpegts", "mp4", "s16le"],
  demuxers: ["s16le", "mpegts", "mov", "hls", "wav", "ogg", "matroska"],
  bsfs: ["noise", "setts", "aac_adtstoasc"],
});
export const targets = ["darwin-arm64", "linux-x64", "win32-x64"];

export function assertTarget(target) {
  if (!targets.includes(target))
    throw new Error(`Unsupported target: ${target}`);
  return target;
}
export function verifySource(content, expected) {
  if (createHash("sha256").update(content).digest("hex") !== expected)
    throw new Error("Source checksum mismatch");
}
/**
 * The names `ffmpeg -<kind>` lists: after the "---" under the legend, flags
 * then names (" A....D aac", " DE matroska,webm"); bsfs list one name per
 * line under their title.
 */
export function listedComponents(listing) {
  const lines = listing.split("\n");
  const separator = lines.findIndex((line) => /^\s*-+\s*$/.test(line));
  const names = new Set();
  for (const line of lines.slice(separator + 1 || 1)) {
    const fields = line.trim().split(/\s+/);
    const name = separator >= 0 ? fields[1] : fields[0];
    if (name) for (const item of name.split(",")) names.add(item);
  }
  return names;
}
export function missingComponents(listings) {
  const missing = [];
  for (const [kind, needed] of Object.entries(FFMPEG_NEEDS)) {
    const names = listedComponents(listings[kind] ?? "");
    for (const name of needed)
      if (!names.has(name)) missing.push(`${kind}:${name}`);
  }
  return missing;
}
/** Whether a 64-bit Mach-O file carries a code signature (LC_CODE_SIGNATURE). */
export function machoSigned(content) {
  if (content.readUInt32LE(0) !== 0xfeedfacf) return false;
  const count = content.readUInt32LE(16);
  let offset = 32;
  for (let index = 0; index < count; index++) {
    if (content.readUInt32LE(offset) === 0x1d) return true;
    offset += content.readUInt32LE(offset + 4);
  }
  return false;
}
/** The DLLs a 64-bit Windows program imports (its PE import directory). */
export function peImports(content) {
  const header = content.readUInt32LE(0x3c);
  if (content.readUInt32LE(header) !== 0x4550) throw new Error("Not a PE file");
  const sections = content.readUInt16LE(header + 6);
  const optional = header + 24;
  if (content.readUInt16LE(optional) !== 0x20b)
    throw new Error("Not a 64-bit PE file");
  const table = optional + content.readUInt16LE(header + 20);
  const offset = (rva) => {
    for (let index = 0; index < sections; index++) {
      const section = table + index * 40;
      const address = content.readUInt32LE(section + 12);
      const size = content.readUInt32LE(section + 16);
      if (rva >= address && rva < address + size)
        return content.readUInt32LE(section + 20) + rva - address;
    }
    throw new Error("PE address outside its sections");
  };
  const directory = content.readUInt32LE(optional + 112 + 8);
  const names = [];
  if (!directory) return names;
  for (let entry = offset(directory); ; entry += 20) {
    const name = content.readUInt32LE(entry + 12);
    if (!name) return names;
    const start = offset(name);
    names.push(content.toString("latin1", start, content.indexOf(0, start)));
  }
}
function run(command, args, cwd, env = {}, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed (${result.status})`);
  return result.stdout;
}
async function download(source, work, name) {
  const file = path.join(work, name);
  run(
    "curl",
    [
      "--fail",
      "--location",
      "--retry",
      "5",
      "--retry-all-errors",
      "--silent",
      "--show-error",
      source.url,
      "--output",
      file,
    ],
    work,
  );
  verifySource(await readFile(file), source.sha256);
  return file;
}
// The LiveKit and FFmpeg sources build in containers that see only `work`.
function docker(work, image, script, env = {}) {
  run(
    "docker",
    [
      "run",
      "--rm",
      "--network=host",
      "--user=0",
      ...Object.entries(env).flatMap(([key, value]) => [
        "-e",
        `${key}=${value}`,
      ]),
      "-v",
      `${work}:/work`,
      "-w",
      "/work",
      image,
      "sh",
      "-euc",
      script,
    ],
    work,
  );
}
async function livekit(target, work, bin, licenses) {
  const exe = target === "win32-x64" ? ".exe" : "";
  if (target === "darwin-arm64") {
    const archive = await download(LIVEKIT.source, work, "livekit-src.tar.gz");
    run("tar", ["-xzf", archive, "-C", work], work);
    const source = path.join(work, LIVEKIT.source.root);
    // GOTOOLCHAIN fetches the pinned Go, and `go mod vendor` the modules,
    // both checked against Go's checksum database.
    const go = {
      GOTOOLCHAIN: `go${LIVEKIT.go}`,
      CGO_ENABLED: "0",
      GOOS: "darwin",
      GOARCH: "arm64",
    };
    run("go", ["mod", "vendor"], source, { ...go, GOFLAGS: "-mod=readonly" });
    const stub = path.join(
      source,
      "vendor/github.com/mackerelio/go-osstat/cpu/cpu_darwin_nocgo.go",
    );
    if (!(await readFile(stub, "utf8")).includes("unavailable without cgo"))
      throw new Error("go-osstat changed; review the macOS CPU stub.");
    await writeFile(stub, DARWIN_CPU_STUB);
    run(
      "go",
      [
        "build",
        "-p",
        "4",
        "-trimpath",
        "-ldflags=-s -w",
        "-o",
        path.join(bin, "livekit-server"),
        "./cmd/server",
      ],
      source,
      { ...go, GOFLAGS: "-mod=vendor" },
    );
    await cp(
      path.join(source, "LICENSE"),
      path.join(licenses, "livekit-LICENSE.txt"),
    );
    await cp(
      path.join(source, "NOTICE"),
      path.join(licenses, "livekit-NOTICE.txt"),
    );
    return {
      ...LIVEKIT.source,
      built: `go${LIVEKIT.go} build -trimpath -ldflags="-s -w" ./cmd/server (CGO_ENABLED=0 GOOS=darwin GOARCH=arm64; vendored go-osstat cpu_darwin_nocgo.go reports an idle CPU)`,
    };
  }
  const release = LIVEKIT.releases[target];
  const unpacked = path.join(work, "livekit");
  await mkdir(unpacked);
  if (exe) {
    const archive = await download(release, work, "livekit.zip");
    run("python3", ["-m", "zipfile", "-e", archive, unpacked], work);
  } else {
    const archive = await download(release, work, "livekit.tar.gz");
    run("tar", ["-xzf", archive, "-C", unpacked], work);
  }
  await cp(
    path.join(unpacked, `livekit-server${exe}`),
    path.join(bin, `livekit-server${exe}`),
  );
  await cp(
    path.join(unpacked, "LICENSE"),
    path.join(licenses, "livekit-LICENSE.txt"),
  );
  return { url: release.url, sha256: release.sha256 };
}
async function ffmpeg(target, work, bin, licenses) {
  if (target === "darwin-arm64") {
    const archive = await download(FFMPEG.darwin, work, "ffmpeg-darwin.tar.gz");
    const unpacked = path.join(work, "ffmpeg-darwin");
    await mkdir(unpacked);
    run("tar", ["-xzf", archive, "-C", unpacked], work);
    for (const name of ["ffmpeg", "ffprobe"])
      await cp(path.join(unpacked, name), path.join(bin, name));
    await cp(
      path.join(unpacked, "COPYING.LGPLv2.1"),
      path.join(licenses, "ffmpeg-COPYING.LGPLv2.1.txt"),
    );
    for (const name of FFMPEG.darwin.notices)
      await cp(
        path.join(unpacked, name),
        path.join(licenses, `ffmpeg-${name}`),
      );
    return {
      license: FFMPEG.darwin.license,
      url: FFMPEG.darwin.url,
      sha256: FFMPEG.darwin.sha256,
      source: FFMPEG.source,
    };
  }
  await download(FFMPEG.source, work, "ffmpeg.tar.xz");
  const windows = target === "win32-x64";
  const configure = [
    ...FFMPEG_CONFIGURE,
    ...(windows
      ? [
          "--target-os=mingw32",
          "--arch=x86_64",
          "--enable-cross-compile",
          "--cross-prefix=x86_64-w64-mingw32-",
        ]
      : []),
  ];
  const jobs = String(
    Math.min(8, (await import("node:os")).availableParallelism()),
  );
  docker(
    work,
    FFMPEG.image,
    [
      `apk add --no-cache build-base nasm xz ${windows ? "mingw-w64-gcc" : ""}`,
      `tar -xJf ffmpeg.tar.xz`,
      `cd ${FFMPEG.source.root}`,
      `./configure --prefix=/work/ffmpeg ${configure.map((arg) => `'${arg}'`).join(" ")}`,
      `make -j${jobs}`,
      "make install",
      `cp COPYING.LGPLv2.1 LICENSE.md /work/ffmpeg/`,
      `chown -R ${process.getuid()}:${process.getgid()} /work`,
    ].join("\n"),
  );
  const exe = windows ? ".exe" : "";
  for (const name of ["ffmpeg", "ffprobe"])
    await cp(
      path.join(work, "ffmpeg/bin", `${name}${exe}`),
      path.join(bin, `${name}${exe}`),
    );
  await cp(
    path.join(work, "ffmpeg/COPYING.LGPLv2.1"),
    path.join(licenses, "ffmpeg-COPYING.LGPLv2.1.txt"),
  );
  await cp(
    path.join(work, "ffmpeg/LICENSE.md"),
    path.join(licenses, "ffmpeg-LICENSE.md"),
  );
  return {
    license: FFMPEG.license,
    source: FFMPEG.source,
    built: `${FFMPEG.image}: ./configure ${configure.join(" ")}`,
  };
}
async function checkTools(target, prefix) {
  const bin = path.join(prefix, "bin");
  if (target === "linux-x64") {
    const version = run(
      path.join(bin, "livekit-server"),
      ["--version"],
      prefix,
      {},
      true,
    );
    if (version.trim() !== `livekit-server version ${LIVEKIT.version}`)
      throw new Error(`Unexpected LiveKit: ${version.trim()}`);
    const listings = {};
    for (const kind of Object.keys(FFMPEG_NEEDS))
      listings[kind] = run(
        path.join(bin, "ffmpeg"),
        ["-hide_banner", `-${kind}`],
        prefix,
        {},
        true,
      );
    const missing = missingComponents(listings);
    if (missing.length) throw new Error(`ffmpeg lacks ${missing.join(", ")}`);
    for (const name of ["ffmpeg", "ffprobe"]) {
      const first = run(
        path.join(bin, name),
        ["-version"],
        prefix,
        {},
        true,
      ).split("\n")[0];
      if (!first.startsWith(`${name} version ${FFMPEG.version} `))
        throw new Error(`Unexpected ${name}: ${first}`);
      // Static: no interpreter, so it runs on any Linux x64.
      if ((await readFile(path.join(bin, name))).includes("ld-linux"))
        throw new Error(`${name} is not static`);
    }
  }
  if (target === "darwin-arm64")
    for (const name of ["livekit-server", "ffmpeg", "ffprobe"])
      if (!machoSigned(await readFile(path.join(bin, name))))
        throw new Error(
          `${name} has no signature; arm64 macOS refuses to run it`,
        );
  if (target === "win32-x64")
    for (const name of ["livekit-server", "ffmpeg", "ffprobe"]) {
      const content = await readFile(path.join(bin, `${name}.exe`));
      if (content.subarray(0, 2).toString() !== "MZ")
        throw new Error(`${name}.exe is not a Windows program`);
      // Static: it imports only Windows' own DLLs, no MinGW runtime.
      const runtime = peImports(content).filter((dll) => /^lib/i.test(dll));
      if (runtime.length)
        throw new Error(`${name}.exe needs ${runtime.join(", ")}`);
    }
}
// Same bytes for the same inputs: sorted names, no owners, times or gzip name.
function archive(prefix, file) {
  run(
    "sh",
    [
      "-c",
      'tar --sort=name --owner=0 --group=0 --numeric-owner --mtime=@0 --format=gnu -cf - -C "$1" . | gzip -9n > "$2"',
      "sh",
      prefix,
      file,
    ],
    prefix,
  );
}
export async function prepareNativeVoiceTools({ target, output }) {
  assertTarget(target);
  if (process.platform !== "linux")
    throw new Error(
      "Prepare the Native voice tools on Linux (GNU tar, Docker)",
    );
  output = path.resolve(output);
  await mkdir(output, { recursive: true });
  const work = await mkdtemp(path.join(output, ".build-"));
  const prefix = path.join(work, "prefix");
  const bin = path.join(prefix, "bin");
  const licenses = path.join(prefix, "licenses");
  try {
    await mkdir(bin, { recursive: true });
    await mkdir(licenses);
    const livekitOrigin = await livekit(target, work, bin, licenses);
    const ffmpegOrigin = await ffmpeg(target, work, bin, licenses);
    for (const name of await readdir(bin))
      await chmod(path.join(bin, name), 0o755);
    await checkTools(target, prefix);
    await writeFile(
      path.join(prefix, "voice-tools.json"),
      JSON.stringify(
        {
          target,
          livekit: {
            version: LIVEKIT.version,
            license: LIVEKIT.license,
            ...livekitOrigin,
          },
          ffmpeg: { version: FFMPEG.version, ...ffmpegOrigin },
        },
        null,
        2,
      ) + "\n",
    );
    const pending = path.join(work, "voice-tools.tar.gz");
    archive(prefix, pending);
    const content = await readFile(pending);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const file = `voice-tools-livekit-${LIVEKIT.version}-ffmpeg-${FFMPEG.version}-${target}-${sha256}.tar.gz`;
    await cp(pending, path.join(output, file));
    const metadata = {
      target,
      file: `native/${file}`,
      sha256,
      bytes: content.length,
      livekitVersion: LIVEKIT.version,
      ffmpegVersion: FFMPEG.version,
    };
    await writeFile(
      path.join(output, `voice-tools-${target}.json`),
      JSON.stringify(metadata, null, 2) + "\n",
    );
    await rm(work, { recursive: true, force: true });
    return metadata;
  } catch (error) {
    console.error(`Kept the build in ${work} for inspection.`);
    throw error;
  }
}
if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  const options = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index];
    if (!["--output", "--target"].includes(name) || !process.argv[index + 1])
      throw new Error(
        "Usage: prepare-native-voice-tools.mjs --target darwin-arm64|linux-x64|win32-x64 --output DIRECTORY",
      );
    options[name.slice(2)] = process.argv[index + 1];
  }
  if (!options.output || !options.target)
    throw new Error("--target and --output are required");
  console.log(JSON.stringify(await prepareNativeVoiceTools(options)));
}
