import { once } from "node:events";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { withDirectoryLock } from "../../src/memory/filesystem-lock.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-process-lock-"));
  roots.push(root);
  return root;
}

describe("Wiki filesystem writer lock", () => {
  it("serializes local callers and releases the lock after failure", async () => {
    const root = await fixture();
    const order: number[] = [];
    const first = withDirectoryLock(root, async () => {
      order.push(1);
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push(2);
      throw new Error("failed writer");
    });
    const second = withDirectoryLock(root, async () => {
      order.push(3);
    });
    await expect(first).rejects.toThrow("failed writer");
    await second;
    expect(order).toEqual([1, 2, 3]);
    await expect(fs.stat(`${root}.lock`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("serializes independent CLI processes over the same directory", async () => {
    const root = await fixture();
    await fs.writeFile(path.join(root, "counter"), "0");
    const moduleUrl = new URL(
      "../../src/memory/filesystem-lock.ts",
      import.meta.url,
    ).href;
    const code = `import { withDirectoryLock } from ${JSON.stringify(moduleUrl)};
      import fs from 'node:fs/promises';
      await withDirectoryLock(${JSON.stringify(root)}, async () => {
        const file = ${JSON.stringify(path.join(root, "counter"))};
        const value = Number(await fs.readFile(file, 'utf8'));
        await new Promise(resolve => setTimeout(resolve, 200));
        await fs.writeFile(file, String(value + 1));
      });`;
    await Promise.all(
      [0, 1].map(() =>
        promisify(execFile)(process.execPath, [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          code,
        ]),
      ),
    );
    expect(await fs.readFile(path.join(root, "counter"), "utf8")).toBe("2");
    await expect(fs.stat(`${root}.lock`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("recovers an expired lock left by a killed CLI process", async () => {
    const root = await fixture();
    const moduleUrl = new URL(
      "../../src/memory/filesystem-lock.ts",
      import.meta.url,
    ).href;
    const code = `import { withDirectoryLock } from ${JSON.stringify(moduleUrl)};
      await withDirectoryLock(${JSON.stringify(root)}, async () => {
        process.stdout.write('locked');
        await new Promise(() => setInterval(() => {}, 1000));
      });`;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", code],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      await once(child.stdout, "data");
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      const stale = new Date(Date.now() - 121_000);
      await fs.utimes(`${root}.lock`, stale, stale);
      await expect(
        withDirectoryLock(root, async () => "recovered"),
      ).resolves.toBe("recovered");
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }
  });

  it("rejects a symlink write root", async () => {
    const root = await fixture();
    const linked = path.join(root, "link");
    await fs.symlink(root, linked, "dir");
    await expect(
      withDirectoryLock(linked, async () => undefined),
    ).rejects.toThrow("symbolic link");
  });
});
