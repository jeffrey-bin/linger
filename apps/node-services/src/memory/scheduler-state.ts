import type postgres from "postgres";
import type {
  MemoryCalendarState,
  MemoryCalendarStore,
  MemoryCalendarTask,
} from "./scheduler.js";
import type {
  PendingSessionTrigger,
  SessionTriggerCursor,
  SessionTriggerStore,
} from "./session-triggers.js";

interface SchedulerStateRow {
  calendar_time_zone: string | null;
  calendar_hour: string | null;
  calendar_completed: string[];
  calendar_pending: MemoryCalendarTask[];
  calendar_failed: MemoryCalendarTask[];
  triggers_activated_at: Date | null;
  triggers_scanned_at: Date | null;
}

/**
 * Reads the calendar once, before the scheduler starts; later saves replace
 * the whole calendar so the row always holds the newest snapshot.
 */
export async function openPostgresCalendarStore(
  sql: postgres.Sql,
): Promise<MemoryCalendarStore> {
  const [row] = await sql<SchedulerStateRow[]>`
    SELECT calendar_time_zone,calendar_hour::text,calendar_completed,calendar_pending,calendar_failed,
      triggers_activated_at,triggers_scanned_at
    FROM memory_index.scheduler_state WHERE singleton`;
  const saved: MemoryCalendarState | undefined =
    row?.calendar_time_zone && row.calendar_hour !== null
      ? {
          timeZone: row.calendar_time_zone,
          hour: Number(row.calendar_hour),
          completed: row.calendar_completed,
          pending: row.calendar_pending,
          failed: row.calendar_failed,
        }
      : undefined;
  return {
    saved,
    async save(state) {
      await sql`
        INSERT INTO memory_index.scheduler_state(singleton,calendar_time_zone,calendar_hour,calendar_completed,calendar_pending,calendar_failed)
        VALUES(true,${state.timeZone},${state.hour},${sql.array([...state.completed])}::text[],${sql.json(toJson(state.pending))},${sql.json(toJson(state.failed))})
        ON CONFLICT(singleton) DO UPDATE SET calendar_time_zone=EXCLUDED.calendar_time_zone,calendar_hour=EXCLUDED.calendar_hour,
          calendar_completed=EXCLUDED.calendar_completed,calendar_pending=EXCLUDED.calendar_pending,
          calendar_failed=EXCLUDED.calendar_failed,updated_at=now()`;
    },
  };
}

export function postgresSessionTriggerStore(
  sql: postgres.Sql,
): SessionTriggerStore {
  return {
    async loadCursor() {
      const [row] = await sql<
        Pick<
          SchedulerStateRow,
          "triggers_activated_at" | "triggers_scanned_at"
        >[]
      >`SELECT triggers_activated_at,triggers_scanned_at FROM memory_index.scheduler_state WHERE singleton`;
      if (!row?.triggers_activated_at) return undefined;
      return {
        activatedAt: row.triggers_activated_at.toISOString(),
        ...(row.triggers_scanned_at
          ? { scannedAt: row.triggers_scanned_at.toISOString() }
          : {}),
      };
    },
    async saveCursor(cursor: SessionTriggerCursor) {
      await sql`
        INSERT INTO memory_index.scheduler_state(singleton,triggers_activated_at,triggers_scanned_at)
        VALUES(true,${cursor.activatedAt}::timestamptz,${cursor.scannedAt ?? null}::timestamptz)
        ON CONFLICT(singleton) DO UPDATE SET triggers_activated_at=EXCLUDED.triggers_activated_at,
          triggers_scanned_at=EXCLUDED.triggers_scanned_at,updated_at=now()`;
    },
    async loadPending() {
      const rows = await sql<
        {
          target: PendingSessionTrigger["target"];
          attempts: number;
          next_attempt_at: Date;
          started: boolean;
        }[]
      >`SELECT target,attempts,next_attempt_at,started FROM memory_index.session_trigger_targets ORDER BY target_key`;
      return rows.map((row) => ({
        target: row.target,
        attempts: row.attempts,
        nextAttemptAt: row.next_attempt_at.toISOString(),
        ...(row.started ? { started: true } : {}),
      }));
    },
    async savePending(key, pending) {
      await sql`
        INSERT INTO memory_index.session_trigger_targets(target_key,target,attempts,next_attempt_at,started)
        VALUES(${key},${sql.json(toJson(pending.target))},${pending.attempts},${pending.nextAttemptAt}::timestamptz,${pending.started ?? false})
        ON CONFLICT(target_key) DO UPDATE SET target=EXCLUDED.target,attempts=EXCLUDED.attempts,
          next_attempt_at=EXCLUDED.next_attempt_at,started=EXCLUDED.started,updated_at=now()`;
    },
    async removePending(key) {
      await sql`DELETE FROM memory_index.session_trigger_targets WHERE target_key=${key}`;
    },
  };
}

/** Drops undefined fields, which the JSON column cannot hold. */
function toJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}
