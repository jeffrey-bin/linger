import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WikiOperationState } from "../../../src/llm-wiki/actor-wiki/wiki-operation-state.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("WikiOperationState", () => {
  it("creates a private directory per operation and removes it on release", async () => {
    const dataDirectory = join(await temporaryDirectory(), "state");
    const state = new WikiOperationState({ dataDirectory });

    const first = await state.createOperation();
    const second = await state.createOperation();
    expect(first.directory).not.toBe(second.directory);
    expect(first.directory.startsWith(join(dataDirectory, "operations"))).toBe(
      true,
    );
    expect((await lstat(first.directory)).mode & 0o777).toBe(0o700);

    await mkdir(join(first.directory, "inputs"));
    await writeFile(join(first.directory, "inputs", "document.md"), "body");
    await chmod(join(first.directory, "inputs"), 0o500);
    await first.release();
    await first.release();
    await expect(access(first.directory)).rejects.toThrow();
    await second.release();
  });

  it("clears what a stopped process left without following symlinks", async () => {
    const root = await temporaryDirectory();
    const dataDirectory = join(root, "state");
    const operationsDirectory = join(dataDirectory, "operations");
    const leftover = join(operationsDirectory, "candidate-left");
    const external = join(root, "external");
    await mkdir(join(leftover, "candidate"), { recursive: true });
    await writeFile(join(leftover, "candidate", "page.md"), "# Page");
    await chmod(join(leftover, "candidate"), 0o500);
    await mkdir(external);
    await writeFile(join(external, "keep.md"), "kept");
    await symlink(external, join(operationsDirectory, "candidate-link"));

    await new WikiOperationState({ dataDirectory }).start();

    await expect(access(leftover)).rejects.toThrow();
    await expect(
      access(join(operationsDirectory, "candidate-link")),
    ).rejects.toThrow();
    await expect(readFile(join(external, "keep.md"), "utf8")).resolves.toBe(
      "kept",
    );
    expect((await lstat(operationsDirectory)).mode & 0o777).toBe(0o700);
  });

  it("allows startup to retry after a local state failure is repaired", async () => {
    const root = await temporaryDirectory();
    const dataDirectory = join(root, "state");
    await writeFile(dataDirectory, "temporarily unavailable");
    const state = new WikiOperationState({ dataDirectory });

    await expect(state.start()).rejects.toBeInstanceOf(Error);
    await rm(dataDirectory);
    await expect(state.start()).resolves.toBeUndefined();

    const operation = await state.createOperation();
    await operation.release();
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "wiki-operation-state-"));
  temporaryDirectories.push(directory);
  return directory;
}
