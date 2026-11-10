import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  endpointConcurrency,
  ModelQueue,
  type ModelEndpoint,
  type ModelLease,
} from "../../../src/agent/runner-gateway/model-queue.js";
import {
  COMPACTION_PRIORITY,
  modelCallPolicies,
  RUN_PRIORITY,
  type ModelCallKind,
} from "../../../src/model-tasks.js";

const codex: ModelEndpoint = {
  computerId: "runner-local",
  runtimeType: "codex",
};
const claude: ModelEndpoint = {
  computerId: "runner-local",
  runtimeType: "claude",
};
const done = { outcome: "completed" };

const call = (kind: ModelCallKind, key: string = kind) => ({
  priority: modelCallPolicies[kind].priority,
  kind,
  key,
});
const run = (key = "run") => ({ priority: RUN_PRIORITY, kind: "chat", key });
const compaction = {
  priority: COMPACTION_PRIORITY,
  kind: "compaction",
  key: "context",
};

/** Tracks whether an acquire has resolved without awaiting it. */
function track<T>(promise: Promise<T>) {
  const state: { value?: T; error?: unknown } = {};
  void promise.then(
    (value) => (state.value = value),
    (error: unknown) => (state.error = error),
  );
  return state;
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const signal = new AbortController().signal;

describe("ModelQueue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts queued units by priority, then arrival, one at a time on a gateway endpoint", async () => {
    const queue = new ModelQueue(() => 1);
    const first = await queue.acquire(codex, call("wiki", "w1"), signal);
    const wiki = track(queue.acquire(codex, call("wiki", "w2"), signal));
    const memory = track(queue.acquire(codex, call("memory"), signal));
    const pack = track(queue.acquire(codex, compaction, signal));
    const chat = track(queue.acquire(codex, run(), signal));
    await flush();
    expect([wiki, memory, pack, chat].map(({ value }) => value)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);

    // A running unit is never interrupted; the Run goes next.
    first.release(done);
    await flush();
    expect(chat.value).toBeDefined();
    expect(pack.value).toBeUndefined();

    for (const [next, after] of [
      [chat, pack],
      [pack, memory],
      [memory, wiki],
    ] as const) {
      next.value!.release(done);
      await flush();
      expect(after.value).toBeDefined();
    }
  });

  it("runs as many units at once as the endpoint's concurrency, each endpoint on its own", async () => {
    const queue = new ModelQueue((endpoint) =>
      endpoint.runtimeType === "claude" ? 2 : 1,
    );
    await queue.acquire(codex, run("a"), signal);
    const codexWaits = track(queue.acquire(codex, run("b"), signal));
    const both = [
      track(queue.acquire(claude, run("c"), signal)),
      track(queue.acquire(claude, run("d"), signal)),
    ];
    const third = track(queue.acquire(claude, call("wiki"), signal));
    await flush();
    expect(codexWaits.value).toBeUndefined();
    expect(both.every(({ value }) => value)).toBe(true);
    expect(third.value).toBeUndefined();
  });

  it("drops a waiter whose caller stops waiting", async () => {
    const queue = new ModelQueue(() => 1);
    const first = await queue.acquire(codex, call("memory"), signal);
    const stop = new AbortController();
    const dropped = track(queue.acquire(codex, call("memory"), stop.signal));
    const kept = track(queue.acquire(codex, call("wiki"), signal));
    stop.abort(new Error("caller left"));
    await flush();
    expect(dropped.error).toEqual(new Error("caller left"));

    first.release(done);
    await flush();
    expect(kept.value).toBeDefined();
  });

  it("rejects every waiter of a Computer that disconnects", async () => {
    const queue = new ModelQueue(() => 1);
    await queue.acquire(codex, call("memory"), signal);
    await queue.acquire(claude, call("memory"), signal);
    const waiting = [
      track(queue.acquire(codex, run(), signal)),
      track(queue.acquire(claude, compaction, signal)),
    ];
    queue.rejectWaiters(codex.computerId, new Error("offline"));
    await flush();
    expect(waiting.map(({ error }) => error)).toEqual([
      new Error("offline"),
      new Error("offline"),
    ]);
  });

  it("frees a place once however often it is released", async () => {
    const queue = new ModelQueue(() => 1);
    const first: ModelLease = await queue.acquire(codex, run(), signal);
    const second = track(queue.acquire(codex, call("wiki"), signal));
    const third = track(queue.acquire(codex, call("wiki"), signal));
    first.release(done);
    first.release(done);
    await flush();
    expect(second.value).toBeDefined();
    expect(third.value).toBeUndefined();
  });
});

describe("endpointConcurrency", () => {
  it("serves several units only when every model is on the signed-in account", () => {
    expect(
      endpointConcurrency([{ link: "subscription" }, { link: "subscription" }]),
    ).toBe(10);
    expect(
      endpointConcurrency([{ link: "subscription" }, { link: "api" }]),
    ).toBe(1);
    expect(endpointConcurrency([{}])).toBe(1);
    expect(endpointConcurrency([])).toBe(1);
    expect(endpointConcurrency(undefined)).toBe(1);
  });
});
