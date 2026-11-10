import { Worker } from "node:worker_threads";

import { serviceModule } from "../paths.js";

import type { DocumentComputations } from "./computation-worker.js";
import { documentLogger } from "./log.js";

export type DocumentModelErrorCode =
  | "payload_too_large"
  | "unsupported_document"
  | "validation_failed";

export class DocumentComputationError extends Error {
  constructor(
    readonly code: DocumentModelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DocumentComputationError";
  }
}

export interface DocumentComputation {
  run<K extends keyof DocumentComputations>(
    name: K,
    input: Parameters<DocumentComputations[K]>[0],
  ): Promise<Awaited<ReturnType<DocumentComputations[K]>>>;
  close(): Promise<void>;
}

type ComputationResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; code?: DocumentModelErrorCode; message: string };

interface Task {
  name: keyof DocumentComputations;
  input: unknown;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

interface Slot {
  worker: Worker;
  active?: { id: number; task: Task };
  idleTimer?: NodeJS.Timeout;
  retired: boolean;
}

// An idle worker holds a whole V8 isolate with BlockNote, Yjs and JSDOM, so it
// exits after this long without work and the next task starts a fresh one.
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export function createDocumentComputationPool(options: {
  size: number;
  workerUrl?: URL;
  reportError?: (message: string) => void;
  respawnDelayMs?: number;
  idleTimeoutMs?: number;
}): DocumentComputation {
  if (!Number.isSafeInteger(options.size) || options.size < 1) {
    throw new TypeError("Document computation pool size must be positive");
  }
  const reportError =
    options.reportError ??
    ((message: string) =>
      documentLogger().log("error", "document.computation_pool_error", {
        message,
      }));
  const workerUrl = options.workerUrl ?? defaultWorkerUrl();
  const execArgv = workerExecArgv(workerUrl);
  const respawnDelayMs = options.respawnDelayMs ?? 1000;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const slots: Slot[] = [];
  const queue: Task[] = [];
  const respawnTimers = new Set<NodeJS.Timeout>();
  let nextId = 0;
  let closing: Promise<void> | undefined;

  function spawn(): Slot {
    const worker = new Worker(workerUrl, { execArgv });
    worker.unref();
    const slot: Slot = { worker, retired: false };
    worker.on("message", (response: ComputationResponse) =>
      settle(slot, response),
    );
    worker.on("error", (error: Error) => retire(slot, error.message));
    worker.on("exit", (code) => retire(slot, `exited with code ${code}`));
    slots.push(slot);
    return slot;
  }

  function settle(slot: Slot, response: ComputationResponse): void {
    const active = slot.active;
    if (active === undefined || active.id !== response.id) {
      return;
    }
    slot.active = undefined;
    if (response.ok) {
      active.task.resolve(response.result);
    } else if (response.code !== undefined) {
      active.task.reject(
        new DocumentComputationError(response.code, response.message),
      );
    } else {
      reportError(
        `Document computation ${active.task.name} failed: ${response.message}`,
      );
      active.task.reject(new Error(response.message));
    }
    dispatch();
  }

  function retire(slot: Slot, reason: string): void {
    if (slot.retired) {
      return;
    }
    slot.retired = true;
    clearTimeout(slot.idleTimer);
    slots.splice(slots.indexOf(slot), 1);
    const active = slot.active;
    slot.active = undefined;
    void slot.worker.terminate();
    reportError(
      `Document computation worker ${active === undefined ? "idle" : `running ${active.task.name}`} failed: ${reason}`,
    );
    active?.task.reject(new Error("Document computation failed"));
    scheduleRespawn();
    dispatch();
  }

  // Spawning waits while a failure delay is pending, so a worker that crashes
  // while loading cannot restart in a hot loop.
  function scheduleRespawn(): void {
    const timer = setTimeout(() => {
      respawnTimers.delete(timer);
      dispatch();
    }, respawnDelayMs);
    timer.unref();
    respawnTimers.add(timer);
  }

  function retireIdle(slot: Slot): void {
    slot.idleTimer = undefined;
    if (closing !== undefined || slot.retired || slot.active !== undefined) {
      return;
    }
    // Retire before terminating so the exit event is not treated as a failure.
    slot.retired = true;
    slots.splice(slots.indexOf(slot), 1);
    void slot.worker.terminate();
    documentLogger().log("info", "document.computation_worker_idle_retired", {
      idle_timeout_ms: idleTimeoutMs,
    });
  }

  function assign(slot: Slot, task: Task): void {
    clearTimeout(slot.idleTimer);
    slot.idleTimer = undefined;
    const id = ++nextId;
    slot.active = { id, task };
    try {
      slot.worker.postMessage({ id, name: task.name, input: task.input });
    } catch (error) {
      slot.active = undefined;
      reportError(`Document computation ${task.name} input was not sent`);
      task.reject(
        error instanceof Error
          ? error
          : new Error("Document computation input was not sent"),
      );
    }
  }

  function dispatch(): void {
    if (closing !== undefined) {
      return;
    }
    for (const slot of slots) {
      if (queue.length === 0) {
        break;
      }
      if (slot.active === undefined) {
        assign(slot, queue.shift()!);
      }
    }
    while (
      queue.length > 0 &&
      slots.length < options.size &&
      respawnTimers.size === 0
    ) {
      assign(spawn(), queue.shift()!);
    }
    for (const slot of slots) {
      if (slot.active === undefined && slot.idleTimer === undefined) {
        slot.idleTimer = setTimeout(() => retireIdle(slot), idleTimeoutMs);
        slot.idleTimer.unref();
      }
    }
  }

  function shutdown(): Promise<void> {
    const closed = new Error("Document computation pool is closed");
    for (const timer of respawnTimers) {
      clearTimeout(timer);
    }
    respawnTimers.clear();
    for (const task of queue.splice(0)) {
      task.reject(closed);
    }
    const retiring = slots.splice(0);
    for (const slot of retiring) {
      slot.retired = true;
      clearTimeout(slot.idleTimer);
      slot.active?.task.reject(closed);
      slot.active = undefined;
    }
    return Promise.all(retiring.map((slot) => slot.worker.terminate())).then(
      () => undefined,
    );
  }

  return {
    run<K extends keyof DocumentComputations>(
      name: K,
      input: Parameters<DocumentComputations[K]>[0],
    ): Promise<Awaited<ReturnType<DocumentComputations[K]>>> {
      if (closing !== undefined) {
        return Promise.reject(new Error("Document computation pool is closed"));
      }
      return new Promise((resolve, reject) => {
        queue.push({
          name,
          input,
          resolve: resolve as (result: unknown) => void,
          reject,
        });
        dispatch();
      });
    },
    close(): Promise<void> {
      closing ??= shutdown();
      return closing;
    },
  };
}

function defaultWorkerUrl(): URL {
  return serviceModule("document/computation-worker");
}

/** Lets a TypeScript worker module load when the parent runs without tsx. */
export function workerExecArgv(workerUrl: URL): string[] {
  const argv = process.execArgv;
  if (!workerUrl.pathname.endsWith(".ts") || loadsTsx(argv)) {
    return argv;
  }
  return [...argv, "--import", "tsx"];
}

function loadsTsx(argv: string[]): boolean {
  return argv.some(
    (arg, index) =>
      (argv[index - 1] === "--import" && arg.includes("tsx")) ||
      (arg.startsWith("--import=") && arg.includes("tsx")),
  );
}
