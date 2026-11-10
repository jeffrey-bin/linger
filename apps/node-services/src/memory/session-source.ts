import path from "node:path";
import { walkFiles } from "./fs-utils.js";
import type { SessionlyCollection } from "./types.js";
import { assertDateString } from "./date.js";

export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
export const SESSION_PATH_PATTERN =
  /^evidence\/(\d{4}-\d{2}-\d{2})\/sessions\/((?:recordings\/)?[A-Za-z0-9][A-Za-z0-9_-]{0,63})\.md$/u;

/** A Human's Pocket Note page for one day; a Daily and Tracking source, never a Wiki Session. */
export const POCKET_NOTE_SESSION_ID = "pocket-note";

export function pocketNoteSessionPath(date: string): string {
  assertDateString(date);
  return `evidence/${date}/sessions/${POCKET_NOTE_SESSION_ID}.md`;
}

export function isPocketNoteSessionPath(filePath: string): boolean {
  return filePath.endsWith(`/sessions/${POCKET_NOTE_SESSION_ID}.md`);
}

export function sessionFileName(roomId: string, recordingId?: string): string {
  const id = recordingId ?? roomId;
  if (!SESSION_ID_PATTERN.test(id))
    throw new Error("Invalid Session source ID");
  return `${recordingId ? "recordings/" : ""}${id}.md`;
}

export function sessionPath(
  date: string,
  roomId: string,
  recordingId?: string,
): string {
  assertDateString(date);
  const parsed = new Date(`${date}T00:00:00Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
  )
    throw new Error("Invalid Session business date");
  return `evidence/${date}/sessions/${sessionFileName(roomId, recordingId)}`;
}

export function collectionSessionPath(
  collection: Pick<SessionlyCollection, "date" | "rooms" | "recording">,
): string {
  const room = collection.rooms[0];
  if (!room)
    throw new Error("Session source is missing its authorization Room");
  return sessionPath(
    collection.date,
    room.roomId,
    collection.recording?.captureId,
  );
}

export function sessionSourceUri(
  collection: Pick<SessionlyCollection, "rooms" | "recording">,
): string {
  return collection.recording
    ? `teamhub://documents/${collection.recording.documentId}/versions/${collection.recording.documentVersionId}`
    : `teamhub://rooms/${collection.rooms[0]!.roomId}/messages`;
}

export async function readSessionWikiPathsForDate(
  memoryRoot: string,
  subjectKey: string,
  date: string,
): Promise<string[]> {
  const sessionsRoot = path.join(
    memoryRoot,
    subjectKey,
    "memory-state",
    "evidence",
    date,
    "sessions",
  );
  const paths: string[] = [];
  for await (const filePath of walkFiles(sessionsRoot)) {
    const relative = path
      .relative(sessionsRoot, filePath)
      .split(path.sep)
      .join("/");
    if (
      path.extname(filePath) === ".md" &&
      !isPocketNoteSessionPath(`/sessions/${relative}`) &&
      (/^[^/]+\.md$/u.test(relative) ||
        /^recordings\/[^/]+\.md$/u.test(relative))
    ) {
      paths.push(`${subjectKey}/evidence/${date}/sessions/${relative}`);
    }
  }
  return paths.sort();
}
