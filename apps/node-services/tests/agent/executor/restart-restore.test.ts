import { describe, expect, it, vi } from "vitest";
import {
  restoreRecentlyUsedContexts,
  type RestartRestoreAdmission,
  type RestartRestoreDeps,
} from "../../../src/agent/executor/restart-restore.js";
import {
  encodeExecutionContextRef,
  type ExecutionContextRef,
} from "../../../src/agent/executor/context-ref.js";
import type { AgentLogger } from "../../../src/agent/observability/agent-log.js";

const ref = (room: string): ExecutionContextRef => ({
  kind: "meta",
  agentId: "agent-1",
  roomId: room,
});
const keyOf = (room: string) => encodeExecutionContextRef(ref(room));

interface Logged {
  readonly level: string;
  readonly event: string;
  readonly fields?: Record<string, unknown>;
}

const harness = (
  overrides: Partial<RestartRestoreDeps> & {
    readonly keys?: readonly string[];
  } = {},
) => {
  const logs: Logged[] = [];
  const logger: AgentLogger = {
    log(level, event, fields) {
      logs.push({ level, event, fields: fields });
    },
    child() {
      return logger;
    },
  };
  const controller = new AbortController();
  const listeners = new Set<(computerId: string) => void>();
  const deps: RestartRestoreDeps = {
    listRecentlyUsed: vi.fn(async () => overrides.keys ?? []),
    restore: vi.fn(async () => ({ status: "restored" as const })),
    admit: vi.fn(
      async (): Promise<RestartRestoreAdmission> => ({
        status: "eligible",
      }),
    ),
    isRecoverableFailure: vi.fn(() => false),
    subscribeLocalComputerReady: vi.fn((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    logger,
    signal: controller.signal,
    retryDelayMs: 0,
    ...overrides,
  };
  return {
    deps,
    logs,
    controller,
    fireReady: (computerId: string) => {
      for (const listener of [...listeners]) listener(computerId);
    },
    subscribers: () => listeners.size,
  };
};

const eventsOf = (logs: readonly Logged[], event: string) =>
  logs.filter((entry) => entry.event === event);

describe("restart Context restore orchestration", () => {
  it("restores most recent first, with at most four in flight", async () => {
    const keys = Array.from({ length: 10 }, (_, index) =>
      keyOf(`room-${index}`),
    );
    let inFlight = 0;
    let maxInFlight = 0;
    const started: string[] = [];
    const resolvers: Array<() => void> = [];
    const { deps, logs } = harness({
      keys,
      restore: vi.fn((target) => {
        started.push(encodeExecutionContextRef(target));
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<{ status: "restored" }>((resolve) =>
          resolvers.push(() => {
            inFlight -= 1;
            resolve({ status: "restored" });
          }),
        );
      }),
    });
    const running = restoreRecentlyUsedContexts(deps);
    await vi.waitFor(() => expect(started).toHaveLength(4));
    expect(maxInFlight).toBe(4);
    while (started.length < keys.length || resolvers.length > 0) {
      await vi.waitFor(() => expect(resolvers.length).toBeGreaterThan(0));
      resolvers.shift()!();
    }
    await running;
    expect(started).toEqual(keys);
    expect(maxInFlight).toBe(4);
    expect(
      eventsOf(logs, "manager.restart_restore_completed")[0]?.fields,
    ).toMatchObject({
      candidateCount: 10,
      restoredCount: 10,
      skippedCount: 0,
      ineligibleCount: 0,
      offlineCount: 0,
      failedCount: 0,
    });
  });

  it("never claims Contexts whose Agent is no longer eligible", async () => {
    const { deps } = harness({
      keys: [keyOf("ineligible-room")],
      admit: vi.fn(async () => ({ status: "ineligible" as const })),
    });
    await restoreRecentlyUsedContexts(deps);
    expect(deps.restore).not.toHaveBeenCalled();
  });

  it("parks an offline Computer and restores its Contexts once when it becomes ready", async () => {
    const keys = [keyOf("offline-a"), keyOf("offline-b")];
    let online = false;
    const { deps, fireReady, subscribers, logs } = harness({
      keys,
      admit: vi.fn(
        async (): Promise<RestartRestoreAdmission> =>
          online
            ? { status: "eligible" }
            : { status: "offline", computerId: "computer-1" },
      ),
    });
    await restoreRecentlyUsedContexts(deps);
    expect(deps.restore).not.toHaveBeenCalled();
    expect(subscribers()).toBe(1);

    fireReady("another-computer");
    expect(deps.restore).not.toHaveBeenCalled();
    online = true;
    fireReady("computer-1");
    await vi.waitFor(() => expect(deps.restore).toHaveBeenCalledTimes(2));
    expect(subscribers()).toBe(0);
    fireReady("computer-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deps.restore).toHaveBeenCalledTimes(2);
    expect(
      eventsOf(logs, "manager.restart_restore_deferred_restored")[0]?.fields,
    ).toMatchObject({
      computerId: "computer-1",
      count: 2,
      restoredCount: 2,
    });
  });

  it("drops parked Contexts once the recently-used window has passed", async () => {
    vi.useFakeTimers();
    try {
      const { deps, fireReady, subscribers } = harness({
        keys: [keyOf("offline-for-days")],
        admit: vi.fn(async () => ({
          status: "offline" as const,
          computerId: "computer-1",
        })),
        windowMs: 60_000,
      });
      await restoreRecentlyUsedContexts(deps);
      expect(subscribers()).toBe(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(subscribers()).toBe(0);
      fireReady("computer-1");
      await vi.advanceTimersByTimeAsync(0);
      expect(deps.admit).toHaveBeenCalledTimes(1);
      expect(deps.restore).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not restore a parked Context whose Agent became ineligible before the ready event", async () => {
    let placement: RestartRestoreAdmission = {
      status: "offline",
      computerId: "computer-1",
    };
    const { deps, fireReady, logs } = harness({
      keys: [keyOf("switched")],
      admit: vi.fn(async () => placement),
    });
    await restoreRecentlyUsedContexts(deps);
    expect(deps.restore).not.toHaveBeenCalled();

    placement = { status: "ineligible" };
    fireReady("computer-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deps.restore).not.toHaveBeenCalled();
    expect(deps.admit).toHaveBeenCalledTimes(2);
    expect(eventsOf(logs, "manager.restart_restore_failed")).toHaveLength(0);
  });

  it("re-parks a Context under its new Computer when it is still offline at the ready event", async () => {
    let computerId = "computer-1";
    let online = false;
    const { deps, fireReady, subscribers } = harness({
      keys: [keyOf("moved")],
      admit: vi.fn(
        async (): Promise<RestartRestoreAdmission> =>
          online ? { status: "eligible" } : { status: "offline", computerId },
      ),
    });
    await restoreRecentlyUsedContexts(deps);
    expect(subscribers()).toBe(1);

    computerId = "computer-2";
    fireReady("computer-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deps.restore).not.toHaveBeenCalled();
    expect(subscribers()).toBe(1);
    // The re-park is not restored by the old Computer's ready event again.
    fireReady("computer-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deps.restore).not.toHaveBeenCalled();

    online = true;
    fireReady("computer-2");
    await vi.waitFor(() => expect(deps.restore).toHaveBeenCalledTimes(1));
    expect(subscribers()).toBe(0);
  });

  it("re-admits before each recoverable retry and stops when the retry is ineligible", async () => {
    let placement: RestartRestoreAdmission = { status: "eligible" };
    const { deps, logs } = harness({
      keys: [keyOf("retry-switched")],
      admit: vi.fn(async () => placement),
      restore: vi.fn(async () => {
        // The Agent becomes ineligible while the first attempt runs.
        placement = { status: "ineligible" };
        return { status: "failed" as const, error: new Error("offline") };
      }),
      isRecoverableFailure: vi.fn(() => true),
    });
    await restoreRecentlyUsedContexts(deps);
    expect(deps.admit).toHaveBeenCalledTimes(2);
    expect(deps.restore).toHaveBeenCalledTimes(1);
    expect(
      eventsOf(logs, "manager.restart_restore_completed")[0]?.fields,
    ).toMatchObject({ ineligibleCount: 1, failedCount: 0 });
  });

  it("retries a recoverable failure once and does not retry a non-recoverable one", async () => {
    const recoverable = harness({
      keys: [keyOf("recoverable")],
      restore: vi
        .fn()
        .mockResolvedValueOnce({
          status: "failed",
          error: new Error("offline"),
        })
        .mockResolvedValueOnce({ status: "restored" }),
      isRecoverableFailure: vi.fn(() => true),
    });
    await restoreRecentlyUsedContexts(recoverable.deps);
    expect(recoverable.deps.restore).toHaveBeenCalledTimes(2);
    expect(
      eventsOf(recoverable.logs, "manager.restart_restore_failed"),
    ).toHaveLength(0);

    const fatal = harness({
      keys: [keyOf("fatal")],
      restore: vi.fn(async () => ({
        status: "failed" as const,
        error: new Error("bad identity"),
      })),
      isRecoverableFailure: vi.fn(() => false),
    });
    await restoreRecentlyUsedContexts(fatal.deps);
    expect(fatal.deps.restore).toHaveBeenCalledTimes(1);
    const warnings = eventsOf(fatal.logs, "manager.restart_restore_failed");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields).toMatchObject({ contextKey: keyOf("fatal") });
  });

  it("logs other list failures once as a warning and does not retry", async () => {
    const { deps, logs } = harness({
      listRecentlyUsed: vi.fn(async () => {
        throw new Error("TeamHub unavailable");
      }),
    });
    await restoreRecentlyUsedContexts(deps);
    expect(deps.listRecentlyUsed).toHaveBeenCalledTimes(1);
    expect(eventsOf(logs, "manager.restart_restore_list_failed")).toHaveLength(
      1,
    );
  });

  it("skips undecodable keys without restoring them", async () => {
    const { deps } = harness({ keys: ["not-a-key", keyOf("valid")] });
    await restoreRecentlyUsedContexts(deps);
    expect(deps.restore).toHaveBeenCalledTimes(1);
    expect(deps.restore).toHaveBeenCalledWith(ref("valid"));
  });

  it("stops scheduling new restores after the shutdown signal aborts", async () => {
    const keys = [keyOf("a"), keyOf("b"), keyOf("c")];
    const holder: { controller?: AbortController } = {};
    const { deps, controller } = harness({
      keys,
      concurrency: 1,
      restore: vi.fn(async () => {
        holder.controller?.abort();
        return { status: "restored" as const };
      }),
    });
    holder.controller = controller;
    await restoreRecentlyUsedContexts(deps);
    expect(deps.restore).toHaveBeenCalledTimes(1);
  });
});
