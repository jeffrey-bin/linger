import { Worker } from "node:worker_threads";

import { serviceModule } from "../paths.js";

import type { JsonLogger } from "@linger/service-kit/node";

import { workerExecArgv } from "./computation-pool.js";

const firstRestartDelayMs = 1_000;
const maxRestartDelayMs = 60_000;

/**
 * Starts the Document Runtime on its own worker thread. The runtime installs
 * jsdom globals and replaces the global Request/Response, which must not reach
 * the host's other roles. A thread that fails is rebuilt in the
 * background, so the Document Runtime never stops the process; only
 * a configuration error at startup fails it.
 */
export async function startDocumentService(options: {
  logger: JsonLogger;
  createThread?: () => Worker;
}): Promise<{ stop(): Promise<void> }> {
  const createThread = options.createThread ?? createDocumentThread;
  let current: Worker | undefined;
  let launching: Promise<void> | undefined;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let restartDelayMs = firstRestartDelayMs;
  let stopping = false;

  const restartLater = (error: unknown): void => {
    if (stopping) return;
    options.logger.log("error", "document.thread_failed", {
      error,
      restart_in_ms: restartDelayMs,
    });
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      launching = launch()
        .catch(restartLater)
        .finally(() => {
          launching = undefined;
        });
    }, restartDelayMs);
    restartDelayMs = Math.min(restartDelayMs * 2, maxRestartDelayMs);
  };

  const launch = async (): Promise<void> => {
    const thread = createThread();
    try {
      await nextReply(thread, "startup");
    } catch (error) {
      await thread.terminate();
      throw error;
    }
    const startedAt = Date.now();
    current = thread;
    // The listeners stay attached: a thread can report an error and then exit.
    const fail = (error: Error): void => {
      if (current !== thread) return;
      current = undefined;
      if (Date.now() - startedAt >= maxRestartDelayMs) {
        restartDelayMs = firstRestartDelayMs;
      }
      void thread.terminate().then(() => restartLater(error));
    };
    thread.on("error", fail);
    thread.on("exit", (code) =>
      fail(new Error(`Document Runtime thread exited with code ${code}`)),
    );
  };

  try {
    await launch();
  } catch (error) {
    // A configuration error fails every attempt the same way.
    if (error instanceof TypeError) throw error;
    restartLater(error);
  }
  return {
    async stop() {
      stopping = true;
      clearTimeout(restartTimer);
      await launching;
      const thread = current;
      current = undefined;
      if (thread === undefined) return;
      thread.postMessage("drain");
      const status = await nextReply(thread, "drain");
      await thread.terminate();
      if (status !== 0) {
        throw new Error("Document Runtime drain failed");
      }
    },
  };
}

function createDocumentThread(): Worker {
  const workerUrl = serviceModule("document/worker");
  return new Worker(workerUrl, { execArgv: workerExecArgv(workerUrl) });
}

function nextReply(worker: Worker, phase: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const settle = (finish: () => void): void => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
      finish();
    };
    const onMessage = (message: unknown): void =>
      settle(() => resolve(message));
    const onError = (error: Error): void => settle(() => reject(error));
    const onExit = (code: number): void =>
      settle(() =>
        reject(
          new Error(
            `Document Runtime thread exited with code ${code} during ${phase}`,
          ),
        ),
      );
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
  });
}
