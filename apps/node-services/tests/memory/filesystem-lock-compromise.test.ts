import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

const locks = vi.hoisted(() => ({
  compromised: (_error: Error) => {
    void _error;
  },
  release: vi.fn(async () => {}),
}));
vi.mock("proper-lockfile", () => ({
  default: {
    lock: vi.fn(async (_path, options) => {
      locks.compromised = options.onCompromised;
      return locks.release;
    }),
  },
}));
import { withDirectoryLock } from "../../src/memory/filesystem-lock.js";
import { writeAtomicJsonFile } from "../../src/memory/fs-utils.js";

it("fences a compromised writer without crashing Memory or releasing its successor's lock", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-lock-lost-"));
  const file = path.join(root, "state.json");
  try {
    await fs.writeFile(file, "original");
    await expect(
      withDirectoryLock(root, async () => {
        locks.compromised(new Error("lock ownership lost"));
        await writeAtomicJsonFile(file, { invalid: true });
      }),
    ).rejects.toThrow("lock ownership lost");
    expect(await fs.readFile(file, "utf8")).toBe("original");
    expect(locks.release).not.toHaveBeenCalled();
    await withDirectoryLock(root, () =>
      writeAtomicJsonFile(file, { valid: true }),
    );
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
      valid: true,
    });
    expect(locks.release).toHaveBeenCalledOnce();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
