import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { renameRetrying } from "./fs-retry.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});

const locked = (code = "EPERM") =>
  Object.assign(
    new Error(`${code}: operation not permitted, rename 'a' -> 'b'`),
    {
      code,
      syscall: "rename",
      path: "a",
    },
  );

// A clock that moves only when the retry waits.
const clock = () => {
  let time = 0;
  const waits: number[] = [];
  return {
    waits,
    now: () => time,
    sleep: async (ms: number) => {
      waits.push(ms);
      time += ms;
    },
  };
};

it("waits out a Windows lock on a freshly unpacked folder", async () => {
  const time = clock();
  const errors = [locked("EPERM"), locked("EBUSY"), locked("EACCES")];
  const calls: string[] = [];
  const retried: [string | undefined, number][] = [];
  await renameRetrying("a.partial", "a", {
    platform: "win32",
    ...time,
    rename: async (from, to) => {
      calls.push(`${from}->${to}`);
      const error = errors.shift();
      if (error) throw error;
    },
    onRetry: (error, attempt) => retried.push([error.code, attempt]),
  });
  expect(calls).toHaveLength(4);
  expect(time.waits).toEqual([50, 100, 200]);
  expect(retried).toEqual([
    ["EPERM", 1],
    ["EBUSY", 2],
    ["EACCES", 3],
  ]);
});

it("gives up after the timeout and keeps the original error", async () => {
  const time = clock();
  let calls = 0;
  const failure = await renameRetrying("a.partial", "a", {
    platform: "win32",
    timeoutMs: 10_000,
    ...time,
    rename: async () => {
      calls++;
      throw locked();
    },
  }).catch((error: NodeJS.ErrnoException) => error);
  expect(failure).toMatchObject({
    code: "EPERM",
    syscall: "rename",
    path: "a",
  });
  expect((failure as Error).message).toMatch(
    /^EPERM: operation not permitted, rename 'a' -> 'b' \(still locked after \d+ attempts over \d+ s\)$/,
  );
  expect((failure as Error).cause).toMatchObject({ code: "EPERM" });
  expect(calls).toBeGreaterThan(5);
  expect(time.now()).toBeLessThanOrEqual(10_000);
  // The wait grows to a second and no further.
  expect(Math.max(...time.waits)).toBe(1_000);
});

it("fails at once off Windows and on other errors", async () => {
  for (const [platform, code] of [
    ["linux", "EPERM"],
    ["win32", "ENOENT"],
  ] as const) {
    let calls = 0;
    await expect(
      renameRetrying("a.partial", "a", {
        platform,
        ...clock(),
        rename: async () => {
          calls++;
          throw locked(code);
        },
      }),
    ).rejects.toMatchObject({ code });
    expect(calls).toBe(1);
  }
});

it("stops waiting when aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    renameRetrying("a.partial", "a", {
      platform: "win32",
      signal: controller.signal,
      ...clock(),
      rename: async () => {
        throw locked();
      },
    }),
  ).rejects.toThrow(/aborted/i);
});

it("renames a real folder under a non-ASCII path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "linger-rename-"));
  roots.push(root);
  const parent = path.join(root, "\u65b0\u5efa\u6587\u4ef6\u5939");
  await mkdir(path.join(parent, "v1.partial"), { recursive: true });
  await writeFile(path.join(parent, "v1.partial", "node.exe"), "");
  await renameRetrying(
    path.join(parent, "v1.partial"),
    path.join(parent, "v1"),
  );
  expect(await readdir(parent)).toEqual(["v1"]);
});
