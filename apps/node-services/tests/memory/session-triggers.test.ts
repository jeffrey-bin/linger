import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SESSION_TRIGGER_ATTEMPTS,
  SessionTriggerMonitor,
  type SessionTriggerTarget,
} from "../../src/memory/session-triggers.js";
import { MemoryScheduler } from "../../src/memory/scheduler.js";
import {
  readSessionlyCheckpoint,
  writeSessionlyCheckpoint,
} from "../../src/memory/sessionly-checkpoint.js";
import { sessionPath } from "../../src/memory/session-source.js";
import { memoryFilePath } from "../../src/memory/paths.js";
import { filesystemMemoryTaskState } from "../../src/memory/task-state.js";
import type { MemoryScheduleConfig } from "../../src/memory/config.js";
import { SessionTriggerFixture } from "./scheduler-state-fixture.js";

const config: MemoryScheduleConfig = {
  weeklyDay: 1,
  timeZone: "Asia/Shanghai",
  concurrency: 4,
};
const target = (time = "10:00", id = "message_1"): SessionTriggerTarget => ({
  tenantId: "tenant_1",
  memorySubjectKey: "agent_1",
  roomId: "room_1",
  date: "2026-09-15",
  version: id,
  messageId: id,
  messageCreatedAt: `2026-09-15T${time}:00+08:00`,
  lastActivityAt: `2026-09-15T${time}:00+08:00`,
});
const at = (time: string) => new Date(`2026-09-15T${time}+08:00`);
let root: string;
let store: SessionTriggerFixture;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-triggers-"));
  store = new SessionTriggerFixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

async function complete(value: SessionTriggerTarget) {
  const file = memoryFilePath(
    root,
    value.memorySubjectKey,
    sessionPath(value.date, value.roomId, value.recordingId),
  );
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "# Published Session\n");
  await writeSessionlyCheckpoint(root, {
    ...value,
    lastMessage: {
      messageId: value.messageId,
      createdAt: value.messageCreatedAt,
    },
    ...(value.recordingId ? { sourceVersion: value.version } : {}),
  });
}

describe("source-triggered Sessionly", () => {
  it("runs once at ten idle minutes and rearms only for new messages", async () => {
    let current = target();
    const run = vi.fn(async () => complete(current));
    const monitor = new SessionTriggerMonitor(root, store, run, async () => [
      current,
    ]);
    await monitor.poll(at("10:09:59"));
    await monitor.idle();
    expect(run).not.toHaveBeenCalled();
    await monitor.poll(at("10:10:00"));
    await monitor.idle();
    await monitor.poll(at("10:10:15"));
    await monitor.idle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]).toBeDefined();
    current = target("10:20", "message_2");
    await monitor.poll(at("10:29:59"));
    await monitor.idle();
    expect(run).toHaveBeenCalledTimes(1);
    await monitor.poll(at("10:30:00"));
    await monitor.idle();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not regenerate an hourly-completed cursor and recovers after restart", async () => {
    const current = target();
    await complete(current);
    const run = vi.fn();
    const monitor = new SessionTriggerMonitor(root, store, run, async () => [
      current,
    ]);
    await monitor.poll(at("10:10:00"));
    await monitor.idle();
    const restarted = new SessionTriggerMonitor(root, store, run, async () => [
      current,
    ]);
    await restarted.poll(at("11:10:00"));
    await restarted.idle();
    expect(run).not.toHaveBeenCalled();
  });

  it("restores pending work across midnight even when no new source is discovered", async () => {
    const current = target("23:55");
    const run = vi.fn(async () => complete(current));
    await new SessionTriggerMonitor(root, store, run, async () => [
      current,
    ]).poll(at("23:59:00"));
    const restarted = new SessionTriggerMonitor(
      root,
      store,
      run,
      async () => [],
    );
    await restarted.poll(new Date("2026-09-16T00:05:00+08:00"));
    await restarted.idle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(await readSessionlyCheckpoint(root, current)).toMatchObject({
      date: "2026-09-15",
    });
  });

  it("persists backoff and retries without requiring another message", async () => {
    const current = target();
    let now = at("10:10:00");
    const failing = vi.fn(async () => {
      throw new Error("temporary failure");
    });
    const monitor = new SessionTriggerMonitor(
      root,
      store,
      failing,
      async () => [current],
      () => now,
    );
    await monitor.poll(now);
    await monitor.idle();
    now = at("10:10:15");
    await monitor.poll(now);
    await monitor.idle();
    expect(failing).toHaveBeenCalledTimes(1);
    const run = vi.fn(async () => complete(current));
    const restarted = new SessionTriggerMonitor(
      root,
      store,
      run,
      async () => [],
      () => now,
    );
    now = at("10:11:00");
    await restarted.poll(now);
    await restarted.idle();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("skips a version after the attempt limit until new activity arrives", async () => {
    let current = target();
    let now = at("09:59:00");
    const failing = vi.fn(async () => {
      throw new Error("still failing");
    });
    const monitor = new SessionTriggerMonitor(
      root,
      store,
      failing,
      async (_now, since) =>
        Date.parse(current.messageCreatedAt) >= Date.parse(since)
          ? [current]
          : [],
      () => now,
    );
    for (const time of [
      "09:59:00",
      "10:10:00",
      "10:11:00",
      "10:13:00",
      "10:17:00",
      "10:25:00",
      "12:00:00",
    ]) {
      now = at(time);
      await monitor.poll(now);
      await monitor.idle();
    }
    expect(failing).toHaveBeenCalledTimes(MAX_SESSION_TRIGGER_ATTEMPTS);

    current = target("12:00", "message_2");
    now = at("12:10:00");
    await monitor.poll(now);
    await monitor.idle();
    expect(failing).toHaveBeenCalledTimes(MAX_SESSION_TRIGGER_ATTEMPTS + 1);
  });

  it("retries pending downstream publication after the Session checkpoint committed", async () => {
    const current = target();
    await complete(current);
    await filesystemMemoryTaskState.markWikiPending(
      root,
      current.date,
      current.memorySubjectKey,
    );
    const run = vi.fn(async () =>
      filesystemMemoryTaskState.clearWikiPending(
        root,
        current.date,
        current.memorySubjectKey,
      ),
    );
    const monitor = new SessionTriggerMonitor(root, store, run, async () => [
      current,
    ]);
    await monitor.poll(at("10:10:00"));
    await monitor.idle();
    await monitor.poll(at("10:10:15"));
    await monitor.idle();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not acknowledge messages arriving while the previous version is running", async () => {
    let current = target();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const run = vi.fn(async () => {
      const snapshot = { ...current };
      markStarted();
      await gate;
      await complete(snapshot);
    });
    const monitor = new SessionTriggerMonitor(root, store, run, async () => [
      current,
    ]);
    await monitor.poll(at("10:10:00"));
    await started;
    current = target("10:11", "message_2");
    await monitor.poll(at("10:11:00"));
    release();
    await monitor.idle();
    expect(
      (await readSessionlyCheckpoint(root, current))?.lastMessage.messageId,
    ).toBe("message_1");
    await monitor.poll(at("10:20:59"));
    await monitor.idle();
    expect(run).toHaveBeenCalledTimes(1);
    await monitor.poll(at("10:21:00"));
    await monitor.idle();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("restores dispatched downstream work even after hourly CRM clears its shared marker", async () => {
    const current = target();
    let now = at("10:10:00");
    const failAfterCheckpoint = vi.fn(async () => {
      await complete(current);
      await filesystemMemoryTaskState.markWikiPending(
        root,
        current.date,
        current.memorySubjectKey,
      );
      throw new Error("Wiki unavailable");
    });
    const first = new SessionTriggerMonitor(
      root,
      store,
      failAfterCheckpoint,
      async () => [current],
      () => now,
    );
    await first.poll(now);
    await first.idle();
    await filesystemMemoryTaskState.clearWikiPending(root, current.date);
    const run = vi.fn<SessionTriggerMonitor["run"]>(
      async (input, _period, _reason, isReady) => {
        expect(input.resumeDownstream).toBe(true);
        expect(await isReady!()).toBe(true);
      },
    );
    now = at("10:11:00");
    const restarted = new SessionTriggerMonitor(
      root,
      store,
      run,
      async () => [current],
      () => now,
    );
    await restarted.poll(now);
    await restarted.idle();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("publishes independent recordings immediately when ready, without Room idle", async () => {
    const captures = ["capture_1", "capture_2"].map((recordingId) => ({
      ...target("10:00"),
      recordingId,
      version: `${recordingId}:hash`,
    }));
    const run = vi.fn(async (input) =>
      complete(
        captures.find((value) => value.recordingId === input.recordingId)!,
      ),
    );
    const monitor = new SessionTriggerMonitor(
      root,
      store,
      run,
      async () => captures,
    );
    await monitor.poll(at("10:00:00"));
    await monitor.idle();
    await monitor.poll(at("10:00:15"));
    await monitor.idle();
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.map((call) => call[0].recordingId).sort()).toEqual([
      "capture_1",
      "capture_2",
    ]);
  });

  it("shares the subject lane with hourly tasks and uses the resulting checkpoint", async () => {
    const current = target("09:40");
    let generations = 0;
    // Like runMemoryTask, hourly work runs each subject's share on its lane.
    const scheduler = new MemoryScheduler(config, async (task, _, lane) =>
      lane(current.memorySubjectKey, async () => {
        if (await readSessionlyCheckpoint(root, current)) return;
        generations += 1;
        await complete(current);
      }),
    );
    scheduler.runDueTasks(at("10:00:00"));
    const monitor = new SessionTriggerMonitor(
      root,
      store,
      (input, period, reason, isReady) =>
        scheduler.runTarget(input, period, reason, isReady),
      async () => [current],
    );
    await monitor.poll(at("10:00:00"));
    await monitor.idle();
    await scheduler.idle();
    expect(generations).toBe(1);
  });

  it("rechecks Room quietness after waiting for the subject's writer, including new-day messages", async () => {
    let current = target("23:40");
    let now = at("23:50:00");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(async () => complete(current));
    const scheduler = new MemoryScheduler(config, run);
    void scheduler.enqueue(() => gate, current.memorySubjectKey);
    const monitor = new SessionTriggerMonitor(
      root,
      store,
      (input, period, reason, isReady) =>
        scheduler.runTarget(input, period, reason, isReady),
      async () => [current],
      () => now,
    );
    await monitor.poll(now);
    current = {
      ...current,
      date: "2026-09-16",
      messageId: "new_day",
      version: "new_day",
      messageCreatedAt: "2026-09-16T00:01:00+08:00",
      lastActivityAt: "2026-09-16T00:01:00+08:00",
    };
    now = new Date("2026-09-16T00:02:00+08:00");
    release();
    await monitor.idle();
    expect(run).not.toHaveBeenCalled();
    now = new Date("2026-09-16T00:11:00+08:00");
    await monitor.poll(now);
    await monitor.idle();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("retains the discovery watermark through a downtime longer than two days", async () => {
    const first = new SessionTriggerMonitor(
      root,
      store,
      vi.fn(),
      async () => [],
    );
    await first.poll(at("10:00:00"));
    const load = vi
      .fn<(now: Date, since: string) => Promise<SessionTriggerTarget[]>>()
      .mockResolvedValue([]);
    const restarted = new SessionTriggerMonitor(root, store, vi.fn(), load);
    await restarted.poll(new Date("2026-09-20T10:00:00+08:00"));
    expect(load.mock.calls[0]?.[1]).toBe(at("10:00:00").toISOString());
  });
});
