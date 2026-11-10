import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";
import tar from "tar-stream";
import {
  stageComputerTools,
  validatedComputerToolAssets,
} from "./bundle-computer-tools.mjs";
import {
  MANAGED_TOOLS_RUNTIME_FILES,
  stageManagedToolsRuntime,
} from "../../../scripts/managed-tools-runtime-files.mjs";
import { NODE_RUNTIME_RELEASES } from "../../../scripts/local-computer-node-distributions.mjs";
import {
  ensurePinnedNodeRuntimeArchive,
  extractNodeRuntime,
} from "../../../scripts/prepare-local-computer-release.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "dist/bundle");
const manifest = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
const executable = process.platform === "win32" ? ".exe" : "";
const daemonName = `daemon/linger-computer-daemon${executable}`;
const cliName = `cli/linger-computer${executable}`;
await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, "cli"), { recursive: true });
await stageManagedToolsRuntime(path.join(output, "cli"));
await stageComputerTools(output);
await mkdir(path.join(output, "daemon"), { recursive: true });
for (const [name, command] of [
  [daemonName, "./cmd/linger-computer-daemon"],
  [cliName, "./cmd/linger-computer"],
]) {
  const compiled = spawnSync(
    "go",
    [
      "build",
      "-trimpath",
      "-ldflags",
      `-X github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport.ReleaseVersion=${manifest.version}`,
      "-o",
      path.join(output, name),
      command,
    ],
    {
      cwd: path.join(root, "local-daemon"),
      env: { ...process.env, CGO_ENABLED: "0" },
      stdio: "inherit",
    },
  );
  if (compiled.error) throw compiled.error;
  if (compiled.status !== 0) throw new Error(`Go build of ${name} failed`);
}
const teamhub = spawnSync(
  process.execPath,
  [
    fileURLToPath(
      new URL("../../teamhub-cli/scripts/build-cli.mjs", import.meta.url),
    ),
  ],
  { cwd: root, stdio: "inherit" },
);
if (teamhub.error) throw teamhub.error;
if (teamhub.status !== 0) throw new Error("TeamHub CLI build failed");
await import("./bundle-teamhub-cli.mjs");
{
  // Ship the pinned, checksum-verified Node runtime, never the build host's
  // binary: a package-manager Node links shared libraries the user lacks.
  const target = `${process.platform}-${process.arch}`;
  const release = NODE_RUNTIME_RELEASES[target];
  if (!release) throw new Error(`Missing pinned Node runtime for ${target}.`);
  await extractNodeRuntime(
    await ensurePinnedNodeRuntimeArchive(target),
    output,
    release.archive,
  );
}
const teamhubManifest = JSON.parse(
  await readFile(path.join(output, "cli/teamhub-assets.json"), "utf8"),
);
const entries = [
  cliName,
  ...MANAGED_TOOLS_RUNTIME_FILES.map((name) => `cli/${name}`),
  daemonName,
  "cli/teamhub",
  ...(process.platform === "win32"
    ? ["cli/teamhub.exe", "runtime/bin/node.exe"]
    : ["runtime/bin/node"]),
  "runtime/LICENSE",
  "cli/teamhub-assets.json",
  // The Daemon derives its TeamHub command allow rules from this manifest.
  "cli/teamhub-commands.json",
  ...teamhubManifest.assets.map(({ path: assetPath }) => `cli/${assetPath}`),
];
for (const name of entries)
  await chmod(
    path.join(output, name),
    name === "runtime/LICENSE" || name.startsWith("licenses/") ? 0o644 : 0o755,
  );
entries.push(
  ...(await validatedComputerToolAssets(
    output,
    `${process.platform}-${process.arch}`,
  )),
);

if (process.argv.includes("--archive")) {
  const archive = path.join(root, "dist/linger-computer.tar.gz");
  const pack = tar.pack();
  const writing = pipeline(pack, createGzip(), createWriteStream(archive));
  for (const name of entries) {
    const content = await readFile(path.join(output, name));
    pack.entry(
      {
        name,
        size: content.length,
        mode: (await stat(path.join(output, name))).mode & 0o777,
        mtime: new Date(0),
      },
      content,
    );
  }
  pack.finalize();
  await writing;
  const checksum = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  await writeFile(`${archive}.sha256`, `${checksum}  linger-computer.tar.gz\n`);
}
