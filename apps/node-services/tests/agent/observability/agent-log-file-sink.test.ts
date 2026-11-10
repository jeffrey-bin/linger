import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import {
  createAgentLogFileSink,
  type AgentLogFileRecord,
} from "../../../src/agent/observability/agent-log-file-sink.js";

class ControlledWorker extends EventEmitter {
  batches: AgentLogFileRecord[][] = [];
  postMessage(batch: AgentLogFileRecord[]) {
    this.batches.push(batch);
  }
  unref() {}
  async terminate() {
    return 0;
  }
  ack(failed = 0) {
    this.emit("message", { failed });
  }
}
const record = (line: string): AgentLogFileRecord => ({
  root: "/logs",
  line,
  maximumBytes: 10_000,
  maximumFiles: 2,
});
const next = () => new Promise<void>((resolve) => setImmediate(resolve));
afterEach(() => vi.restoreAllMocks());

it("bounds queued and in-flight bytes while preserving accepted record order", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const worker = new ControlledWorker();
  const sink = createAgentLogFileSink(() => worker as unknown as Worker);
  const line = "x".repeat(1024 * 1024);
  sink.enqueue(record(`0${line}`));
  await next();
  for (let i = 1; i < 20; i++) sink.enqueue(record(`${i}${line}`));
  expect(worker.batches).toHaveLength(1); // stalled worker mailbox stays bounded
  const draining = sink.flush(1000);
  worker.ack();
  await next();
  worker.ack();
  await next();
  worker.ack();
  await next();
  expect(worker.batches.flat().map(({ line }) => line[0])).toEqual([
    "0",
    "1",
    "2",
  ]);
  expect(await draining).toBe(false); // diagnostic file loss is observable
  expect(warning).toHaveBeenCalled();
  await sink.close(10);
});

it("bounds the number of small records and never grows the worker mailbox", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const worker = new ControlledWorker();
  const sink = createAgentLogFileSink(() => worker as unknown as Worker);
  for (let i = 0; i < 10_000; i++) sink.enqueue(record(String(i)));
  await next();
  expect(worker.batches).toHaveLength(1);
  for (let i = 0; i < 32; i++) {
    worker.ack();
    await next();
  }
  expect(worker.batches.flat()).toHaveLength(4096);
  expect(await sink.close(10)).toBe(false);
});

it("flush waits for the acknowledged write, and timeout never blocks business timers", async () => {
  const worker = new ControlledWorker();
  const sink = createAgentLogFileSink(() => worker as unknown as Worker);
  sink.enqueue(record("first"));
  expect(await sink.flush(10)).toBe(false);
  const done = sink.flush(1000);
  worker.ack();
  expect(await done).toBe(true);
  expect(await sink.close(10)).toBe(true);
});

it.each(["error", "exit"])(
  "isolates worker %s and stops submitting records",
  async (event) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const worker = new ControlledWorker();
    const sink = createAgentLogFileSink(() => worker as unknown as Worker);
    sink.enqueue(record("first"));
    const done = sink.flush(1000);
    worker.emit(event, event === "error" ? new Error("private path") : 1);
    expect(await done).toBe(false);
    sink.enqueue(record("later"));
    await next();
    expect(worker.batches).toHaveLength(1);
    expect(JSON.stringify(warning.mock.calls)).not.toContain("private path");
    await sink.close(10);
  },
);

it("reports write failures and continues with later batches", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const worker = new ControlledWorker();
  const sink = createAgentLogFileSink(() => worker as unknown as Worker);
  sink.enqueue(record("unwritable"));
  await next();
  sink.enqueue(record("writable"));
  worker.ack(1);
  await next();
  worker.ack();
  expect(worker.batches.flat().map(({ line }) => line)).toEqual([
    "unwritable",
    "writable",
  ]);
  expect(await sink.close(10)).toBe(false);
});

it("closes within its budget even when a writer never acknowledges", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const worker = new ControlledWorker();
  const sink = createAgentLogFileSink(() => worker as unknown as Worker);
  sink.enqueue(record("blocked"));
  const waiting = sink.flush(1000);
  expect(await sink.close(10)).toBe(false);
  expect(await waiting).toBe(false);
  sink.enqueue(record("after-close"));
  await next();
  expect(worker.batches).toHaveLength(1);
});
