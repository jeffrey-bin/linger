interface QueuedAgentOperation {
  key: string;
  operation: () => Promise<unknown>;
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

interface AgentQueue {
  idle: Promise<void>;
  queued: QueuedAgentOperation[];
  queuedByKey: Map<string, QueuedAgentOperation>;
  resolveIdle: () => void;
  running: boolean;
}

/**
 * Serializes synchronization snapshots for one Agent. A repeated trigger that
 * arrives while its key is running is coalesced into one follow-up snapshot,
 * so the follow-up re-reads the latest authoritative source versions.
 */
export class ChunkSyncCoordinator {
  readonly #agents = new Map<string, AgentQueue>();

  constructor(readonly sourceConcurrency: number) {
    if (!Number.isSafeInteger(sourceConcurrency) || sourceConcurrency < 1) {
      throw new TypeError("Chunk source concurrency must be positive");
    }
  }

  runAgent<T>(
    agentId: string,
    operationKey: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const state = this.#agents.get(agentId) ?? this.#newAgentQueue(agentId);
    const existing = state.queuedByKey.get(operationKey);
    if (existing) return existing.promise as Promise<T>;

    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<unknown>((accept, decline) => {
      resolve = accept;
      reject = decline;
    });
    const job: QueuedAgentOperation = {
      key: operationKey,
      operation,
      promise,
      reject,
      resolve,
    };
    state.queued.push(job);
    state.queuedByKey.set(operationKey, job);
    this.#drain(agentId, state);
    return promise as Promise<T>;
  }

  async mapSources<T, R>(
    sources: readonly T[],
    operation: (source: T, index: number) => Promise<R>,
  ): Promise<R[]> {
    const results = new Array<R>(sources.length);
    let next = 0;
    const workers = Array.from(
      { length: Math.min(this.sourceConcurrency, sources.length) },
      async () => {
        while (next < sources.length) {
          const index = next;
          next += 1;
          results[index] = await operation(sources[index]!, index);
        }
      },
    );
    await Promise.all(workers);
    return results;
  }

  async idle(): Promise<void> {
    await Promise.all([...this.#agents.values()].map(({ idle }) => idle));
  }

  #newAgentQueue(agentId: string): AgentQueue {
    let resolveIdle!: () => void;
    const idle = new Promise<void>((resolve) => {
      resolveIdle = resolve;
    });
    const state: AgentQueue = {
      idle,
      queued: [],
      queuedByKey: new Map(),
      resolveIdle,
      running: false,
    };
    this.#agents.set(agentId, state);
    return state;
  }

  #drain(agentId: string, state: AgentQueue): void {
    if (state.running) return;
    const job = state.queued.shift();
    if (!job) {
      state.resolveIdle();
      if (this.#agents.get(agentId) === state) this.#agents.delete(agentId);
      return;
    }
    state.running = true;
    state.queuedByKey.delete(job.key);
    void job
      .operation()
      .then(job.resolve, job.reject)
      .finally(() => {
        state.running = false;
        this.#drain(agentId, state);
      });
  }
}
