import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
const { check } = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock("@linger/local-installation/windows-private", () => ({
  windowsPrivatePath: check,
}));
import { privateRead } from "./storage.js";
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  check.mockReset();
});
it("uses Windows SID permissions instead of POSIX uid for private manager state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "linger-win-state-"));
  try {
    const file = path.join(root, "session.json");
    await writeFile(file, '{"value":1}');
    Object.defineProperty(process, "platform", { value: "win32" });
    check.mockResolvedValue(undefined);
    expect(await privateRead(file)).toEqual({ value: 1 });
    expect(check).toHaveBeenCalledWith(file, "file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("does not read private manager state when Windows ACL validation fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "linger-win-denied-"));
  try {
    const file = path.join(root, "session.json");
    await writeFile(file, '{"value":1}', { mode: 0o600 });
    Object.defineProperty(process, "platform", { value: "win32" });
    check.mockRejectedValue(new Error("Unsafe Windows permissions"));
    await expect(privateRead(file)).rejects.toThrow();
    expect(check).toHaveBeenCalledWith(file, "file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
