import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { isNodeError } from "@linger/service-kit";
import type { ComputerTargetRelease } from "@linger/wire-contracts/runner-gateway/types";

/** The Computer release targets this image can ship. */
export const COMPUTER_RELEASE_TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
] as const;
export type ComputerReleaseTarget = (typeof COMPUTER_RELEASE_TARGETS)[number];
/** Windows installs and upgrades through its PowerShell installer. */
export const isWindowsTarget = (target: string): boolean =>
  target.startsWith("win32-");

export interface ComputerReleaseArchive {
  readonly file: string;
  readonly sha256: string;
  readonly size: number;
}

/** The Computer release built into this image, read from `release.json`. */
export interface ComputerRelease {
  /** Directory holding `release.json`, the installer scripts and `files/`. */
  readonly root: string;
  readonly version: string;
  readonly targets: Readonly<
    Partial<
      Record<
        ComputerReleaseTarget,
        {
          readonly app: ComputerReleaseArchive;
          readonly deps: ComputerReleaseArchive;
        }
      >
    >
  >;
  /** Raw `installer/linger-computer.sh` template; every app archive has the same one. */
  readonly installerTemplate: string;
  readonly uninstallerTemplate: string;
  /** PowerShell templates whose release metadata marker is still unrendered. */
  readonly windowsInstallerTemplate: string;
  readonly windowsUninstallerTemplate: string;
}

/**
 * Loads the release once at startup. A missing `release.json` means this
 * process ships no Computer release. `release.json` comes from this image's
 * own build, so it is trusted; a listed archive missing from `files/` means
 * the image was built incorrectly and fails startup.
 */
export async function loadComputerRelease(
  root: string,
): Promise<ComputerRelease | undefined> {
  let source: string;
  try {
    source = await readFile(path.join(root, "release.json"), "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  const { version, targets } = JSON.parse(source) as Pick<
    ComputerRelease,
    "version" | "targets"
  >;
  for (const { app, deps } of Object.values(targets)) {
    for (const { file } of [app, deps]) {
      await access(path.join(root, "files", file)).catch(() => {
        throw new Error(
          `Computer release ${root} lists ${file}, which is missing from files/.`,
        );
      });
    }
  }
  return {
    root,
    version,
    targets,
    installerTemplate: await readFile(
      path.join(root, "linger-computer.sh"),
      "utf8",
    ),
    uninstallerTemplate: await readFile(
      path.join(root, "uninstall-linger-computer.sh"),
      "utf8",
    ),
    windowsInstallerTemplate: await readFile(
      path.join(root, "linger-computer.ps1"),
      "utf8",
    ),
    windowsUninstallerTemplate: await readFile(
      path.join(root, "uninstall-linger-computer.ps1"),
      "utf8",
    ),
  };
}

/** The `runner.welcome` upgrade target: every target's archive digests. */
export const computerTargetRelease = (
  release: ComputerRelease,
): ComputerTargetRelease => ({
  targets: Object.fromEntries(
    Object.entries(release.targets).map(([target, { app, deps }]) => [
      target,
      {
        app: { sha256: app.sha256, size: app.size },
        deps: { sha256: deps.sha256, size: deps.size },
      },
    ]),
  ),
});
