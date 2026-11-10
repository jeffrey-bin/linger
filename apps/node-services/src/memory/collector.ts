import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import type postgres from "postgres";
import { memoryDatabase } from "./database.js";
import {
  fetchTeamHubDocumentVersionContent,
  teamHubContentAccess,
} from "./teamhub-content.js";
import { localDateWindow, localTimeZone } from "./date.js";
import { compareSessionlyMessages } from "./sessionly-checkpoint.js";
import { walkFiles } from "./fs-utils.js";
import { ensureMemoryScaffold } from "./scaffold.js";
import { assertSafeMemorySubjectKey, memorySubjectKey } from "./subject.js";
import { agentMemoryRoot, logicalMemoryPath } from "./paths.js";
import type {
  AnotherMeSubject,
  DailyCollection,
  ExistingMemoryFile,
  MemoryRoomSnapshot,
  RoomMessage,
} from "./types.js";

interface CollectOptions {
  date: string;
  memoryRoot: string;
  includeExistingMemoryFiles?: boolean;
  roomId?: string;
}

interface SubjectRow {
  tenant_id: string;
  agent_actor_id: string;
  agent_management_id: string;
  agent_display_name: string;
  represented_human_actor_id: string;
  represented_human_display_name: string;
  represented_human_account_id: string | null;
  user_profile_revision_id: string | null;
  user_profile_markdown: string | null;
}

interface WikiGraphSubjectRow {
  tenant_id: string;
  agent_management_id: string;
  represented_human_actor_id: string;
}

export interface WikiGraphSubject {
  tenantId: string;
  agentManagementId: string;
  memorySubjectKey: string;
  representedHumanActorId: string;
}

interface RoomRow {
  tenant_id: string;
  room_id: string;
  room_name: string;
  room_created_by_actor_id: string;
  agent_actor_id: string;
  agent_management_id: string;
  represented_human_actor_id: string;
  memory_subject_key: string;
  agent_is_member: boolean;
  represented_human_is_member: boolean;
}

interface MessageRow {
  id: string;
  room_id: string;
  author_actor_id: string;
  author_display_name: string;
  author_kind: "human" | "agent";
  message_kind: string;
  body: string;
  created_at: Date;
}

interface MessageAttachmentRow {
  tenant_id: string;
  document_version_id: string;
  document_id: string;
  filename: string;
  media_type: string;
  message_id: string;
  representation_format: string;
  sha256: string;
  size_bytes: number;
}

export async function collectDaily(
  options: CollectOptions,
  suppliedSubjects?: readonly AnotherMeSubject[],
): Promise<DailyCollection> {
  const sql = memoryDatabase();
  const subjects = suppliedSubjects
    ? [...suppliedSubjects]
    : await queryAnotherMeSubjects(sql);
  const subjectKeys = subjects.map((subject) => subject.memorySubjectKey);
  await ensureMemoryScaffold(options.memoryRoot, subjects);
  const rooms = await loadMemoryRooms(
    sql,
    subjects,
    options.date,
    options.roomId,
  );
  const { startIso, endIso } = localDateWindow(options.date);
  const roomSnapshots: MemoryRoomSnapshot[] = [];

  for (const room of rooms) {
    const messages = await loadRoomMessages(
      sql,
      room.room_id,
      startIso,
      endIso,
    );
    roomSnapshots.push({
      tenantId: room.tenant_id,
      roomId: room.room_id,
      roomName: room.room_name,
      agentActorId: room.agent_actor_id,
      agentManagementId: room.agent_management_id,
      representedHumanActorId: room.represented_human_actor_id,
      memorySubjectKey: room.memory_subject_key,
      relation: {
        agentIsMember: room.agent_is_member,
        representedHumanIsMember: room.represented_human_is_member,
        agentIsCreator: room.room_created_by_actor_id === room.agent_actor_id,
        representedHumanIsCreator:
          room.room_created_by_actor_id === room.represented_human_actor_id,
        includedBecause: [
          ...(room.agent_is_member ? (["agent_member"] as const) : []),
          ...(room.represented_human_is_member
            ? (["represented_human_member"] as const)
            : []),
        ],
      },
      messages,
    });
  }

  const existingMemoryFiles =
    options.includeExistingMemoryFiles === false
      ? []
      : await loadExistingMemoryFiles(options.memoryRoot, subjectKeys);

  return {
    schemaVersion: 1,
    date: options.date,
    timeZone: localTimeZone(),
    generatedAt: new Date().toISOString(),
    source: {
      teamhubDatabaseUrlSet: true,
      memoryRoot: options.memoryRoot,
    },
    subjects,
    rooms: roomSnapshots,
    existingMemoryFiles,
  };
}

export async function loadAnotherMeSubjects(): Promise<AnotherMeSubject[]> {
  return queryAnotherMeSubjects(memoryDatabase());
}

export async function loadWikiGraphSubjectsForActor(
  representedHumanActorId: string,
): Promise<WikiGraphSubject[]> {
  const rows = await memoryDatabase()<WikiGraphSubjectRow[]>`
    SELECT tenant_id, agent_management_id, represented_human_actor_id
    FROM memory_source.another_me_subjects
    WHERE represented_human_actor_id = ${representedHumanActorId}
    ORDER BY tenant_id, agent_management_id
  `;
  return rows.map((row) => ({
    tenantId: row.tenant_id,
    agentManagementId: row.agent_management_id,
    memorySubjectKey: assertSafeMemorySubjectKey(row.agent_management_id),
    representedHumanActorId: row.represented_human_actor_id,
  }));
}

async function queryAnotherMeSubjects(
  sql: postgres.Sql,
): Promise<AnotherMeSubject[]> {
  const rows = await sql<SubjectRow[]>`
    SELECT tenant_id, agent_actor_id, agent_management_id, agent_display_name,
      represented_human_actor_id, represented_human_display_name,
      represented_human_account_id, user_profile_revision_id, user_profile_markdown
    FROM memory_source.another_me_subjects
    ORDER BY tenant_id, represented_human_display_name
  `;
  return rows.map((row) => {
    const subject = {
      tenantId: row.tenant_id,
      agentActorId: row.agent_actor_id,
      agentManagementId: row.agent_management_id,
      agentDisplayName: row.agent_display_name,
      representedHumanActorId: row.represented_human_actor_id,
      representedHumanDisplayName: row.represented_human_display_name,
      representedHumanAccountId: row.represented_human_account_id,
      ...(row.user_profile_revision_id && row.user_profile_markdown
        ? {
            userProfileRevisionId: row.user_profile_revision_id,
            userProfileMarkdown: row.user_profile_markdown,
          }
        : {}),
    };
    return {
      ...subject,
      memorySubjectKey: memorySubjectKey(subject),
    };
  });
}

export async function loadMemoryRooms(
  sql: postgres.Sql,
  subjects: readonly AnotherMeSubject[],
  date: string,
  roomId?: string,
): Promise<RoomRow[]> {
  const { startIso, endIso } = localDateWindow(date);
  if (subjects.length === 0) {
    return [];
  }
  const subjectKeys = new Map(
    subjects.map((subject) => [
      subject.agentManagementId,
      subject.memorySubjectKey,
    ]),
  );
  const rows = await sql<Omit<RoomRow, "memory_subject_key">[]>`
    SELECT room.tenant_id, room.room_id, room.room_name,
      room.room_created_by_actor_id, room.agent_actor_id,
      room.agent_management_id, room.represented_human_actor_id,
      room.agent_is_member, room.represented_human_is_member
    FROM memory_source.subject_rooms room
    WHERE room.agent_management_id IN ${sql([...subjectKeys.keys()])}
      AND (${roomId ?? null}::text IS NULL OR room.room_id = ${roomId ?? null})
      AND EXISTS (
        SELECT 1
        FROM memory_source.conversation_messages message
        WHERE message.room_id = room.room_id
          AND message.tenant_id = room.tenant_id
          AND message.created_at >= ${startIso}
          AND message.created_at < ${endIso}
      )
    ORDER BY room.agent_management_id, room.tenant_id, room.room_name, room.room_id
  `;
  return rows.map((row) => ({
    ...row,
    memory_subject_key: subjectKeys.get(row.agent_management_id)!,
  }));
}

async function loadRoomMessages(
  sql: postgres.Sql,
  roomId: string,
  startIso: string,
  endIso: string,
): Promise<RoomMessage[]> {
  const rows = await sql<MessageRow[]>`
    SELECT id, room_id, author_actor_id, author_display_name, author_kind,
      message_kind, body, created_at
    FROM memory_source.conversation_messages
    WHERE room_id = ${roomId}
      AND created_at >= ${startIso}
      AND created_at < ${endIso}
    ORDER BY created_at, id
  `;
  const attachments = await loadMessageAttachments(
    sql,
    rows.map((row) => row.id),
  );
  // Use the same (instant, id) order as the checkpoint, including timestamp ties.
  return rows
    .map((row) => ({
      id: row.id,
      roomId: row.room_id,
      authorActorId: row.author_actor_id,
      authorDisplayName: row.author_display_name,
      authorKind: row.author_kind,
      messageKind: row.message_kind,
      body: row.body,
      createdAt: row.created_at.toISOString(),
      attachments: attachments.get(row.id) ?? [],
    }))
    .sort(compareSessionlyMessages);
}

async function loadMessageAttachments(
  sql: postgres.Sql,
  messageIds: readonly string[],
): Promise<Map<string, RoomMessage["attachments"]>> {
  const result = new Map<string, RoomMessage["attachments"]>();
  if (messageIds.length === 0) return result;
  const rows = await sql<MessageAttachmentRow[]>`
    SELECT message_id, tenant_id, document_version_id, document_id, filename,
      representation_format, media_type, size_bytes, sha256
    FROM memory_source.message_attachments
    WHERE message_id IN ${sql(messageIds)}
      AND NOT is_recording_transcript
    ORDER BY message_id, position
  `;
  let teamHub: ReturnType<typeof teamHubContentAccess> | undefined;
  for (const row of rows) {
    if (
      row.representation_format !== "markdown" &&
      row.representation_format !== "plain_text"
    ) {
      continue;
    }
    const sizeBytes = Number(row.size_bytes);
    if (
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 0 ||
      sizeBytes > 1_000_000 ||
      !row.document_version_id ||
      !row.tenant_id
    ) {
      throw new Error(`Unsupported Memory attachment: ${row.filename}`);
    }
    teamHub ??= teamHubContentAccess();
    const content = await fetchTeamHubDocumentVersionContent(
      teamHub,
      row.tenant_id,
      row.document_version_id,
    );
    if (
      content.byteLength !== sizeBytes ||
      crypto.createHash("sha256").update(content).digest("hex") !== row.sha256
    ) {
      throw new Error(
        `Memory attachment integrity check failed: ${row.filename}`,
      );
    }
    const existing = result.get(row.message_id) ?? [];
    existing.push({
      documentId: row.document_id,
      documentVersionId: row.document_version_id,
      sha256: row.sha256,
      content: Buffer.from(content).toString("utf8"),
      filename: row.filename,
      mediaType: row.media_type,
    });
    result.set(row.message_id, existing);
  }
  return result;
}

async function loadExistingMemoryFiles(
  memoryRoot: string,
  subjectIds: string[],
): Promise<ExistingMemoryFile[]> {
  const result: ExistingMemoryFile[] = [];
  const skipSegments = new Set(["updates"]);
  const allowedTopLevelSegments = new Set(subjectIds);
  const allowedExtensions = new Set([".md", ".markdown", ".yaml", ".yml"]);
  let totalBytes = 0;
  const maxBytes = 250_000;

  for (const subjectId of [...allowedTopLevelSegments].sort()) {
    for await (const filePath of walkFiles(
      agentMemoryRoot(memoryRoot, subjectId),
    )) {
      const relativePath = path.relative(
        agentMemoryRoot(memoryRoot, subjectId),
        filePath,
      );
      if (
        relativePath
          .split(path.sep)
          .some((segment) => skipSegments.has(segment)) ||
        !allowedExtensions.has(path.extname(filePath))
      ) {
        continue;
      }
      const content = await fs.readFile(filePath, "utf8");
      totalBytes += Buffer.byteLength(content);
      if (totalBytes > maxBytes) return result;
      result.push({
        path: logicalMemoryPath(memoryRoot, subjectId, filePath),
        content,
      });
    }
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}
