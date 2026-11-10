import { describe, expect, it, vi } from "vitest";

import { composeContextFeatures } from "../../../src/agent/agent-features/compose.js";
import type { FeatureSubmitResult } from "../../../src/agent/agent-features/contracts.js";
import type { FeatureTimers } from "../../../src/agent/agent-features/host-ports.js";
import {
  createTaskProgressFeature,
  formatDuration,
  renderTaskProgressReminder,
  TASK_PROGRESS_FEATURE_ID,
  type TaskProgressSnapshot,
} from "../../../src/agent/agent-features/task-progress/index.js";
import type { Message } from "../../../src/agent/executor/types.js";
import { makeTestFeatureContext } from "./fixtures.js";

const MINUTE = 60_000;
const QUIET = 10 * MINUTE;
const CHECK = "task-progress.check";
const START = Date.parse("2026-11-04T08:00:00Z");

const iso = (ms: number) => new Date(ms).toISOString();

const running = (
  overrides: Partial<TaskProgressSnapshot["tasks"][number]> = {},
): TaskProgressSnapshot["tasks"][number] => ({
  task_id: "workitem_1",
  title: "Competitor report",
  status: "running",
  status_since: iso(START),
  pending_approvals: 0,
  ...overrides,
});

const setup = (
  options: {
    kind?: "meta" | "alter_ego";
    snapshot?: () => TaskProgressSnapshot | Promise<TaskProgressSnapshot>;
    busy?: () => boolean;
    followUp?: () => FeatureSubmitResult;
  } = {},
) => {
  let clock = START;
  let snapshot: () => TaskProgressSnapshot | Promise<TaskProgressSnapshot> =
    options.snapshot ?? (() => ({ live_foreground: false, tasks: [] }));
  const timers = { set: vi.fn(), clear: vi.fn() } satisfies FeatureTimers;
  const sent: Message[] = [];
  const background: Promise<unknown>[] = [];
  const read = vi.fn(async () => snapshot());
  const logger = { log: vi.fn(), child: vi.fn() };
  const { context } = makeTestFeatureContext({
    activeRunId: () => (options.busy?.() ? "run-1" : undefined),
    followUp: async (message) => {
      sent.push(message);
      return options.followUp?.() ?? { status: "accepted" };
    },
    ...(options.kind === "alter_ego"
      ? { ref: { kind: "alter_ego", agentId: "agent-1", taskId: "task-1" } }
      : {}),
  });
  const composed = composeContextFeatures({
    context,
    features: [
      createTaskProgressFeature({
        client: { read },
        timers,
        trackBackground: (operation) => {
          background.push(operation);
        },
        logger,
        now: () => clock,
      }),
    ],
  });
  return {
    composed,
    read,
    sent,
    logger,
    advance: (ms: number) => {
      clock += ms;
    },
    setSnapshot: (next: () => TaskProgressSnapshot) => {
      snapshot = next;
    },
    /** When the check timer was last set for. */
    due: () => timers.set.mock.calls.at(-1)?.[2] as number | undefined,
    armedTimes: () => timers.set.mock.calls.length,
    /** Fires the check timer at its due time and waits for the check. */
    fire: async () => {
      const due = timers.set.mock.calls.at(-1)?.[2] as number;
      clock = Math.max(clock, due);
      composed.onTimer(CHECK);
      await Promise.all(background.splice(0));
    },
  };
};

describe("task-progress feature", () => {
  it("matches only Meta Contexts", () => {
    expect(setup().composed.matched).toEqual([TASK_PROGRESS_FEATURE_ID]);
    expect(setup({ kind: "alter_ego" }).composed.matched).toEqual([]);
  });

  it("checks one quiet period after binding and stops when nothing is at work", async () => {
    const { composed, due, fire, read, sent, armedTimes } = setup();
    await composed.bindSources({ bootstrap: undefined as never });
    expect(due()).toBe(START + QUIET);
    await fire();
    expect(read).toHaveBeenCalledWith("room-1", "agent-1", expect.anything());
    expect(sent).toEqual([]);
    expect(armedTimes()).toBe(1);
  });

  it("reminds once the Agent has been silent for the quiet period while a Task runs", async () => {
    const lastSpoke = START - 15 * MINUTE;
    const { composed, fire, sent, due, logger } = setup({
      snapshot: () => ({
        live_foreground: false,
        agent_last_spoke_at: iso(lastSpoke),
        tasks: [
          running({
            last_report_at: iso(START - 5 * MINUTE),
            latest_step: {
              title: "Reading pricing pages",
              at: iso(START + 2 * MINUTE),
            },
          }),
          running({
            task_id: "workitem_2",
            title: "Mac r3 package",
            status: "waiting_for_approval",
            pending_approvals: 1,
          }),
        ],
      }),
    });
    composed.onRunTerminal({
      runId: "run",
      terminal: { type: "succeeded" },
    } as never);
    await fire();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.sourceInboxIds).toBeUndefined();
    expect(sent[0]!.rawMessage).toBe(
      [
        "[Task progress check] Tasks you coordinate are still at work, and nobody in this Room has heard from you for 25m. As of now:",
        '- workitem_1 "Competitor report": running for 10m; last report 15m ago; latest step "Reading pricing pages" (8m ago)',
        '- workitem_2 "Mac r3 package": waiting for approval for 10m; no report yet; 1 approval pending',
        "If something here is worth telling the user, run teamhub task check --task-id <id> first, then tell them in one short message with teamhub message send, as your own update; do not mention this check. If nothing that matters changed, do nothing.",
      ].join("\n"),
    );
    expect(logger.log).toHaveBeenCalledWith(
      "info",
      "task_progress.reminded",
      expect.objectContaining({ tasks: 2, wait_ms: QUIET }),
    );
    expect(due()).toBe(START + QUIET + QUIET);
  });

  it("waits a full quiet period after the Agent last spoke", async () => {
    const spoke = START + 4 * MINUTE;
    const { composed, fire, sent, due, setSnapshot } = setup();
    setSnapshot(() => ({
      live_foreground: false,
      agent_last_spoke_at: iso(spoke),
      tasks: [running()],
    }));
    await composed.bindSources({ bootstrap: undefined as never });
    await fire();
    expect(sent).toEqual([]);
    expect(due()).toBe(spoke + QUIET);
    await fire();
    expect(sent).toHaveLength(1);
  });

  it("doubles the wait while reminders pass with nothing changed, and resets on a change", async () => {
    const tasks = [running()];
    const { composed, fire, sent, due, setSnapshot } = setup();
    setSnapshot(() => ({
      live_foreground: false,
      agent_last_spoke_at: iso(START - QUIET),
      tasks,
    }));
    await composed.bindSources({ bootstrap: undefined as never });
    await fire();
    const first = START + QUIET;
    expect(sent).toHaveLength(1);
    await fire();
    expect(sent).toHaveLength(1);
    expect(due()).toBe(first + 2 * QUIET);
    await fire();
    expect(sent).toHaveLength(2);
    const second = first + 2 * QUIET;
    // The next reminder waits 40m but TeamHub is still read every 10m.
    await fire();
    expect(due()).toBe(second + 2 * QUIET);
    await fire();
    expect(sent).toHaveLength(2);
    expect(due()).toBe(second + 3 * QUIET);
    tasks[0] = running({
      latest_step: { title: "Writing summary", at: iso(second + MINUTE) },
    });
    await fire();
    expect(sent).toHaveLength(3);
    expect(due()).toBe(second + 4 * QUIET);
  });

  it("never reminds while a Live call holds the foreground", async () => {
    const { composed, fire, sent, due, read } = setup({
      snapshot: () => ({ live_foreground: true, tasks: [] }),
    });
    await composed.bindSources({ bootstrap: undefined as never });
    await fire();
    expect(sent).toEqual([]);
    expect(due()).toBe(START + 2 * QUIET);
    await fire();
    expect(read).toHaveBeenCalledTimes(2);
    expect(sent).toEqual([]);
  });

  it("waits for a busy Meta instead of steering into its Run", async () => {
    let busy = true;
    const { composed, fire, sent, due } = setup({
      busy: () => busy,
      snapshot: () => ({ live_foreground: false, tasks: [running()] }),
    });
    await composed.bindSources({ bootstrap: undefined as never });
    await fire();
    expect(sent).toEqual([]);
    expect(due()).toBe(START + QUIET + MINUTE);
    busy = false;
    await fire();
    expect(sent).toHaveLength(1);
  });

  it("retries a failed read or a skipped submission after a minute", async () => {
    let fail = true;
    let skip = true;
    const { composed, fire, sent, due, logger } = setup({
      snapshot: () => {
        if (fail) throw new Error("TeamHub down");
        return { live_foreground: false, tasks: [running()] };
      },
      followUp: () =>
        skip ? { status: "skipped", reason: "stale" } : { status: "accepted" },
    });
    await composed.bindSources({ bootstrap: undefined as never });
    await fire();
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "task_progress.read_failed",
      expect.objectContaining({ room_id: "room-1" }),
    );
    expect(due()).toBe(START + QUIET + MINUTE);
    fail = false;
    await fire();
    expect(sent).toHaveLength(1);
    expect(due()).toBe(START + QUIET + 2 * MINUTE);
    skip = false;
    await fire();
    expect(sent).toHaveLength(2);
  });

  it("ignores other timers and arms on a Run only when no check is pending", async () => {
    const { composed, read, armedTimes } = setup();
    composed.onTimer("context-restart.idle");
    expect(read).not.toHaveBeenCalled();
    composed.onRunTerminal({
      runId: "run",
      terminal: { type: "succeeded" },
    } as never);
    composed.onRunTerminal({
      runId: "run",
      terminal: { type: "succeeded" },
    } as never);
    expect(armedTimes()).toBe(1);
  });
});

describe("task-progress reminder text", () => {
  it("formats durations for reading", () => {
    expect(formatDuration(-5)).toBe("0s");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(12 * MINUTE)).toBe("12m");
    expect(formatDuration(125 * MINUTE)).toBe("2h5m");
  });

  it("says when the Agent has not spoken in the Room yet", () => {
    expect(
      renderTaskProgressReminder(
        { live_foreground: false, tasks: [running()] },
        START,
      ).split("\n")[0],
    ).toBe(
      "[Task progress check] Tasks you coordinate are still at work, and you have not said anything in this Room yet. As of now:",
    );
  });
});
