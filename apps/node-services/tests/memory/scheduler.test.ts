import { createJsonLogger } from "@linger/service-kit/node";
import { afterEach, describe, expect, it } from "vitest";

import type { MemoryScheduleConfig } from "../../src/memory/config.js";
import {
  MemoryScheduler,
  type MemoryScheduledTask,
} from "../../src/memory/scheduler.js";
import {
  memoryLogger,
  recordSubjectFailure,
  setMemoryLogger,
} from "../../src/memory/run-telemetry.js";

const config: MemoryScheduleConfig = {
  concurrency: 3,
  timeZone: "Asia/Shanghai",
  weeklyDay: 1,
};

const defaultLogger = memoryLogger();

afterEach(() => {
  setMemoryLogger(defaultLogger);
});

/** Collects `memory_schedule_run` log entries, newest last. */
function captureScheduleRuns(): Record<string, unknown>[] {
  const runs: Record<string, unknown>[] = [];
  setMemoryLogger(
    createJsonLogger({
      service: "test",
      write: (line) => {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.event === "memory_schedule_run") runs.push(entry);
      },
    }),
  );
  return runs;
}

describe("MemoryScheduler", () => {
  it("runs other subjects while one subject waits, keeping each subject in order", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const events: string[] = [];
    let held = true;
    const scheduler = new MemoryScheduler(config, async (task) => {
      events.push(`start:${task.memorySubjectKey}`);
      if (task.memorySubjectKey === "agent_a" && held) {
        held = false;
        await gate;
      }
      events.push(`end:${task.memorySubjectKey}`);
    });
    const target = (memorySubjectKey: string) =>
      ({
        task: "wiki",
        date: "2026-09-29",
        concurrency: 1,
        memorySubjectKey,
        roomId: "room_1",
      }) as const;
    const firstA = scheduler.runTarget(target("agent_a"), "a1", "idle");
    const secondA = scheduler.runTarget(target("agent_a"), "a2", "idle");
    // A stuck subject (e.g. a Wiki publication wait) does not hold others.
    await scheduler.runTarget(target("agent_b"), "b1", "idle");
    expect(events).toEqual(["start:agent_a", "start:agent_b", "end:agent_b"]);
    release();
    await Promise.all([firstA, secondA]);
    expect(events.slice(3)).toEqual([
      "end:agent_a",
      "start:agent_a",
      "end:agent_a",
    ]);
  });

  it("marks isolated AnotherMe failures as failed rather than successful", async () => {
    const runs = captureScheduleRuns();
    const scheduler = new MemoryScheduler(config, async () => {
      recordSubjectFailure({
        error: "graph failed",
        memory_subject_key: "agent_bad",
      });
    });
    scheduler.runDueTasks(new Date("2026-08-31T01:00:00.000Z"));
    await scheduler.idle();
    expect(runs).toMatchObject([
      {
        level: "error",
        status: "failed",
        subjectFailures: [
          { error: "graph failed", memory_subject_key: "agent_bad" },
        ],
      },
    ]);
  });
  it("runs the sessionly pipeline once per local hour", async () => {
    const invocations: MemoryScheduledTask[] = [];
    const scheduler = new MemoryScheduler(config, async (input) => {
      invocations.push(input);
    });
    const now = new Date("2026-08-31T01:00:00.000Z");

    scheduler.runDueTasks(now);
    scheduler.runDueTasks(now);
    await scheduler.idle();

    expect(invocations).toEqual([
      { task: "wiki", date: "2026-08-31", concurrency: 3 },
    ]);
  });

  it("runs daily and weekly root pipelines at Shanghai midnight", async () => {
    const invocations: MemoryScheduledTask[] = [];
    const scheduler = new MemoryScheduler(config, async (input) => {
      invocations.push(input);
    });

    scheduler.runDueTasks(new Date("2026-08-30T16:00:00.000Z"));
    await scheduler.idle();

    expect(invocations).toEqual([
      { task: "wiki", date: "2026-08-30", concurrency: 3 },
      { task: "daily", date: "2026-08-30", concurrency: 3 },
      { task: "weekly", weekStart: "2026-08-24", concurrency: 3 },
    ]);
  });

  it("closes the previous date once at midnight and resumes today's sessions at 01:00", async () => {
    const invocations: MemoryScheduledTask[] = [];
    const scheduler = new MemoryScheduler(config, async (input) => {
      invocations.push(input);
    });
    for (const time of [
      "2026-12-31T15:00:00.000Z",
      "2026-12-31T16:00:00.000Z",
      "2026-12-31T16:00:15.000Z",
      "2026-12-31T17:00:00.000Z",
    ]) {
      scheduler.runDueTasks(new Date(time));
      await scheduler.idle();
    }

    expect(invocations).toEqual([
      { task: "wiki", date: "2026-12-31", concurrency: 3 },
      { task: "wiki", date: "2026-12-31", concurrency: 3 },
      { task: "daily", date: "2026-12-31", concurrency: 3 },
      { task: "wiki", date: "2027-01-01", concurrency: 3 },
    ]);
  });

  it("does not queue work outside the schedule minute", async () => {
    const invocations: MemoryScheduledTask[] = [];
    const scheduler = new MemoryScheduler(config, async (input) => {
      invocations.push(input);
    });
    scheduler.runDueTasks(new Date("2026-08-31T01:07:00.000Z"));
    await scheduler.idle();
    expect(invocations).toEqual([]);
  });

  it("blocks dependent work after a failure and retries it next hour", async () => {
    const invocations: MemoryScheduledTask[] = [];
    let failSessionly = true;
    const scheduler = new MemoryScheduler(config, async (input) => {
      invocations.push(input);
      if (input.task === "wiki" && failSessionly) {
        throw new Error("sessionly failed");
      }
    });

    scheduler.runDueTasks(new Date("2026-08-30T16:00:00.000Z"));
    await scheduler.idle();
    expect(invocations.map(({ task }) => task)).toEqual(["wiki"]);

    failSessionly = false;
    scheduler.runDueTasks(new Date("2026-08-30T17:00:00.000Z"));
    await scheduler.idle();
    expect(invocations.map(({ task }) => task)).toEqual([
      "wiki",
      "wiki",
      "daily",
      "weekly",
      "wiki",
    ]);
    expect(invocations[1]).toEqual({
      task: "wiki",
      date: "2026-08-30",
      concurrency: 3,
    });
  });

  it("does not run Weekly over a failed Daily", async () => {
    const invocations: MemoryScheduledTask[] = [];
    let failDaily = true;
    const scheduler = new MemoryScheduler(config, async (input) => {
      invocations.push(input);
      if (input.task === "daily" && failDaily) throw new Error("daily failed");
    });

    scheduler.runDueTasks(new Date("2026-08-30T16:00:00.000Z"));
    await scheduler.idle();
    expect(invocations.map(({ task }) => task)).toEqual(["wiki", "daily"]);

    failDaily = false;
    scheduler.runDueTasks(new Date("2026-08-30T17:00:00.000Z"));
    await scheduler.idle();
    expect(invocations.map(({ task }) => task)).toEqual([
      "wiki",
      "daily",
      "daily",
      "weekly",
      "wiki",
    ]);
  });
});
