import { describe, expect, it, vi } from "vitest";
import {
  MemoryRebuildUnavailableError,
  MemoryScheduler,
  type MemoryScheduledTask,
} from "../../src/memory/scheduler.js";
import { rebuildHoldsOwner } from "../../src/memory/rebuild.js";
import { recordSubjectFailure } from "../../src/memory/run-telemetry.js";
import type { MemoryScheduleConfig } from "../../src/memory/config.js";
import { MemoryCalendarFixture } from "./scheduler-state-fixture.js";
import {
  COMPUTER_OFFLINE_MESSAGE,
  ModelCallError,
} from "../../src/runtime-model-call.js";

const config: MemoryScheduleConfig = {
  concurrency: 1,
  weeklyDay: 1,
  timeZone: "Asia/Shanghai",
};
type Runner = ConstructorParameters<typeof MemoryScheduler>[1];
async function checkpoint() {
  return new MemoryCalendarFixture();
}
/** The saved calendar row, read as the loosely typed JSON the tests inspect. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function row(store: MemoryCalendarFixture): any {
  return store.saved;
}
function summary(tasks: MemoryScheduledTask[]) {
  return tasks.map(
    (task) =>
      `${task.task}:${task.task === "weekly" ? task.weekStart : task.date}`,
  );
}

describe("durable Wiki calendar", () => {
  it("catches up a missed midnight on first start without replaying each intermediate hour", async () => {
    const calls: MemoryScheduledTask[] = [];
    const scheduler = new MemoryScheduler(
      config,
      async (task) => {
        calls.push(task);
      },
      undefined,
      await checkpoint(),
    );
    scheduler.runDueTasks(new Date("2026-09-28T15:37:00+08:00"));
    await scheduler.idle();
    expect(summary(calls)).toEqual([
      "wiki:2026-09-27",
      "daily:2026-09-27",
      "weekly:2026-09-21",
      "wiki:2026-09-28",
    ]);
    scheduler.runDueTasks(new Date("2026-09-28T15:58:00+08:00"));
    await scheduler.idle();
    expect(calls).toHaveLength(4);
  });

  it("keeps completed receipts across restart and catches closed dates in order", async () => {
    const file = await checkpoint();
    const first = new MemoryScheduler(config, async () => {}, undefined, file);
    first.runDueTasks(new Date("2026-09-27T23:03:00+08:00"));
    await first.idle();
    const calls: MemoryScheduledTask[] = [];
    const restarted = new MemoryScheduler(
      config,
      async (task) => {
        calls.push(task);
      },
      undefined,
      file,
    );
    restarted.runDueTasks(new Date("2026-09-29T09:45:00+08:00"));
    await restarted.idle();
    expect(summary(calls)).toEqual([
      "wiki:2026-09-27",
      "daily:2026-09-27",
      "weekly:2026-09-21",
      "wiki:2026-09-28",
      "daily:2026-09-28",
      "wiki:2026-09-29",
    ]);
    const noRepeat = vi.fn(async () => {});
    const sameHour = new MemoryScheduler(config, noRepeat, undefined, file);
    sameHour.runDueTasks(new Date("2026-09-29T09:50:00+08:00"));
    await sameHour.idle();
    expect(noRepeat).not.toHaveBeenCalled();
  });

  it("restores failed Daily and its blocked Weekly without rerunning successful Session work", async () => {
    const file = await checkpoint();
    const first = new MemoryScheduler(
      config,
      async (task) => {
        if (task.task === "daily")
          throw new Error("retryable provider failure");
      },
      undefined,
      file,
    );
    const now = new Date("2026-09-28T00:03:00+08:00");
    first.runDueTasks(now);
    await first.idle();
    const calls: MemoryScheduledTask[] = [];
    const restarted = new MemoryScheduler(
      config,
      async (task) => {
        calls.push(task);
      },
      undefined,
      file,
    );
    restarted.runDueTasks(new Date(now.getTime() + 3_600_000));
    await restarted.idle();
    expect(summary(calls)).toEqual([
      "daily:2026-09-27",
      "weekly:2026-09-21",
      "wiki:2026-09-28",
    ]);
    const saved = row(file);
    expect(saved.pending).toEqual([]);
  });
});

it("starts the calendar over when it was saved in another timezone", async () => {
  const file = await checkpoint();
  file.saved = {
    timeZone: "UTC",
    hour: 1,
    completed: [],
    pending: [],
    failed: [],
  };
  const calls: MemoryScheduledTask[] = [];
  const scheduler = new MemoryScheduler(
    config,
    async (task) => {
      calls.push(task);
    },
    undefined,
    file,
  );
  scheduler.runDueTasks(new Date("2026-09-29T10:01:00+08:00"));
  await scheduler.idle();
  expect(calls.length).toBeGreaterThan(0);
  expect(row(file).timeZone).toBe(config.timeZone);
});

it("coalesces obsolete hourly failures without accumulating one retry per hour", async () => {
  const file = await checkpoint();
  const scheduler = new MemoryScheduler(
    config,
    async () => {
      throw new Error("offline");
    },
    undefined,
    file,
  );
  for (const hour of [10, 11, 12, 13]) {
    scheduler.runDueTasks(new Date(`2026-09-29T${hour}:00:00+08:00`));
    await scheduler.idle();
  }
  const saved = row(file);
  expect(
    saved.pending.filter(
      (task: { input: { date: string } }) => task.input.date === "2026-09-29",
    ),
  ).toHaveLength(1);
});

describe("bounded per-subject calendar recovery", () => {
  // Wiki succeeds and Weekly is not due, so each case observes only Daily.
  const daily =
    (run: Runner): Runner =>
    async (task, ...rest) =>
      task.task === "daily" ? run(task, ...rest) : undefined;
  const start = new Date("2026-09-30T00:00:00+08:00");
  it("persists only failing subjects and retries them after restart", async () => {
    const file = await checkpoint();
    const first = new MemoryScheduler(
      config,
      daily(async () => {
        recordSubjectFailure({
          memory_subject_key: "agent_bad",
          error: "provider offline",
        });
      }),
      undefined,
      file,
    );
    first.runDueTasks(start);
    await first.idle();
    const state = row(file);
    expect(state.completed).toEqual(["wiki:2026-09-30T00"]);
    expect(state.pending[0]).toMatchObject({
      attempts: 1,
      retrySubjects: ["agent_bad"],
    });
    const calls = vi.fn(async () => {});
    const restored = new MemoryScheduler(config, daily(calls), undefined, file);
    restored.runDueTasks(start);
    await restored.idle();
    expect(calls).not.toHaveBeenCalled();
    restored.runDueTasks(new Date(start.getTime() + 3_600_000));
    await restored.idle();
    expect(calls).toHaveBeenCalledTimes(1);
    expect(calls).toHaveBeenCalledWith(
      expect.objectContaining({
        memorySubjectKey: "agent_bad",
        date: "2026-09-29",
      }),
      "daily",
      expect.any(Function),
      "2026-09-29",
    );
    expect(row(file).pending).toEqual([]);
  });
  it("retries within the hour at 15s, 1m, 3m, 10m and 1h, then preserves the terminal receipt", async () => {
    const file = await checkpoint();
    const calls = vi.fn(async () => {
      throw new Error("invalid output");
    });
    const scheduler = new MemoryScheduler(
      config,
      daily(calls),
      undefined,
      file,
    );
    let at = start.getTime();
    for (const delay of [0, 15_000, 60_000, 180_000, 600_000, 3_600_000]) {
      // One tick just before each retry is due must not run it.
      at += delay;
      if (delay) {
        scheduler.runDueTasks(new Date(at - 1_000));
        await scheduler.idle();
      }
      const before = calls.mock.calls.length;
      scheduler.runDueTasks(new Date(at));
      await scheduler.idle();
      expect(calls.mock.calls.length).toBe(before + 1);
    }
    expect(calls).toHaveBeenCalledTimes(6);
    scheduler.runDueTasks(new Date(start.getTime() + 23 * 3_600_000));
    await scheduler.idle();
    expect(calls).toHaveBeenCalledTimes(6);
    const saved = row(file);
    expect(saved.pending).toEqual([]);
    expect(saved.failed[0]).toMatchObject({
      attempts: 6,
      terminalReason: "invalid output",
    });
  });
  it("waits five minutes for an offline Computer without spending attempts", async () => {
    const file = await checkpoint();
    let offline = true;
    const calls = vi.fn(async () => {
      if (offline)
        throw new ModelCallError("computer_offline", COMPUTER_OFFLINE_MESSAGE);
    });
    const scheduler = new MemoryScheduler(
      config,
      daily(calls),
      undefined,
      file,
    );
    let at = start.getTime();
    for (let round = 0; round < 10; round += 1) {
      scheduler.runDueTasks(new Date(at));
      await scheduler.idle();
      scheduler.runDueTasks(new Date(at + 5 * 60_000 - 1_000));
      await scheduler.idle();
      at += 5 * 60_000;
    }
    expect(calls).toHaveBeenCalledTimes(10);
    const waiting = row(file);
    expect(waiting.failed).toEqual([]);
    expect(waiting.pending[0]).toMatchObject({ attempts: 0 });
    offline = false;
    scheduler.runDueTasks(new Date(at));
    await scheduler.idle();
    expect(calls).toHaveBeenCalledTimes(11);
    expect(row(file).pending).toEqual([]);
  });
  it("fails a task whose Computer stays offline past the wait limit", async () => {
    const file = await checkpoint();
    const calls = vi.fn(async () => {
      throw new ModelCallError("computer_offline", COMPUTER_OFFLINE_MESSAGE);
    });
    const scheduler = new MemoryScheduler(
      config,
      daily(calls),
      undefined,
      file,
    );
    scheduler.runDueTasks(start);
    await scheduler.idle();
    const waiting = row(file);
    expect(waiting.pending[0]).toMatchObject({
      attempts: 0,
      offlineSince: start.getTime(),
    });
    scheduler.runDueTasks(new Date(start.getTime() + 7 * 24 * 3_600_000));
    await scheduler.idle();
    const saved = row(file);
    expect(saved.failed).toContainEqual(
      expect.objectContaining({
        input: waiting.pending[0].input,
        terminalReason: expect.stringContaining(COMPUTER_OFFLINE_MESSAGE),
      }),
    );
  });
  it("runs a blocked Weekly on the next tick after its Daily retry succeeds", async () => {
    const file = await checkpoint();
    const monday = new Date("2026-09-28T00:00:00+08:00");
    const calls: string[] = [];
    let offline = true;
    const scheduler = new MemoryScheduler(
      config,
      async (task) => {
        calls.push(task.task);
        if (offline && task.task === "daily") throw new Error("offline");
      },
      undefined,
      file,
    );
    scheduler.runDueTasks(monday);
    await scheduler.idle();
    expect(calls).toEqual(["wiki", "daily"]);
    offline = false;
    for (const offset of [15_000, 30_000]) {
      scheduler.runDueTasks(new Date(monday.getTime() + offset));
      await scheduler.idle();
    }
    expect(calls).toEqual(["wiki", "daily", "daily", "weekly"]);
  });
  describe("per-subject dependencies", () => {
    const monday = new Date("2026-09-28T00:00:00+08:00");
    const label = (task: MemoryScheduledTask) =>
      `${summary([task])[0]}:${task.memorySubjectKey ?? "all"}${
        "heldMemorySubjectKeys" in task && task.heldMemorySubjectKeys
          ? `-held:${task.heldMemorySubjectKeys.join(",")}`
          : ""
      }`;
    const badWiki = (state: { broken: boolean }) =>
      async function run(task: MemoryScheduledTask) {
        if (!state.broken || task.task !== "wiki" || task.date !== "2026-09-27")
          return;
        if (task.memorySubjectKey) throw new Error("source 404");
        recordSubjectFailure({
          memory_subject_key: "agent_bad",
          error: "source 404",
        });
      };
    async function tick(scheduler: MemoryScheduler, at: number) {
      scheduler.runDueTasks(new Date(at));
      await scheduler.idle();
    }

    it("runs Daily and Weekly for other subjects while one subject's Wiki retries", async () => {
      const state = { broken: true };
      const calls: MemoryScheduledTask[] = [];
      const fail = badWiki(state);
      const scheduler = new MemoryScheduler(
        config,
        async (task) => {
          calls.push(task);
          await fail(task);
        },
        undefined,
        await checkpoint(),
      );
      await tick(scheduler, monday.getTime());
      expect(calls.map(label)).toEqual([
        "wiki:2026-09-27:all",
        "daily:2026-09-27:all-held:agent_bad",
        "weekly:2026-09-21:all-held:agent_bad",
      ]);

      state.broken = false;
      for (const offset of [15_000, 30_000, 45_000, 60_000])
        await tick(scheduler, monday.getTime() + offset);
      expect(calls.slice(3).map(label)).toEqual([
        "wiki:2026-09-27:agent_bad",
        "daily:2026-09-27:agent_bad",
        "weekly:2026-09-21:agent_bad",
      ]);
      expect(scheduler.failures()).toEqual({
        exhausted: [],
        pending_retries: [],
      });
    });

    it("exhausts only the failing subject's dependents and revives them with its Wiki", async () => {
      const state = { broken: true };
      const calls: MemoryScheduledTask[] = [];
      const fail = badWiki(state);
      const scheduler = new MemoryScheduler(
        config,
        async (task) => {
          calls.push(task);
          await fail(task);
        },
        undefined,
        await checkpoint(),
      );
      let at = monday.getTime();
      for (const delay of [0, 15_000, 60_000, 180_000, 600_000, 3_600_000]) {
        at += delay;
        await tick(scheduler, at);
      }
      for (const offset of [15_000, 30_000]) await tick(scheduler, at + offset);
      expect(
        scheduler
          .failures()
          .exhausted.map(({ key, subjects }) => ({ key, subjects })),
      ).toEqual([
        { key: "wiki:2026-09-28T00", subjects: ["agent_bad"] },
        { key: "daily:2026-09-27", subjects: ["agent_bad"] },
        { key: "weekly:2026-09-21", subjects: ["agent_bad"] },
      ]);

      state.broken = false;
      calls.length = 0;
      expect(await scheduler.retryFailed(["wiki:2026-09-28T00"])).toEqual([
        "wiki:2026-09-28T00",
        "daily:2026-09-27",
        "weekly:2026-09-21",
      ]);
      for (const offset of [45_000, 60_000, 75_000, 90_000])
        await tick(scheduler, at + offset);
      expect(calls.map(label)).toEqual([
        "wiki:2026-09-27:agent_bad",
        "daily:2026-09-27:agent_bad",
        "weekly:2026-09-21:agent_bad",
      ]);
      expect(scheduler.failures().exhausted).toEqual([]);
    });
  });

  it("manually revives an exhausted task and the dependents it blocked", async () => {
    const file = await checkpoint();
    const wiki = {
      input: { task: "wiki", date: "2026-09-29", concurrency: 1 },
      period: "2026-09-30T00",
      reason: "hourly",
      attempts: 5,
      retrySubjects: ["agent_bad"],
      terminalReason: "provider offline",
    };
    const blocked = (task: "daily" | "weekly", dependsOn: string) => ({
      input:
        task === "daily"
          ? { task, date: "2026-09-29", concurrency: 1 }
          : { task, weekStart: "2026-09-22", concurrency: 1 },
      period: task === "daily" ? "2026-09-29" : "2026-09-22",
      reason: task,
      dependsOn,
      attempts: 0,
      terminalReason: `Dependency exhausted: ${dependsOn}`,
    });
    const unrelated = { ...wiki, period: "2026-09-29T00" };
    file.saved = JSON.parse(
      JSON.stringify({
        timeZone: config.timeZone,
        hour: Date.UTC(2026, 8, 30, 0) / 3_600_000,
        completed: [],
        pending: [],
        // Dependents are listed first to prove revival orders dependencies.
        failed: [
          blocked("weekly", "daily:2026-09-29"),
          blocked("daily", "wiki:2026-09-30T00"),
          wiki,
          unrelated,
        ],
      }),
    );
    const calls: MemoryScheduledTask[] = [];
    const scheduler = new MemoryScheduler(
      config,
      async (task) => {
        calls.push(task);
      },
      undefined,
      file,
    );
    const now = new Date("2026-09-30T00:10:00+08:00");
    scheduler.runDueTasks(now);
    await scheduler.idle();
    expect(calls).toEqual([]);
    expect(scheduler.failures().exhausted).toContainEqual({
      key: "wiki:2026-09-30T00",
      task: "wiki",
      period: "2026-09-29",
      subjects: ["agent_bad"],
      attempts: 5,
      terminal_reason: "provider offline",
    });

    expect(await scheduler.retryFailed(["wiki:2026-09-30T00"])).toEqual([
      "wiki:2026-09-30T00",
      "daily:2026-09-29",
      "weekly:2026-09-22",
    ]);
    const saved = row(file);
    expect(saved.failed.map((task: typeof wiki) => task.period)).toEqual([
      "2026-09-29T00",
    ]);
    expect(saved.pending[0]).toMatchObject({ attempts: 0 });
    expect(saved.pending[0].terminalReason).toBeUndefined();
    expect(calls).toEqual([]);

    scheduler.runDueTasks(new Date(now.getTime() + 60_000));
    await scheduler.idle();
    expect(summary(calls)).toEqual([
      "wiki:2026-09-29",
      "daily:2026-09-29",
      "weekly:2026-09-22",
    ]);
    expect(calls[0]).toMatchObject({ memorySubjectKey: "agent_bad" });
    const done = row(file);
    expect(done.pending).toEqual([]);
    expect(done.failed).toHaveLength(1);
  });
});

describe("operator history rebuild", () => {
  // The calendar always runs; these cases observe only the rebuild steps.
  const rebuildOnly =
    (run: Runner): Runner =>
    async (task, ...rest) =>
      task.memorySubjectKey ? run(task, ...rest) : undefined;
  // Wednesday; the week starting Monday 2026-09-28 is still open.
  const now = new Date("2026-09-30T10:00:00+08:00");
  const rebuild = {
    memorySubjectKey: "agent_a",
    sessionDates: [
      "2026-09-24",
      "2026-09-10",
      "2026-09-22",
      "2026-09-27",
      "2026-09-28",
      "2026-09-30",
      "2026-09-24",
      "2026-10-01",
    ],
  };
  const chain = [
    "init",
    "index-initial",
    "wiki:2026-09-10",
    "daily:2026-09-10",
    // The closed week's last Session date is followed by its Weekly.
    "weekly:2026-09-07",
    "wiki:2026-09-22",
    "daily:2026-09-22",
    "wiki:2026-09-24",
    "daily:2026-09-24",
    "wiki:2026-09-27",
    "daily:2026-09-27",
    "weekly:2026-09-21",
    "wiki:2026-09-28",
    "daily:2026-09-28",
    // Today's Session is replayed; Daily and the open week wait for the calendar.
    "wiki:2026-09-30",
    "index-final",
  ];
  const label = (task: MemoryScheduledTask) =>
    task.task === "weekly"
      ? `weekly:${task.weekStart}`
      : task.task === "wiki" || task.task === "daily"
        ? `${task.task}:${task.date}`
        : task.task;
  const unscoped = (key: string) => key.replace(/:rebuild:agent_a(?=:|$)/u, "");
  async function drain(scheduler: MemoryScheduler, at = now, ticks = 30) {
    for (let tick = 0; tick < ticks; tick += 1) {
      // Keep the final idle tick without writing every empty intermediate hour.
      if (scheduler.rebuildHolds().size === 0) tick = ticks - 1;
      scheduler.runDueTasks(new Date(at.getTime() + tick * 3_600_000));
      await scheduler.idle();
    }
  }

  it("orders init, one index, only Session dates with closed Weeklies, then a final index, idempotently and durably", async () => {
    const file = await checkpoint();
    const calls: string[] = [];
    const phases: (string | null)[] = [];
    let scheduler: MemoryScheduler;
    const runTask = async (task: MemoryScheduledTask) => {
      calls.push(label(task));
      phases.push(scheduler.rebuildStatus("agent_a").phase);
      // The hold covers every step up to and including the final index.
      expect(scheduler.rebuildHolds()).toEqual(new Set(["agent_a"]));
    };
    scheduler = new MemoryScheduler(
      config,
      rebuildOnly(runTask),
      undefined,
      file,
    );
    scheduler.runDueTasks(now);
    await scheduler.idle();
    const prepare = vi.fn(async () => {});
    const first = await scheduler.enqueueRebuild(rebuild, prepare, now);
    expect(first.queued).toEqual(first.task_keys);
    expect(first.task_keys.map(unscoped)).toEqual(chain);
    expect(first.task_keys).toContain("index-final:rebuild:agent_a");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(scheduler.rebuildStatus("agent_a")).toMatchObject({
      phase: "init",
      index_hold: true,
      from: "2026-09-10",
      to: "2026-09-30",
      sessions: { total: 6, completed: 0 },
      current_task: "init:rebuild:agent_a",
      current_date: null,
    });

    scheduler.runDueTasks(now);
    await scheduler.idle();
    expect(calls).toEqual(["init"]);
    expect(await scheduler.enqueueRebuild(rebuild, prepare, now)).toMatchObject(
      { queued: [] },
    );

    // Pending steps (and so the index hold) survive a restart.
    scheduler = new MemoryScheduler(
      config,
      rebuildOnly(runTask),
      undefined,
      file,
    );
    expect(scheduler.rebuildHolds()).toEqual(new Set(["agent_a"]));
    scheduler.runDueTasks(now);
    await scheduler.idle();
    expect(scheduler.rebuildStatus("agent_a")).toMatchObject({
      phase: "sessions",
      sessions: { total: 6, completed: 0 },
      current_task: "wiki:rebuild:agent_a:2026-09-10",
      current_date: "2026-09-10",
    });
    await drain(scheduler);
    expect(calls).toEqual(chain);
    expect(phases).toEqual([
      "init",
      "index-initial",
      ...Array(chain.length - 3).fill("sessions"),
      "index-final",
    ]);
    expect(scheduler.rebuildHolds().size).toBe(0);
    expect(scheduler.rebuildStatus("agent_a")).toMatchObject({
      phase: "completed",
      index_hold: false,
      sessions: { total: 6, completed: 6 },
      total: chain.length,
      completed: chain.length,
      pending: 0,
      failed: 0,
      current_task: null,
    });
    expect(await scheduler.enqueueRebuild(rebuild, prepare, now)).toMatchObject(
      { queued: [] },
    );
    expect(prepare).toHaveBeenCalledTimes(1);
    await expect(
      scheduler.enqueueRebuild({ ...rebuild, restart: true }, prepare, now),
    ).resolves.toMatchObject({ queued: first.task_keys });
    expect(prepare).toHaveBeenCalledTimes(2);
    await expect(
      scheduler.enqueueRebuild({ ...rebuild, restart: true }, prepare, now),
    ).rejects.toBeInstanceOf(MemoryRebuildUnavailableError);
  });

  it("limits a pilot to Session dates from --from and holds only the rebuilding subject", async () => {
    const calls: string[] = [];
    const scheduler = new MemoryScheduler(
      config,
      rebuildOnly(async (task) => {
        calls.push(label(task));
      }),
      undefined,
      await checkpoint(),
    );
    scheduler.runDueTasks(now);
    await scheduler.idle();
    const result = await scheduler.enqueueRebuild(
      { ...rebuild, from: "2026-09-27" },
      undefined,
      now,
    );
    expect(result.task_keys.map(unscoped)).toEqual([
      "init",
      "index-initial",
      "wiki:2026-09-27",
      "daily:2026-09-27",
      "weekly:2026-09-21",
      "wiki:2026-09-28",
      "daily:2026-09-28",
      "wiki:2026-09-30",
      "index-final",
    ]);
    expect(scheduler.rebuildHolds()).toEqual(new Set(["agent_a"]));
    await expect(
      rebuildHoldsOwner(scheduler.rebuildHolds(), "human_b", async () => [
        subject("agent_a", "human_a"),
        subject("agent_b", "human_b"),
      ]),
    ).resolves.toBe(false);
    await expect(
      rebuildHoldsOwner(scheduler.rebuildHolds(), "human_a", async () => [
        subject("agent_a", "human_a"),
      ]),
    ).resolves.toBe(true);
    // Nothing is looked up while no rebuild is pending.
    const load = vi.fn(async () => []);
    await expect(rebuildHoldsOwner(new Set(), "human_a", load)).resolves.toBe(
      false,
    );
    expect(load).not.toHaveBeenCalled();
    await drain(scheduler);
    expect(calls).toHaveLength(9);
  });

  it("releases the hold when a step is exhausted and revives a failed index step", async () => {
    const file = await checkpoint();
    let offline = true;
    const calls: string[] = [];
    const scheduler = new MemoryScheduler(
      config,
      rebuildOnly(async (task) => {
        calls.push(label(task));
        if (offline && task.task === "index-initial")
          throw new Error("index offline");
      }),
      undefined,
      file,
    );
    scheduler.runDueTasks(now);
    await scheduler.idle();
    await scheduler.enqueueRebuild(rebuild, undefined, now);
    // Every backoff (15s up to 1h) fits in one day of hourly ticks.
    await drain(scheduler, now, 24);
    expect(calls).toEqual(["init", ...Array(6).fill("index-initial")]);
    const failedKey = "index-initial:rebuild:agent_a";
    expect(scheduler.rebuildHolds().size).toBe(0);
    expect(scheduler.rebuildStatus("agent_a")).toMatchObject({
      phase: "failed",
      index_hold: false,
      completed: 1,
      pending: 0,
      failed: chain.length - 1,
      failures: expect.arrayContaining([
        { key: failedKey, attempts: 6, terminal_reason: "index offline" },
      ]),
    });
    expect(scheduler.failures().exhausted).toContainEqual(
      expect.objectContaining({
        key: failedKey,
        task: "index-initial",
        period: "2026-09-30",
        subjects: ["agent_a"],
      }),
    );

    offline = false;
    calls.length = 0;
    expect(await scheduler.retryFailed([failedKey])).toHaveLength(
      chain.length - 1,
    );
    expect(scheduler.rebuildHolds()).toEqual(new Set(["agent_a"]));
    // A revived chain also survives a restart.
    const restored = new MemoryScheduler(
      config,
      rebuildOnly(async (task) => {
        calls.push(label(task));
      }),
      undefined,
      file,
    );
    await drain(restored, new Date(now.getTime() + 86_400_000));
    expect(calls).toEqual(chain.slice(1));
    expect(restored.rebuildStatus("agent_a")).toMatchObject({
      phase: "completed",
      completed: chain.length,
      failed: 0,
    });
  });

  it("lets due calendar work run before the next rebuild step", async () => {
    const calls: MemoryScheduledTask[] = [];
    const scheduler = new MemoryScheduler(
      config,
      async (task) => {
        calls.push(task);
      },
      undefined,
      await checkpoint(),
    );
    const morning = new Date("2026-09-29T10:00:00+08:00");
    scheduler.runDueTasks(morning);
    await scheduler.idle();
    await scheduler.enqueueRebuild(
      { memorySubjectKey: "agent_a", sessionDates: ["2026-09-20"] },
      undefined,
      morning,
    );
    scheduler.runDueTasks(morning);
    await scheduler.idle();
    scheduler.runDueTasks(new Date("2026-09-30T00:05:00+08:00"));
    await scheduler.idle();
    expect(
      calls.map((task) => `${label(task)}@${task.memorySubjectKey ?? "*"}`),
    ).toEqual([
      "wiki:2026-09-28@*",
      "daily:2026-09-28@*",
      "wiki:2026-09-29@*",
      "init@agent_a",
      // The midnight Wiki runs before the next rebuild step; its Daily follows.
      "wiki:2026-09-29@*",
      "index-initial@agent_a",
      "daily:2026-09-29@*",
    ]);
  });

  describe("concurrent subjects", () => {
    // Closed week 2026-09-21; the chain has six steps.
    const steps = [
      "init",
      "index-initial",
      "wiki:2026-09-22",
      "daily:2026-09-22",
      "weekly:2026-09-21",
      "index-final",
    ];
    const subjects = ["agent_a", "agent_b", "agent_c", "agent_d"];
    async function startAll(scheduler: MemoryScheduler, keys = subjects) {
      scheduler.runDueTasks(now);
      await scheduler.idle();
      for (const memorySubjectKey of keys)
        await scheduler.enqueueRebuild(
          { memorySubjectKey, sessionDates: ["2026-09-22"] },
          undefined,
          now,
        );
    }
    /** With `concurrency`, each step is held until that many subjects (or
     * every subject with steps left, for the last batch) are inside `runTask`,
     * so the peak does not depend on checkpoint write speed. */
    function tracker(
      concurrency?: number,
      chains: Record<string, number> = {},
    ) {
      const order = new Map<string, string[]>();
      const active = new Set<string>();
      const events: string[] = [];
      const finished = new Map<string, number>();
      const held: (() => void)[] = [];
      let open = concurrency === undefined;
      let peak = 0;
      const unfinished = () =>
        Object.entries(chains).filter(
          ([subject, length]) => (finished.get(subject) ?? 0) < length,
        ).length;
      const runTask = async (task: MemoryScheduledTask) => {
        const subject = task.memorySubjectKey ?? "*";
        expect(active.has(subject)).toBe(false);
        active.add(subject);
        peak = Math.max(peak, active.size);
        events.push(`${label(task)}@${subject}`);
        order.set(subject, [...(order.get(subject) ?? []), label(task)]);
        if (!open) await new Promise<void>((resolve) => held.push(resolve));
        finished.set(subject, (finished.get(subject) ?? 0) + 1);
        active.delete(subject);
      };
      const drainHeld = async (scheduler: MemoryScheduler, ticks: number) => {
        const drained = drain(scheduler, now, ticks);
        try {
          while (unfinished()) {
            await vi.waitFor(
              () =>
                expect(held.length).toBe(Math.min(concurrency!, unfinished())),
              { interval: 1 },
            );
            for (const release of held.splice(0)) release();
          }
        } finally {
          open = true;
          for (const release of held.splice(0)) release();
          await drained;
        }
      };
      return { order, events, runTask, drain: drainHeld, peak: () => peak };
    }
    const chains = (keys: string[]) =>
      Object.fromEntries(keys.map((key) => [key, steps.length]));

    it("runs one subject's chain, then the next", async () => {
      const track = tracker(1, chains(["agent_a", "agent_b"]));
      const scheduler = new MemoryScheduler(
        config,
        rebuildOnly(track.runTask),
        undefined,
        await checkpoint(),
      );
      await startAll(scheduler, ["agent_a", "agent_b"]);
      await track.drain(scheduler, 14);
      expect(track.peak()).toBe(1);
      expect(track.events).toEqual([
        ...steps.map((step) => `${step}@agent_a`),
        ...steps.map((step) => `${step}@agent_b`),
      ]);
    });

    it("continues a checkpoint with an interrupted step", async () => {
      const file = await checkpoint();
      let started!: () => void;
      const running = new Promise<void>((resolve) => (started = resolve));
      const old = new MemoryScheduler(
        config,
        rebuildOnly(async (task) => {
          if (task.task !== "index-initial") return;
          started();
          await new Promise(() => {});
        }),
        undefined,
        file,
      );
      await startAll(old, ["agent_a", "agent_b"]);
      old.runDueTasks(now);
      await old.idle();
      old.runDueTasks(now);
      await running;
      const saved = row(file);
      expect(Object.keys(saved).sort()).toEqual([
        "completed",
        "failed",
        "hour",
        "pending",
        "timeZone",
      ]);
      expect(saved.completed).toContain("init:rebuild:agent_a");
      expect(saved.pending).toContainEqual(
        expect.objectContaining({
          period: "rebuild:agent_a",
          input: expect.objectContaining({ task: "index-initial" }),
          attempts: 1,
        }),
      );

      const track = tracker(1, {
        agent_a: steps.length - 1,
        agent_b: steps.length,
      });
      const restored = new MemoryScheduler(
        config,
        rebuildOnly(track.runTask),
        undefined,
        file,
      );
      expect(restored.rebuildHolds()).toEqual(new Set(["agent_a", "agent_b"]));
      await track.drain(restored, 14);
      // The interrupted step is retried once; nothing before it reruns.
      expect(track.order.get("agent_a")).toEqual(steps.slice(1));
      expect(track.order.get("agent_b")).toEqual(steps);
      expect(track.peak()).toBe(1);
      for (const subject of ["agent_a", "agent_b"])
        expect(restored.rebuildStatus(subject)).toMatchObject({
          phase: "completed",
          completed: steps.length,
          failed: 0,
        });
    });

    it("runs due calendar work beside another subject's rebuild step", async () => {
      const track = tracker();
      const rebuilding = new Set<string>();
      let releaseRebuilds!: () => void;
      const holdRebuilds = new Promise<void>((resolve) => {
        releaseRebuilds = resolve;
      });
      let overlapped = false;
      const scheduler = new MemoryScheduler(
        config,
        async (task) => {
          // Each subject keeps its own lane; calendar work no longer waits for
          // other subjects' rebuild steps to drain.
          if (task.memorySubjectKey) {
            rebuilding.add(task.memorySubjectKey);
            try {
              await holdRebuilds;
              await track.runTask(task);
            } finally {
              rebuilding.delete(task.memorySubjectKey);
            }
          } else {
            if (rebuilding.size) overlapped = true;
            await track.runTask(task);
          }
        },
        undefined,
        await checkpoint(),
      );
      const morning = new Date("2026-09-29T10:00:00+08:00");
      scheduler.runDueTasks(morning);
      await scheduler.idle();
      await scheduler.enqueueRebuild(
        { memorySubjectKey: "agent_a", sessionDates: ["2026-09-20"] },
        undefined,
        morning,
      );
      scheduler.runDueTasks(morning);
      try {
        await vi.waitFor(() => expect(rebuilding.size).toBe(1));
        // Keep the init step active until calendar work actually starts.
        scheduler.runDueTasks(new Date("2026-09-30T00:05:00+08:00"));
        await vi.waitFor(() => expect(overlapped).toBe(true));
      } finally {
        releaseRebuilds();
        await scheduler.idle();
      }
      expect(scheduler.failures()).toEqual({
        exhausted: [],
        pending_retries: [],
      });
      expect(track.order.get("agent_a")).toEqual(["init"]);
      expect(track.order.get("*")).toEqual([
        "wiki:2026-09-28",
        "daily:2026-09-28",
        "wiki:2026-09-29",
        "wiki:2026-09-29",
        "daily:2026-09-29",
      ]);
    });
  });

  it("validates the start and requires the durable production calendar", async () => {
    const scheduler = new MemoryScheduler(
      config,
      rebuildOnly(async () => {}),
      undefined,
      await checkpoint(),
    );
    for (const invalid of [
      { from: "2026-10-01" },
      { from: "2026-02-30" },
      { sessionDates: ["2026-9-1"] },
    ]) {
      expect(() =>
        scheduler.enqueueRebuild({ ...rebuild, ...invalid }, undefined, now),
      ).toThrow(TypeError);
    }
    expect(() =>
      new MemoryScheduler(
        config,
        rebuildOnly(async () => {}),
      ).enqueueRebuild(rebuild, undefined, now),
    ).toThrow(MemoryRebuildUnavailableError);
  });
});

function subject(memorySubjectKey: string, representedHumanActorId: string) {
  return {
    tenantId: "tenant_a",
    agentActorId: `actor_${memorySubjectKey}`,
    agentManagementId: memorySubjectKey,
    memorySubjectKey,
    representedHumanActorId,
  };
}
