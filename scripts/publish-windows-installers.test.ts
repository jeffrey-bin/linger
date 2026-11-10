import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  publishWindowsInstallers,
  WINDOWS_RELEASE_METADATA_MARKER,
} from "./publish-windows-installers.mjs";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("Windows installer publication", () => {
  it("preserves PowerShell literal dollar tokens in published entrypoints", async () => {
    const output = await mkdtemp(
      path.join(os.tmpdir(), "linger-powershell-release-"),
    );
    temporaryRoots.push(output);
    await publishWindowsInstallers(output);
    for (const filename of [
      "linger-computer.ps1",
      "uninstall-linger-computer.ps1",
    ]) {
      const source = await readFile(path.join(output, filename), "utf8");
      expect(source).toContain("$checksumText -notmatch '^[0-7]+$'");
      expect(source).toContain("$archive.sha256 -cnotmatch '^[0-9a-f]{64}$'");
      expect(source.match(/this file is a release template/g)).toHaveLength(1);
      // node-services fills the release metadata with its origin at startup.
      expect(source.split(WINDOWS_RELEASE_METADATA_MARKER)).toHaveLength(2);
      expect(source).not.toContain("__LINGER_INSTALLER_HELPER_BASE64__");
    }
  });
});
