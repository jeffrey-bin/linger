import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHostFileExclusive,
  replaceHostFile,
} from "./host-file-system.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename), link: vi.fn(actual.link) };
});

const actual =
  await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const rename = vi.mocked(fs.rename);
const link = vi.mocked(fs.link);
const platform = process.platform;
const roots: string[] = [];

function stubPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}
function errno(code: string) {
  return Object.assign(new Error(code), { code });
}
async function root() {
  const value = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "host-file-system-")),
  );
  roots.push(value);
  return value;
}

afterEach(async () => {
  stubPlatform(platform);
  vi.useRealTimers();
  rename.mockReset().mockImplementation(actual.rename);
  link.mockReset().mockImplementation(actual.link);
  await Promise.all(
    roots.splice(0).map((value) => rm(value, { recursive: true, force: true })),
  );
});

describe("replaceHostFile", () => {
  it("retries Windows sharing violations until the rename succeeds", async () => {
    stubPlatform("win32");
    rename
      .mockRejectedValueOnce(errno("EBUSY"))
      .mockRejectedValueOnce(errno("EBUSY"))
      .mockResolvedValueOnce(undefined);
    await expect(replaceHostFile("a", "b")).resolves.toBeUndefined();
    expect(rename).toHaveBeenCalledTimes(3);
  });

  it("rethrows the original error once the Windows budget is spent", async () => {
    vi.useFakeTimers();
    stubPlatform("win32");
    const error = errno("EPERM");
    rename.mockRejectedValue(error);
    const pending = replaceHostFile("a", "b");
    const outcome = expect(pending).rejects.toBe(error);
    await vi.runAllTimersAsync();
    await outcome;
    expect(rename.mock.calls.length).toBeGreaterThan(2);
  });

  it("does not retry other Windows errors", async () => {
    stubPlatform("win32");
    const error = errno("ENOENT");
    rename.mockRejectedValue(error);
    await expect(replaceHostFile("a", "b")).rejects.toBe(error);
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it("does not retry outside Windows", async () => {
    stubPlatform("linux");
    const error = errno("EBUSY");
    rename.mockRejectedValue(error);
    await expect(replaceHostFile("a", "b")).rejects.toBe(error);
    expect(rename).toHaveBeenCalledTimes(1);
  });
});

describe("createHostFileExclusive", () => {
  async function fixture(directory?: string) {
    const base = directory ?? (await root());
    const source = path.join(base, "source.tmp");
    const target = path.join(base, "target.txt");
    await writeFile(source, "new bytes");
    return { source, target };
  }

  it("installs the source bytes at a new target", async () => {
    const { source, target } = await fixture();
    await createHostFileExclusive(source, target);
    expect(await readFile(target, "utf8")).toBe("new bytes");
  });

  it("refuses an existing target", async () => {
    const { source, target } = await fixture();
    await writeFile(target, "existing");
    await expect(createHostFileExclusive(source, target)).rejects.toMatchObject(
      { code: "EEXIST" },
    );
    expect(await readFile(target, "utf8")).toBe("existing");
  });

  it("copies exclusively when the filesystem has no hard links", async () => {
    const { source, target } = await fixture();
    link.mockRejectedValueOnce(errno("EPERM"));
    await createHostFileExclusive(source, target);
    expect(await readFile(target, "utf8")).toBe("new bytes");
  });

  it("refuses an existing target in the copy fallback", async () => {
    const { source, target } = await fixture();
    await writeFile(target, "existing");
    link.mockRejectedValueOnce(errno("ENOTSUP"));
    await expect(createHostFileExclusive(source, target)).rejects.toMatchObject(
      { code: "EEXIST" },
    );
    expect(await readFile(target, "utf8")).toBe("existing");
  });

  it.runIf(process.platform === "win32")(
    "installs files in a directory beyond MAX_PATH",
    async () => {
      const directory = path.join(
        await root(),
        ...Array.from({ length: 7 }, () => "d".repeat(40)),
      );
      expect(directory.length).toBeGreaterThan(260);
      await mkdir(directory, { recursive: true });
      const { source, target } = await fixture(directory);
      await createHostFileExclusive(source, target);
      expect(await readFile(target, "utf8")).toBe("new bytes");
    },
  );
});

describe("replaceHostFile on Windows", () => {
  const powershell = path.win32.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );

  // Holds the file open without delete sharing, as Office does.
  async function holdOpen(file: string, milliseconds: number) {
    const child = spawn(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$f = [IO.File]::Open($env:HOLD_PATH, 'Open', 'Read', 'None'); [Console]::Out.WriteLine('held'); Start-Sleep -Milliseconds ${milliseconds}; $f.Close()`,
      ],
      { env: { ...process.env, HOLD_PATH: file }, windowsHide: true },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", () => resolve());
    });
    return {
      exited: new Promise<void>((resolve) =>
        child.once("exit", () => resolve()),
      ),
    };
  }

  it.runIf(process.platform === "win32")(
    "waits for a short-lived open handle to close",
    async () => {
      const directory = await root();
      const target = path.join(directory, "book.xlsx");
      const source = path.join(directory, "book.tmp");
      await writeFile(target, "old");
      await writeFile(source, "new");
      const { exited } = await holdOpen(target, 1_000);
      await replaceHostFile(source, target);
      await exited;
      expect(await readFile(target, "utf8")).toBe("new");
    },
    15_000,
  );

  it.runIf(process.platform === "win32")(
    "gives up while the file stays open",
    async () => {
      const directory = await root();
      const target = path.join(directory, "book.xlsx");
      const source = path.join(directory, "book.tmp");
      await writeFile(target, "old");
      await writeFile(source, "new");
      const { exited } = await holdOpen(target, 6_000);
      const error = await replaceHostFile(source, target).then(
        () => null,
        (reason: NodeJS.ErrnoException) => reason,
      );
      expect(["EPERM", "EACCES", "EBUSY"]).toContain(error?.code);
      await exited;
      expect(await readFile(target, "utf8")).toBe("old");
    },
    20_000,
  );
});
