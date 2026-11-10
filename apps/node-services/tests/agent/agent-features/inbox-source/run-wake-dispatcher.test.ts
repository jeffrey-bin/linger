import { afterEach, describe, expect, it, vi } from "vitest";

import { RunWakeDispatcher } from "../../../../src/agent/agent-features/inbox-source/run-wake-dispatcher.js";
import { encodeExecutionContextRef } from "../../../../src/agent/executor/context-ref.js";
import type {
  RunWakeKind,
  RunWakeTarget,
} from "../../../../src/agent/agent-features/inbox-source/types.js";

const ref = { kind: "meta" as const, agentId: "agent-1", roomId: "room-1" };
const key = encodeExecutionContextRef(ref);

const target = () => {
  const kinds: RunWakeKind[] = [];
  const value: RunWakeTarget = { ref, wake: (kind) => kinds.push(kind) };
  return { value, kinds };
};

const logger = () => ({ log: vi.fn(), child: vi.fn() });

afterEach(() => {
  vi.useRealTimers();
});

describe("RunWakeDispatcher", () => {
  it("hands a hint for a bound Context straight to its target", () => {
    const claimContext = vi.fn(async () => true);
    const dispatcher = new RunWakeDispatcher({
      claimContext,
      listWaitingContexts: async () => [],
      logger: logger(),
    });
    const bound = target();
    dispatcher.registerTarget(bound.value);
    dispatcher.wake(key, "queued");
    dispatcher.wake(key, "steered");
    expect(bound.kinds).toEqual(["queued", "steered"]);
    expect(claimContext).not.toHaveBeenCalled();
    dispatcher.close();
  });

  it("claims an unbound Context and delivers the wake once its binding registers", async () => {
    const claimContext = vi.fn(async () => true);
    const dispatcher = new RunWakeDispatcher({
      claimContext,
      listWaitingContexts: async () => [],
      logger: logger(),
    });
    dispatcher.wake(key, "queued");
    dispatcher.wake(key, "queued");
    await vi.waitFor(() => expect(claimContext).toHaveBeenCalledWith(key));
    const bound = target();
    dispatcher.registerTarget(bound.value);
    // Repeated early hints collapse into one wake per kind.
    expect(bound.kinds).toEqual(["queued"]);
    dispatcher.close();
  });

  it("drops early wakes after their time to live", () => {
    let now = 0;
    const dispatcher = new RunWakeDispatcher({
      claimContext: async () => false,
      listWaitingContexts: async () => [],
      logger: logger(),
      now: () => now,
    });
    dispatcher.wake(key, "queued");
    now = 30_000;
    const bound = target();
    dispatcher.registerTarget(bound.value);
    expect(bound.kinds).toEqual([]);
    dispatcher.close();
  });

  it("stops delivering to a target after its binding stops", async () => {
    const claimContext = vi.fn(async () => true);
    const dispatcher = new RunWakeDispatcher({
      claimContext,
      listWaitingContexts: async () => [],
      logger: logger(),
    });
    const bound = target();
    dispatcher.registerTarget(bound.value).stop();
    dispatcher.wake(key, "queued");
    expect(bound.kinds).toEqual([]);
    await vi.waitFor(() => expect(claimContext).toHaveBeenCalledWith(key));
    dispatcher.close();
  });

  it("wakes every waiting Context the fallback scan lists, even after a lost hint", async () => {
    const dispatcher = new RunWakeDispatcher({
      claimContext: async () => true,
      listWaitingContexts: async () => [key],
      logger: logger(),
    });
    const bound = target();
    dispatcher.registerTarget(bound.value);
    await dispatcher.scanNow();
    // The scan does not know whether a Run or a steer waits, so it reads.
    expect(bound.kinds).toEqual(["steered"]);
    dispatcher.close();
  });

  it("scans periodically between the configured bounds and logs a failed scan", async () => {
    vi.useFakeTimers();
    const log = logger();
    const listWaitingContexts = vi
      .fn<(signal: AbortSignal) => Promise<readonly string[]>>()
      .mockRejectedValueOnce(new Error("TeamHub unavailable"))
      .mockResolvedValue([key]);
    const dispatcher = new RunWakeDispatcher({
      claimContext: async () => true,
      listWaitingContexts,
      logger: log,
      scanIntervalMs: { min: 30_000, max: 60_000 },
      random: () => 0.5,
    });
    const bound = target();
    dispatcher.registerTarget(bound.value);
    dispatcher.start();
    await vi.advanceTimersByTimeAsync(44_999);
    expect(listWaitingContexts).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(listWaitingContexts).toHaveBeenCalledOnce();
    expect(log.log).toHaveBeenCalledWith(
      "warn",
      "run_wake.scan_failed",
      expect.objectContaining({ error: expect.any(Error) }),
    );
    await vi.advanceTimersByTimeAsync(45_000);
    expect(listWaitingContexts).toHaveBeenCalledTimes(2);
    expect(bound.kinds).toEqual(["steered"]);
    dispatcher.close();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(listWaitingContexts).toHaveBeenCalledTimes(2);
  });

  it("rejects an unordered scan interval", () => {
    expect(
      () =>
        new RunWakeDispatcher({
          claimContext: async () => true,
          listWaitingContexts: async () => [],
          scanIntervalMs: { min: 60_000, max: 30_000 },
        }),
    ).toThrow("scanIntervalMs must be a positive ordered range");
  });
});
