import { Worker } from "node:worker_threads";

import { serviceModule } from "../../paths.js";

export interface AgentLogFileRecord {
  readonly root: string;
  readonly agentId?: string;
  readonly line: string;
  readonly maximumBytes: number;
  readonly maximumFiles: number;
}

// Count both queued and in-flight records. Only one batch may enter the worker
// mailbox, so a stalled network filesystem cannot grow another hidden queue.
const MAX_PENDING_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_RECORDS = 4096;
const MAX_BATCH_BYTES = 64 * 1024;

export const createAgentLogFileSink = (
  createWorker = () =>
    new Worker(serviceModule("agent/observability/agent-log-file-worker.mjs")),
) => {
  let worker: Worker | undefined;
  let closed = false;
  let failed = false;
  let pendingBytes = 0;
  let pendingCount = 0;
  let inFlight: { bytes: number; count: number } | undefined;
  let queue: { record: AgentLogFileRecord; bytes: number }[] = [];
  let scheduled = false;
  let dropped = 0;
  let reported = false;
  const waiters = new Set<() => void>();

  const notify = () => {
    for (const resolve of waiters) resolve();
  };
  const report = (reason: string, count: number) => {
    // Never send sink diagnostics through the sink itself or include raw paths
    // and filesystem errors, which may contain sensitive identifiers.
    try {
      console.warn(
        JSON.stringify({ event: "agent_log.file_loss", reason, count }),
      );
    } catch {
      /* terminal failure must not affect business work */
    }
  };
  const fail = () => {
    if (closed || failed) return;
    failed = true;
    dropped += pendingCount;
    report("worker_unavailable", pendingCount);
    queue = [];
    pendingBytes = pendingCount = 0;
    inFlight = undefined;
    void worker?.terminate().catch(() => undefined);
    // terminate() refs the Worker again; release that reference after calling it.
    worker?.unref();
    notify();
  };
  const dispatch = () => {
    scheduled = false;
    if (closed || failed || inFlight || queue.length === 0) return;
    try {
      if (!worker) {
        worker = createWorker();
        worker.on("error", fail);
        worker.on("exit", fail);
        worker.on("message", ({ failed: failures }: { failed: number }) => {
          if (closed || failed || !inFlight) return;
          if (failures > 0) {
            dropped += failures;
            report("write_failed", failures);
          }
          pendingBytes -= inFlight.bytes;
          pendingCount -= inFlight.count;
          inFlight = undefined;
          if (pendingCount === 0) {
            worker!.unref();
            reported = false;
            notify();
          }
          schedule();
        });
        worker.unref();
      }
      const batch: AgentLogFileRecord[] = [];
      let bytes = 0;
      while (queue.length > 0 && batch.length < 128) {
        const next = queue[0]!;
        if (batch.length > 0 && bytes + next.bytes > MAX_BATCH_BYTES) break;
        queue.shift();
        batch.push(next.record);
        bytes += next.bytes;
      }
      inFlight = { bytes, count: batch.length };
      worker.postMessage(batch);
    } catch {
      fail();
    }
  };
  const schedule = () => {
    if (scheduled || inFlight || queue.length === 0 || closed || failed) return;
    scheduled = true;
    setImmediate(dispatch).unref();
  };

  return {
    enqueue(record: AgentLogFileRecord): void {
      if (closed || failed) return;
      const bytes =
        Buffer.byteLength(record.line) +
        Buffer.byteLength(record.root) +
        Buffer.byteLength(record.agentId ?? "") +
        64;
      if (
        pendingBytes + bytes > MAX_PENDING_BYTES ||
        pendingCount >= MAX_PENDING_RECORDS
      ) {
        dropped++;
        if (!reported) {
          report("buffer_full", dropped);
          reported = true;
        }
        return;
      }
      pendingBytes += bytes;
      pendingCount++;
      queue.push({ record, bytes });
      schedule();
    },
    async flush(timeoutMs: number): Promise<boolean> {
      if (pendingCount === 0) return !failed && dropped === 0;
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          waiters.delete(done);
          resolve(pendingCount === 0 && !failed && dropped === 0);
        };
        const timer = setTimeout(done, timeoutMs);
        waiters.add(done);
        // The deadline keeps the process alive, but a stuck worker never does.
        dispatch();
      });
    },
    async close(timeoutMs: number): Promise<boolean> {
      const complete = await this.flush(timeoutMs);
      closed = true;
      if (pendingCount > 0) report("drain_timeout", pendingCount);
      dropped += pendingCount;
      queue = [];
      pendingBytes = pendingCount = 0;
      inFlight = undefined;
      void worker?.terminate().catch(() => undefined);
      worker?.unref();
      notify();
      return complete;
    },
  };
};
