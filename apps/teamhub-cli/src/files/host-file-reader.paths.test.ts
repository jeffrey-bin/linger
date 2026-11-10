import { createHash } from "node:crypto";
import {
  appendFile,
  lstat,
  mkdtemp,
  mkdir,
  open,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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

describe("exact Host file reads", () => {
  it("reads exact bytes below the root", async () => {
    const root = await temporaryRoot();
    const playground = path.join(root, "playground");
    await mkdir(playground);
    await writeFile(path.join(playground, "result.md"), "result\n");
    const reader = hostReader(playground);

    const snapshot = await reader.readFile({
      logicalPath: "result.md",
      maxSizeBytes: 1_024,
      signal: new AbortController().signal,
    });

    expect(Buffer.from(snapshot.content).toString()).toBe("result\n");
    expect(snapshot.sha256).toBe(
      createHash("sha256").update("result\n").digest("hex"),
    );
  });

  it("rejects symlinks and oversize files", async () => {
    const root = await temporaryRoot();
    const playground = path.join(root, "playground");
    await mkdir(playground);
    await writeFile(path.join(playground, "large.md"), "1234");
    const fixtureRoot = process.env.LINGER_TEST_WINDOWS_SYMLINK_FIXTURE;
    if (process.platform !== "win32") {
      await symlink(
        path.join(playground, "large.md"),
        path.join(playground, "link.md"),
      );
    } else if (!fixtureRoot) {
      throw new Error(
        "LINGER_TEST_WINDOWS_SYMLINK_FIXTURE is required for Windows file link tests",
      );
    } else {
      expect(
        (
          await lstat(path.join(fixtureRoot, "config-link.json"))
        ).isSymbolicLink(),
      ).toBe(true);
    }
    const reader = hostReader(playground);
    const signal = new AbortController().signal;

    await expect(
      (process.platform === "win32"
        ? hostReader(fixtureRoot!)
        : reader
      ).readFile({
        logicalPath:
          process.platform === "win32" ? "config-link.json" : "link.md",
        maxSizeBytes: 10,
        signal,
      }),
    ).rejects.toThrow("symbolic links");
    await expect(
      reader.readFile({
        logicalPath: "large.md",
        maxSizeBytes: 3,
        signal,
      }),
    ).rejects.toThrow("upload limit");
  });

  it("bounds a concurrently growing file to the pinned size plus one byte", async () => {
    const root = await temporaryRoot();
    const playground = path.join(root, "playground");
    const filePath = path.join(playground, "growing.md");
    await mkdir(playground);
    await writeFile(filePath, "seed");
    const reader = hostReader(playground);

    const probe = await open(filePath, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      read: FileHandle["read"];
    };
    await probe.close();
    const originalRead = fileHandlePrototype.read;
    let appended = false;
    let maximumRequestedBytes = 0;
    fileHandlePrototype.read = async function (
      this: FileHandle,
      ...args: unknown[]
    ) {
      const requestedBytes = args[2];
      if (typeof requestedBytes === "number") {
        maximumRequestedBytes = Math.max(maximumRequestedBytes, requestedBytes);
      }
      if (!appended) {
        appended = true;
        await appendFile(filePath, Buffer.alloc(1024 * 1024, 0x61));
      }
      return Reflect.apply(originalRead, this, args);
    } as FileHandle["read"];

    try {
      await expect(
        reader.readFile({
          logicalPath: "growing.md",
          maxSizeBytes: 2 * 1024 * 1024,
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: "changed" });
    } finally {
      fileHandlePrototype.read = originalRead;
    }

    expect(appended).toBe(true);
    expect(maximumRequestedBytes).toBe(5);
  });

  it("rejects symlinked directories, symlinked roots, and aborts", async () => {
    const root = await temporaryRoot();
    const playground = path.join(root, "playground");
    const outside = path.join(root, "outside");
    await mkdir(playground);
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.md"), "secret");
    await symlink(outside, path.join(playground, "linked"), "junction");
    const reader = hostReader(playground);

    await expect(
      reader.readFile({
        logicalPath: "linked/secret.md",
        maxSizeBytes: 1_024,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("symbolic links");

    const aborted = new AbortController();
    aborted.abort();
    await expect(
      reader.readFile({
        logicalPath: "secret.md",
        maxSizeBytes: 1_024,
        signal: aborted.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    const linkedRoot = path.join(root, "linked-root");
    await symlink(playground, linkedRoot, "junction");
    const linkedRootReader = hostReader(linkedRoot);
    await expect(
      linkedRootReader.readFile({
        logicalPath: "secret.md",
        maxSizeBytes: 1_024,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("mapping source is unavailable");
  });
});

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "context-file-reader-"));
  roots.push(root);
  return root;
};

// The playground root and a path relative to it, as the CLI reads files.
const hostReader = (root: string) => ({
  readFile: (input: {
    logicalPath: string;
    maxSizeBytes: number;
    signal: AbortSignal;
  }) =>
    readExactHostFile(
      root,
      input.logicalPath,
      input.maxSizeBytes,
      input.signal,
    ),
});
