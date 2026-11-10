import fs from "node:fs/promises";
import { agentWorkspaceRoot } from "./paths.js";
import crypto from "node:crypto";
import path from "node:path";
import { parseOkfFrontmatter } from "@linger/knowledge-format";
import type { components } from "@linger/wire-contracts/node-services-internal/types";
import { loadWikiGraphSubjectsForActor } from "./collector.js";
import { queryReadyMeetings, type MeetingRow } from "./ready-meetings.js";
import { localMeetingTime } from "./date.js";
import { localDate } from "./date.js";
import { readIndexedWiki } from "./wiki-index.js";
import {
  readSessionlyCheckpoint,
  sourceVersionCoversTranscript,
} from "./sessionly-checkpoint.js";
import { SESSION_ID_PATTERN } from "./session-source.js";

type Entry = components["schemas"]["MemoryEntry"];
interface Request {
  dataRoot: string;
  tenantId: string;
  ownerActorId: string;
  cursor?: string;
  limit?: number;
  entryId?: string;
}

function idForMeeting(tenantId: string, captureId: string): string {
  return `meeting_${crypto.createHash("sha256").update(`meeting\0${tenantId}\0${captureId}`).digest("hex").slice(0, 24)}`;
}

export function meetingDisplayPath(start: Date): string {
  const time = localMeetingTime(start);
  return `Meetings/${localDate(start).replaceAll("-", "/")}/Meeting ${time}`;
}

/**
 * The meeting's summary is the published Session page of its Recording.
 * `wikiPages` maps each page path of the indexed published Wiki to its
 * Markdown.
 */
export async function readMeetingSummary(
  dataRoot: string,
  subjectKey: string,
  row: MeetingRow,
  wikiPages: ReadonlyMap<string, string>,
  includeContent = true,
): Promise<{ content: string; path: string } | undefined> {
  const date = localDate(row.transcript_created_at);
  const input = {
    date,
    memorySubjectKey: subjectKey,
    roomId: row.room_id,
    recordingId: row.id,
  };
  const checkpoint = await readSessionlyCheckpoint(dataRoot, input);
  if (
    !sourceVersionCoversTranscript(
      checkpoint?.sourceVersion,
      row.transcript_version_id,
      row.transcript_sha256,
    )
  )
    return undefined;
  if (!SESSION_ID_PATTERN.test(row.id))
    throw new TypeError("Invalid capture ID");
  const relativePath = `sessions/${date}/${row.id}.md`;
  // Raw collection commits its checkpoint before the Wiki publishes a Session.
  // It is evidence, never a human summary. Read only the published page and
  // require this exact transcript version to be among its raw references.
  const content = wikiPages.get(relativePath);
  if (content === undefined) return undefined;
  const { fields } = parseOkfFrontmatter(content);
  const resource = `teamhub://documents/${row.transcript_document_id}/versions/${row.transcript_version_id}`;
  if (
    fields?.type !== "Session" ||
    !Array.isArray(fields.sources) ||
    !fields.sources.some(
      (source: unknown) =>
        typeof source === "object" &&
        source !== null &&
        "resource" in source &&
        source.resource === resource,
    )
  )
    return undefined;
  return { content: includeContent ? content : "", path: relativePath };
}

export async function browseMeetings(
  input: Request,
): Promise<components["schemas"]["MemoryEntryPage"]> {
  const rows = await queryReadyMeetings(input.tenantId, input.ownerActorId);
  const subject = (
    await loadWikiGraphSubjectsForActor(input.ownerActorId)
  ).find((item) => item.tenantId === input.tenantId);
  const names = new Map<string, number>();
  for (const row of rows) {
    const name = meetingDisplayPath(row.started_at);
    names.set(name, (names.get(name) ?? 0) + 1);
  }
  const offset = Number(input.cursor ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new TypeError("Memory cursor is invalid");
  const selected = input.entryId
    ? rows.filter(
        (row) => idForMeeting(input.tenantId, row.id) === input.entryId,
      )
    : rows.slice(offset, offset + (input.limit ?? 50));
  const wikiPages = new Map(
    subject && selected.length
      ? (
          await readIndexedWiki(
            input.tenantId,
            input.ownerActorId,
            selected.map(
              (row) =>
                `sessions/${localDate(row.transcript_created_at)}/${row.id}.md`,
            ),
          )
        ).pages.map((page) => [page.key, page.content])
      : [],
  );
  const filenames: Record<string, string> =
    subject && wikiPages.size
      ? JSON.parse(
          await fs
            .readFile(
              path.join(
                agentWorkspaceRoot(input.dataRoot, subject.agentManagementId),
                "memory-state/wiki-file-paths.json",
              ),
              "utf8",
            )
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
              return "{}";
            }),
        )
      : {};
  const items: Entry[] = [];
  for (const row of selected) {
    const basePath = meetingDisplayPath(row.started_at);
    const displayPath =
      names.get(basePath)! > 1
        ? `${basePath} (${rows.some((other) => other.id !== row.id && meetingDisplayPath(other.started_at) === basePath && other.id.slice(-8) === row.id.slice(-8)) ? row.id : row.id.slice(-8)})`
        : basePath;
    const summary = subject
      ? await readMeetingSummary(
          input.dataRoot,
          subject.agentManagementId,
          row,
          wikiPages,
          Boolean(input.entryId),
        )
      : undefined;
    items.push({
      id: idForMeeting(input.tenantId, row.id),
      kind: "meeting",
      path: displayPath,
      title: displayPath.split("/").at(-1)!,
      summary: "",
      date: basePath.split("/").slice(1, 4).join("-"),
      updated_at: row.updated_at.toISOString(),
      content: input.entryId ? (summary?.content ?? "").slice(0, 200_000) : "",
      meeting: {
        capture_id: row.id,
        started_at: row.started_at.toISOString(),
        recording_document_id: row.recording_document_id,
        recording_version_id: row.recording_version_id,
        recording_filename: `recording${path.extname(row.recording_filename) || ".m4a"}`,
        transcript_document_id: row.transcript_document_id,
        transcript_version_id: row.transcript_version_id,
        summary_ready: Boolean(summary),
        ...(summary && filenames[summary.path]
          ? { summary_path: filenames[summary.path] }
          : {}),
      },
    });
  }
  const next = offset + selected.length;
  return {
    items,
    ...(!input.entryId && next < rows.length
      ? { next_cursor: String(next) }
      : {}),
  };
}
