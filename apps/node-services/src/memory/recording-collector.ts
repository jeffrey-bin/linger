import crypto from "node:crypto";
import type postgres from "postgres";
import { memoryDatabase } from "./database.js";
import { localDate, localTimeZone } from "./date.js";
import { readSessionlyCheckpoint } from "./sessionly-checkpoint.js";
import {
  fetchTeamHubDocumentVersionContent,
  teamHubContentAccess,
} from "./teamhub-content.js";
import { SESSION_ID_PATTERN, sessionPath } from "./session-source.js";
import { memoryFilePath } from "./paths.js";
import fs from "node:fs/promises";
import type {
  AnotherMeSubject,
  RecordingSessionSource,
  SessionlyCollection,
} from "./types.js";
import type { CliOptions } from "./options.js";

export const MAX_TRANSCRIPT_BYTES = 4_000_000;

export interface RecordingCandidate extends RecordingSessionSource {
  tenantId: string;
  roomId: string;
  roomName: string;
  date: string;
  sizeBytes: number;
  creatorId: string;
  creatorName: string;
  agentIsMember: boolean;
  humanIsMember: boolean;
  /** The recorder's private questions and task requests; set only when the recorder is the represented Human. */
  privateContext?: string;
}

export interface RecordingPrivateRows {
  /** Voice session clock offset where the recording started. */
  recordingStartOffsetMs: number;
  /** `cutoff_offset_ms` is on the voice session clock. A `task` item is a
   * request the recorder asked Another Me to act on; `task_sent` says whether
   * it was handed to Another Me, whose Meta decides on the Task. */
  questions: {
    kind: string;
    task_sent: boolean;
    question: string;
    answer: string;
    answered: boolean;
    cutoff_offset_ms: number;
  }[];
}

/** Recording time as mm:ss, or h:mm:ss past an hour, like the recording window. */
export function formatRecordingTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
}

const oneLine = (text: string) => text.replace(/\s+/gu, " ").trim();

/**
 * Renders in-meeting Q&A and requests the recorder asked Another Me to act on
 * as labeled Markdown sections that follow the transcript. Empty sections are
 * omitted; returns undefined when nothing remains.
 */
export function renderRecordingPrivateContext(
  rows: RecordingPrivateRows,
): string | undefined {
  const at = (sessionOffsetMs: number) =>
    formatRecordingTime(Number(sessionOffsetMs) - rows.recordingStartOffsetMs);
  const asked = rows.questions.filter((item) => oneLine(item.question));
  const requests = asked
    .filter((item) => item.kind === "task")
    .map(
      (item) =>
        `- [${at(item.cutoff_offset_ms)}] ${oneLine(item.question)}${item.task_sent ? " (sent to Another Me)" : " (not sent)"}`,
    );
  const questions = asked
    .filter((item) => item.kind !== "task")
    .map(
      (item) =>
        `- Q: ${oneLine(item.question)}\n  A${item.answered ? "" : " (not answered)"}: ${oneLine(item.answer) || "None."} (based on the recording up to ${at(item.cutoff_offset_ms)})`,
    );
  const sections = [
    ["## Questions asked during the meeting", questions] as const,
    [
      "## Requests the recorder gave Another Me during the meeting",
      requests,
    ] as const,
  ]
    .filter(([, lines]) => lines.length > 0)
    .map(([heading, lines]) => `${heading}\n\n${lines.join("\n")}\n`);
  return sections.length ? sections.join("\n") : undefined;
}

/**
 * Transcript identity, extended with a fingerprint of the recorder's private
 * context so later question or request changes re-stage the Session.
 */
export function recordingSourceVersion(
  source: Pick<RecordingCandidate, "documentVersionId" | "sha256"> & {
    privateContext?: string;
  },
): string {
  const base = `${source.documentVersionId}:${source.sha256}`;
  return source.privateContext
    ? `${base}:${crypto.createHash("sha256").update(source.privateContext).digest("hex").slice(0, 16)}`
    : base;
}

/** Read metadata only. Transcript bytes remain behind the TeamHub workload API. */
export async function loadRecordingCandidates(
  subject: AnotherMeSubject,
  since: string,
  captureId?: string,
): Promise<RecordingCandidate[]> {
  if (captureId && !SESSION_ID_PATTERN.test(captureId))
    throw new Error("Invalid Capture ID");
  return queryRecordingCandidates(memoryDatabase(), subject, since, captureId);
}

export async function queryRecordingCandidates(
  sql: postgres.Sql,
  subject: Pick<AnotherMeSubject, "agentManagementId">,
  since: string,
  captureId?: string,
): Promise<RecordingCandidate[]> {
  const rows = await sql<
    {
      id: string;
      tenant_id: string;
      room_id: string;
      room_name: string;
      document_id: string;
      version_id: string;
      sha256: string;
      size_bytes: number;
      started_at: Date;
      ready_at: Date;
      source_date_at: Date;
      duration_ms: number;
      creator_id: string;
      creator_name: string;
      agent_is_member: boolean;
      human_is_member: boolean;
      recording_start_offset_ms: number | string;
      private_questions: RecordingPrivateRows["questions"] | null;
    }[]
  >`
    SELECT capture_id AS id, tenant_id, room_id, room_name, document_id,
      version_id, sha256, size_bytes, started_at, ready_at, source_date_at,
      duration_ms, creator_id, creator_name, agent_is_member, human_is_member,
      recording_start_offset_ms, private_questions
    FROM memory_source.subject_recordings
    WHERE agent_management_id = ${subject.agentManagementId}
      AND (${captureId ?? null}::text IS NULL OR capture_id = ${captureId ?? null})
      AND (${captureId ?? null}::text IS NOT NULL
        OR ready_at >= ${since}::timestamptz
        OR private_changed_at >= ${since}::timestamptz)
    ORDER BY ready_at, capture_id
  `;
  return rows.map((row) => ({
    captureId: row.id,
    tenantId: row.tenant_id,
    roomId: row.room_id,
    roomName: row.room_name,
    documentId: row.document_id,
    documentVersionId: row.version_id,
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes),
    startedAt: row.started_at.toISOString(),
    endedAt: new Date(
      row.started_at.getTime() + Number(row.duration_ms),
    ).toISOString(),
    readyAt: row.ready_at.toISOString(),
    date: localDate(row.source_date_at),
    creatorId: row.creator_id,
    creatorName: row.creator_name,
    agentIsMember: row.agent_is_member,
    humanIsMember: row.human_is_member,
    ...privateContextField(row),
  }));
}

function privateContextField(row: {
  recording_start_offset_ms: number | string;
  private_questions: RecordingPrivateRows["questions"] | null;
}): Pick<RecordingCandidate, "privateContext"> {
  const privateContext = renderRecordingPrivateContext({
    recordingStartOffsetMs: Number(row.recording_start_offset_ms),
    questions: row.private_questions ?? [],
  });
  return privateContext ? { privateContext } : {};
}

export async function collectRecordingSession(
  options: CliOptions,
  subject: AnotherMeSubject,
  candidate: RecordingCandidate,
): Promise<SessionlyCollection | undefined> {
  assertRecordingScope(subject, candidate);
  const input = {
    date: candidate.date,
    memorySubjectKey: subject.memorySubjectKey,
    roomId: candidate.roomId,
    recordingId: candidate.captureId,
  };
  const checkpoint = await readSessionlyCheckpoint(options.memoryRoot, input);
  const sourceVersion = recordingSourceVersion(candidate);
  const relativePath = sessionPath(
    candidate.date,
    candidate.roomId,
    candidate.captureId,
  );
  let previousSession: SessionlyCollection["previousSession"];
  try {
    previousSession = {
      path: `${subject.memorySubjectKey}/${relativePath}`,
      content: await fs.readFile(
        memoryFilePath(
          options.memoryRoot,
          subject.memorySubjectKey,
          relativePath,
        ),
        "utf8",
      ),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (checkpoint?.sourceVersion === sourceVersion && previousSession)
    return undefined;
  if (
    !Number.isSafeInteger(candidate.sizeBytes) ||
    candidate.sizeBytes < 0 ||
    candidate.sizeBytes > MAX_TRANSCRIPT_BYTES
  )
    throw new Error("Recording transcript exceeds the supported byte limit");
  const bytes = await fetchTeamHubDocumentVersionContent(
    teamHubContentAccess(),
    subject.tenantId,
    candidate.documentVersionId,
    MAX_TRANSCRIPT_BYTES,
  );
  if (
    bytes.byteLength !== candidate.sizeBytes ||
    crypto.createHash("sha256").update(bytes).digest("hex") !== candidate.sha256
  )
    throw new Error("Recording transcript integrity check failed");
  const transcript = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!transcript.trim()) throw new Error("Recording transcript is empty");
  return recordingCollection(
    options,
    subject,
    candidate,
    transcript,
    previousSession,
  );
}

export function recordingCollection(
  options: Pick<CliOptions, "memoryRoot">,
  subject: AnotherMeSubject,
  candidate: RecordingCandidate,
  transcript: string,
  previousSession?: SessionlyCollection["previousSession"],
): SessionlyCollection {
  assertRecordingScope(subject, candidate);
  const {
    captureId,
    documentId,
    documentVersionId,
    sha256,
    startedAt,
    endedAt,
    readyAt,
    privateContext,
  } = candidate;
  return {
    schemaVersion: 1,
    date: candidate.date,
    timeZone: localTimeZone(),
    generatedAt: new Date().toISOString(),
    source: {
      memoryRoot: options.memoryRoot,
      teamhubDatabaseUrlSet: true,
    },
    subjects: [subject],
    ...(previousSession ? { previousSession } : {}),
    recording: {
      captureId,
      documentId,
      documentVersionId,
      sha256,
      startedAt,
      endedAt,
      readyAt,
      sourceVersion: recordingSourceVersion(candidate),
    },
    rooms: [
      {
        tenantId: subject.tenantId,
        roomId: candidate.roomId,
        roomName: candidate.roomName,
        agentActorId: subject.agentActorId,
        agentManagementId: subject.agentManagementId,
        representedHumanActorId: subject.representedHumanActorId,
        memorySubjectKey: subject.memorySubjectKey,
        relation: {
          agentIsMember: candidate.agentIsMember,
          representedHumanIsMember: candidate.humanIsMember,
          agentIsCreator: false,
          representedHumanIsCreator:
            subject.representedHumanActorId === candidate.creatorId,
          includedBecause: [
            ...(candidate.agentIsMember ? ["agent_member" as const] : []),
            ...(candidate.humanIsMember
              ? ["represented_human_member" as const]
              : []),
          ],
        },
        messages: [
          {
            id: documentVersionId,
            roomId: candidate.roomId,
            authorActorId: candidate.creatorId,
            authorDisplayName: candidate.creatorName,
            authorKind: "human",
            messageKind: "recording_transcript",
            // The recorder's private context follows the unchanged transcript.
            body: privateContext
              ? `${transcript.trimEnd()}\n\n${privateContext}`
              : transcript,
            createdAt: readyAt,
            attachments: [],
          },
        ],
      },
    ],
    sourceCursor: {
      after: { messageId: documentVersionId, createdAt: readyAt },
    },
  };
}

function assertRecordingScope(
  subject: AnotherMeSubject,
  candidate: RecordingCandidate,
): void {
  if (
    candidate.tenantId !== subject.tenantId ||
    (!candidate.agentIsMember && !candidate.humanIsMember)
  )
    throw new Error("Recording source is outside the Memory subject scope");
}
