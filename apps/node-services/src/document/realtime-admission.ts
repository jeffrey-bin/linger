export interface RealtimeAdmissionLimits {
  authenticationTimeoutMs: number;
  maxConcurrentRecoveries: number;
  maxConnections: number;
  maxConnectionsPerSession: number;
  maxPendingDocumentsPerConnection: number;
  maxResidentDocuments: number;
  maxUnauthenticatedQueueBytes: number;
  maxUnauthenticatedQueueMessages: number;
}

export const defaultRealtimeAdmissionLimits: RealtimeAdmissionLimits = {
  authenticationTimeoutMs: 15_000,
  maxConcurrentRecoveries: 8,
  maxConnections: 1_000,
  maxConnectionsPerSession: 4,
  maxPendingDocumentsPerConnection: 4,
  maxResidentDocuments: 200,
  maxUnauthenticatedQueueBytes: 1 << 20,
  maxUnauthenticatedQueueMessages: 64,
};

export class RealtimeAdmissionError extends Error {}

export interface RealtimeConnectionAdmission {
  readonly signal: AbortSignal;
  markEstablished(): void;
  promote(sessionId: string): void;
  release(): void;
  runRecovery<T>(operation: () => Promise<T>): Promise<T>;
}

interface ConnectionState {
  abortController: AbortController;
  sessionId?: string;
  timeout: ReturnType<typeof setTimeout>;
}

interface RecoveryWaiter {
  reject(error: Error): void;
  resolve(): void;
  signal?: AbortSignal;
  abort?: () => void;
}

export class RealtimeAdmissionController {
  readonly limits: RealtimeAdmissionLimits;
  readonly #connections = new Map<number, ConnectionState>();
  readonly #residentDocuments = new Set<string>();
  readonly #sessionConnections = new Map<string, number>();
  readonly #recoveryWaiters: RecoveryWaiter[] = [];
  #activeRecoveries = 0;
  #nextConnectionId = 1;

  constructor(limits: Partial<RealtimeAdmissionLimits> = {}) {
    this.limits = { ...defaultRealtimeAdmissionLimits, ...limits };
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new TypeError(`${name} must be a positive integer`);
      }
    }
  }

  reserveConnection(): RealtimeConnectionAdmission {
    if (this.#connections.size >= this.limits.maxConnections) {
      throw new RealtimeAdmissionError(
        "Document Runtime connection capacity is exhausted",
      );
    }
    const id = this.#nextConnectionId++;
    const abortController = new AbortController();
    const timeout = setTimeout(
      () => this.#releaseConnection(id),
      this.limits.authenticationTimeoutMs,
    );
    timeout.unref();
    this.#connections.set(id, { abortController, timeout });
    let released = false;
    return {
      signal: abortController.signal,
      markEstablished: () => {
        const state = this.#requireConnection(id);
        clearTimeout(state.timeout);
      },
      promote: (sessionId) => this.#promoteConnection(id, sessionId),
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.#releaseConnection(id);
      },
      runRecovery: (operation) =>
        this.runRecovery(operation, abortController.signal),
    };
  }

  reserveResidentDocument(documentId: string): { release(): void } {
    if (this.#residentDocuments.has(documentId)) {
      return { release: () => undefined };
    }
    if (this.#residentDocuments.size >= this.limits.maxResidentDocuments) {
      throw new RealtimeAdmissionError(
        "Document Runtime resident Document capacity is exhausted",
      );
    }
    this.#residentDocuments.add(documentId);
    let released = false;
    return {
      release: () => {
        if (!released) {
          released = true;
          this.#residentDocuments.delete(documentId);
        }
      },
    };
  }

  async runRecovery<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    await this.#acquireRecovery(signal);
    try {
      if (signal?.aborted) {
        throw new RealtimeAdmissionError(
          "Document Runtime connection admission expired",
        );
      }
      return await operation();
    } finally {
      this.#releaseRecovery();
    }
  }

  // One connection token is one Document session; an account may open as
  // many sessions as the Runtime-wide connection limit allows.
  #promoteConnection(id: number, sessionId: string): void {
    const state = this.#requireConnection(id);
    if (state.sessionId !== undefined) {
      throw new RealtimeAdmissionError(
        "Document Runtime connection admission was already authenticated",
      );
    }
    if (
      (this.#sessionConnections.get(sessionId) ?? 0) >=
      this.limits.maxConnectionsPerSession
    ) {
      throw new RealtimeAdmissionError(
        "Document Runtime session connection capacity is exhausted",
      );
    }
    state.sessionId = sessionId;
    increment(this.#sessionConnections, sessionId);
  }

  #requireConnection(id: number): ConnectionState {
    const state = this.#connections.get(id);
    if (state === undefined) {
      throw new RealtimeAdmissionError(
        "Document Runtime connection admission expired",
      );
    }
    return state;
  }

  #releaseConnection(id: number): void {
    const state = this.#connections.get(id);
    if (state === undefined) {
      return;
    }
    this.#connections.delete(id);
    clearTimeout(state.timeout);
    state.abortController.abort();
    if (state.sessionId !== undefined) {
      decrement(this.#sessionConnections, state.sessionId);
    }
  }

  #acquireRecovery(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(
        new RealtimeAdmissionError(
          "Document Runtime connection admission expired",
        ),
      );
    }
    if (this.#activeRecoveries < this.limits.maxConcurrentRecoveries) {
      this.#activeRecoveries += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter: RecoveryWaiter = {
        resolve,
        reject,
        ...(signal && { signal }),
      };
      if (signal !== undefined) {
        waiter.abort = () => {
          const index = this.#recoveryWaiters.indexOf(waiter);
          if (index >= 0) {
            this.#recoveryWaiters.splice(index, 1);
          }
          reject(
            new RealtimeAdmissionError(
              "Document Runtime connection admission expired",
            ),
          );
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      this.#recoveryWaiters.push(waiter);
    });
  }

  #releaseRecovery(): void {
    const waiter = this.#recoveryWaiters.shift();
    if (waiter === undefined) {
      this.#activeRecoveries -= 1;
      return;
    }
    if (waiter.signal !== undefined && waiter.abort !== undefined) {
      waiter.signal.removeEventListener("abort", waiter.abort);
    }
    waiter.resolve();
  }
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function decrement(counts: Map<string, number>, key: string): void {
  const count = counts.get(key);
  if (count === undefined || count <= 1) {
    counts.delete(key);
    return;
  }
  counts.set(key, count - 1);
}
