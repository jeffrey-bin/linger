import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import type postgres from "postgres";
import { loadAnotherMeSubjects } from "./collector.js";
import { memoryDatabase } from "./database.js";
import { localDate, localTimeZone } from "./date.js";
import {
  loadRecordingCandidates,
  recordingSourceVersion,
} from "./recording-collector.js";
import {
  compareSessionlyMessages,
  readSessionlyCheckpoint,
} from "./sessionly-checkpoint.js";
import { SESSION_ID_PATTERN, sessionPath } from "./session-source.js";
import { memoryFilePath } from "./paths.js";
import { filesystemMemoryTaskState } from "./task-state.js";
import type { MemoryScheduledTask } from "./scheduler.js";
import { writeMemoryLog } from "./run-telemetry.js";
import type { AnotherMeSubject } from "./types.js";

export const ROOM_IDLE_MS = 10 * 60_000;
const MAX_QUEUED_TARGETS = 4;
/** A version that fails this many runs is skipped until new activity. */
export const MAX_SESSION_TRIGGER_ATTEMPTS = 5;

export interface SessionTriggerTarget {
  tenantId: string;
  memorySubjectKey: string;
  roomId: string;
  date: string;
  recordingId?: string;
  version: string;
  messageId: string;
  messageCreatedAt: string;
  /** Latest activity in the entire Room, not just this business date. */
  lastActivityAt: string;
}

export interface PendingSessionTrigger {
  target: SessionTriggerTarget;
  attempts: number;
  nextAttemptAt: string;
  started?: boolean;
}

/** When the monitor first ran and how far its source scan has reached. */
export interface SessionTriggerCursor {
  activatedAt: string;
  scannedAt?: string;
}

/** The monitor's durable state, kept in Memory's schema in production. */
export interface SessionTriggerStore {
  loadCursor(): Promise<SessionTriggerCursor | undefined>;
  saveCursor(cursor: SessionTriggerCursor): Promise<void>;
  loadPending(): Promise<PendingSessionTrigger[]>;
  savePending(key: string, pending: PendingSessionTrigger): Promise<void>;
  removePending(key: string): Promise<void>;
}

export class SessionTriggerMonitor {
  readonly #pending = new Map<string, PendingSessionTrigger>();
  readonly #running = new Map<string, Promise<void>>();
  #loaded = false;
  #activatedAt: string | undefined;
  #scannedAt: string | undefined;

  constructor(
    readonly dataRoot: string,
    readonly store: SessionTriggerStore,
    readonly run: (
      input: Extract<MemoryScheduledTask, { task: "wiki" }>,
      period: string,
      reason: "idle" | "recording",
      isReady?: () => Promise<boolean>,
    ) => Promise<void>,
    readonly loadTargets: (
      now: Date,
      activatedAt: string,
    ) => Promise<SessionTriggerTarget[]> = loadSessionTriggerTargets,
    readonly clock: () => Date = () => new Date(),
  ) {}

  async poll(now: Date): Promise<void> {
    await this.#load(now);
    const since = new Date(
      Math.max(
        Date.parse(this.#activatedAt!),
        Math.min(
          now.getTime() - 48 * 3_600_000,
          Date.parse(this.#scannedAt ?? this.#activatedAt!),
        ),
      ),
    ).toISOString();
    const candidates = await this.loadTargets(now, since);
    for (const target of candidates) {
      validateTarget(target);
      const key = targetKey(target);
      if (this.#running.has(key)) continue;
      const existing = this.#pending.get(key);
      if (
        existing?.target.version === target.version &&
        (existing.attempts > 0 || existing.started)
      )
        continue;
      if (await isSessionTargetProcessed(this.dataRoot, target)) {
        if (existing) await this.#remove(key);
        continue;
      }
      const pending: PendingSessionTrigger = {
        target,
        attempts: 0,
        nextAttemptAt: new Date(
          target.recordingId
            ? Date.parse(target.lastActivityAt)
            : Date.parse(target.lastActivityAt) + ROOM_IDLE_MS,
        ).toISOString(),
      };
      // Same version and untouched: only a later Room activity moves it.
      if (
        existing?.target.version !== pending.target.version ||
        existing.nextAttemptAt !== pending.nextAttemptAt
      ) {
        await this.store.savePending(key, pending);
        this.#pending.set(key, pending);
      }
    }
    for (const [key, pending] of this.#pending) {
      if (pending.attempts >= MAX_SESSION_TRIGGER_ATTEMPTS) {
        // Skipped: discovery no longer returns this version, so only new
        // activity (a new version) could have reset it.
        if (Date.parse(pending.target.messageCreatedAt) < Date.parse(since))
          await this.#remove(key);
        continue;
      }
      if (
        this.#running.has(key) ||
        Date.parse(pending.nextAttemptAt) > now.getTime()
      )
        continue;
      if (this.#running.size >= MAX_QUEUED_TARGETS) break;
      const execution = this.#execute(key, pending)
        .catch(() => {
          writeMemoryLog(
            "memory_session_trigger_state_write_failed",
            { source: key },
            "ERROR",
          );
        })
        .finally(() => {
          this.#running.delete(key);
        });
      this.#running.set(key, execution);
    }
    this.#scannedAt = now.toISOString();
    await this.store.saveCursor({
      activatedAt: this.#activatedAt!,
      scannedAt: this.#scannedAt,
    });
  }

  async idle(): Promise<void> {
    await Promise.all(this.#running.values());
  }

  async #execute(key: string, pending: PendingSessionTrigger): Promise<void> {
    const target = pending.target;
    const resume = Boolean(pending.started || pending.attempts > 0);
    const dispatched = { ...pending, started: true };
    // An hourly CRM success can clear the shared marker, but cannot
    // acknowledge this source's interrupted downstream Daily/Wiki work.
    await this.store.savePending(key, dispatched);
    this.#pending.set(key, dispatched);
    try {
      await this.run(
        {
          task: "wiki",
          date: target.date,
          concurrency: 1,
          memorySubjectKey: target.memorySubjectKey,
          resumeDownstream: true,
          roomId: target.roomId,
          ...(target.recordingId ? { recordingId: target.recordingId } : {}),
        },
        `${key}:${target.version}`,
        target.recordingId ? "recording" : "idle",
        async () => {
          if (
            !resume &&
            (await isSessionTargetProcessed(this.dataRoot, target))
          )
            return false;
          if (resume || target.recordingId) return true;
          // The serial writer may have been busy for minutes. Re-read metadata
          // at dequeue time, including activity on a newer business date.
          const now = this.clock();
          const candidates = await this.loadTargets(
            now,
            target.messageCreatedAt,
          );
          const room = candidates.filter(
            (candidate) =>
              !candidate.recordingId &&
              candidate.tenantId === target.tenantId &&
              candidate.memorySubjectKey === target.memorySubjectKey &&
              candidate.roomId === target.roomId,
          );
          return (
            room.length > 0 &&
            room.every(
              (candidate) =>
                Date.parse(candidate.lastActivityAt) + ROOM_IDLE_MS <=
                now.getTime(),
            )
          );
        },
      );
      await this.#remove(key);
    } catch {
      const attempts = pending.attempts + 1;
      const next = {
        ...dispatched,
        attempts,
        nextAttemptAt: new Date(
          this.clock().getTime() +
            Math.min(60_000 * 2 ** Math.min(attempts - 1, 6), 3_600_000),
        ).toISOString(),
      };
      this.#pending.set(key, next);
      await this.store.savePending(key, next);
      if (attempts >= MAX_SESSION_TRIGGER_ATTEMPTS)
        writeMemoryLog(
          "memory_session_trigger_skipped",
          {
            source: key,
            attempts,
            memorySubjectKey: target.memorySubjectKey,
            roomId: target.roomId,
            date: target.date,
          },
          "ERROR",
        );
      else
        writeMemoryLog("memory_session_trigger_retry", {
          source: key,
          attempts,
          nextAttemptAt: next.nextAttemptAt,
        });
    }
  }

  async #remove(key: string): Promise<void> {
    await this.store.removePending(key);
    this.#pending.delete(key);
  }
  async #load(now: Date): Promise<void> {
    if (this.#loaded) return;
    const cursor = await this.store.loadCursor();
    if (cursor) {
      this.#activatedAt = cursor.activatedAt;
      this.#scannedAt = cursor.scannedAt;
    } else {
      this.#activatedAt = now.toISOString();
      await this.store.saveCursor({ activatedAt: this.#activatedAt });
    }
    for (const pending of await this.store.loadPending())
      this.#pending.set(targetKey(pending.target), pending);
    this.#loaded = true;
  }
}

function validateTarget(target: SessionTriggerTarget): void {
  if (
    !target ||
    ![
      target.tenantId,
      target.memorySubjectKey,
      target.roomId,
      ...(target.recordingId ? [target.recordingId] : []),
    ].every((value) => SESSION_ID_PATTERN.test(value)) ||
    !target.version ||
    !Number.isFinite(Date.parse(target.lastActivityAt)) ||
    !Number.isFinite(Date.parse(target.messageCreatedAt))
  )
    throw new Error("Invalid Session trigger target");
  sessionPath(target.date, target.roomId, target.recordingId);
}

function targetKey(target: SessionTriggerTarget): string {
  return createHash("sha256")
    .update(
      `${target.tenantId}:${target.memorySubjectKey}:${sessionPath(target.date, target.roomId, target.recordingId)}`,
    )
    .digest("hex");
}

export async function isSessionTargetProcessed(
  dataRoot: string,
  target: SessionTriggerTarget,
): Promise<boolean> {
  if (
    await filesystemMemoryTaskState.hasWikiPending(
      dataRoot,
      target.date,
      target.memorySubjectKey,
    )
  )
    return false;
  const checkpoint = await readSessionlyCheckpoint(dataRoot, target);
  if (!checkpoint) return false;
  const processed = target.recordingId
    ? checkpoint.sourceVersion === target.version
    : compareSessionlyMessages(
        {
          id: checkpoint.lastMessage.messageId,
          createdAt: checkpoint.lastMessage.createdAt,
        },
        { id: target.messageId, createdAt: target.messageCreatedAt },
      ) >= 0;
  if (!processed) return false;
  try {
    return (
      await fs.stat(
        memoryFilePath(
          dataRoot,
          target.memorySubjectKey,
          sessionPath(target.date, target.roomId, target.recordingId),
        ),
      )
    ).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function loadSessionTriggerTargets(
  _now: Date,
  since: string,
): Promise<SessionTriggerTarget[]> {
  const subjects = await loadAnotherMeSubjects();
  const targets: SessionTriggerTarget[] = [];
  for (const subject of subjects) {
    targets.push(...(await loadRoomActivity(subject, since)));
    for (const recording of await loadRecordingCandidates(subject, since)) {
      targets.push({
        tenantId: subject.tenantId,
        memorySubjectKey: subject.memorySubjectKey,
        roomId: recording.roomId,
        recordingId: recording.captureId,
        date: recording.date,
        version: recordingSourceVersion(recording),
        messageId: recording.documentVersionId,
        messageCreatedAt: recording.readyAt,
        lastActivityAt: recording.readyAt,
      });
    }
  }
  return targets;
}

async function loadRoomActivity(
  subject: AnotherMeSubject,
  since: string,
): Promise<SessionTriggerTarget[]> {
  return queryRoomActivity(memoryDatabase(), subject, since);
}

export async function queryRoomActivity(
  sql: postgres.Sql,
  subject: Pick<
    AnotherMeSubject,
    "tenantId" | "agentManagementId" | "memorySubjectKey"
  >,
  since: string,
): Promise<SessionTriggerTarget[]> {
  const rows = await sql<
    { room_id: string; id: string; created_at: Date; last_activity_at: Date }[]
  >`
      SELECT DISTINCT ON (message.room_id, local_day)
        message.room_id, message.id, message.created_at,
        (message.created_at AT TIME ZONE ${localTimeZone()}::text)::date AS local_day,
        (SELECT max(latest.created_at) FROM memory_source.conversation_messages latest WHERE latest.tenant_id = message.tenant_id AND latest.room_id = message.room_id) AS last_activity_at
      FROM memory_source.conversation_messages message
      JOIN memory_source.subject_rooms room ON room.room_id = message.room_id AND room.tenant_id = message.tenant_id AND room.agent_management_id = ${subject.agentManagementId}
      WHERE message.created_at >= ${since}::timestamptz
      ORDER BY message.room_id, local_day, message.created_at DESC, message.id DESC
    `;
  return rows.map((row) => ({
    tenantId: subject.tenantId,
    memorySubjectKey: subject.memorySubjectKey,
    roomId: row.room_id,
    date: localDate(row.created_at),
    version: `${row.created_at.toISOString()}:${row.id}`,
    messageId: row.id,
    messageCreatedAt: row.created_at.toISOString(),
    lastActivityAt: row.last_activity_at.toISOString(),
  }));
}
