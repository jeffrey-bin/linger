import { RuntimeConnectionError } from "./realtime-session.js";

const maxWaitingOperationsPerDocument = 128;

export interface DocumentOrderingLease {
  release(): void;
  remainingMilliseconds(): number;
}

interface DocumentOrderingRequest {
  lease: Promise<DocumentOrderingLease>;
  extendDeadline(deadlineAt: number): void;
}

interface WaitingOperation {
  deadlineAt: number;
  queueName: string;
  reject(error: Error): void;
  resolve(lease: DocumentOrderingLease): void;
  timeout: ReturnType<typeof setTimeout>;
}

interface DocumentOrderingState {
  active: boolean;
  waiting: WaitingOperation[];
}

export class DocumentOrderingQueue {
  readonly #documents = new Map<string, DocumentOrderingState>();

  acquireMutation(
    documentId: string,
    timeoutMs: number,
  ): Promise<DocumentOrderingLease> {
    return this.#acquire(documentId, timeoutMs, "Document mutation queue")
      .lease;
  }

  acquireSessionLoad(
    documentId: string,
    timeoutMs: number,
  ): Promise<DocumentOrderingLease> {
    return this.#acquire(documentId, timeoutMs, "Document session load queue")
      .lease;
  }

  #acquire(
    documentId: string,
    timeoutMs: number,
    queueName: string,
  ): DocumentOrderingRequest {
    const deadlineAt = Date.now() + timeoutMs;
    const existing = this.#documents.get(documentId);
    const state = existing ?? { active: false, waiting: [] };
    if (existing === undefined) {
      this.#documents.set(documentId, state);
    }
    if (!state.active) {
      state.active = true;
      return {
        lease: Promise.resolve(this.#lease(documentId, state, deadlineAt)),
        extendDeadline: () => undefined,
      };
    }
    if (state.waiting.length >= maxWaitingOperationsPerDocument) {
      throw new RuntimeConnectionError(`${queueName} is full`);
    }
    let waiting!: WaitingOperation;
    const lease = new Promise<DocumentOrderingLease>((resolve, reject) => {
      waiting = {
        deadlineAt,
        queueName,
        reject,
        resolve,
        timeout: undefined as unknown as ReturnType<typeof setTimeout>,
      };
      waiting.timeout = this.#waitingTimeout(state, waiting);
      state.waiting.push(waiting);
    });
    return {
      lease,
      extendDeadline: (extendedDeadlineAt) => {
        if (
          extendedDeadlineAt <= waiting.deadlineAt ||
          !state.waiting.includes(waiting)
        ) {
          return;
        }
        waiting.deadlineAt = extendedDeadlineAt;
        clearTimeout(waiting.timeout);
        waiting.timeout = this.#waitingTimeout(state, waiting);
      },
    };
  }

  #waitingTimeout(
    state: DocumentOrderingState,
    waiting: WaitingOperation,
  ): ReturnType<typeof setTimeout> {
    return setTimeout(
      () => {
        const index = state.waiting.indexOf(waiting);
        if (index >= 0) {
          state.waiting.splice(index, 1);
        }
        waiting.reject(
          new RuntimeConnectionError(`${waiting.queueName} timed out`),
        );
      },
      Math.max(1, waiting.deadlineAt - Date.now()),
    );
  }

  #lease(
    documentId: string,
    state: DocumentOrderingState,
    deadlineAt: number,
  ): DocumentOrderingLease {
    let released = false;
    return {
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.#advance(documentId, state);
      },
      remainingMilliseconds: () => Math.max(1, deadlineAt - Date.now()),
    };
  }

  #advance(documentId: string, state: DocumentOrderingState): void {
    for (;;) {
      const next = state.waiting.shift();
      if (next === undefined) {
        state.active = false;
        this.#documents.delete(documentId);
        return;
      }
      clearTimeout(next.timeout);
      if (next.deadlineAt <= Date.now()) {
        next.reject(new RuntimeConnectionError(`${next.queueName} timed out`));
        continue;
      }
      next.resolve(this.#lease(documentId, state, next.deadlineAt));
      return;
    }
  }
}
