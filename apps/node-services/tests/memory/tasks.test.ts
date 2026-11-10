import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { localDate } from "../../src/memory/date.js";
import { describe, expect, it, vi } from "vitest";

import type { MemoryScheduledTask } from "../../src/memory/scheduler.js";
import type { DailyRunResult } from "../../src/memory/daily-cli.js";
import type { SessionlyRunResult } from "../../src/memory/sync-runners.js";
import { memoryWikiRefreshLog } from "../../src/memory/run-telemetry.js";
import { runMemoryTask } from "../../src/memory/tasks.js";
import type { WikiSyncResult } from "../../src/memory/wiki-sync-cli.js";
import {
  wikiPendingPath,
  filesystemMemoryTaskState,
  type MemoryTaskState,
} from "../../src/memory/task-state.js";

const memoryRoot = "/data/agents";

function steps() {
  return {
    daily: vi
      .fn<(argv: string[]) => Promise<DailyRunResult>>()
      .mockResolvedValue({ processedSubjectCount: 1 }),
    wiki: vi
      .fn<(argv: string[]) => Promise<SessionlyRunResult>>()
      .mockResolvedValue({ updatedSessionCount: 1 }),
    weekly: vi
      .fn<() => Promise<DailyRunResult>>()
      .mockResolvedValue({ processedSubjectCount: 1 }),
    wikiSync: vi
      .fn<(argv: string[]) => Promise<WikiSyncResult[]>>()
      .mockResolvedValue([]),
  };
}

function taskState(pending = false): MemoryTaskState {
  return {
    clearWikiPending: vi.fn(async () => {
      pending = false;
    }),
    hasWikiPending: vi.fn(async () => pending),
    markWikiPending: vi.fn(async () => {
      pending = true;
    }),
  };
}

function subjects(...keys: string[]) {
  return {
    listSubjects: vi.fn(async () => keys),
  };
}

describe("runMemoryTask", () => {
  it("does not publish or index a skipped empty Weekly", async () => {
    const handlers = steps();
    handlers.weekly.mockResolvedValue({ processedSubjectCount: 0 });
    const indexPeriodReports = vi.fn();
    await runMemoryTask(
      memoryRoot,
      {
        task: "weekly",
        weekStart: "2026-10-12",
        concurrency: 1,
        memorySubjectKey: "agent_1",
      },
      handlers,
      taskState(),
      { indexPeriodReports },
    );
    expect(indexPeriodReports).not.toHaveBeenCalled();
  });

  it("only indexes during the day, and asks for the nightly refresh without waiting", async () => {
    const taskSteps = steps();
    // Index-only runs ask for nothing, so they report no refresh.
    taskSteps.wikiSync.mockImplementation(async (argv) =>
      argv.includes("--index-only")
        ? []
        : [
            {
              agent_id: "agent_1",
              actor_id: "actor_1",
              memory_subject_key: "agent_1",
              refresh_id: "refresh_1",
              refresh_status: "accepted",
              wiki_id: "wiki_1",
            },
          ],
    );
    const state = taskState();
    const run = (date: string, roomId?: string, nightly = false) =>
      runMemoryTask(
        memoryRoot,
        {
          task: "wiki",
          date,
          concurrency: 1,
          memorySubjectKey: "agent_1",
          ...(roomId ? { roomId } : {}),
        },
        taskSteps,
        state,
        { nightly },
      );
    // Today: the hourly run and a quiet Room only index their Sessions.
    await run(localDate());
    await run(localDate(), "room_1");
    // Midnight still asks TeamHub after earlier indexing consumed every message.
    taskSteps.wiki.mockResolvedValue({ updatedSessionCount: 0 });
    await run(localDate(), undefined, true);
    expect(
      taskSteps.wikiSync.mock.calls.map(([argv]) =>
        argv.includes("--index-only"),
      ),
    ).toEqual([true, true, false]);
  });

  it("skips subjects held by their unfinished dependency", async () => {
    const taskSteps = steps();
    const runtime = { ...subjects("agent_1", "agent_bad") };
    await runMemoryTask(
      memoryRoot,
      {
        task: "daily",
        date: "2026-09-15",
        concurrency: 2,
        heldMemorySubjectKeys: ["agent_bad"],
      },
      taskSteps,
      taskState(),
      runtime,
    );
    expect(taskSteps.daily).toHaveBeenCalledTimes(1);
    expect(taskSteps.daily.mock.calls[0]![0]).toContain("agent_1");

    await runMemoryTask(
      memoryRoot,
      {
        task: "daily",
        date: "2026-09-15",
        concurrency: 2,
        heldMemorySubjectKeys: ["agent_1", "agent_bad"],
      },
      taskSteps,
      taskState(),
      runtime,
    );
    expect(taskSteps.daily).toHaveBeenCalledTimes(1);
  });

  it("runs each fanned-out subject on that subject's lane", async () => {
    const taskSteps = steps();
    const lanes: string[] = [];
    await runMemoryTask(
      memoryRoot,
      { task: "daily", date: "2026-09-15", concurrency: 2 },
      taskSteps,
      taskState(),
      {
        ...subjects("agent_1", "agent_2"),
        subjectLane: async (subject, work) => {
          lanes.push(subject);
          return work();
        },
      },
    );
    expect(lanes.sort()).toEqual(["agent_1", "agent_2"]);
    expect(taskSteps.daily).toHaveBeenCalledTimes(2);
  });

  it("asks for a meeting's refresh by its capture ID and records it without waiting", async () => {
    const taskSteps = steps();
    const refreshes: Array<{
      id?: string;
      memory_subject_key: string;
      status: string;
    }> = [];
    taskSteps.wikiSync.mockResolvedValue([
      {
        agent_id: "agent_1",
        actor_id: "actor_1",
        memory_subject_key: "agent_1",
        refresh_id: "refresh_1",
        refresh_status: "accepted",
        wiki_id: "wiki_1",
      },
    ]);
    await memoryWikiRefreshLog.run(refreshes, () =>
      runMemoryTask(
        memoryRoot,
        {
          task: "wiki",
          date: "2026-09-15",
          concurrency: 1,
          memorySubjectKey: "agent_1",
          recordingId: "rec_1",
        },
        taskSteps,
        taskState(),
      ),
    );
    expect(taskSteps.wikiSync.mock.calls[0]![0]).toEqual(
      expect.arrayContaining(["--capture-id", "rec_1"]),
    );
    expect(taskSteps.wikiSync.mock.calls[0]![0]).not.toContain("--index-only");
    expect(refreshes).toEqual([
      { id: "refresh_1", memory_subject_key: "agent_1", status: "accepted" },
    ]);
  });

  it("scopes idle/recording Wiki work without invoking the legacy CRM generator", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T12:00:00+08:00"));
    try {
      const taskSteps = steps();
      const state = taskState();
      await runMemoryTask(
        memoryRoot,
        {
          task: "wiki",
          date: "2026-09-15",
          concurrency: 1,
          memorySubjectKey: "agent_1",
          roomId: "room_1",
          recordingId: "capture_1",
        },
        taskSteps,
        state,
        {},
      );
      expect(taskSteps.wiki.mock.calls[0]![0]).toEqual(
        expect.arrayContaining([
          "--memory-subject-key",
          "agent_1",
          "--room-id",
          "room_1",
          "--recording-id",
          "capture_1",
        ]),
      );
      expect(state.clearWikiPending).toHaveBeenCalledWith(
        memoryRoot,
        "2026-09-15",
        "agent_1",
      );
      expect(taskSteps.daily).not.toHaveBeenCalled();
      expect(taskSteps.wikiSync).toHaveBeenCalledWith([
        "--date",
        "2026-09-15",
        "--memory-root",
        memoryRoot,
        "--memory-subject-key",
        "agent_1",
        "--capture-id",
        "capture_1",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains recovery state until a late Session's scoped Daily/Wiki catch-up succeeds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-16T00:10:00+08:00"));
    try {
      const taskSteps = steps();
      const state = taskState(true);
      taskSteps.wiki.mockResolvedValue({ updatedSessionCount: 0 });
      taskSteps.wikiSync.mockRejectedValueOnce(new Error("Wiki unavailable"));
      const input = {
        task: "wiki" as const,
        date: "2026-09-15",
        concurrency: 1,
        memorySubjectKey: "agent_1",
        roomId: "room_1",
      };
      await expect(
        runMemoryTask(memoryRoot, input, taskSteps, state),
      ).rejects.toThrow("Wiki unavailable");
      expect(state.clearWikiPending).not.toHaveBeenCalled();
      // Another hourly task may have finished CRM, but not this late Wiki.
      await state.clearWikiPending(memoryRoot, input.date);
      const resumed = { ...input, resumeDownstream: true };
      await runMemoryTask(memoryRoot, resumed, taskSteps, state);
      expect(taskSteps.daily.mock.calls[0]![0]).toContain("agent_1");
      expect(state.clearWikiPending).toHaveBeenCalledTimes(2);
      expect(taskSteps.wikiSync).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each<{
    input: MemoryScheduledTask;
    calls: Array<[keyof ReturnType<typeof steps>, string[] | string]>;
  }>([
    {
      input: { task: "wiki", date: "2026-08-31", concurrency: 3 },
      calls: [
        [
          "wiki",
          [
            "run",
            "--date",
            "2026-08-31",
            "--concurrency",
            "3",
            "--memory-root",
            memoryRoot,
            "--memory-subject-key",
            "agent_1",
          ],
        ],
        [
          "wikiSync",
          [
            "--date",
            "2026-08-31",
            "--memory-root",
            memoryRoot,
            "--memory-subject-key",
            "agent_1",
          ],
        ],
      ],
    },
    {
      input: { task: "daily", date: "2026-08-31", concurrency: 1 },
      calls: [
        [
          "daily",
          [
            "run",
            "--date",
            "2026-08-31",
            "--memory-root",
            memoryRoot,
            "--memory-subject-key",
            "agent_1",
          ],
        ],
      ],
    },
    {
      input: { task: "weekly", weekStart: "2026-08-31", concurrency: 3 },
      calls: [
        [
          "weekly",
          [
            "run",
            "--week-start",
            "2026-08-31",
            "--concurrency",
            "3",
            "--memory-root",
            memoryRoot,
            "--memory-subject-key",
            "agent_1",
          ],
        ],
      ],
    },
  ])("runs the $input.task pipeline in process", async ({ input, calls }) => {
    const taskSteps = steps();
    const state = taskState();

    const runtime = {
      nightly: input.task === "wiki",
      ...subjects("agent_1"),
      indexPeriodReports: vi.fn(async () => undefined),
    };
    await runMemoryTask(memoryRoot, input, taskSteps, state, runtime);
    if (input.task === "daily" || input.task === "weekly") {
      expect(runtime.indexPeriodReports).toHaveBeenCalledWith(
        "agent_1",
        input.task,
      );
      expect(taskSteps.wikiSync).not.toHaveBeenCalled();
    } else {
      expect(runtime.indexPeriodReports).not.toHaveBeenCalled();
    }

    expect(
      Object.entries(taskSteps).flatMap(([name, step]) =>
        step.mock.calls.map((args) => [name, args[0]]),
      ),
    ).toEqual(expect.arrayContaining(calls));
    expect(
      Object.values(taskSteps).reduce(
        (sum, step) => sum + step.mock.calls.length,
        0,
      ),
    ).toBe(calls.length);
  });

  it("stops a pipeline at the first failed step", async () => {
    const taskSteps = steps();
    taskSteps.daily.mockRejectedValueOnce(new Error("daily failed"));

    await expect(
      runMemoryTask(
        memoryRoot,
        { task: "daily", date: "2026-08-31", concurrency: 1 },
        taskSteps,
        taskState(),
        subjects("agent_1"),
      ),
    ).rejects.toThrow("daily failed");
    expect(taskSteps.wikiSync).not.toHaveBeenCalled();
  });

  it("checks document changes at midnight even without Room activity", async () => {
    const taskSteps = steps();
    taskSteps.wiki.mockResolvedValueOnce({ updatedSessionCount: 0 });

    await runMemoryTask(
      memoryRoot,
      { task: "wiki", date: "2026-08-31", concurrency: 3 },
      taskSteps,
      taskState(),
      { ...subjects("agent_1"), nightly: true },
    );
    expect(taskSteps.wikiSync).toHaveBeenCalledExactlyOnceWith([
      "--date",
      "2026-08-31",
      "--memory-root",
      memoryRoot,
      "--memory-subject-key",
      "agent_1",
    ]);
  });

  it("does not acknowledge a report before its index job is durable", async () => {
    const taskSteps = steps();
    await expect(
      runMemoryTask(
        memoryRoot,
        { task: "daily", date: "2026-08-31", concurrency: 1 },
        taskSteps,
        taskState(),
        {
          ...subjects("agent_1"),
          indexPeriodReports: vi.fn(async () => {
            throw new Error("period PG unavailable");
          }),
        },
      ),
    ).rejects.toThrow("period PG unavailable");
    expect(taskSteps.wikiSync).not.toHaveBeenCalled();
  });

  it("does not publish Wiki sources or update Graph when Daily has no input", async () => {
    const taskSteps = steps();
    taskSteps.daily.mockResolvedValueOnce({ processedSubjectCount: 0 });

    await runMemoryTask(
      memoryRoot,
      { task: "daily", date: "2026-08-31", concurrency: 1 },
      taskSteps,
      taskState(),
      subjects("agent_1"),
    );

    expect(taskSteps.wikiSync).not.toHaveBeenCalled();
  });

  it("retries pending Wiki publication after Sessionly has already advanced", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-task-state-"));
    const taskSteps = steps();
    const input: MemoryScheduledTask = {
      task: "wiki",
      date: "2026-08-31",
      concurrency: 3,
    };
    taskSteps.wikiSync.mockRejectedValueOnce(new Error("wiki failed"));

    await expect(
      runMemoryTask(
        root,
        input,
        taskSteps,
        filesystemMemoryTaskState,
        subjects("agent_1"),
      ),
    ).rejects.toThrow("wiki failed");
    await expect(
      fs.access(wikiPendingPath(root, input.date, "agent_1")),
    ).resolves.toBeUndefined();

    taskSteps.wiki.mockResolvedValueOnce({ updatedSessionCount: 0 });
    await runMemoryTask(
      root,
      input,
      taskSteps,
      filesystemMemoryTaskState,
      subjects("agent_1"),
    );

    expect(taskSteps.wikiSync).toHaveBeenCalledTimes(2);
    await expect(
      fs.access(wikiPendingPath(root, input.date, "agent_1")),
    ).rejects.toThrow();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("continues other AnotherMe refreshes when one subject fails", async () => {
    const taskSteps = steps();
    taskSteps.wiki.mockImplementation(async (argv) => {
      if (argv.includes("agent_bad")) throw new Error("graph failed");
      return { updatedSessionCount: 1 };
    });

    await expect(
      runMemoryTask(
        memoryRoot,
        { task: "wiki", date: "2026-08-31", concurrency: 2 },
        taskSteps,
        taskState(),
        subjects("agent_good", "agent_bad"),
      ),
    ).rejects.toThrow("Some 1 AnotherMe refreshes failed");

    const sessionlySubjects = taskSteps.wiki.mock.calls.map((call) => {
      const argv = call[0];
      return argv[argv.indexOf("--memory-subject-key") + 1];
    });
    expect(sessionlySubjects.sort()).toEqual(["agent_bad", "agent_good"]);
    expect(taskSteps.wiki.mock.calls.map((call) => call[0])).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          "--concurrency",
          "2",
          "--memory-subject-key",
          "agent_good",
        ]),
        expect.arrayContaining([
          "--concurrency",
          "2",
          "--memory-subject-key",
          "agent_bad",
        ]),
      ]),
    );
    expect(taskSteps.wikiSync.mock.calls).toEqual([
      [expect.arrayContaining(["--memory-subject-key", "agent_good"])],
    ]);
  });

  it("refreshes distinct AnotherMe subjects in parallel", async () => {
    const taskSteps = steps();
    let started = 0;
    let releaseSlow: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    taskSteps.wiki.mockImplementation(async (argv) => {
      started += 1;
      if (argv.includes("agent_slow")) await slow;
      return { updatedSessionCount: 1 };
    });

    const running = runMemoryTask(
      memoryRoot,
      { task: "wiki", date: "2026-08-31", concurrency: 2 },
      taskSteps,
      taskState(),
      subjects("agent_slow", "agent_fast"),
    );
    await vi.waitFor(() => {
      expect(started).toBe(2);
    });
    expect(taskSteps.wikiSync).toHaveBeenCalledTimes(1);
    expect(taskSteps.wikiSync.mock.calls[0]![0]).toEqual(
      expect.arrayContaining(["--memory-subject-key", "agent_fast"]),
    );
    releaseSlow();
    await running;
    expect(taskSteps.wikiSync).toHaveBeenCalledTimes(2);
  });

  it("fails the calendar run only when every AnotherMe refresh fails", async () => {
    const taskSteps = steps();
    taskSteps.wiki.mockRejectedValue(new Error("graph failed"));

    await expect(
      runMemoryTask(
        memoryRoot,
        { task: "wiki", date: "2026-08-31", concurrency: 2 },
        taskSteps,
        taskState(),
        subjects("agent_a", "agent_b"),
      ),
    ).rejects.toThrow("All 2 AnotherMe refreshes failed");
    expect(taskSteps.wiki).toHaveBeenCalledTimes(2);
  });
});
