import { describe, expect, it, vi } from "vitest";

import {
  createTeamHubAgentWakeStream,
  parseContextChanged,
  parseContextHint,
} from "../../../../src/agent/agent-features/inbox-source/teamhub-agent-wake-stream.js";

describe("TeamHub Agent wake stream", () => {
  it.each(["5xx", "timeout", "SESSION_EXPIRED"])(
    "keeps subsequent hints and reconcile on the same stream after %s",
    async (failure) => {
      const encoder = new TextEncoder();
      const onRunWake = vi.fn().mockImplementationOnce(() => {
        throw new Error(failure);
      });
      const onContextChanged = vi
        .fn()
        .mockRejectedValueOnce(new Error(failure));
      const onReconcile = vi.fn();
      const logger = { log: vi.fn(), child: vi.fn() };
      const cancelled = vi.fn();
      const fetch = vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    [
                      'event: run.queued\ndata: {"context_key":"context-1"}\n\n',
                      'event: context.changed\ndata: {"context_key":"context-1","state_revision":"3"}\n\n',
                      'event: run.steered\ndata: {"context_key":"context-2"}\n\n',
                      'event: context.changed\ndata: {"context_key":"context-2","state_revision":"4"}\n\n',
                      "event: reconcile\ndata: {}\n\n",
                    ].join(""),
                  ),
                );
              },
              cancel: cancelled,
            }),
          ),
      );
      const handle = createTeamHubAgentWakeStream({
        baseUrl: "http://teamhub.test",
        serviceToken: "service-token",
        fetch,
        logger,
        onRunWake,
        onContextChanged,
        onReconcile,
      });
      try {
        handle.start();
        await vi.waitFor(() => expect(onReconcile).toHaveBeenCalledOnce());
        expect(onRunWake.mock.calls).toEqual([
          ["context-1", "queued"],
          ["context-2", "steered"],
        ]);
        expect(onContextChanged).toHaveBeenCalledTimes(2);
        expect(fetch).toHaveBeenCalledOnce();
        expect(cancelled).not.toHaveBeenCalled();
        expect(
          logger.log.mock.calls.filter(
            (call) => call[1] === "agent_wake_stream.hint_failed",
          ),
        ).toHaveLength(2);
      } finally {
        await handle.close();
      }
    },
  );

  it("hands context.prepare straight to the presence callback", async () => {
    const encoder = new TextEncoder();
    const onContextPrepare = vi.fn(() => {
      throw new Error("manager closed");
    });
    const onContextChanged = vi.fn();
    const onReconcile = vi.fn();
    const log = vi.fn();
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  [
                    'event: context.prepare\ndata: {"context_key":"context-1"}\n\n',
                    'event: context.prepare\ndata: {"context_key":""}\n\n',
                    "event: reconcile\ndata: {}\n\n",
                  ].join(""),
                ),
              );
            },
          }),
        ),
    );
    const handle = createTeamHubAgentWakeStream({
      baseUrl: "http://teamhub.test",
      serviceToken: "service-token",
      fetch,
      logger: { log, child: vi.fn() },
      onRunWake: vi.fn(),
      onContextChanged,
      onContextPrepare,
      onReconcile,
    });
    try {
      handle.start();
      await vi.waitFor(() => expect(onReconcile).toHaveBeenCalledOnce());
      expect(onContextPrepare.mock.calls).toEqual([["context-1"]]);
      expect(onContextChanged).not.toHaveBeenCalled();
      // A throwing callback is contained and logged; the stream keeps going.
      expect(log).toHaveBeenCalledWith(
        "warn",
        "agent_wake_stream.hint_failed",
        expect.objectContaining({ event: "context.prepare" }),
      );
    } finally {
      await handle.close();
    }
  });

  it("hands task.claimable straight to the Task callback", async () => {
    const encoder = new TextEncoder();
    const onTaskClaimable = vi.fn();
    const onContextChanged = vi.fn();
    const onReconcile = vi.fn();
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  [
                    "event: task.claimable\ndata: {}\n\n",
                    "event: task.claimable\ndata: {}\n\n",
                    "event: reconcile\ndata: {}\n\n",
                  ].join(""),
                ),
              );
            },
          }),
        ),
    );
    const handle = createTeamHubAgentWakeStream({
      baseUrl: "http://teamhub.test",
      serviceToken: "service-token",
      fetch,
      logger: { log: vi.fn(), child: vi.fn() },
      onRunWake: vi.fn(),
      onContextChanged,
      onTaskClaimable,
      onReconcile,
    });
    try {
      handle.start();
      await vi.waitFor(() => expect(onReconcile).toHaveBeenCalledOnce());
      expect(onTaskClaimable).toHaveBeenCalledTimes(2);
      expect(onContextChanged).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it("reports each connection transition once and not for failed reconnects", async () => {
    const onConnectionChanged = vi.fn();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            },
          }),
        ),
      )
      .mockResolvedValue(new Response("unavailable", { status: 503 }));
    const handle = createTeamHubAgentWakeStream({
      baseUrl: "http://teamhub.test",
      serviceToken: "service-token",
      fetch,
      logger: { log: vi.fn(), child: vi.fn() },
      onRunWake: vi.fn(),
      onContextChanged: vi.fn(),
      onReconcile: vi.fn(),
      onConnectionChanged,
    });
    try {
      handle.start();
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3), {
        timeout: 10_000,
      });
      expect(onConnectionChanged.mock.calls).toEqual([[true], [false]]);
    } finally {
      await handle.close();
    }
  });

  it("accepts only a Context key on body-free hints", () => {
    expect(parseContextHint('{"context_key":"context-1"}')).toBe("context-1");
    for (const data of [
      "[]",
      "{}",
      '{"context_key":""}',
      '{"context_key":"context-1\\n"}',
      '{"context_key":7}',
    ])
      expect(() => parseContextHint(data)).toThrow();
  });

  it("validates Context refresh hints independently of run hints", () => {
    expect(
      parseContextChanged('{"context_key":"context-1","state_revision":"12"}'),
    ).toEqual({ contextKey: "context-1", stateRevision: "12" });
    for (const data of [
      "[]",
      "{}",
      '{"context_key":""}',
      '{"context_key":"context-1"}',
      '{"context_key":"context-1","state_revision":"0"}',
      '{"context_key":"context-1","state_revision":12}',
    ])
      expect(() => parseContextChanged(data)).toThrow();
  });

  it("dispatches fragmented messages and every repeated run hint", async () => {
    const encoder = new TextEncoder();
    const onRunWake = vi.fn();
    const onReconcile = vi.fn();
    const handle = createTeamHubAgentWakeStream({
      baseUrl: "http://teamhub.test/",
      serviceToken: "service-token",
      onContextChanged: vi.fn(),
      onRunWake,
      onReconcile,
      fetch: vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    'event: reconcile\r\ndata: {}\r\n\r\nevent: run.queued\ndata: {"context_key":',
                  ),
                );
                controller.enqueue(
                  encoder.encode(
                    '"context-1"}\n\nevent: run.queued\ndata: {"context_key":"context-1"}\n\n',
                  ),
                );
                controller.close();
              },
            }),
          ),
      ),
    });
    try {
      handle.start();
      await vi.waitFor(() => expect(onRunWake).toHaveBeenCalledTimes(2));
      expect(onReconcile).toHaveBeenCalledOnce();
      expect(onRunWake.mock.calls).toEqual([
        ["context-1", "queued"],
        ["context-1", "queued"],
      ]);
    } finally {
      await handle.close();
    }
  });

  it("ignores one malformed event while delivering the following wake on the same connection", async () => {
    const encoder = new TextEncoder();
    const onRunWake = vi.fn();
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  'event: run.queued\ndata: {bad-json\n\nevent: run.queued\ndata: {"context_key":"context-healthy"}\n\n',
                ),
              );
            },
          }),
        ),
    );
    const handle = createTeamHubAgentWakeStream({
      baseUrl: "http://teamhub.test",
      serviceToken: "service-token",
      fetch,
      onContextChanged: vi.fn(),
      onRunWake,
      onReconcile() {},
    });
    try {
      handle.start();
      await vi.waitFor(() => expect(onRunWake).toHaveBeenCalledOnce());
      expect(onRunWake).toHaveBeenCalledWith("context-healthy", "queued");
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      await handle.close();
    }
  });

  it("reconnects after a lost heartbeat and requests reconciliation again", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    const cancellations = vi.fn();
    const onReconcile = vi.fn();
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode("event: reconcile\ndata: {}\n\n"),
              );
            },
            cancel: cancellations,
          }),
        ),
    );
    const handle = createTeamHubAgentWakeStream({
      baseUrl: "http://teamhub.test",
      serviceToken: "service-token",
      fetch,
      onContextChanged() {},
      onRunWake() {},
      onReconcile,
    });
    try {
      handle.start();
      await vi.advanceTimersByTimeAsync(45_000);
      expect(cancellations).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(onReconcile).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenCalledWith(
        "http://teamhub.test/v0/agent-runtime/wakes",
        expect.objectContaining({
          headers: {
            accept: "text/event-stream",
            authorization: "Bearer service-token",
          },
        }),
      );
    } finally {
      await handle.close();
      vi.useRealTimers();
    }
  });

  it("backs off a failing reconcile and resets after a success", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    const failure = new Error("TeamHub unavailable");
    const onReconcile = vi.fn().mockRejectedValue(failure);
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode("event: reconcile\ndata: {}\n\n"),
              );
            },
          }),
        ),
    );
    const handle = createTeamHubAgentWakeStream({
      baseUrl: "http://teamhub.test",
      serviceToken: "service-token",
      fetch,
      logger: { log: vi.fn(), child: vi.fn() },
      onContextChanged() {},
      onRunWake() {},
      onReconcile,
    });
    const expectRetryAfter = async (delayMs: number) => {
      const calls = onReconcile.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delayMs - 1);
      expect(onReconcile).toHaveBeenCalledTimes(calls);
      await vi.advanceTimersByTimeAsync(1);
      expect(onReconcile).toHaveBeenCalledTimes(calls + 1);
    };
    try {
      handle.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(onReconcile).toHaveBeenCalledTimes(1);
      for (const delayMs of [
        1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
      ])
        await expectRetryAfter(delayMs);
      onReconcile.mockResolvedValueOnce(undefined).mockRejectedValue(failure);
      await expectRetryAfter(30_000);
      // A heartbeat reconnect requests the next reconcile; its failure
      // starts the backoff again from the base delay.
      const succeeded = onReconcile.mock.calls.length;
      while (onReconcile.mock.calls.length === succeeded)
        await vi.advanceTimersByTimeAsync(1_000);
      await expectRetryAfter(1_000);
      await expectRetryAfter(2_000);
    } finally {
      await handle.close();
      vi.useRealTimers();
    }
  });
});
