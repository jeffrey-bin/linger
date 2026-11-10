import { appendFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import type { JsonLogger } from "@linger/service-kit/node";

/** How long a work's record is kept after its last write. */
const RETENTION_MS = 3 * 24 * 60 * 60_000;
/** How often old records are looked for. */
const PRUNE_INTERVAL_MS = 60 * 60_000;

/** One model call as it starts, before the Runtime answers. */
export interface ModelCallStarted {
  readonly kind: string;
  readonly key: string;
  readonly attempt: number;
  readonly mode: string;
  readonly instructions?: string;
  readonly input: string;
}

/** How the call ended: the reply, or what the Runtime streamed before it
 * stopped, and the error when it failed. */
export interface ModelCallFinished {
  readonly kind: string;
  readonly key: string;
  readonly attempt: number;
  readonly outcome: string;
  readonly durationMs: number;
  readonly model?: string;
  readonly text?: string;
  readonly usage?: unknown;
  readonly error?: string;
}

/**
 * Keeps each model call's prompt and reply in a local JSONL file, one file per
 * piece of work (the part of the call key before the first `/`, for example
 * `wiki:<refresh id>`), so a failed or stalled generation can be read back.
 * The records hold the owner's sources, so they stay in the service's data
 * directory and never go to the log stream. A failed write is logged once
 * and never fails the call.
 */
export interface ModelCallLog {
  started(call: ModelCallStarted): void;
  finished(call: ModelCallFinished): void;
}

export function createModelCallLog(options: {
  readonly directory: string;
  readonly logger?: Pick<JsonLogger, "log">;
  readonly now?: () => number;
}): ModelCallLog {
  const now = options.now ?? Date.now;
  let writes: Promise<void> = Promise.resolve();
  let created = false;
  let warned = false;
  let prunedAt = 0;
  const write = (key: string, record: Record<string, unknown>): void => {
    const file = join(options.directory, `${workOf(key)}.jsonl`);
    const line = `${JSON.stringify({ at: new Date(now()).toISOString(), ...record })}\n`;
    writes = writes
      .then(async () => {
        if (!created) {
          await mkdir(options.directory, { recursive: true, mode: 0o700 });
          created = true;
        }
        if (now() - prunedAt >= PRUNE_INTERVAL_MS) {
          prunedAt = now();
          await prune(options.directory, now());
        }
        await appendFile(file, line, { mode: 0o600 });
      })
      .catch((error: unknown) => {
        if (warned) return;
        warned = true;
        options.logger?.log("warn", "model_call.record_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };
  return {
    started: (call) =>
      write(call.key, {
        event: "started",
        kind: call.kind,
        key: call.key,
        attempt: call.attempt,
        mode: call.mode,
        ...(call.instructions ? { instructions: call.instructions } : {}),
        input: call.input,
      }),
    finished: (call) =>
      write(call.key, {
        event: "finished",
        kind: call.kind,
        key: call.key,
        attempt: call.attempt,
        outcome: call.outcome,
        duration_ms: call.durationMs,
        ...(call.model ? { model: call.model } : {}),
        ...(call.usage === undefined ? {} : { usage: call.usage }),
        ...(call.text ? { text: call.text } : {}),
        ...(call.error ? { error: call.error } : {}),
      }),
  };
}

/** The file name of a call key's work: its part before the first `/`. */
export function workOf(key: string): string {
  const work = key.split("/", 1)[0]!.replace(/[^A-Za-z0-9._-]+/gu, "_");
  return work.slice(0, 160) || "call";
}

async function prune(directory: string, now: number): Promise<void> {
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".jsonl")) continue;
    const file = join(directory, name);
    const { mtimeMs } = await stat(file);
    if (now - mtimeMs > RETENTION_MS) await rm(file, { force: true });
  }
}
