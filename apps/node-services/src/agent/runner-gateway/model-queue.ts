import { logAgentEvent } from "../observability/agent-log.js";
import type {
  LocalComputerModel,
  LocalRuntimeType,
} from "./local-computer-management.js";

/** One Runtime on one Computer, which model work queues for. */
export interface ModelEndpoint {
  readonly computerId: string;
  readonly runtimeType: LocalRuntimeType;
}

export interface ModelWork {
  /** Lowest first; see model-tasks. */
  readonly priority: number;
  /** What the work is: a call kind, a Run kind or compaction. Only logged. */
  readonly kind: string;
  /** Names the work in the log. */
  readonly key: string;
}

export interface ModelLeaseResult {
  readonly outcome: string;
  /** Token usage as the Runtime reported it; only logged. */
  readonly usage?: unknown;
}

export interface ModelLease {
  /** Frees the place; later calls do nothing. */
  release(result: ModelLeaseResult): void;
}

/** Units one endpoint on the signed-in account runs at once. */
const SUBSCRIPTION_CONCURRENCY = 10;

/**
 * Units an endpoint runs at once. A Runtime whose every model is on the
 * signed-in account serves several. One that reaches a model through a
 * gateway, usually one local model every Agent shares and that answers one
 * more request only by slowing the others, serves one, as does a Runtime
 * whose models are unknown.
 */
export function endpointConcurrency(
  models: readonly Pick<LocalComputerModel, "link">[] | undefined,
): number {
  return models?.length && models.every(({ link }) => link === "subscription")
    ? SUBSCRIPTION_CONCURRENCY
    : 1;
}

interface Waiter {
  readonly priority: number;
  readonly seq: number;
  readonly signal: AbortSignal;
  readonly admit: () => void;
  readonly reject: (error: unknown) => void;
  readonly onAbort: () => void;
}

interface EndpointState {
  readonly key: string;
  readonly endpoint: ModelEndpoint;
  active: number;
  readonly waiting: Waiter[];
}

/**
 * Admits model work per endpoint. A Run's Operation, a one-shot call, a
 * chain and a compaction are each one unit. Units start lowest priority
 * first, in arrival order within one priority, while the endpoint runs fewer
 * than its concurrency; a running unit is never interrupted. Admission only;
 * it never picks, orders or retries a Run.
 */
export class ModelQueue {
  readonly #endpoints = new Map<string, EndpointState>();
  #seq = 0;

  constructor(
    private readonly concurrency: (endpoint: ModelEndpoint) => number,
  ) {}

  /** Waits for the work's turn; aborting stops waiting. */
  async acquire(
    endpoint: ModelEndpoint,
    work: ModelWork,
    signal: AbortSignal,
  ): Promise<ModelLease> {
    signal.throwIfAborted();
    const queuedAt = Date.now();
    const state = this.#state(endpoint);
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = state.waiting.indexOf(waiter);
        if (index >= 0) state.waiting.splice(index, 1);
        this.#prune(state);
        reject(signal.reason);
      };
      const waiter: Waiter = {
        priority: work.priority,
        seq: this.#seq++,
        signal,
        admit: () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
        reject,
        onAbort,
      };
      state.waiting.push(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
      this.#drain(state);
    });
    return this.#lease(state, work, queuedAt);
  }

  /** The Computer is gone; work waiting for it fails with error. */
  rejectWaiters(computerId: string, error: unknown): void {
    for (const state of [...this.#endpoints.values()]) {
      if (state.endpoint.computerId !== computerId) continue;
      for (const waiter of state.waiting.splice(0)) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
        waiter.reject(error);
      }
      this.#prune(state);
    }
  }

  #state(endpoint: ModelEndpoint): EndpointState {
    const key = `${endpoint.computerId}\n${endpoint.runtimeType}`;
    let state = this.#endpoints.get(key);
    if (!state) {
      state = { key, endpoint, active: 0, waiting: [] };
      this.#endpoints.set(key, state);
    }
    return state;
  }

  /** Admission already counted the unit as active. */
  #lease(state: EndpointState, work: ModelWork, queuedAt: number): ModelLease {
    const startedAt = Date.now();
    let released = false;
    return {
      release: (result) => {
        if (released) return;
        released = true;
        state.active -= 1;
        logAgentEvent("info", "model_queue.finished", {
          kind: work.kind,
          key: work.key.slice(0, 200),
          computer_id: state.endpoint.computerId,
          runtime_type: state.endpoint.runtimeType,
          outcome: result.outcome,
          queued_ms: startedAt - queuedAt,
          run_ms: Date.now() - startedAt,
          ...(result.usage === undefined ? {} : { usage: result.usage }),
        });
        this.#drain(state);
      },
    };
  }

  #drain(state: EndpointState): void {
    state.waiting.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    const limit = this.concurrency(state.endpoint);
    while (state.active < limit && state.waiting.length > 0) {
      // Counted now, so the next waiter sees the place taken.
      state.active += 1;
      state.waiting.shift()!.admit();
    }
    this.#prune(state);
  }

  #prune(state: EndpointState): void {
    if (
      state.active === 0 &&
      state.waiting.length === 0 &&
      this.#endpoints.get(state.key) === state
    )
      this.#endpoints.delete(state.key);
  }
}
