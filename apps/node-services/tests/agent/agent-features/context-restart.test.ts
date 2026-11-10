import { describe, expect, it, vi } from "vitest";

import { composeContextFeatures } from "../../../src/agent/agent-features/compose.js";
import {
  CONTEXT_COMPACTED_NOTICE,
  CONTEXT_RESTART_FEATURE_ID,
  createContextRestartFeature,
} from "../../../src/agent/agent-features/context-restart/index.js";
import type { MaintenanceAction } from "../../../src/agent/agent-features/contracts.js";
import type { FeatureTimers } from "../../../src/agent/agent-features/host-ports.js";
import { makeTestFeatureContext, makeTestMessage } from "./fixtures.js";

const HOUR = 60 * 60 * 1_000;
const PERIOD = 12 * HOUR;
const IDLE_TIMER = "context-restart.idle";

const setup = (
  options: { runtimeType?: string; kind?: "meta" | "alter_ego" } = {},
) => {
  let clock = 1_000_000;
  const timers = { set: vi.fn(), clear: vi.fn() } satisfies FeatureTimers;
  const { context } = makeTestFeatureContext({
    runtime: {
      type: "local",
      placement: { runtimeType: options.runtimeType ?? "codex" },
    },
    ...(options.kind === "alter_ego"
      ? { ref: { kind: "alter_ego", agentId: "agent-1", taskId: "task-1" } }
      : {}),
  });
  const composed = composeContextFeatures({
    context,
    features: [createContextRestartFeature({ timers, now: () => clock })],
  });
  return {
    composed,
    timers,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
    succeed: () =>
      composed.onRunTerminal({ runId: "run", terminal: { type: "succeeded" } }),
    complete: (action: MaintenanceAction) =>
      composed.onMaintenance({
        phase: "finished",
        trigger: { kind: "idle_suspend" },
        action,
        outcome: { status: "completed" },
      }),
  };
};

describe("context-restart feature", () => {
  it("matches only Meta Contexts", () => {
    expect(setup().composed.matched).toEqual([CONTEXT_RESTART_FEATURE_ID]);
    expect(setup({ kind: "alter_ego" }).composed.matched).toEqual([]);
  });

  it("compacts before an idle suspend once the period has passed since the first Run", () => {
    const { composed, advance, succeed } = setup();
    expect(composed.decideMaintenance({ kind: "idle_suspend" })).toBeNull();
    succeed();
    advance(PERIOD - 1);
    expect(composed.decideMaintenance({ kind: "idle_suspend" })).toBeNull();
    advance(1);
    expect(composed.decideMaintenance({ kind: "idle_suspend" })).toMatchObject({
      kind: "compact",
      reason: "since_last_compaction",
      instructions: expect.stringContaining("Task ids"),
    });
  });

  it("requires a succeeded Run after each completed compaction", () => {
    const { composed, advance, succeed, complete, timers } = setup();
    succeed();
    advance(PERIOD);
    const action = composed.decideMaintenance({ kind: "idle_suspend" })!;
    complete(action);
    expect(timers.clear).toHaveBeenCalledWith(expect.anything(), IDLE_TIMER);
    advance(HOUR);
    succeed();
    // A Run alone is not enough: the period restarts at the compaction.
    expect(composed.decideMaintenance({ kind: "idle_suspend" })).toBeNull();
    advance(PERIOD);
    expect(composed.decideMaintenance({ kind: "idle_suspend" })).not.toBeNull();
    complete(action);
    // The period alone is not enough either.
    advance(PERIOD * 2);
    expect(composed.decideMaintenance({ kind: "idle_suspend" })).toBeNull();
    succeed();
    expect(composed.decideMaintenance({ kind: "idle_suspend" })).not.toBeNull();
  });

  it("keeps waiting after a skipped or failed compaction", () => {
    const { composed, advance, succeed } = setup();
    succeed();
    advance(PERIOD);
    const action = composed.decideMaintenance({ kind: "idle_suspend" })!;
    composed.onMaintenance({
      phase: "finished",
      trigger: { kind: "idle_suspend" },
      action,
      outcome: { status: "skipped", reason: "input_arrived" },
    });
    expect(composed.decideMaintenance({ kind: "idle_suspend" })).not.toBeNull();
  });

  it("arms an idle timer on every succeeded Run and compacts once idle for the period", () => {
    const { composed, advance, succeed, timers, now } = setup();
    succeed();
    expect(timers.set).toHaveBeenLastCalledWith(
      expect.anything(),
      IDLE_TIMER,
      now() + PERIOD,
    );
    advance(HOUR);
    succeed();
    expect(timers.set).toHaveBeenLastCalledWith(
      expect.anything(),
      IDLE_TIMER,
      now() + PERIOD,
    );
    advance(PERIOD - 1);
    expect(
      composed.decideMaintenance({ kind: "timer", name: IDLE_TIMER }),
    ).toBeNull();
    advance(1);
    expect(
      composed.decideMaintenance({ kind: "timer", name: IDLE_TIMER }),
    ).toMatchObject({ kind: "compact", reason: "idle" });
    expect(
      composed.decideMaintenance({ kind: "timer", name: "other" }),
    ).toBeNull();
  });

  it("does not compact Runtimes without native compaction", () => {
    const { composed, advance, succeed, timers } = setup({ runtimeType: "pi" });
    succeed();
    advance(PERIOD);
    expect(timers.set).not.toHaveBeenCalled();
    expect(composed.decideMaintenance({ kind: "idle_suspend" })).toBeNull();
  });

  it("adds the compacted notice to exactly the first new input after a compaction", () => {
    const { composed, advance, succeed, complete } = setup();
    const first = makeTestMessage("hello");
    expect(composed.prepareInput(first).rawMessage).toBe("hello");
    succeed();
    advance(PERIOD);
    complete(composed.decideMaintenance({ kind: "idle_suspend" })!);

    const steered = {
      ...makeTestMessage("steer"),
      trustedNotification: true as const,
    };
    expect(composed.prepareInput(steered).rawMessage).toBe("steer");

    const next = { ...makeTestMessage("next"), messageId: "m-2" };
    expect(composed.prepareInput(next).rawMessage).toContain(
      CONTEXT_COMPACTED_NOTICE,
    );
    // A replay of the same input renders the same text.
    expect(composed.prepareInput(next).rawMessage).toContain(
      CONTEXT_COMPACTED_NOTICE,
    );
    const later = { ...makeTestMessage("later"), messageId: "m-3" };
    expect(composed.prepareInput(later).rawMessage).toBe("later");
    expect(composed.prepareInput(next).rawMessage).toBe("next");
  });

  it("requires timers", () => {
    expect(() =>
      createContextRestartFeature(
        {} as Parameters<typeof createContextRestartFeature>[0],
      ),
    ).toThrow("context-restart feature requires timers");
  });
});
