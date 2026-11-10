import { expect, it, vi } from "vitest";

import { createTeamHubAgentWakeStream } from "../../../../src/agent/agent-features/inbox-source/teamhub-agent-wake-stream.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const queued = (context: string) =>
  `event: run.queued\ndata: ${JSON.stringify({ context_key: context })}\n\n`;

const changed = (context: string, revision = "1") =>
  `event: context.changed\ndata: ${JSON.stringify({ context_key: context, state_revision: revision })}\n\n`;

const fixture = (
  callbacks: Pick<
    Parameters<typeof createTeamHubAgentWakeStream>[0],
    "onRunWake" | "onContextChanged" | "onReconcile"
  >,
) => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const fetch = vi.fn(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
          },
          cancel,
        }),
      ),
  );
  const handle = createTeamHubAgentWakeStream({
    baseUrl: "http://teamhub.test",
    serviceToken: "test",
    fetch,
    ...callbacks,
  });
  handle.start();
  return {
    handle,
    fetch,
    cancel,
    async emit(events: string) {
      await vi.waitFor(() => expect(controller).toBeDefined());
      controller.enqueue(new TextEncoder().encode(events));
    },
  };
};

it("dispatches other Contexts while one refresh waits and keeps only the newest pending revision", async () => {
  const blocked = deferred();
  const calls: string[] = [];
  const stream = fixture({
    onRunWake(key, kind) {
      calls.push(`${key}:${kind}`);
    },
    async onContextChanged(key, revision) {
      calls.push(`${key}:changed:${revision}`);
      if (calls.length === 1) await blocked.promise;
    },
    onReconcile() {},
  });
  try {
    await stream.emit(changed("a"));
    await vi.waitFor(() => expect(calls).toEqual(["a:changed:1"]));
    await stream.emit(
      changed("a", "2") + changed("a", "5") + changed("a", "3") + changed("b"),
    );
    // Run hints never wait behind a Context refresh.
    await stream.emit(queued("a"));
    await vi.waitFor(() =>
      expect(calls).toEqual(["a:changed:1", "b:changed:1", "a:queued"]),
    );
    blocked.resolve();
    await vi.waitFor(() =>
      expect(calls).toEqual([
        "a:changed:1",
        "b:changed:1",
        "a:queued",
        "a:changed:5",
      ]),
    );
    expect(stream.fetch).toHaveBeenCalledOnce();
  } finally {
    blocked.resolve();
    await stream.handle.close();
  }
});

it("bounds active Context callbacks, folds overflow once and drops queued work on close", async () => {
  const blocked = deferred();
  const onContextChanged = vi.fn(async () => blocked.promise);
  const onReconcile = vi.fn();
  const stream = fixture({ onRunWake() {}, onContextChanged, onReconcile });
  try {
    await stream.emit(
      [0, 1, 2, 3].map((key) => changed(`active-${key}`)).join(""),
    );
    await vi.waitFor(() => expect(onContextChanged).toHaveBeenCalledTimes(4));
    await stream.emit(
      Array.from({ length: 1_000 }, (_, key) => changed(`queued-${key}`)).join(
        "",
      ),
    );
    await vi.waitFor(() => expect(onReconcile).toHaveBeenCalledOnce());
    expect(onContextChanged).toHaveBeenCalledTimes(4);
    const closing = stream.handle.close();
    await vi.waitFor(() => expect(stream.cancel).toHaveBeenCalledOnce());
    blocked.resolve();
    await closing;
    expect(onContextChanged).toHaveBeenCalledTimes(4);
    expect(onReconcile).toHaveBeenCalledOnce();
  } finally {
    blocked.resolve();
    await stream.handle.close();
  }
});

it("keeps hints flowing while reconciliation waits and coalesces its follow-up", async () => {
  const blocked = deferred();
  const onReconcile = vi.fn(async () => {
    if (onReconcile.mock.calls.length === 1) await blocked.promise;
  });
  const onRunWake = vi.fn();
  const onContextChanged = vi.fn();
  const stream = fixture({ onRunWake, onContextChanged, onReconcile });
  try {
    await stream.emit("event: reconcile\ndata: {}\n\n");
    await vi.waitFor(() => expect(onReconcile).toHaveBeenCalledOnce());
    await stream.emit(
      "event: reconcile\ndata: {}\n\n".repeat(20) + queued("a") + changed("b"),
    );
    await vi.waitFor(() => {
      expect(onRunWake).toHaveBeenCalledWith("a", "queued");
      expect(onContextChanged).toHaveBeenCalledWith("b", "1");
    });
    expect(onReconcile).toHaveBeenCalledOnce();
    blocked.resolve();
    await vi.waitFor(() => expect(onReconcile).toHaveBeenCalledTimes(2));
    expect(stream.fetch).toHaveBeenCalledOnce();
  } finally {
    blocked.resolve();
    await stream.handle.close();
  }
});
