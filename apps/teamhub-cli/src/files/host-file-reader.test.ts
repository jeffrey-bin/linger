import { link, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readExactHostFile } from "./host-file-reader.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "pinned-reader-")),
  );
  roots.push(root);
  const file = path.join(root, "report.md");
  const alias = path.join(root, "alias.md");
  await writeFile(file, "report bytes");
  return { root, file, alias };
}
const read = (root: string) =>
  readExactHostFile(root, "report.md", 1024, new AbortController().signal);

describe("pinned publication file aliases", () => {
  it("keeps ordinary files readable but rejects an existing hardlink", async () => {
    const { root, file, alias } = await fixture();
    expect(Buffer.from((await read(root)).content).toString()).toBe(
      "report bytes",
    );
    await link(file, alias);
    await expect(read(root)).rejects.toThrow(/alias|hard.?link/i);
  });

  it("rejects a hardlink introduced after path capture and before descriptor validation", async () => {
    const { root, file, alias } = await fixture();
    const probe = await open(file, "r");
    const inode = (await probe.stat({ bigint: true })).ino;
    const prototype = Object.getPrototypeOf(probe) as {
      stat: FileHandle["stat"];
    };
    await probe.close();
    const original = prototype.stat;
    let linked = false;
    prototype.stat = async function (this: FileHandle, ...args: unknown[]) {
      const metadata = await Reflect.apply(original, this, args);
      if (!linked && metadata.ino === inode) {
        linked = true;
        await link(file, alias);
        return Reflect.apply(original, this, args);
      }
      return metadata;
    } as FileHandle["stat"];
    try {
      await expect(read(root)).rejects.toThrow(/alias|hard.?link/i);
      expect(linked).toBe(true);
    } finally {
      prototype.stat = original;
    }
  });
});
