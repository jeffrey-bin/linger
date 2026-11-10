import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  appleDeveloperToolsReady,
  installAppleDeveloperTools,
  needsAppleDeveloperTools,
} from "./apple-developer-tools.js";
import type { runProcess } from "./process.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

// A Mac whose developer directory gains clang once `installed` is set.
async function mac() {
  const root = await mkdtemp(path.join(tmpdir(), "linger-xcode-"));
  roots.push(root);
  const state = { installed: false, windowOpen: false };
  const calls: string[][] = [];
  const run = vi.fn(async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (args[0] === "--install") {
      state.windowOpen = true;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "-p") {
      if (state.installed) {
        await mkdir(path.join(root, "usr/bin"), { recursive: true });
        await writeFile(path.join(root, "usr/bin/clang"), "");
      }
      return { code: 0, stdout: `${root}\n`, stderr: "" };
    }
    return { code: state.windowOpen ? 0 : 1, stdout: "", stderr: "" };
  }) as unknown as typeof runProcess;
  return {
    state,
    calls,
    options: {
      signal: new AbortController().signal,
      platform: "darwin" as const,
      run,
    },
  };
}

test("only a Mac without a compiler and a toolchain failure needs the tools", async () => {
  const m = await mac();
  const gyp = "gyp ERR! stack Error: `make` failed with exit code: 1\n";
  expect(await needsAppleDeveloperTools(gyp, m.options)).toBe(true);
  expect(
    await needsAppleDeveloperTools("ERR_PNPM_FETCH_404 Not Found\n", m.options),
  ).toBe(false);
  expect(
    await needsAppleDeveloperTools(gyp, { ...m.options, platform: "linux" }),
  ).toBe(false);
  m.state.installed = true;
  expect(await appleDeveloperToolsReady(m.options)).toBe(true);
  expect(await needsAppleDeveloperTools(gyp, m.options)).toBe(false);
});

test("a developer directory without a compiler is not ready", async () => {
  const m = await mac();
  expect(await appleDeveloperToolsReady(m.options)).toBe(false);
  const run = vi.fn(async () => ({
    code: 2,
    stdout: "",
    stderr: "xcode-select: error: unable to get active developer directory",
  })) as unknown as typeof runProcess;
  expect(await appleDeveloperToolsReady({ ...m.options, run })).toBe(false);
});

test("the install opens Apple's window and resolves once the tools arrive", async () => {
  const m = await mac();
  const waits: number[] = [];
  const done = installAppleDeveloperTools({
    ...m.options,
    pollMs: 1,
    onWaiting: (seconds) => {
      waits.push(seconds);
      if (waits.length === 3) m.state.installed = true;
    },
  });
  await expect(done).resolves.toBeUndefined();
  expect(m.calls[0]).toEqual(["/usr/bin/xcode-select", "--install"]);
  expect(waits).toHaveLength(3);
});

test("closing Apple's window without installing ends the wait", async () => {
  const m = await mac();
  let polls = 0;
  await expect(
    installAppleDeveloperTools({
      ...m.options,
      pollMs: 1,
      onWaiting: () => {
        if (++polls === 2) m.state.windowOpen = false;
      },
    }),
  ).rejects.toThrow("Apple's developer tools were not installed");
});
