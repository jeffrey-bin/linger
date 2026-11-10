import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHostTeamHubWorkingCopyStateFiles } from "./teamhub-workspace-files.js";

const STATE_FILE = `${"a".repeat(64)}.json`;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "teamhub-pinned-state-")),
  );
  roots.push(root);
  const files = createHostTeamHubWorkingCopyStateFiles({
    workspacePath: root,
    namespace: "identity",
    signal: new AbortController().signal,
  });
  return { root, files };
}

describe("pinned working-copy metadata", () => {
  it("retains a record across a failed operation and a fresh handle", async () => {
    const { files } = await fixture();
    await expect(
      files.withPinnedDirectory(async (pinned) => {
        await pinned.write(STATE_FILE, Buffer.from("accepted receipt"));
        throw new Error("EPIPE");
      }),
    ).rejects.toThrow("EPIPE");
    await files.withPinnedDirectory(async (pinned) => {
      expect((await pinned.read(STATE_FILE, 100))?.toString()).toBe(
        "accepted receipt",
      );
    });
  });

  it("rejects a directory replaced by a symlink before writing outside metadata", async () => {
    const { root, files } = await fixture();
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await expect(
      files.withPinnedDirectory(async (pinned) => {
        await rename(files.key, files.key + "-moved");
        await symlink(outside, files.key, "junction");
        await pinned.write(STATE_FILE, Buffer.from("must not escape"));
      }),
    ).rejects.toMatchObject({ code: "state_unavailable" });
    await expect(
      readFile(path.join(outside, STATE_FILE)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a replaced ancestor while retaining metadata in the original tree", async () => {
    const { root, files } = await fixture();
    const outside = path.join(root, "outside");
    await mkdir(path.join(outside, "files", "identity"), { recursive: true });
    await expect(
      files.withPinnedDirectory(async (pinned) => {
        await pinned.write(STATE_FILE, Buffer.from("original receipt"));
        await rename(path.join(root, ".teamhub"), path.join(root, "moved"));
        await symlink(outside, path.join(root, ".teamhub"), "junction");
        await pinned.write(STATE_FILE, Buffer.from("must not escape"));
      }),
    ).rejects.toMatchObject({ code: "state_unavailable" });
    expect(
      await readFile(
        path.join(root, "moved/files/identity", STATE_FILE),
        "utf8",
      ),
    ).toBe("original receipt");
    await expect(
      readFile(path.join(outside, "files/identity", STATE_FILE)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform !== "linux")(
    "closes pinned descriptors after the operation fails",
    async () => {
      const { files } = await fixture();
      let later: (() => Promise<void>) | undefined;
      await expect(
        files.withPinnedDirectory(async (pinned) => {
          later = () => pinned.write(STATE_FILE, Buffer.from("late write"));
          throw new Error("stop");
        }),
      ).rejects.toThrow("stop");
      await expect(later!()).rejects.toThrow();
      expect(await files.read(STATE_FILE, 100)).toBeNull();
    },
  );
});
