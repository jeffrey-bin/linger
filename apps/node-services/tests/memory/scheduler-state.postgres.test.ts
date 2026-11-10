import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  openPostgresCalendarStore,
  postgresSessionTriggerStore,
} from "../../src/memory/scheduler-state.js";

// Explicit opt-in to a disposable database that TeamHub migrations created.
const testDatabase = process.env.MEMORY_SOURCE_TEST_DATABASE_URL;

describe.runIf(Boolean(testDatabase))(
  "Memory scheduler state in PostgreSQL",
  () => {
    let sql: postgres.Sql;
    beforeAll(() => {
      const url = new URL(testDatabase!);
      if (
        url.pathname !== "/memory_source_test" ||
        !["127.0.0.1", "localhost"].includes(url.hostname)
      )
        throw new Error(
          "Use an isolated localhost memory_source_test database",
        );
      sql = postgres(testDatabase!, { max: 2, onnotice: () => undefined });
    });
    beforeEach(async () => {
      await sql`TRUNCATE memory_index.scheduler_state, memory_index.session_trigger_targets`;
    });
    afterAll(async () => {
      await sql?.end({ timeout: 5 });
    });

    it("restores the calendar a restarted scheduler saved", async () => {
      const first = await openPostgresCalendarStore(sql);
      expect(first.saved).toBeUndefined();
      const pending = {
        input: { task: "daily" as const, date: "2026-09-28", concurrency: 1 },
        period: "2026-09-28",
        reason: "daily" as const,
        attempts: 2,
        nextAttemptAt: 1_790_000_000_000,
        retrySubjects: undefined,
      };
      await first.save({
        timeZone: "Asia/Shanghai",
        hour: 497_224,
        completed: ["wiki:2026-09-29T00"],
        pending: [pending],
        failed: [],
      });
      // The trigger cursor shares the row and must not clear the calendar.
      await postgresSessionTriggerStore(sql).saveCursor({
        activatedAt: "2026-09-29T00:00:00.000Z",
      });
      const restarted = await openPostgresCalendarStore(sql);
      expect(restarted.saved).toEqual({
        timeZone: "Asia/Shanghai",
        hour: 497_224,
        completed: ["wiki:2026-09-29T00"],
        pending: [
          {
            input: pending.input,
            period: pending.period,
            reason: pending.reason,
            attempts: 2,
            nextAttemptAt: 1_790_000_000_000,
          },
        ],
        failed: [],
      });
    });

    it("keeps the Session trigger cursor and pending targets across restarts", async () => {
      const store = postgresSessionTriggerStore(sql);
      expect(await store.loadCursor()).toBeUndefined();
      await store.saveCursor({
        activatedAt: "2026-09-29T00:00:00.000Z",
        scannedAt: "2026-09-29T01:00:00.000Z",
      });
      const target = {
        tenantId: "tenant_1",
        memorySubjectKey: "agent_1",
        roomId: "room_1",
        date: "2026-09-29",
        version: "v1",
        messageId: "message_1",
        messageCreatedAt: "2026-09-29T01:00:00.000Z",
        lastActivityAt: "2026-09-29T01:00:00.000Z",
      };
      const key = "a".repeat(64);
      await store.savePending(key, {
        target,
        attempts: 0,
        nextAttemptAt: "2026-09-29T01:10:00.000Z",
      });
      await store.savePending(key, {
        target,
        attempts: 1,
        nextAttemptAt: "2026-09-29T01:11:00.000Z",
        started: true,
      });
      const restarted = postgresSessionTriggerStore(sql);
      expect(await restarted.loadCursor()).toEqual({
        activatedAt: "2026-09-29T00:00:00.000Z",
        scannedAt: "2026-09-29T01:00:00.000Z",
      });
      expect(await restarted.loadPending()).toEqual([
        {
          target,
          attempts: 1,
          nextAttemptAt: "2026-09-29T01:11:00.000Z",
          started: true,
        },
      ]);
      await restarted.removePending(key);
      expect(await restarted.loadPending()).toEqual([]);
    });
  },
);
