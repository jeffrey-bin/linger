import path from "node:path";
import { contextHostRoot, repositoryRoot } from "../paths.js";
import { assertDateString, localDate } from "./date.js";
import { sessionFileName } from "./session-source.js";

export interface CliOptions {
  date: string;
  memoryRoot: string;
  memorySubjectKey?: string;
  roomId?: string;
  recordingId?: string;
  weekStart?: string;
  concurrency: number;
}

export function parseOptions(args: string[]): CliOptions {
  let date = localDate();
  let memoryRoot = contextHostRoot();
  let memorySubjectKey: string | undefined;
  let roomId: string | undefined;
  let recordingId: string | undefined;
  let weekStart: string | undefined;
  let concurrency = 4;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "--date" && next) {
      date = assertDateString(next);
      index += 1;
    } else if (arg === "--memory-root" && next) {
      memoryRoot = next;
      index += 1;
    } else if (arg === "--memory-subject-key" && next) {
      memorySubjectKey = next;
      index += 1;
    } else if (arg === "--room-id" && next) {
      roomId = next;
      index += 1;
    } else if (arg === "--recording-id" && next) {
      sessionFileName("", next);
      recordingId = next;
      index += 1;
    } else if (arg === "--week-start" && next) {
      weekStart = assertDateString(next);
      index += 1;
    } else if (arg === "--concurrency" && next) {
      concurrency = parseConcurrency(next);
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete option: ${arg}`);
    }
  }

  return {
    date,
    memoryRoot: path.resolve(repositoryRoot, memoryRoot),
    ...(memorySubjectKey ? { memorySubjectKey } : {}),
    ...(roomId ? { roomId } : {}),
    ...(recordingId ? { recordingId } : {}),
    ...(weekStart ? { weekStart } : {}),
    concurrency,
  };
}

export function sessionlyUpdateDir(
  options: Pick<CliOptions, "date" | "memoryRoot">,
  input: {
    memorySubjectKey: string;
    tenantId: string;
    roomId: string;
    recordingId?: string;
  },
) {
  return path.join(
    options.memoryRoot,
    "updates",
    "sessionly",
    options.date,
    input.memorySubjectKey,
    input.tenantId,
    sessionFileName(input.roomId, input.recordingId).slice(0, -3),
  );
}

export function weeklyUpdateDir(
  options: Pick<CliOptions, "memoryRoot"> & { weekStart: string },
  memorySubjectKey: string,
) {
  return path.join(
    options.memoryRoot,
    "updates",
    "weekly",
    options.weekStart,
    memorySubjectKey,
  );
}

function parseConcurrency(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 16) {
    throw new Error(`--concurrency must be an integer from 1 to 16: ${value}`);
  }
  return parsed;
}
