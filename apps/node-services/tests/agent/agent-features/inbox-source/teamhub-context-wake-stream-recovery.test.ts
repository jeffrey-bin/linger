import { describe, expect, it, vi } from "vitest";

import { createTeamHubAgentWakeStream } from "../../../../src/agent/agent-features/inbox-source/teamhub-agent-wake-stream.js";

describe("TeamHub Context wake stream recovery", () => {
  it("consumes reconcile and Context refresh events from a fragmented SSE response", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("event: reconcile\ndata: {}\n"));
        controller.enqueue(
          encoder.encode('\nevent: context.changed\ndata: {"context_key":'),
        );
        controller.enqueue(
          encoder.encode('"context-1","state_revision":"5"}\n\n'),
        );
        controller.close();
      },
    });
    const fetch = vi.fn(async () => new Response(stream, { status: 200 }));
    const onContextChanged = vi.fn();
    const onReconcile = vi.fn();
    const handle = createTeamHubAgentWakeStream({
      baseUrl: "http://teamhub.test/",
      serviceToken: "service-token",
      fetch,
      onContextChanged,
      onRunWake() {},
      onReconcile,
    });

    handle.start();
    await vi.waitFor(() => expect(onContextChanged).toHaveBeenCalledOnce());
    await handle.close();

    expect(onReconcile).toHaveBeenCalledOnce();
    expect(onContextChanged).toHaveBeenCalledWith("context-1", "5");
    expect(fetch).toHaveBeenCalledWith(
      "http://teamhub.test/v0/agent-runtime/wakes",
      expect.objectContaining({
        headers: {
          accept: "text/event-stream",
          authorization: "Bearer service-token",
        },
      }),
    );
  });

  it("keeps consuming after one malformed Context refresh payload", async () => {
    const encoder = new TextEncoder();
    const onContextChanged = vi.fn();
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  'event: context.changed\ndata: []\n\nevent: context.changed\ndata: {"context_key":"context-1","state_revision":"2"}\n\n',
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
      onContextChanged,
      onRunWake() {},
      onReconcile() {},
    });
    try {
      handle.start();
      await vi.waitFor(() => expect(onContextChanged).toHaveBeenCalledOnce());
      expect(onContextChanged).toHaveBeenCalledWith("context-1", "2");
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      await handle.close();
    }
  });

  it.each(["headers", "heartbeat"])(
    "reconnects after missing %s and reconciles saved work",
    async (phase) => {
      vi.useFakeTimers();
      const encoder = new TextEncoder();
      let releaseHeaders!: () => void;
      const bodies: ReadableStreamDefaultController<Uint8Array>[] = [];
      const signals: AbortSignal[] = [];
      const onReconcile = vi.fn();
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        const signal = init!.signal!;
        signals.push(signal);
        if (signals.length === 1 && phase === "headers") {
          await new Promise<void>((resolve, reject) => {
            releaseHeaders = resolve;
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              bodies.push(controller);
              controller.enqueue(
                encoder.encode("event: reconcile\ndata: {}\n\n"),
              );
            },
          }),
        );
      });
      const handle = createTeamHubAgentWakeStream({
        baseUrl: "http://teamhub.test",
        serviceToken: "test",
        fetch,
        onContextChanged() {},
        onRunWake() {},
        onReconcile,
      });
      try {
        handle.start();
        await vi.advanceTimersByTimeAsync(phase === "headers" ? 5_000 : 45_000);
        expect(signals[0]!.aborted).toBe(true);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(onReconcile).toHaveBeenCalledTimes(phase === "headers" ? 1 : 2);
      } finally {
        releaseHeaders?.();
        for (const body of bodies) {
          try {
            body.close();
          } catch {
            // The production reader may already have cancelled this test body.
          }
        }
        await handle.close();
        vi.useRealTimers();
      }
    },
  );

  it("retries failed reconciliation independently while retaining the healthy response", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    const cancellations = vi.fn();
    const bodies: ReadableStreamDefaultController<Uint8Array>[] = [];
    const onReconcile = vi
      .fn()
      .mockRejectedValueOnce(new Error("context refresh failed"));
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              bodies.push(controller);
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
      serviceToken: "test",
      fetch,
      onContextChanged() {},
      onRunWake() {},
      onReconcile,
    });
    try {
      handle.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(cancellations).not.toHaveBeenCalled();
      expect(onReconcile).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      for (const body of bodies) {
        try {
          body.close();
        } catch {
          // The production reader may already have cancelled this test body.
        }
      }
      await handle.close();
      vi.useRealTimers();
    }
  });

  it("keeps a quiet healthy stream connected and cancels a pending read on shutdown", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const cancelled = vi.fn();
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(value) {
              controller = value;
            },
            cancel: cancelled,
          }),
        ),
    );
    const handle = createTeamHubAgentWakeStream({
      baseUrl: "http://teamhub.test",
      serviceToken: "test",
      fetch,
      onContextChanged() {},
      onRunWake() {},
      onReconcile() {},
    });
    try {
      handle.start();
      for (let index = 0; index < 4; index += 1) {
        await vi.advanceTimersByTimeAsync(30_000);
        controller.enqueue(encoder.encode(": heartbeat\n\n"));
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(fetch).toHaveBeenCalledOnce();
      await handle.close();
      expect(cancelled).toHaveBeenCalledOnce();
    } finally {
      try {
        controller.close();
      } catch {
        // The production reader may already have cancelled this test body.
      }
      await handle.close();
      vi.useRealTimers();
    }
  });
});
