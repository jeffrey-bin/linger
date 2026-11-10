import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  LlmWikiBackend,
  LlmWikiGenerateRequest,
  LlmWikiGenerateResult,
  WikiInput,
} from "./backend.js";
import { ActorAssetError } from "./actor-wiki/actor-asset-client.js";
import { wikiLogger, writeWikiLog } from "./log.js";
import { WikiCandidateValidationError } from "./wiki-candidate-validation.js";

// Runs allowed after a rejected first run. Bisecting down to one rejected
// source costs about 2*log2(n) runs; this covers a few rejected sources.
// Each run may itself spend several correction attempts.
const MAX_RETRY_RUNS = 32;
/** How long one refresh may start model work. TeamHub waits four hours for
 * the whole generation; a step already running when this passes may take
 * most of the rest, so no further task, step or bisection run starts after
 * it. What is left is reported deferred: it stays pending without spending
 * a try. */
export const WIKI_GENERATION_BUDGET_MS = 150 * 60_000;

interface Source {
  input: WikiInput;
  modified: boolean;
  date: string;
}

/**
 * Keep one frozen generation and one publication. Every source goes to one
 * run, and the backend sizes its own model tasks to the model's context
 * window. A run whose candidate is rejected is retried from its halves, so one
 * bad source cannot hold every other frozen source of this refresh: a source
 * still rejected on its own is skipped. Removals are applied once, by the first
 * accepted run. Original bytes remain files, never summaries or synthetic
 * replacement facts.
 */
export async function generateWikiCandidate(
  runtime: LlmWikiBackend,
  input: LlmWikiGenerateRequest,
): Promise<Pick<LlmWikiGenerateResult, "unsettled" | "deferred">> {
  const request = {
    ...input,
    deadline: input.deadline ?? Date.now() + WIKI_GENERATION_BUDGET_MS,
  };
  let rejected: WikiCandidateValidationError;
  try {
    const { unsettled, deferred } = await runtime.generate(request);
    return { unsettled, deferred };
  } catch (error) {
    if (!(error instanceof WikiCandidateValidationError)) throw error;
    await rm(request.outputDirectory, { recursive: true, force: true });
    rejected = error;
  }
  const modified = new Set(request.changes.modified);
  // Establish document/entity context first, then replay dated Sessions
  // chronologically. IDs, bytes and source provenance never change.
  const sources: Source[] = [
    ...request.changes.added,
    ...request.changes.modified,
  ]
    .map((input) => ({
      input,
      modified: modified.has(input),
      date: input.session?.date ?? "",
    }))
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.input.contentPath.localeCompare(b.input.contentPath),
    );
  await mkdir(dirname(request.outputDirectory), { recursive: true });
  const scratch = await mkdtemp(
    join(dirname(request.outputDirectory), ".bisect-"),
  );
  let previous = request.existingOutputDirectory;
  let completed = 0;
  let removedApplied = false;
  let attempt = 0;
  let lastSkip: WikiCandidateValidationError | undefined;
  const unsettled = new Set<string>();
  const deferred = new Set<string>();
  // A single source with deterministic invalid output would fail again; keep
  // the other sources and continue without its rejected pages. Its frozen
  // version still settles, so a later refresh is not held by it.
  const skip = (batch: Source[], error: WikiCandidateValidationError) => {
    lastSkip = error;
    writeWikiLog(
      "wiki_sources_skipped",
      {
        mode: request.mode,
        asset_keys: batch.map((source) => source.input.assetKey),
        codes: [...new Set(error.issues.map((issue) => issue.code))],
      },
      "ERROR",
    );
  };
  const run = async (batch: Source[]): Promise<void> => {
    request.signal?.throwIfAborted();
    // Past its run or time budget, bisection stops: the sources not yet run
    // stay pending for a later refresh, and the accepted runs still publish.
    if (attempt >= MAX_RETRY_RUNS || Date.now() >= request.deadline) {
      // Not a failure of these sources: they spend none of their tries.
      for (const source of batch) deferred.add(source.input.assetKey);
      writeWikiLog(
        "wiki_sources_deferred",
        {
          mode: request.mode,
          asset_keys: batch.map((source) => source.input.assetKey),
          reason: attempt >= MAX_RETRY_RUNS ? "retry_runs" : "deadline",
          retry_runs: attempt,
        },
        "ERROR",
      );
      return;
    }
    const stage = join(scratch, String(++attempt));
    const inputs = join(stage, "inputs");
    await mkdir(inputs, { recursive: true });
    for (const source of batch) {
      const target = join(inputs, source.input.contentPath);
      await mkdir(dirname(target), { recursive: true });
      await cp(join(request.inputsDirectory, source.input.contentPath), target);
    }
    const output = join(stage, "wiki");
    try {
      const result = await runtime.generate({
        ...request,
        mode: completed === 0 ? request.mode : "update",
        changes: {
          added: batch.filter((s) => !s.modified).map((s) => s.input),
          modified: batch.filter((s) => s.modified).map((s) => s.input),
          removed: removedApplied ? [] : request.changes.removed,
        },
        inputsDirectory: inputs,
        existingOutputDirectory: previous,
        outputDirectory: output,
      });
      for (const key of result.unsettled) unsettled.add(key);
      for (const key of result.deferred) deferred.add(key);
    } catch (error) {
      if (!(error instanceof WikiCandidateValidationError)) throw error;
      if (batch.length > 1) {
        // A smaller run often succeeds where a larger one did not, for
        // example a missing target page; never carry rejected pages into the
        // baseline. Bisect so one rejected source costs log2(n) runs, not n.
        await bisect(batch);
        return;
      }
      skip(batch, error);
      return;
    }
    previous = output;
    removedApplied = true;
    completed += batch.length;
    wikiLogger().log("info", "wiki_generation.half_completed", {
      completed_sources: completed,
      total_sources: sources.length,
    });
  };
  const bisect = async (batch: Source[]) => {
    const half = Math.ceil(batch.length / 2);
    await run(batch.slice(0, half));
    await run(batch.slice(half));
  };
  try {
    // Repeating the rejected run would fail again; start from its halves.
    if (sources.length > 1) await bisect(sources);
    else if (sources.length === 1) skip(sources, rejected);
    // Without an accepted run there is no Wiki to initialize from, and pending
    // removals were never applied; an update otherwise republishes its base.
    if (
      completed === 0 &&
      (request.mode === "initialize" || request.changes.removed.length > 0)
    ) {
      if (lastSkip) throw lastSkip;
      throw new ActorAssetError(
        "WIKI_OPERATION_RETRYABLE",
        "Wiki generation ran out of its budget before any run was accepted",
      );
    }
    // Expose a complete candidate only after every frozen source settled or
    // was left pending.
    await cp(previous, request.outputDirectory, { recursive: true });
    return {
      unsettled: [...unsettled],
      deferred: [...deferred].filter((key) => !unsettled.has(key)),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
