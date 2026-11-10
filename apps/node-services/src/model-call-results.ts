import type { ModelInvokeFile } from "@linger/wire-contracts/runner-gateway/types";

/** A finished call's answer, as the caller receives it. */
export interface ModelCallAnswer {
  readonly model: string;
  /** A JSON object, the text, or the workspace's final files. */
  readonly output:
    | Readonly<Record<string, unknown>>
    | string
    | readonly ModelInvokeFile[];
}

/**
 * Answers of background calls nobody waited for when they finished, kept for
 * the caller that comes back with the same call. They live only as long as
 * the process.
 */
export interface ModelCallResults {
  get(id: string): ModelCallAnswer | undefined;
  put(id: string, answer: ModelCallAnswer, ttlMs: number): void;
}

/** How much uncollected output one process keeps. */
const MAX_RESULT_BYTES = 32 * 1024 * 1024;

export interface ModelCallResultsOptions {
  readonly now?: () => number;
  readonly maxBytes?: number;
}

/** Keeps answers until they expire, up to a byte budget, oldest dropped
 * first. */
export function createModelCallResults(
  options: ModelCallResultsOptions = {},
): ModelCallResults {
  const now = options.now ?? Date.now;
  const maxBytes = options.maxBytes ?? MAX_RESULT_BYTES;
  const answers = new Map<
    string,
    {
      readonly answer: ModelCallAnswer;
      readonly bytes: number;
      readonly expiresAt: number;
    }
  >();
  let bytes = 0;
  const drop = (id: string) => {
    const entry = answers.get(id);
    if (!entry) return;
    answers.delete(id);
    bytes -= entry.bytes;
  };
  return {
    get: (id) => {
      const entry = answers.get(id);
      if (!entry) return undefined;
      if (entry.expiresAt > now()) return entry.answer;
      drop(id);
      return undefined;
    },
    put: (id, answer, ttlMs) => {
      drop(id);
      const size = JSON.stringify(answer).length * 2;
      if (size > maxBytes) return;
      for (const oldest of answers.keys()) {
        if (bytes + size <= maxBytes) break;
        drop(oldest);
      }
      answers.set(id, { answer, bytes: size, expiresAt: now() + ttlMs });
      bytes += size;
    },
  };
}
