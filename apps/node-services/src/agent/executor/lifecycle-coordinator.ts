import {
  encodeExecutionContextRef,
  type ExecutionContextRef,
} from "./context-ref.js";

type LifecycleAccess = "shared" | "exclusive";

interface LifecycleWaiter {
  readonly access: LifecycleAccess;
  readonly resolve: () => void;
}

interface AgentLifecycleState {
  activeReaders: number;
  writerActive: boolean;
  readonly queue: LifecycleWaiter[];
}

/**
 * Serialized admission boundary owned by ONE bound Context instance: the
 * final instance/run/gate checks, the durable accept, and its synchronous
 * accepted-fact observers run as one FIFO section. Invalidation is itself an
 * enqueued operation, so it linearizes after every already-queued admission
 * and before later ones.
 *
 * Deliberately generic (tail + run only): publication state, the bind-time
 * cell, and FeatureContext invalidation belong to the Manager. This tail
 * never nests Agent/runContext lifecycle locks, so a queued admission cannot
 * deadlock against a stop path that holds lifecycle access while it awaits
 * invalidation.
 */
export class ContextAdmission {
  #tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class AgentLifecycleCoordinator {
  readonly #states = new Map<string, AgentLifecycleState>();
  readonly #contextTails = new Map<string, Promise<void>>();

  run<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    return this.#runWithAccess(agentId, "exclusive", operation);
  }

  runShared<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    return this.#runWithAccess(agentId, "shared", operation);
  }

  runContext<T>(
    ref: ExecutionContextRef,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = encodeExecutionContextRef(ref);
    const previous = this.#contextTails.get(key) ?? Promise.resolve();
    const run = () => this.runShared(ref.agentId, operation);
    const result = previous.then(run, run);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#contextTails.set(key, tail);
    void tail.then(() => {
      if (this.#contextTails.get(key) === tail) {
        this.#contextTails.delete(key);
      }
    });
    return result;
  }

  async #runWithAccess<T>(
    agentId: string,
    access: LifecycleAccess,
    operation: () => Promise<T>,
  ): Promise<T> {
    const state = this.#state(agentId);
    await new Promise<void>((resolve) => {
      state.queue.push({ access, resolve });
      this.#drain(state);
    });
    try {
      return await operation();
    } finally {
      if (access === "exclusive") {
        state.writerActive = false;
      } else {
        state.activeReaders -= 1;
      }
      this.#drain(state);
      if (
        !state.writerActive &&
        state.activeReaders === 0 &&
        state.queue.length === 0
      ) {
        this.#states.delete(agentId);
      }
    }
  }

  #state(agentId: string): AgentLifecycleState {
    const existing = this.#states.get(agentId);
    if (existing) return existing;
    const created: AgentLifecycleState = {
      activeReaders: 0,
      writerActive: false,
      queue: [],
    };
    this.#states.set(agentId, created);
    return created;
  }

  #drain(state: AgentLifecycleState): void {
    if (state.writerActive || state.queue.length === 0) return;
    const next = state.queue[0]!;
    if (next.access === "exclusive") {
      if (state.activeReaders > 0) return;
      state.queue.shift();
      state.writerActive = true;
      next.resolve();
      return;
    }
    while (state.queue[0]?.access === "shared") {
      const reader = state.queue.shift()!;
      state.activeReaders += 1;
      reader.resolve();
    }
  }
}
