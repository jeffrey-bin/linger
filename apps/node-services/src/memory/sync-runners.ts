import fs from "node:fs/promises";
import path from "node:path";
import { applyMemoryUpdate, validateMemoryUpdate } from "./apply.js";
import { collectDaily, loadAnotherMeSubjects } from "./collector.js";
import { assertDateString, localTimeZone } from "./date.js";
import {
  ensureDir,
  markMemoryChanged,
  readJsonFile,
  writeJsonFile,
} from "./fs-utils.js";
import { runValidatedMemoryModelUpdate } from "./llm.js";
import {
  parseOptions,
  sessionlyUpdateDir,
  weeklyUpdateDir,
  type CliOptions,
} from "./options.js";
import { logicalMemoryPath, memoryFilePath } from "./paths.js";
import { weeklyLlmOutputPath, writeWeeklyPrompt } from "./prompt.js";
import {
  collectRecordingSession,
  loadRecordingCandidates,
  recordingSourceVersion,
} from "./recording-collector.js";
import { ensureMemoryScaffold } from "./scaffold.js";
import {
  sessionSourceText,
  storeSessionSource,
} from "./search/source-store.js";
import {
  collectionSessionPath,
  sessionSourceUri,
  readSessionWikiPathsForDate,
} from "./session-source.js";
import {
  messageCursor,
  messagesAfterCursor,
  readSessionlyCheckpoint,
  writeSessionlyCheckpoint,
} from "./sessionly-checkpoint.js";
import { memoryOutputPrefixes } from "./sync-policy.js";
import { filesystemMemoryTaskState } from "./task-state.js";
import type {
  AnotherMeSubject,
  DailyCollection,
  ExistingMemoryFile,
  MemoryUpdateOutput,
  SessionlyCollection,
  WeeklyCollection,
} from "./types.js";
import { weeklySourceCatalog } from "./report-source-references.js";
import { dailyReportHasEvidence } from "./daily-report.js";
import { parseReportOutput } from "./report-render.js";
import {
  renderWeeklyReport,
  weeklyReportSchema,
  type WeeklyReportOutput,
} from "./weekly-report.js";
import { isNodeError } from "@linger/service-kit";
import { syncWeeklyMemory } from "./user-memory-sync.js";
import { writeMemoryLog } from "./run-telemetry.js";
import { updateDailyTrackingItems } from "./tracking-items.js";

type SyncAction = "collect" | "prompt" | "run" | "apply";

export interface SessionlyRunResult {
  updatedSessionCount: number;
}

export async function runWikiSessionSources(
  argv: string[],
): Promise<SessionlyRunResult> {
  const { action, options } = parseSyncInvocation(argv, "run");
  if (action !== "run") {
    throw new Error("Wiki Session source collection supports only run");
  }
  const subjects = await prepareAnotherMeSubjects(options);
  const collections = await collectSessionlyCommand(options, subjects);
  if (collections.length === 0) {
    console.log("No new Session sources for Wiki update.");
    return { updatedSessionCount: 0 };
  }
  for (const collection of collections) {
    const staged = await stageSessionRawForWiki(options, collection);
    if (collection.recording)
      followMeetingInTrackingItems(options.date, staged);
  }
  return { updatedSessionCount: collections.length };
}

/**
 * A finished meeting reaches Tracking Items right away, from its transcript
 * alone, without holding the Wiki run. A failure is logged and skipped: the
 * midnight Daily reads the meeting again with the whole day.
 */
function followMeetingInTrackingItems(
  date: string,
  staged: { memorySubjectKey: string; path: string; content: string },
): void {
  void updateDailyTrackingItems(
    staged.memorySubjectKey,
    date,
    [{ path: staged.path, content: staged.content }],
    "meeting",
  ).catch((error: unknown) =>
    writeMemoryLog(
      "memory_meeting_tracking_skipped",
      {
        memory_subject_key: staged.memorySubjectKey,
        date,
        path: staged.path,
        error,
      },
      "ERROR",
    ),
  );
}

export async function stageSessionRawForWiki(
  options: CliOptions,
  collection: SessionlyCollection,
): Promise<{ memorySubjectKey: string; path: string; content: string }> {
  const subject = collection.subjects[0];
  const snapshot = collection.rooms[0];
  if (
    collection.subjects.length !== 1 ||
    collection.rooms.length !== 1 ||
    !subject?.representedHumanActorId ||
    !snapshot ||
    snapshot.tenantId !== subject.tenantId ||
    snapshot.memorySubjectKey !== subject.memorySubjectKey ||
    snapshot.representedHumanActorId !== subject.representedHumanActorId ||
    snapshot.messages.some((message) => message.roomId !== snapshot.roomId)
  ) {
    throw new Error("Session evidence identity does not match its subject");
  }
  const subjectKey = sessionlySubjectKey(collection);
  const room = sessionlyRoomRef(collection);
  const relativePath = collectionSessionPath(collection);
  const targetPath = memoryFilePath(
    options.memoryRoot,
    subjectKey,
    ...relativePath.split("/"),
  );
  const title = collection.recording
    ? `Recording ${collection.recording.captureId}`
    : collection.rooms[0]!.roomName;
  const content = `---\ntype: Session Evidence\ntitle: ${JSON.stringify(title)}\ndate: ${collection.date}\nsource_kind: ${collection.recording ? "meeting" : "room"}\nsession_identity:\n  represented_human_actor_id: ${JSON.stringify(subject.representedHumanActorId)}\n  represented_human_display_name: ${JSON.stringify(subject.representedHumanDisplayName)}\n  attribution_basis: ${collection.recording ? "unknown_transcript_speakers" : "message_author_actor_id"}\n  attachment_attribution_basis: unknown_transcript_speakers\nsources:\n  - resource: ${sessionSourceUri(collection)}\n---\n\n# ${title.replace(/[\r\n]/gu, " ")}\n\n## Authoritative Raw Evidence\n\n${sessionSourceText(collection).trimEnd()}\n`;
  await ensureDir(path.dirname(targetPath));
  await fs.writeFile(targetPath, content);
  await markMemoryChanged(options.memoryRoot, subjectKey);
  await storeSessionSource(options.memoryRoot, collection);
  await filesystemMemoryTaskState.markWikiPending(
    options.memoryRoot,
    options.date,
    subjectKey,
  );
  await writeSessionlyCheckpoint(options.memoryRoot, {
    date: options.date,
    memorySubjectKey: subjectKey,
    roomId: room.roomId,
    lastMessage: collection.sourceCursor.after,
    ...(collection.recording
      ? {
          recordingId: collection.recording.captureId,
          sourceVersion:
            collection.recording.sourceVersion ??
            recordingSourceVersion(collection.recording),
        }
      : {}),
  });
  return {
    memorySubjectKey: subjectKey,
    path: `${subjectKey}/${relativePath}`,
    content,
  };
}

export async function runWeeklyCli(
  argv: string[],
): Promise<{ processedSubjectCount: number }> {
  const { action, options } = parseSyncInvocation(argv, "run");
  const subjects = await prepareAnotherMeSubjects(options);
  const weekStart = resolveWeekStart(options);
  const weekOptions = { ...options, weekStart };
  let processedSubjectCount = 0;
  await mapWithConcurrency(subjects, options.concurrency, async (subject) => {
    const memorySubjectKey = subject.memorySubjectKey;
    const subjectOptions = { ...weekOptions, memorySubjectKey };
    const collection =
      action === "run" || action === "collect"
        ? await readJsonFile<WeeklyCollection>(
            await collectWeeklyCommand(subjectOptions, memorySubjectKey),
          )
        : await ensureWeeklyCollection(subjectOptions, memorySubjectKey);
    // Missing upstream reports are pending work, not evidence of an empty week.
    const dailyPaths = new Set(
      collection.existingMemoryFiles.map((file) => file.path),
    );
    for (let offset = 0; offset < 7; offset++) {
      const date = addDays(weekStart, offset);
      if (
        !dailyPaths.has(`${memorySubjectKey}/timeline/daily/${date}.md`) &&
        (
          await readSessionWikiPathsForDate(
            options.memoryRoot,
            memorySubjectKey,
            date,
          )
        ).length > 0
      )
        throw new Error(
          `Daily report is not ready for ${date}; retry Weekly after Daily`,
        );
    }
    const hasEvidence = hasCurrentWeekEvidence(collection);
    if (!hasEvidence) {
      console.log(
        `No current-week evidence for ${memorySubjectKey} on ${weekStart}; Weekly unchanged.`,
      );
      return;
    }
    if (action === "collect") return;
    const outputPath = await writeWeeklyReport(
      action,
      subjectOptions,
      subject,
      collection,
    );
    if (!outputPath) return;
    processedSubjectCount += 1;
    console.log(`Applied weekly memory update: ${outputPath}`);
    await syncWeeklyMemory(options.memoryRoot, subject, {
      start: weekStart,
      end: addDays(weekStart, 6),
    });
  });
  return { processedSubjectCount };
}

/**
 * Writes one subject's Weekly for `options.weekStart` from its collected
 * Dailies and returns the model output's path; `prompt` stops after writing
 * the prompt. Benchmarks call it directly.
 */
export async function writeWeeklyReport(
  action: string,
  subjectOptions: CliOptions & { weekStart: string; memorySubjectKey: string },
  subject: AnotherMeSubject,
  collection: WeeklyCollection,
): Promise<string | undefined> {
  const { weekStart, memorySubjectKey } = subjectOptions;
  const options = subjectOptions;
  const applyOptions = {
    allowedSubjectKeys: [memorySubjectKey],
    allowedPathPrefixes: memoryOutputPrefixes("weekly", "write"),
    allowedDeletePathPrefixes: memoryOutputPrefixes("weekly", "delete"),
  };
  const prepareOutput = async (
    outputPath: string,
  ): Promise<MemoryUpdateOutput> => {
    const catalog = weeklySourceCatalog(collection);
    const report = parseReportOutput<WeeklyReportOutput>(
      await fs.readFile(outputPath, "utf8"),
      weeklyReportSchema(catalog.map(({ sourceRef }) => sourceRef)),
      "Weekly",
    );
    if (!report.source_refs.some((ref) => ref.startsWith("daily_")))
      throw new Error("Weekly requires current-week Daily evidence");
    const output: MemoryUpdateOutput = {
      schema_version: 1,
      date: weekStart,
      files: [
        {
          path: `${memorySubjectKey}/timeline/weekly/${weekStart}.md`,
          content: renderWeeklyReport(report, {
            weekStart,
            memorySubjectKey,
            hasPreviousWeekly: collection.existingMemoryFiles.some(({ path }) =>
              path.includes("/timeline/weekly/"),
            ),
            catalog,
            now: new Date(),
          }),
          source_refs: report.source_refs,
        },
      ],
      deleted_paths: [],
      memory_log_entries: [],
    };
    await validateMemoryUpdate(options.memoryRoot, output, applyOptions);
    return output;
  };
  let outputPath = weeklyLlmOutputPath(subjectOptions, memorySubjectKey);
  if (action !== "apply") {
    const artifacts = await writeWeeklyPrompt(
      subjectOptions,
      collection,
      subject,
    );
    if (action === "prompt") return undefined;
    outputPath = await runValidatedMemoryModelUpdate(
      {
        tenantId: subject.tenantId,
        ownerActorId: subject.representedHumanActorId,
      },
      artifacts,
      async (candidatePath) => {
        await prepareOutput(candidatePath);
      },
    );
  }
  await applyMemoryUpdate(
    options.memoryRoot,
    await prepareOutput(outputPath),
    applyOptions,
  );
  return outputPath;
}

export function hasCurrentWeekEvidence(collection: WeeklyCollection): boolean {
  return collection.existingMemoryFiles.some(
    (file) =>
      file.path.includes("/timeline/daily/") &&
      dailyReportHasEvidence(file.content),
  );
}

async function collectSessionlyCommand(
  options: CliOptions,
  subjects: readonly AnotherMeSubject[],
): Promise<SessionlyCollection[]> {
  if (options.recordingId) {
    const collections: SessionlyCollection[] = [];
    for (const subject of subjects) {
      const candidates = await loadRecordingCandidates(
        subject,
        new Date(0).toISOString(),
        options.recordingId,
      );
      for (const candidate of candidates) {
        if (options.roomId && candidate.roomId !== options.roomId)
          throw new Error("Recording does not belong to the requested Room");
        if (candidate.date !== options.date)
          throw new Error(
            "Recording business date does not match the requested Session",
          );
        const collection = await collectRecordingSession(
          options,
          subject,
          candidate,
        );
        if (collection) {
          await writeJsonFile(
            sessionlyCollectionPath(options, collection),
            collection,
          );
          collections.push(collection);
        }
      }
    }
    return collections;
  }
  const dayCollection = await collectDaily(
    { ...options, includeExistingMemoryFiles: false },
    subjects,
  );
  const collections = await toSessionlyCollections(dayCollection, options);
  for (const collection of collections) {
    await writeJsonFile(
      sessionlyCollectionPath(options, collection),
      collection,
    );
  }
  return collections;
}

async function collectWeeklyCommand(
  options: CliOptions & { weekStart: string },
  memorySubjectKey: string,
): Promise<string> {
  const collection = await collectWeekly(options, memorySubjectKey);
  const collectionPath = weeklyCollectionPath(options, memorySubjectKey);
  await writeJsonFile(collectionPath, collection);
  return collectionPath;
}

async function ensureWeeklyCollection(
  options: CliOptions & { weekStart: string },
  memorySubjectKey: string,
): Promise<WeeklyCollection> {
  const collectionPath = weeklyCollectionPath(options, memorySubjectKey);
  try {
    const collection = await readJsonFile<WeeklyCollection>(collectionPath);
    if (collection.memorySubjectKey === memorySubjectKey) return collection;
  } catch {
    // Fall through and replace an unavailable collection.
  }
  await collectWeeklyCommand(options, memorySubjectKey);
  return readJsonFile<WeeklyCollection>(collectionPath);
}

async function toSessionlyCollections(
  collection: DailyCollection,
  options: Pick<CliOptions, "memoryRoot" | "memorySubjectKey" | "roomId">,
): Promise<SessionlyCollection[]> {
  const subjectsByKey = new Map(
    collection.subjects.map((subject) => [subject.memorySubjectKey, subject]),
  );
  const rooms = collection.rooms.filter((room) => {
    if (
      options.memorySubjectKey &&
      room.memorySubjectKey !== options.memorySubjectKey
    ) {
      return false;
    }
    if (options.roomId && room.roomId !== options.roomId) {
      return false;
    }
    return true;
  });
  if (rooms.length === 0 && options.roomId) {
    throw new Error("No session rooms matched the supplied options");
  }
  const result = await Promise.all(
    rooms.map(async (room) => {
      const subject = subjectsByKey.get(room.memorySubjectKey);
      if (!subject) {
        throw new Error(
          `Session room has unknown subject: ${room.memorySubjectKey}`,
        );
      }
      const input = {
        date: collection.date,
        memorySubjectKey: room.memorySubjectKey,
        roomId: room.roomId,
      };
      const checkpoint = await readSessionlyCheckpoint(
        options.memoryRoot,
        input,
      );
      const previousSession = await readExistingSessionFile(
        options.memoryRoot,
        input,
      );
      const newMessages =
        checkpoint && previousSession
          ? messagesAfterCursor(room.messages, checkpoint.lastMessage)
          : room.messages;
      if (newMessages.length === 0) return undefined;
      const latestMessage = newMessages.at(-1);
      if (!latestMessage) return undefined;
      return {
        schemaVersion: 1 as const,
        date: collection.date,
        timeZone: collection.timeZone,
        generatedAt: new Date().toISOString(),
        source: collection.source,
        subjects: [subject],
        // The checkpoint controls whether generation is needed. A generation
        // always receives the complete Room history so its replacement file
        // remains a cumulative session snapshot instead of a delta summary.
        rooms: [{ ...room, messages: room.messages }],
        ...(previousSession ? { previousSession } : {}),
        sourceCursor: {
          ...(checkpoint ? { before: checkpoint.lastMessage } : {}),
          after: messageCursor(latestMessage),
        },
      } satisfies SessionlyCollection;
    }),
  );
  return result
    .filter((value): value is SessionlyCollection => value !== undefined)
    .sort((left, right) =>
      sessionlySortKey(left).localeCompare(sessionlySortKey(right)),
    );
}

async function readExistingSessionFile(
  memoryRoot: string,
  input: { date: string; memorySubjectKey: string; roomId: string },
): Promise<ExistingMemoryFile | undefined> {
  const filePath = memoryFilePath(
    memoryRoot,
    input.memorySubjectKey,
    "evidence",
    input.date,
    "sessions",
    `${input.roomId}.md`,
  );
  try {
    return {
      path: logicalMemoryPath(memoryRoot, input.memorySubjectKey, filePath),
      content: await fs.readFile(filePath, "utf8"),
    };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

export async function collectWeekly(
  options: CliOptions & { weekStart: string },
  memorySubjectKey: string,
): Promise<WeeklyCollection> {
  return {
    schemaVersion: 1,
    weekStart: options.weekStart,
    weekEnd: addDays(options.weekStart, 6),
    timeZone: localTimeZone(),
    generatedAt: new Date().toISOString(),
    source: {
      memoryRoot: options.memoryRoot,
    },
    memorySubjectKey,
    existingMemoryFiles: await loadWeeklyMemoryFiles(
      options.memoryRoot,
      memorySubjectKey,
      options.weekStart,
    ),
  };
}

async function prepareAnotherMeSubjects(
  options: Pick<CliOptions, "memoryRoot" | "memorySubjectKey">,
): Promise<AnotherMeSubject[]> {
  const subjects = (await loadAnotherMeSubjects()).filter(
    (subject) =>
      !options.memorySubjectKey ||
      subject.memorySubjectKey === options.memorySubjectKey,
  );
  if (subjects.length === 0) {
    throw new Error(
      "No AnotherMe memory subjects matched the supplied options",
    );
  }
  await ensureMemoryScaffold(options.memoryRoot, subjects);
  return subjects;
}

export async function loadWeeklyMemoryFiles(
  memoryRoot: string,
  memorySubjectKey: string,
  weekStart: string,
): Promise<ExistingMemoryFile[]> {
  const result: ExistingMemoryFile[] = [];
  const weekDates = new Set(
    Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)),
  );
  const previousWeekStart = addDays(weekStart, -7);
  const append = async (filePath: string, content: string) => {
    result.push({
      path: logicalMemoryPath(memoryRoot, memorySubjectKey, filePath),
      content,
    });
  };

  const dailyRoot = memoryFilePath(
    memoryRoot,
    memorySubjectKey,
    "timeline",
    "daily",
  );
  for (const date of weekDates) {
    const filePath = path.join(dailyRoot, `${date}.md`);
    try {
      await append(filePath, await fs.readFile(filePath, "utf8"));
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }

  const previousDynamicPath = memoryFilePath(
    memoryRoot,
    memorySubjectKey,
    "timeline",
    "weekly",
    `${previousWeekStart}.md`,
  );
  try {
    await append(
      previousDynamicPath,
      await fs.readFile(previousDynamicPath, "utf8"),
    );
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }

  const totalBytes = result.reduce(
    (sum, file) => sum + Buffer.byteLength(file.content),
    0,
  );
  if (totalBytes > 700_000) {
    throw new Error(
      `Weekly input exceeds the 700000-byte bounded collection: ${totalBytes}`,
    );
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

function parseSyncInvocation(
  argv: string[],
  defaultAction: SyncAction,
): { action: SyncAction; options: CliOptions } {
  const [first = defaultAction, separatorOrFirstOption, ...rest] = argv;
  const action = isSyncAction(first) ? first : defaultAction;
  const rawArgs = isSyncAction(first)
    ? [separatorOrFirstOption, ...rest]
    : argv;
  const args = rawArgs.filter((arg): arg is string => typeof arg === "string");
  return {
    action,
    options: parseOptions(args[0] === "--" ? args.slice(1) : args),
  };
}

function isSyncAction(value: string): value is SyncAction {
  return (
    value === "collect" ||
    value === "prompt" ||
    value === "run" ||
    value === "apply"
  );
}

function sessionlyCollectionPath(
  options: Pick<CliOptions, "date" | "memoryRoot">,
  collection: Pick<SessionlyCollection, "rooms" | "subjects" | "recording">,
): string {
  const room = sessionlyRoomRef(collection);
  return path.join(
    sessionlyUpdateDir(options, {
      memorySubjectKey: sessionlySubjectKey(collection),
      tenantId: room.tenantId,
      roomId: room.roomId,
      recordingId: collection.recording?.captureId,
    }),
    "collection.json",
  );
}

function weeklyCollectionPath(
  options: Pick<CliOptions, "memoryRoot"> & { weekStart: string },
  memorySubjectKey: string,
): string {
  return path.join(
    weeklyUpdateDir(options, memorySubjectKey),
    "collection.json",
  );
}

function resolveWeekStart(options: CliOptions): string {
  return assertDateString(options.weekStart ?? options.date);
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function roomKey(tenantId: string, roomId: string): string {
  return `${tenantId}\u0000${roomId}`;
}

function sessionlyRoomRef(collection: Pick<SessionlyCollection, "rooms">): {
  tenantId: string;
  roomId: string;
} {
  const room = collection.rooms[0];
  if (room) {
    return { tenantId: room.tenantId, roomId: room.roomId };
  }
  throw new Error("Sessionly collection is missing room data");
}

function sessionlySortKey(collection: SessionlyCollection): string {
  const room = sessionlyRoomRef(collection);
  return `${sessionlySubjectKey(collection)}\u0000${roomKey(room.tenantId, room.roomId)}`;
}

function sessionlySubjectKey(
  collection: Pick<SessionlyCollection, "rooms" | "subjects">,
): string {
  const subjectKey =
    collection.rooms[0]?.memorySubjectKey ??
    collection.subjects[0]?.memorySubjectKey;
  if (!subjectKey)
    throw new Error("Sessionly collection is missing subject data");
  return subjectKey;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(values.length);
  const waiters: Array<() => void> = [];
  let active = 0;

  const runLimited = async (run: () => Promise<void>): Promise<void> => {
    if (active >= concurrency) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    active += 1;
    try {
      await run();
    } finally {
      active -= 1;
      waiters.shift()?.();
    }
  };

  const tasks = values.map((value, index) =>
    runLimited(async () => {
      results[index] = await mapper(value, index);
    }),
  );

  const settled = await Promise.allSettled(tasks);
  const failed = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failed) throw failed.reason;
  return results;
}
