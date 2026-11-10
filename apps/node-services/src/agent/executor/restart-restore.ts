import { setTimeout as delay } from "node:timers/promises";
import {
  encodeExecutionContextRef,
  type ExecutionContextRef,
  decodeExecutionContextKey,
} from "./context-ref.js";
import type { AgentLogger } from "../observability/agent-log.js";

export const RESTART_RESTORE_CONCURRENCY = 4;
export const RESTART_RESTORE_RETRY_DELAY_MS = 5_000;
/** TeamHub's recently-used window: a Context parked longer is no longer recent. */
export const RESTART_RESTORE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type RestartRestoreAdmission =
  | { readonly status: "eligible" }
  | { readonly status: "ineligible" }
  | { readonly status: "offline"; readonly computerId: string };

export interface RestartRestoreDeps {
  /** Read-only TeamHub list of recently used Context keys, most recent first. */
  listRecentlyUsed(signal: AbortSignal): Promise<readonly string[]>;
  restore(
    ref: Readonly<ExecutionContextRef>,
  ): Promise<ContextPreparationOutcome>;
  /** Never waits for a Computer: an offline one is parked until it is ready. */
  admit(ref: Readonly<ExecutionContextRef>): Promise<RestartRestoreAdmission>;
  isRecoverableFailure(error: unknown): boolean;
  subscribeLocalComputerReady(
    listener: (computerId: string) => void,
  ): () => void;
  logger: AgentLogger;
  signal: AbortSignal;
  concurrency?: number;
  retryDelayMs?: number;
  windowMs?: number;
}

type AttemptOutcome =
  | { readonly status: "restored" | "skipped" | "failed" | "ineligible" }
  | { readonly status: "offline"; readonly computerId: string };

/**
 * Restores recently used Contexts after an Agent Service restart. Activation
 * only: no input is accepted, no Run starts, and no Computer is woken. Offline
 * Computers are parked and restored once when they become execution-ready,
 * until the recently-used window has passed since this restore started.
 * Each Context's failure is logged once, here; the returned promise never
 * rejects for a Context.
 */
export const restoreRecentlyUsedContexts = async (
  deps: RestartRestoreDeps,
): Promise<void> => {
  const { logger, signal } = deps;
  if (signal.aborted) return;
  const startedAt = performance.now();
  let keys: readonly string[];
  try {
    keys = await deps.listRecentlyUsed(signal);
  } catch (error) {
    if (!signal.aborted)
      logger.log("warn", "manager.restart_restore_list_failed", { error });
    return;
  }
  const limiter = new ConcurrencyLimiter(
    deps.concurrency ?? RESTART_RESTORE_CONCURRENCY,
    "restartRestoreConcurrency",
  );
  const counts = {
    candidateCount: 0,
    restoredCount: 0,
    skippedCount: 0,
    ineligibleCount: 0,
    offlineCount: 0,
    failedCount: 0,
  };
  const count = (status: AttemptOutcome["status"]) => {
    if (status === "restored") counts.restoredCount += 1;
    else if (status === "failed") counts.failedCount += 1;
    else if (status === "ineligible") counts.ineligibleCount += 1;
    else if (status === "offline") counts.offlineCount += 1;
    else counts.skippedCount += 1;
  };
  const refs: Readonly<ExecutionContextRef>[] = [];
  for (const key of keys) {
    try {
      refs.push(decodeExecutionContextKey(key));
    } catch {
      counts.skippedCount += 1;
    }
  }
  counts.candidateCount = refs.length;

  // Offline candidates wait per Computer; one ready event restores each once.
  // The parked set is dropped when the recently-used window has passed.
  const windowMs = deps.windowMs ?? RESTART_RESTORE_WINDOW_MS;
  const parked = new Map<string, Map<string, Readonly<ExecutionContextRef>>>();
  let unsubscribe: (() => void) | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const releaseSubscription = () => {
    unsubscribe?.();
    unsubscribe = undefined;
    clearTimeout(expiry);
    expiry = undefined;
  };
  const stop = () => {
    releaseSubscription();
    parked.clear();
  };
  const ensureSubscription = () => {
    unsubscribe ??= deps.subscribeLocalComputerReady(onComputerReady);
    if (expiry) return;
    expiry = setTimeout(stop, windowMs - (performance.now() - startedAt));
    expiry.unref?.();
  };
  signal.addEventListener("abort", stop, { once: true });

  const attempt = async (
    ref: Readonly<ExecutionContextRef>,
  ): Promise<AttemptOutcome> => {
    for (let attemptNumber = 1; ; attemptNumber += 1) {
      let error: unknown;
      try {
        // Re-admit every attempt: the Agent may have switched placement or
        // Computer since the Context was listed, parked, or last retried.
        const admission = await deps.admit(ref);
        if (signal.aborted) return { status: "skipped" };
        if (admission.status === "ineligible") return { status: "ineligible" };
        if (admission.status === "offline") return admission;
        const outcome = await deps.restore(ref);
        if (outcome.status !== "failed") return { status: outcome.status };
        error = outcome.error;
      } catch (thrown) {
        error = thrown;
      }
      if (signal.aborted) return { status: "skipped" };
      const recoverable =
        attemptNumber === 1 && deps.isRecoverableFailure(error);
      if (recoverable) {
        try {
          await delay(
            deps.retryDelayMs ?? RESTART_RESTORE_RETRY_DELAY_MS,
            undefined,
            {
              signal,
              ref: false,
            },
          );
        } catch {
          return { status: "skipped" };
        }
        continue;
      }
      logger.log("warn", "manager.restart_restore_failed", {
        contextKey: encodeExecutionContextRef(ref),
        error,
      });
      return { status: "failed" };
    }
  };

  const park = (
    ref: Readonly<ExecutionContextRef>,
    computerId: string,
  ): void => {
    if (signal.aborted || performance.now() - startedAt >= windowMs) return;
    let waiting = parked.get(computerId);
    if (!waiting) {
      waiting = new Map();
      parked.set(computerId, waiting);
    }
    waiting.set(encodeExecutionContextRef(ref), ref);
    ensureSubscription();
  };

  // Shared by the first pass and deferred restores: an offline outcome is parked again.
  const settle = (
    ref: Readonly<ExecutionContextRef>,
    outcome: AttemptOutcome,
  ): AttemptOutcome => {
    if (outcome.status === "offline") park(ref, outcome.computerId);
    return outcome;
  };

  function onComputerReady(computerId: string): void {
    const waiting = parked.get(computerId);
    if (!waiting || signal.aborted) return;
    // Removed before dispatch: a later reconnect never repeats this restore.
    parked.delete(computerId);
    if (parked.size === 0) releaseSubscription();
    const deferredStartedAt = performance.now();
    const deferred = [...waiting.values()];
    // One dispatch per ready event: a Context still offline here is parked
    // again under its current Computer and waits for the next ready event.
    // attempt never throws: it logs and reports each Context's failure.
    void Promise.all(
      deferred.map((ref) =>
        limiter.run(async () => settle(ref, await attempt(ref))),
      ),
    ).then(
      (outcomes) => {
        if (signal.aborted) return;
        logger.log("info", "manager.restart_restore_deferred_restored", {
          computerId,
          count: deferred.length,
          restoredCount: outcomes.filter((o) => o.status === "restored").length,
          failedCount: outcomes.filter((o) => o.status === "failed").length,
          durationMs: performance.now() - deferredStartedAt,
        });
      },
      (error: unknown) => {
        logger.log("error", "manager.restart_restore_crashed", { error });
      },
    );
  }

  try {
    await Promise.all(
      refs.map((ref) =>
        limiter.run(async () => {
          if (signal.aborted) return;
          count(settle(ref, await attempt(ref)).status);
        }),
      ),
    );
  } finally {
    if (parked.size === 0) releaseSubscription();
  }
  if (signal.aborted) return;
  logger.log("info", "manager.restart_restore_completed", {
    ...counts,
    durationMs: performance.now() - startedAt,
  });
};

export type ContextPreparationOutcome =
  | { readonly status: "restored" | "skipped" }
  | { readonly status: "failed"; readonly error: unknown };

/** Runs at most `limit` operations at once; waiters go by lowest priority. */
export class ConcurrencyLimiter {
  readonly limit: number;
  #active = 0;
  readonly #waiters: Array<{ resolve: () => void; priority: () => number }> =
    [];

  constructor(limit: number, optionName: string) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new TypeError(`${optionName} must be a positive safe integer`);
    }
    this.limit = limit;
  }

  async run<T>(
    operation: () => Promise<T>,
    priority: () => number = () => 0,
  ): Promise<T> {
    await this.#acquire(priority);
    try {
      return await operation();
    } finally {
      this.#release();
    }
  }

  #acquire(priority: () => number): Promise<void> {
    if (this.#active < this.limit) {
      this.#active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#waiters.push({ resolve, priority }));
  }

  #release(): void {
    // Re-evaluate at dispatch: a message can arrive after startup sorting.
    let selected = 0;
    for (let index = 1; index < this.#waiters.length; index += 1) {
      if (
        this.#waiters[index]!.priority() < this.#waiters[selected]!.priority()
      )
        selected = index;
    }
    const [next] = this.#waiters.splice(selected, 1);
    if (next) {
      next.resolve();
      return;
    }
    this.#active -= 1;
  }
}
