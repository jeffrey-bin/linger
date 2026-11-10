// Compiles the TeamHub commands Native runs (teamhub, migrate, account) from
// the source package the app ships, for the targets in TEAMHUB_TARGETS, into
// dist/installer/native/teamhub-<target>/ with a manifest of their sha256
// and the source they came from. The desktop copies them into the unpacked
// source, so Native there needs no Go toolchain, module download or compile.
//
//   node scripts/build-teamhub.mjs --target win32-x64 --source linger-<label>.tar.gz
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";

import { DAEMON_TARGETS } from "./build-daemon.mjs";

const desktop = fileURLToPath(new URL("../", import.meta.url));

// Native then needs no Go toolchain, module download or compile: Windows
// has no compiler on most computers, and an offline install has no modules.
export const TEAMHUB_TARGETS = ["win32-x64", "linux-x64", "darwin-arm64"];
const COMMANDS = ["teamhub", "migrate", "account"];

export const teamhubDirectory = (target) =>
  path.join(desktop, "dist/installer/native", `teamhub-${target}`);

const sha256File = async (file) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};

// The commit `git archive` records in the package's first (pax) header.
export async function sourceCommit(archive) {
  const stream = createReadStream(archive).pipe(createGunzip());
  let head = Buffer.alloc(0);
  for await (const chunk of stream) {
    head = Buffer.concat([head, chunk]);
    if (head.length >= 1024) break;
  }
  stream.destroy();
  const commit =
    head[156] === "g".charCodeAt(0) &&
    /comment=([0-9a-f]{40})\n/.exec(head.subarray(512, 1024).toString())?.[1];
  if (!commit)
    throw new Error(`${archive} does not record its commit (git archive)`);
  return commit;
}

// Throws unless `directory` holds the commands its manifest lists, built for
// `target` from the package with `sourceArchiveSha256`.
export async function verifyTeamhub(directory, target, sourceArchiveSha256) {
  const manifest = JSON.parse(
    await readFile(path.join(directory, "manifest.json"), "utf8").catch(() => {
      throw new Error(`${directory} has no TeamHub binaries for ${target}`);
    }),
  );
  if (
    manifest.target !== target ||
    manifest.sourceArchiveSha256 !== sourceArchiveSha256
  )
    throw new Error(
      `${directory} holds TeamHub binaries for another target or source package`,
    );
  for (const command of COMMANDS) {
    const binary = manifest.binaries?.[command];
    const file = path.join(directory, binary?.file ?? command);
    const bytes = await stat(file).then(
      (info) => info.size,
      () => -1,
    );
    if (bytes !== binary?.bytes || (await sha256File(file)) !== binary.sha256)
      throw new Error(`${file} does not match ${directory}/manifest.json`);
  }
  return manifest;
}

export async function buildTeamhub(
  target,
  archive,
  output = teamhubDirectory(target),
) {
  const go = DAEMON_TARGETS[target];
  if (!go) throw new Error(`Unknown TeamHub target ${target}`);
  const sourceArchiveSha256 = await sha256File(archive);
  const commit = await sourceCommit(archive);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const work = await mkdtemp(path.join(tmpdir(), "linger-teamhub-"));
  try {
    // The package holds one folder, `<name>-<label>/`.
    const unpacked = spawnSync(
      "tar",
      ["-xzf", archive, "-C", work, "--strip-components=1"],
      { stdio: "inherit" },
    );
    if (unpacked.status !== 0) throw new Error(`Could not unpack ${archive}`);
    const teamhub = path.join(work, "apps/teamhub");
    const env = {
      ...process.env,
      CGO_ENABLED: "0",
      GOOS: go.goos,
      GOARCH: go.goarch,
      GOFLAGS: [process.env.GOFLAGS, "-buildvcs=false"]
        .filter(Boolean)
        .join(" "),
    };
    const version = spawnSync("go", ["env", "GOVERSION"], {
      cwd: teamhub,
      env,
      encoding: "utf8",
    });
    if (version.status !== 0) throw new Error("go env GOVERSION failed");
    const binaries = {};
    for (const command of COMMANDS) {
      const file = go.goos === "windows" ? `${command}.exe` : command;
      const compiled = spawnSync(
        "go",
        [
          "build",
          "-trimpath",
          "-ldflags",
          "-s -w",
          "-o",
          path.join(output, file),
          `./cmd/${command}`,
        ],
        { cwd: teamhub, env, stdio: "inherit" },
      );
      if (compiled.error) throw compiled.error;
      if (compiled.status !== 0)
        throw new Error(`Go build of ${command} for ${target} failed`);
      binaries[command] = {
        file,
        sha256: await sha256File(path.join(output, file)),
        bytes: (await stat(path.join(output, file))).size,
      };
    }
    await writeFile(
      path.join(output, "manifest.json"),
      JSON.stringify(
        {
          target,
          sourceCommit: commit,
          sourceArchiveSha256,
          goVersion: version.stdout.trim().replace(/^go/, ""),
          binaries,
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return verifyTeamhub(output, target, sourceArchiveSha256);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (name) => args[args.indexOf(name) + 1];
  if (!args.includes("--target") || !args.includes("--source"))
    throw new Error(
      "Usage: build-teamhub.mjs --target win32-x64 --source ARCHIVE",
    );
  console.log(
    JSON.stringify(
      await buildTeamhub(value("--target"), value("--source")),
      null,
      2,
    ),
  );
}
