import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const installerTemplate = [
  "#!/usr/bin/env bash",
  'web_origin="${LINGER_WEB_URL:-http://localhost:3000}"',
  'release_darwin_arm64=""',
  'release_darwin_x64=""',
  'release_linux_arm64=""',
  'release_linux_x64=""',
  'echo "$web_origin"',
  "",
].join("\n");

export const uninstallerTemplate = [
  "#!/usr/bin/env bash",
  'web_origin="${LINGER_WEB_URL:-http://localhost:3000}"',
  "echo uninstall",
  "",
].join("\n");

export const windowsInstallerTemplate =
  "$m = '__LINGER_RELEASE_METADATA_BASE64__'\nWrite-Host install\n";
export const windowsUninstallerTemplate =
  "$m = '__LINGER_RELEASE_METADATA_BASE64__'\nWrite-Host uninstall\n";

const sha256 = (content: Buffer) =>
  createHash("sha256").update(content).digest("hex");

type Archives = Record<string, { file: string; sha256: string; size: number }>;

/**
 * Writes a release directory with each target's archives; returns its parts,
 * with `target` and `archives` naming the first target.
 */
export async function writeComputerRelease(
  options: {
    readonly targets?: readonly string[];
    readonly template?: string;
  } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "computer-release-"));
  await mkdir(path.join(root, "files"));
  const targets: Record<string, Archives> = {};
  for (const target of options.targets ?? ["linux-x64"]) {
    const archives: Archives = {};
    for (const kind of ["app", "deps"]) {
      const content = Buffer.from(
        `${kind} archive for ${target}\n`.repeat(100),
      );
      const digest = sha256(content);
      const file = `${kind}-${target}-${digest}.tar.gz`;
      await writeFile(path.join(root, "files", file), content);
      archives[kind] = { file, sha256: digest, size: content.length };
    }
    targets[target] = archives;
  }
  const [target, archives] = Object.entries(targets)[0]!;
  const release = { version: "1.2.3", targets };
  await writeFile(path.join(root, "release.json"), JSON.stringify(release));
  await writeFile(
    path.join(root, "linger-computer.sh"),
    options.template ?? installerTemplate,
  );
  await writeFile(
    path.join(root, "uninstall-linger-computer.sh"),
    uninstallerTemplate,
  );
  await writeFile(
    path.join(root, "linger-computer.ps1"),
    windowsInstallerTemplate,
  );
  await writeFile(
    path.join(root, "uninstall-linger-computer.ps1"),
    windowsUninstallerTemplate,
  );
  return { root, target, archives, targets, release };
}
