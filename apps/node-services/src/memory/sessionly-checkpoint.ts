import {
  markMemoryChanged,
  readJsonFile,
  writeAtomicJsonFile,
} from "./fs-utils.js";
import { memoryFilePath } from "./paths.js";
import { sessionFileName } from "./session-source.js";
import type {
  RoomMessage,
  SessionlyCheckpoint,
  SessionlyMessageCursor,
} from "./types.js";
import { isNodeError, isRecord } from "@linger/service-kit";

export async function readSessionlyCheckpoint(
  memoryRoot: string,
  input: {
    date: string;
    memorySubjectKey: string;
    roomId: string;
    recordingId?: string;
  },
): Promise<SessionlyCheckpoint | undefined> {
  const filePath = sessionlyCheckpointPath(memoryRoot, input);
  try {
    return validateCheckpoint(await readJsonFile<unknown>(filePath), input);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

export async function writeSessionlyCheckpoint(
  memoryRoot: string,
  input: {
    date: string;
    memorySubjectKey: string;
    roomId: string;
    lastMessage: SessionlyMessageCursor;
    recordingId?: string;
    sourceVersion?: string;
  },
): Promise<void> {
  await writeAtomicJsonFile(sessionlyCheckpointPath(memoryRoot, input), {
    schemaVersion: 1,
    date: input.date,
    memorySubjectKey: input.memorySubjectKey,
    roomId: input.roomId,
    lastMessage: input.lastMessage,
    updatedAt: new Date().toISOString(),
    ...(input.recordingId
      ? { recordingId: input.recordingId, sourceVersion: input.sourceVersion }
      : {}),
  } satisfies SessionlyCheckpoint);
  await markMemoryChanged(memoryRoot, input.memorySubjectKey);
}

export function sessionlyCheckpointPath(
  memoryRoot: string,
  input: {
    date: string;
    memorySubjectKey: string;
    roomId: string;
    recordingId?: string;
  },
): string {
  return memoryFilePath(
    memoryRoot,
    input.memorySubjectKey,
    "evidence",
    input.date,
    "sessions",
    ".checkpoints",
    sessionFileName(input.roomId, input.recordingId).replace(/\.md$/u, ".json"),
  );
}

export function messageCursor(message: RoomMessage): SessionlyMessageCursor {
  return { messageId: message.id, createdAt: message.createdAt };
}

export function compareSessionlyMessages(
  left: Pick<RoomMessage, "id" | "createdAt">,
  right: Pick<RoomMessage, "id" | "createdAt">,
): number {
  const leftTime = Date.parse(left.createdAt);
  const rightTime = Date.parse(right.createdAt);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) {
    return left.createdAt < right.createdAt
      ? -1
      : left.createdAt > right.createdAt
        ? 1
        : 0;
  }
  return (
    leftTime - rightTime ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );
}

export function messagesAfterCursor(
  messages: readonly RoomMessage[],
  cursor: SessionlyMessageCursor | undefined,
): RoomMessage[] {
  if (!cursor) return [...messages];
  return messages.filter(
    (message) =>
      compareSessionlyMessages(message, {
        id: cursor.messageId,
        createdAt: cursor.createdAt,
      }) > 0,
  );
}

function validateCheckpoint(
  value: unknown,
  expected: {
    date: string;
    memorySubjectKey: string;
    roomId: string;
    recordingId?: string;
  },
): SessionlyCheckpoint {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("Invalid sessionly checkpoint");
  }
  if (
    value.date !== expected.date ||
    value.memorySubjectKey !== expected.memorySubjectKey ||
    value.roomId !== expected.roomId ||
    value.recordingId !== expected.recordingId ||
    (expected.recordingId !== undefined &&
      typeof value.sourceVersion !== "string") ||
    !isRecord(value.lastMessage) ||
    typeof value.lastMessage.messageId !== "string" ||
    typeof value.lastMessage.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw new Error("Sessionly checkpoint does not match its session");
  }
  return {
    schemaVersion: 1,
    ...(expected.recordingId
      ? {
          recordingId: expected.recordingId,
          sourceVersion: value.sourceVersion as string,
        }
      : {}),
    date: value.date,
    memorySubjectKey: value.memorySubjectKey,
    roomId: value.roomId,
    lastMessage: {
      messageId: value.lastMessage.messageId,
      createdAt: value.lastMessage.createdAt,
    },
    updatedAt: value.updatedAt,
  };
}

/** True when a recorded source version is for this exact transcript version. */
export function sourceVersionCoversTranscript(
  sourceVersion: string | undefined,
  documentVersionId: string,
  sha256: string,
): boolean {
  const base = `${documentVersionId}:${sha256}`;
  return sourceVersion === base || !!sourceVersion?.startsWith(`${base}:`);
}
