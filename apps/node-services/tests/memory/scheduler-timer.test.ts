import { afterEach, describe, expect, it, vi } from "vitest";

import type { MemoryScheduleConfig } from "../../src/memory/config.js";
import {
  MEMORY_SCHEDULER_FALLBACK_MS,
  MemoryScheduler,
  type MemorySchedulerReason,
} from "../../src/memory/scheduler.js";
import { MemoryCalendarFixture } from "./scheduler-state-fixture.js";

const config: MemoryScheduleConfig = {
  concurrency: 1,
  weeklyDay: 1,
  timeZone: "Asia/Shanghai",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("Memory scheduler timer", () => {
  it("runs periodic work at start and again only after its interval, never twice at once", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-29T10:00:30+08:00") });
    let finish!: () => void;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const scheduler = new MemoryScheduler(config, async () => {}, [
      { name: "test", everyMs: 60_000, run },
    ]);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledOnce();
    // A pass that finds the work still running skips it.
    await vi.advanceTimersByTimeAsync(180_000);
    expect(run).toHaveBeenCalledOnce();
    finish();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(2);
    scheduler.stop();
    finish();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("sleeps until the next calendar hour or a due retry, and at most one minute", () => {
    const at = new Date("2026-09-29T10:30:00+08:00");
    const calendar = new MemoryCalendarFixture();
    const idle = new MemoryScheduler(config, async () => {}, [], calendar);
    expect(idle.nextDelayMs(at)).toBe(MEMORY_SCHEDULER_FALLBACK_MS);
    expect(idle.nextDelayMs(new Date("2026-09-29T10:59:30.250+08:00"))).toBe(
      29_750,
    );

    calendar.saved = {
      timeZone: config.timeZone,
      hour: Date.UTC(2026, 8, 29, 10) / 3_600_000,
      completed: [],
      pending: [
        {
          input: { task: "daily", date: "2026-09-28", concurrency: 1 },
          period: "2026-09-28",
          reason: "daily",
          attempts: 1,
          nextAttemptAt: at.getTime() + 15_000,
        },
      ],
      failed: [],
    };
    const retrying = new MemoryScheduler(config, async () => {}, [], calendar);
    expect(retrying.nextDelayMs(at)).toBe(15_000);
  });

  it("starts each rebuild step as soon as the one before it settles", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-29T10:00:30+08:00") });
    const reasons: MemorySchedulerReason[] = [];
    const scheduler = new MemoryScheduler(
      config,
      async (_input, reason) => {
        reasons.push(reason);
      },
      [],
      new MemoryCalendarFixture(),
    );
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await scheduler.enqueueRebuild({
      memorySubjectKey: "agent_a",
      sessionDates: ["2026-09-28"],
    });
    // init, initial index, Wiki and Daily for the closed date, final index;
    // passes stay a second apart, far below the one-minute fallback.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reasons.filter((reason) => reason === "rebuild")).toHaveLength(5);
    expect(scheduler.rebuildStatus("agent_a")).toMatchObject({
      phase: "completed",
    });
    scheduler.stop();
  });
});
