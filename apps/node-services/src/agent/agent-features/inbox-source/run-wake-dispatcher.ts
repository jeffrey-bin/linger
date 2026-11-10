import { encodeExecutionContextRef } from "../../executor/context-ref.js";
import {
  createAgentLogger,
  type AgentLogger,
} from "../../observability/agent-log.js";
import type {
  RunWakeKind,
  RunWakeTarget,
  RunWakeTargetHandle,
  RunWakeTargetRegistrar,
} from "./types.js";

export interface RunWakeDispatcherOptions {
  /**
   * Claims a Context this process does not hold yet. Binding the claimed
   * Context registers its target, which then receives the pending wake.
   */
  readonly claimContext: (contextKey: string) => Promise<unknown>;
  /** Contexts whose queued Run or Message steer outlived its hint. */
  readonly listWaitingContexts: (
    signal: AbortSignal,
  ) => Promise<readonly string[]>;
  readonly logger?: AgentLogger;
  /** Fallback scan period bounds; each period is drawn between them. */
  readonly scanIntervalMs?: { readonly min: number; readonly max: number };
  readonly random?: () => number;
  readonly now?: () => number;
}

const DEFAULT_SCAN_INTERVAL_MS = Object.freeze({ min: 30_000, max: 60_000 });
// A hint can reach a Context before its binding registers the target: the
// claim materializes it asynchronously. Keep such wakes briefly and bounded.
const EARLY_WAKE_TTL_MS = 30_000;
const EARLY_WAKE_MAX_KEYS = 1_024;

export const RUN_WAKE_LOG_EVENTS = Object.freeze({
  claimFailed: "run_wake.claim_failed",
  scanFailed: "run_wake.scan_failed",
  scanFinished: "run_wake.scan_finished",
  targetFailed: "run_wake.target_failed",
} as const);

/**
 * Routes TeamHub's run.queued and run.steered hints to the bound Context that
 * takes up the work, claiming Contexts this process does not hold. A periodic
 * scan of waiting Runs replaces any hint that was lost.
 */
export class RunWakeDispatcher implements RunWakeTargetRegistrar {
  readonly #claimContext: RunWakeDispatcherOptions["claimContext"];
  readonly #listWaitingContexts: RunWakeDispatcherOptions["listWaitingContexts"];
  readonly #logger: AgentLogger;
  readonly #scanInterval: { readonly min: number; readonly max: number };
  readonly #random: () => number;
  readonly #now: () => number;
  readonly #targets = new Map<string, RunWakeTarget>();
  readonly #earlyWakes = new Map<
    string,
    { readonly kinds: Set<RunWakeKind>; readonly receivedAt: number }
  >();
  readonly #stop = new AbortController();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #scan: Promise<void> | null = null;
  #started = false;

  constructor(options: RunWakeDispatcherOptions) {
    this.#claimContext = options.claimContext;
    this.#listWaitingContexts = options.listWaitingContexts;
    this.#logger =
      options.logger ?? createAgentLogger({ component: "run-wake" });
    const interval = options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
    if (
      !Number.isSafeInteger(interval.min) ||
      interval.min <= 0 ||
      !Number.isSafeInteger(interval.max) ||
      interval.max < interval.min
    )
      throw new TypeError("scanIntervalMs must be a positive ordered range");
    this.#scanInterval = interval;
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? Date.now;
  }

  registerTarget(target: RunWakeTarget): RunWakeTargetHandle {
    const key = encodeExecutionContextRef(target.ref);
    if (this.#targets.has(key))
      throw new Error(`Run wake target already exists for ${key}`);
    this.#targets.set(key, target);
    const early = this.#takeEarlyWake(key);
    for (const kind of early ?? []) this.#deliver(key, target, kind);
    return {
      stop: () => {
        if (this.#targets.get(key) === target) this.#targets.delete(key);
      },
    };
  }

  /** One hint for one Context; never waits for the work it starts. */
  wake(contextKey: string, kind: RunWakeKind): void {
    if (this.#stop.signal.aborted) return;
    const target = this.#targets.get(contextKey);
    if (target) {
      this.#deliver(contextKey, target, kind);
      return;
    }
    this.#recordEarlyWake(contextKey, kind);
    void Promise.resolve()
      .then(() => this.#claimContext(contextKey))
      .catch((error: unknown) =>
        this.#logger.log("warn", RUN_WAKE_LOG_EVENTS.claimFailed, {
          contextKey,
          error,
        }),
      );
  }

  /** Starts the periodic fallback scan. */
  start(): void {
    if (this.#started || this.#stop.signal.aborted) return;
    this.#started = true;
    this.#schedule();
  }

  /**
   * Scans waiting Runs now, for example after the hint stream reconnects. A
   * scan already running covers this request.
   */
  scanNow(): Promise<void> {
    if (this.#stop.signal.aborted) return Promise.resolve();
    this.#scan ??= this.#runScan().finally(() => {
      this.#scan = null;
    });
    return this.#scan;
  }

  close(): void {
    this.#stop.abort();
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#targets.clear();
    this.#earlyWakes.clear();
  }

  async #runScan(): Promise<void> {
    let keys: readonly string[];
    try {
      keys = await this.#listWaitingContexts(this.#stop.signal);
    } catch (error) {
      if (!this.#stop.signal.aborted)
        this.#logger.log("warn", RUN_WAKE_LOG_EVENTS.scanFailed, { error });
      return;
    }
    // A waiting Context may hold a queued Run or a steer, so its target
    // reads the work state instead of claiming on trust.
    for (const key of keys) this.wake(key, "steered");
    this.#logger.log("debug", RUN_WAKE_LOG_EVENTS.scanFinished, {
      waitingContextCount: keys.length,
    });
  }

  #schedule(): void {
    if (this.#stop.signal.aborted) return;
    const { min, max } = this.#scanInterval;
    const delayMs = min + Math.floor(this.#random() * (max - min + 1));
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.scanNow().finally(() => this.#schedule());
    }, delayMs);
    this.#timer.unref?.();
  }

  #deliver(contextKey: string, target: RunWakeTarget, kind: RunWakeKind) {
    try {
      target.wake(kind);
    } catch (error) {
      this.#logger.log("warn", RUN_WAKE_LOG_EVENTS.targetFailed, {
        contextKey,
        kind,
        error,
      });
    }
  }

  #recordEarlyWake(contextKey: string, kind: RunWakeKind): void {
    const now = this.#now();
    this.#purgeEarlyWakes(now);
    const existing = this.#earlyWakes.get(contextKey);
    if (existing) {
      existing.kinds.add(kind);
      return;
    }
    if (this.#earlyWakes.size >= EARLY_WAKE_MAX_KEYS) {
      const oldest = this.#earlyWakes.keys().next().value;
      if (oldest !== undefined) this.#earlyWakes.delete(oldest);
    }
    this.#earlyWakes.set(contextKey, {
      kinds: new Set([kind]),
      receivedAt: now,
    });
  }

  #takeEarlyWake(contextKey: string): ReadonlySet<RunWakeKind> | undefined {
    this.#purgeEarlyWakes(this.#now());
    const wake = this.#earlyWakes.get(contextKey);
    this.#earlyWakes.delete(contextKey);
    return wake?.kinds;
  }

  #purgeEarlyWakes(now: number): void {
    // Map insertion order is first-hint order.
    for (const [key, wake] of this.#earlyWakes) {
      if (now - wake.receivedAt < EARLY_WAKE_TTL_MS) break;
      this.#earlyWakes.delete(key);
    }
  }
}
