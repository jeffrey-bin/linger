import {
  mkdtemp,
  readdir,
  readFile,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createModelCallLog, workOf } from "../src/model-call-log.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("model call log", () => {
  it("writes each work's calls to one JSONL file", async () => {
    const directory = join(
      await mkdtemp(join(tmpdir(), "model-calls-")),
      "calls",
    );
    const log = createModelCallLog({ directory });
    log.started({
      kind: "wiki",
      key: "wiki:refresh_1/batch:1/1",
      attempt: 1,
      mode: "structured",
      instructions: "Write.",
      input: "Evidence",
    });
    log.finished({
      kind: "wiki",
      key: "wiki:refresh_1/batch:1/1",
      attempt: 1,
      outcome: "output_limited",
      durationMs: 12,
      text: '{"actions":[',
      error: "The model reply passed its output limit",
    });
    log.started({
      kind: "memory",
      key: "memory:daily:2026-11-06",
      attempt: 1,
      mode: "text",
      input: "Day",
    });
    await settle();
    expect((await readdir(directory)).sort()).toEqual([
      "memory_daily_2026-11-06.jsonl",
      "wiki_refresh_1.jsonl",
    ]);
    const lines = (
      await readFile(join(directory, "wiki_refresh_1.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toEqual([
      expect.objectContaining({
        event: "started",
        key: "wiki:refresh_1/batch:1/1",
        instructions: "Write.",
        input: "Evidence",
      }),
      expect.objectContaining({
        event: "finished",
        outcome: "output_limited",
        duration_ms: 12,
        text: '{"actions":[',
      }),
    ]);
  });

  it("removes records not written for three days", async () => {
    const directory = await mkdtemp(join(tmpdir(), "model-calls-"));
    const old = join(directory, "wiki_old.jsonl");
    await writeFile(old, "{}\n");
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60_000);
    await utimes(old, fourDaysAgo, fourDaysAgo);
    await writeFile(join(directory, "wiki_recent.jsonl"), "{}\n");
    createModelCallLog({ directory }).started({
      kind: "wiki",
      key: "wiki:new",
      attempt: 1,
      mode: "text",
      input: "x",
    });
    await settle();
    expect((await readdir(directory)).sort()).toEqual([
      "wiki_new.jsonl",
      "wiki_recent.jsonl",
    ]);
  });

  it("reports a failed write once and never throws", async () => {
    const directory = await mkdtemp(join(tmpdir(), "model-calls-"));
    const blocked = join(directory, "file");
    await writeFile(blocked, "");
    const logger = { log: vi.fn() };
    const log = createModelCallLog({ directory: blocked, logger });
    for (let attempt = 1; attempt <= 2; attempt++)
      log.started({
        kind: "wiki",
        key: "wiki:x",
        attempt,
        mode: "text",
        input: "x",
      });
    await settle();
    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "model_call.record_failed",
      expect.any(Object),
    );
  });

  it("names a work by the call key before its first slash", () => {
    expect(workOf("wiki:document_wiki_refresh_1/route:1/1")).toBe(
      "wiki_document_wiki_refresh_1",
    );
    expect(workOf("/x")).toBe("call");
  });
});
