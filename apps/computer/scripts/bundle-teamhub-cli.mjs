import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = new URL("../dist/bundle/cli/", import.meta.url);
await mkdir(cli, { recursive: true });
const source = new URL("../../teamhub-cli/dist/", import.meta.url);
const manifestContent = await readFile(new URL("teamhub-assets.json", source));
const manifest = JSON.parse(manifestContent.toString("utf8"));
if (
  manifest.schema_version !== 1 ||
  manifest.entrypoint !== "teamhub.js" ||
  !Array.isArray(manifest.assets) ||
  !manifest.assets.every(
    (asset) =>
      asset &&
      typeof asset.path === "string" &&
      /^(?:teamhub\.js|teamhub-chunks\/[A-Za-z0-9_-]+\.js)$/u.test(
        asset.path,
      ) &&
      Number.isSafeInteger(asset.size_bytes) &&
      asset.size_bytes >= 0 &&
      typeof asset.sha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(asset.sha256),
  ) ||
  !manifest.assets.some((asset) => asset.path === "teamhub.js") ||
  new Set(manifest.assets.map((asset) => asset.path)).size !==
    manifest.assets.length ||
  createHash("sha256").update(JSON.stringify(manifest.assets)).digest("hex") !==
    manifest.artifact_sha256
)
  throw new Error("CLI asset manifest is invalid.");
const files = await Promise.all(
  manifest.assets.map(async (asset) => {
    const content = await readFile(new URL(asset.path, source));
    if (
      content.length !== asset.size_bytes ||
      createHash("sha256").update(content).digest("hex") !== asset.sha256
    )
      throw new Error(`CLI asset does not match its manifest: ${asset.path}`);
    return { path: asset.path, content };
  }),
);
await rm(new URL("teamhub-chunks/", cli), { recursive: true, force: true });
for (const file of files) {
  if (file.path.startsWith("teamhub-chunks/"))
    await mkdir(new URL("teamhub-chunks/", cli), { recursive: true });
  await writeFile(new URL(file.path, cli), file.content);
}
await writeFile(new URL("teamhub-assets.json", cli), manifestContent);
// Host-only command metadata beside the CLI (not a CLI asset). The Daemon
// derives Runtime permission rules for TeamHub commands from it.
const commandsContent = await readFile(
  new URL("teamhub-commands.json", source),
);
const commands = JSON.parse(commandsContent.toString("utf8"));
if (
  commands.schema_version !== 2 ||
  !Array.isArray(commands.commands) ||
  !commands.commands.every(
    (entry) =>
      entry &&
      Array.isArray(entry.command) &&
      entry.command.length > 0 &&
      entry.command.every(
        (part) =>
          typeof part === "string" && /^[a-z0-9][a-z0-9-]*$/u.test(part),
      ) &&
      ["allow", "confirm", "judge"].includes(entry.approval),
  )
)
  throw new Error("CLI command manifest is invalid.");
await writeFile(new URL("teamhub-commands.json", cli), commandsContent);
// Run the CLI with the Node runtime bundled beside it, as release builds do;
// the Runtime's PATH need not contain node.
await writeFile(
  new URL("teamhub", cli),
  '#!/bin/sh\ncli_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$cli_dir/../runtime/bin/node" --use-env-proxy "$cli_dir/teamhub.js" "$@"\n',
  { mode: 0o755 },
);
await chmod(new URL("teamhub", cli), 0o755);

if (process.platform === "win32") {
  const result = spawnSync(
    "go",
    [
      "build",
      "-trimpath",
      "-o",
      fileURLToPath(new URL("teamhub.exe", cli)),
      "./cmd/linger-computer-launcher",
    ],
    {
      cwd: fileURLToPath(new URL("../local-daemon/", import.meta.url)),
      env: { ...process.env, CGO_ENABLED: "0" },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Native CLI launcher build failed");
}
