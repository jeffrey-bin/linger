import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { writeCliConfig } from "./test-support/cli-config.js";

it.runIf(
  process.platform === "win32" &&
    !!process.env.LINGER_TEST_WINDOWS_SYMLINK_FIXTURE,
)(
  "refuses a precreated file symlink before sending an attachment",
  async () => {
    const root = process.env.LINGER_TEST_WINDOWS_SYMLINK_FIXTURE!;
    const target = path.join(root, "target.json");
    expect(
      (await lstat(path.join(root, "config-link.json"))).isSymbolicLink(),
    ).toBe(true);
    expect(await realpath(path.join(root, "config-link.json"))).toBe(
      await realpath(target),
    );
    const before = await readFile(target);
    const config = await mkdtemp(
      path.join(os.tmpdir(), "teamhub-link-config-"),
    );
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}));
    const stderr: string[] = [];
    try {
      const code = await runCli(
        ["message", "send", "--attach", "config-link.json", "--json"],
        {
          cwd: root,
          env: writeCliConfig(config, {
            scope: { kind: "room", id: "room_fixture" },
          }),
          fetch: fetcher,
          stdout: () => {},
          stderr: (value) => stderr.push(value),
        },
      );
      expect(code).not.toBe(0);
      expect(JSON.parse(stderr.join("")).error).toMatchObject({
        code: "invalid_input",
      });
      expect(fetcher).not.toHaveBeenCalled();
      expect(await readFile(target)).toEqual(before);
      await runCli(["message", "send", "--attach", "target.json", "--json"], {
        cwd: root,
        env: writeCliConfig(config, {
          scope: { kind: "room", id: "room_fixture" },
        }),
        fetch: fetcher,
        stdout: () => {},
        stderr: () => {},
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      await rm(config, { recursive: true, force: true });
    }
  },
);
