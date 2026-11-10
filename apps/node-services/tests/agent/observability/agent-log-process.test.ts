import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const agentRoot = fileURLToPath(new URL("../../../", import.meta.url));

it.each([5_000, 20])(
  "keeps timers responsive and bounds file drain (%i ms)",
  async (flushTimeout) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-log-process-"));
    try {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          "--import",
          "tsx",
          "--import",
          "./tests/agent/fixtures/slow-agent-log.mjs",
          "tests/agent/fixtures/agent-log-responsiveness.mjs",
        ],
        {
          cwd: agentRoot,
          env: {
            ...process.env,
            FIXTURE_LOG_DIRECTORY: root,
            AGENT_LOG_LEVEL: "info",
            FIXTURE_FLUSH_TIMEOUT_MS: String(flushTimeout),
          },
          timeout: 10_000,
        },
      );
      const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
      expect(result.timerMs).toBeLessThan(250);
      expect(result.flushed).toBe(flushTimeout === 5_000);
      if (flushTimeout !== 5_000) return;
      const entries = (
        await readFile(path.join(root, "system/events.ndjson"), "utf8")
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(entries.map((entry) => entry.index)).toEqual(
        Array.from({ length: 10 }, (_, i) => i),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);
