import { mkdtemp, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  computerTargetRelease,
  loadComputerRelease,
} from "../../../src/agent/runner-gateway/computer-release.js";
import { writeComputerRelease } from "./computer-release-fixture.js";

describe("loadComputerRelease", () => {
  it("returns undefined when the image ships no release", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "no-release-"));
    await expect(loadComputerRelease(root)).resolves.toBeUndefined();
    await expect(
      loadComputerRelease(path.join(root, "missing")),
    ).resolves.toBeUndefined();
  });

  it("loads the release and projects every target into the welcome", async () => {
    const { root, target, archives } = await writeComputerRelease();
    const loaded = await loadComputerRelease(root);
    expect(loaded).toMatchObject({ root, version: "1.2.3" });
    expect(computerTargetRelease(loaded!)).toEqual({
      targets: {
        [target]: {
          app: { sha256: archives.app!.sha256, size: archives.app!.size },
          deps: { sha256: archives.deps!.sha256, size: archives.deps!.size },
        },
      },
    });
  });

  it("fails startup when a listed archive is missing on disk", async () => {
    const { root, archives } = await writeComputerRelease();
    await unlink(path.join(root, "files", archives.deps!.file));
    await expect(loadComputerRelease(root)).rejects.toThrow(
      `lists ${archives.deps!.file}, which is missing`,
    );
  });
});
