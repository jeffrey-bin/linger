import { parseOkfFrontmatter } from "@linger/knowledge-format";
import fs from "node:fs/promises";
import path from "node:path";
import { isMainModule } from "../paths.js";
import { applyMemoryUpdate, validateMemoryUpdate } from "./apply.js";
import { loadAnotherMeSubjects } from "./collector.js";
import { closeMemoryDatabase } from "./database.js";
import { localTimeZone, previousDate } from "./date.js";
import {
  readJsonFile,
  walkFiles,
  writeJsonFile,
  writeTextFile,
} from "./fs-utils.js";
import { runValidatedMemoryModelUpdate } from "./llm.js";
import {
  COMPUTER_OFFLINE_MESSAGE,
  isComputerOffline,
  ModelCallError,
} from "../runtime-model-call.js";
import { parseOptions, type CliOptions } from "./options.js";
import { logicalMemoryPath, memoryFilePath, promptRoot } from "./paths.js";
import { stagePocketNote } from "./pocket-note-source.js";
import { dreamProactiveForSubject } from "./proactive-dreaming.js";
import { renderSyncPolicyBoundary, type PromptArtifacts } from "./prompt.js";
import { memoryOutputPrefixes } from "./sync-policy.js";
import type { AnotherMeSubject, MemoryUpdateOutput } from "./types.js";
import { writeMemoryLog } from "./run-telemetry.js";
import { runDayRead } from "./day-read.js";
import { updateDailyTrackingItems } from "./tracking-items.js";
import {
  POCKET_NOTE_SESSION_ID,
  pocketNoteSessionPath,
  readSessionWikiPathsForDate,
} from "./session-source.js";
import type { ReportSourceReference } from "./report-source-references.js";
import {
  dailyReportSchema,
  renderDailyReport,
  type DailyReportOutput,
} from "./daily-report.js";
import { parseReportOutput } from "./report-render.js";

export type DailyOptions = CliOptions & { subject: AnotherMeSubject };

interface SessionSummaryFile {
  path: string;
  content: string;
}

export interface DailyCollection {
  schemaVersion: 4;
  date: string;
  timeZone: string;
  generatedAt: string;
  source: {
    memoryRoot: string;
  };
  memorySubjectKey: string;
  sessionFiles: SessionSummaryFile[];
  previousDailyFiles: SessionSummaryFile[];
  requiredOutputs: {
    dailyMemoryPath: string;
  };
}

if (isMainModule(import.meta.url)) {
  runDailyCli(process.argv.slice(2))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(closeMemoryDatabase);
}

export interface DailyRunResult {
  processedSubjectCount: number;
}

export async function runDailyCli(argv: string[]): Promise<DailyRunResult> {
  const [action = "run", ...rest] = argv;
  const args = rest[0] === "--" ? rest.slice(1) : rest;
  const options = parseOptions(args);
  if (!["collect", "prompt", "run", "apply"].includes(action)) {
    throw new Error(`Unknown daily action: ${action}`);
  }
  const subjectOptions = await resolveDailySubjectOptions(options);
  if (subjectOptions.length === 0) {
    console.log(`No AnotherMe subjects for ${options.date}.`);
  }
  // Like scheduled fan-out, one subject's failure never stops the others.
  const failures: string[] = [];
  let offlineFailures = 0;
  let processedSubjectCount = 0;
  for (const subjectOptionsItem of subjectOptions) {
    try {
      if (await runDailyForSubject(action, subjectOptionsItem))
        processedSubjectCount += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${subjectOptionsItem.memorySubjectKey}: ${message}`);
      if (isComputerOffline(error)) offlineFailures += 1;
      writeMemoryLog(
        "memory_daily_subject_failed",
        {
          memory_subject_key: subjectOptionsItem.memorySubjectKey,
          error: message,
        },
        "ERROR",
      );
    }
  }
  // Subjects that only wait for their Computer are retried without spending
  // an attempt.
  if (failures.length > 0 && offlineFailures === failures.length)
    throw new ModelCallError(
      "computer_offline",
      `${COMPUTER_OFFLINE_MESSAGE}: ${failures.join("; ")}`,
    );
  if (failures.length > 0)
    throw new Error(
      `${failures.length} of ${subjectOptions.length} Daily subjects failed: ${failures.join("; ")}`,
    );
  return { processedSubjectCount };
}

async function runDailyForSubject(
  action: string,
  options: DailyOptions,
): Promise<boolean> {
  const collectionPath = dailyCollectionPath(options);
  const artifacts = dailyArtifacts(options);

  const collection =
    action === "run" || action === "collect"
      ? await collectAndPersistDaily(options)
      : await ensureDailyCollection(options);
  if (collection.sessionFiles.length === 0) {
    if (action === "run") await refreshDailyTracking(options);
    return false;
  }
  if (action === "collect") {
    console.log(`Collected daily input: ${collectionPath}`);
    return true;
  }

  if (action === "prompt") {
    await writeDailyPrompt(options, collection, artifacts);
    console.log(`Wrote daily prompt: ${artifacts.promptPath}`);
    return true;
  }

  if (action === "apply") {
    await applyDailyOutput(options, collection, artifacts.outputPath);
    console.log(`Applied daily output: ${artifacts.outputPath}`);
    return true;
  }

  // memory.md and the Daily come from one read of the day's conversations.
  const dayRead = await runDayRead(options, collection);
  console.log(`Applied daily output: ${dayRead.dailyPath}`);
  await dreamDailyProactive(options.subject);
  await refreshDailyTracking(options);
  return true;
}

/**
 * Writes one subject's Daily for `options.date` from its collected evidence
 * and returns the model output's path. Benchmarks call it directly.
 */
export async function writeDailyReport(
  options: DailyOptions,
  collection?: DailyCollection,
): Promise<string | undefined> {
  const evidence = collection ?? (await collectAndPersistDaily(options, false));
  if (evidence.sessionFiles.length === 0) return undefined;
  const artifacts = dailyArtifacts(options);
  await writeDailyPrompt(options, evidence, artifacts);
  const outputPath = await runValidatedMemoryModelUpdate(
    {
      tenantId: options.subject.tenantId,
      ownerActorId: options.subject.representedHumanActorId,
    },
    artifacts,
    async (candidatePath) => {
      await prepareDailyOutput(options, evidence, candidatePath);
    },
  );
  await applyDailyOutput(options, evidence, outputPath);
  return outputPath;
}

async function refreshDailyTracking(options: DailyOptions): Promise<void> {
  const subjectKey = options.subject.memorySubjectKey;
  const files: SessionSummaryFile[] = [];
  for await (const file of walkFiles(
    memoryFilePath(
      options.memoryRoot,
      subjectKey,
      "evidence",
      options.date,
      "sessions",
    ),
  )) {
    if ([".md", ".markdown"].includes(path.extname(file)))
      files.push({
        path: logicalMemoryPath(options.memoryRoot, subjectKey, file),
        content: await fs.readFile(file, "utf8"),
      });
  }
  if (files.length === 0) return;
  await updateDailyTrackingItems(
    subjectKey,
    options.date,
    files.sort((a, b) => a.path.localeCompare(b.path)),
  );
}

/** Revises the subject's reminder guideline from today's proactive replies
 * and clears the day's event deduplication records. */
async function dreamDailyProactive(subject: AnotherMeSubject): Promise<void> {
  const result = await dreamProactiveForSubject({
    tenantId: subject.tenantId,
    ownerActorId: subject.representedHumanActorId,
  });
  writeMemoryLog("memory_proactive_dreaming", {
    memory_subject_key: subject.memorySubjectKey,
    ...result,
  });
}

async function resolveDailySubjectOptions(
  options: CliOptions,
): Promise<DailyOptions[]> {
  const subjects = (await loadAnotherMeSubjects())
    .filter(
      (subject) =>
        !options.memorySubjectKey ||
        subject.memorySubjectKey === options.memorySubjectKey,
    )
    .sort((a, b) => a.memorySubjectKey.localeCompare(b.memorySubjectKey));
  if (options.memorySubjectKey && subjects.length === 0)
    throw new Error(
      "No AnotherMe memory subjects matched the supplied options",
    );
  return subjects.map((subject) => ({
    ...options,
    memorySubjectKey: subject.memorySubjectKey,
    subject,
  }));
}

async function ensureDailyCollection(
  options: DailyOptions,
): Promise<DailyCollection> {
  try {
    const collection = await readJsonFile<DailyCollection>(
      dailyCollectionPath(options),
    );
    if (
      collection.schemaVersion !== 4 ||
      collection.memorySubjectKey !== options.memorySubjectKey ||
      collection.date !== options.date
    )
      throw new Error(
        "Daily collection does not match the current Session evidence contract; collect again",
      );
    return collection;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return collectAndPersistDaily(options);
  }
}

/** Collects the day's evidence; `stage` first fetches today's Pocket Note
 * from TeamHub, which a benchmark without TeamHub skips. */
/** Collects and saves one day's Daily evidence; `stage` fetches today's Pocket Note first. */
export async function collectAndPersistDaily(
  options: DailyOptions,
  stage = true,
): Promise<DailyCollection> {
  const pocketNote = stage
    ? await stagePocketNote(options.memoryRoot, options.subject, options.date)
    : false;
  const collection = await collectDaily(options, pocketNote);
  await writeJsonFile(dailyCollectionPath(options), collection);
  return collection;
}

/**
 * The day's conversations as their Raw evidence, with the Human's own Pocket
 * Note when TeamHub had one today. Room chats have no Session page, so Daily
 * reads them directly and does not wait for the Wiki.
 */
async function collectDaily(
  options: DailyOptions,
  pocketNote: boolean,
): Promise<DailyCollection> {
  const { date, memoryRoot } = options;
  const memorySubjectKey = options.subject.memorySubjectKey;
  const sessionFiles: SessionSummaryFile[] = [];
  for (const file of await readSessionWikiPathsForDate(
    memoryRoot,
    memorySubjectKey,
    date,
  )) {
    const content = await fs.readFile(
      memoryFilePath(memoryRoot, memorySubjectKey, ...file.split("/").slice(1)),
      "utf8",
    );
    sessionFiles.push({
      path: wxy(content) ?? file,
      content: content.replace(/^Message metadata: .*\n?/gmu, ""),
    });
  }
  if (pocketNote)
    sessionFiles.push(
      await readPocketNoteFile(memoryRoot, memorySubjectKey, date),
    );
  return {
    schemaVersion: 4,
    date,
    timeZone: localTimeZone(),
    generatedAt: new Date().toISOString(),
    source: { memoryRoot },
    memorySubjectKey,
    sessionFiles,
    previousDailyFiles: await readPreviousDailyFiles(
      memoryRoot,
      memorySubjectKey,
      date,
    ),
    requiredOutputs: {
      dailyMemoryPath: `${memorySubjectKey}/timeline/daily/${date}.md`,
    },
  };
}

/** Where a Session's evidence opens in TeamHub: its Room or its transcript. */
function wxy(content: string): string | undefined {
  const sources = parseOkfFrontmatter(content).fields?.sources;
  const first: unknown = Array.isArray(sources) ? sources[0] : undefined;
  return first &&
    typeof first === "object" &&
    "resource" in first &&
    typeof first.resource === "string"
    ? first.resource
    : undefined;
}

async function readPocketNoteFile(
  memoryRoot: string,
  memorySubjectKey: string,
  date: string,
): Promise<SessionSummaryFile> {
  const filePath = memoryFilePath(
    memoryRoot,
    memorySubjectKey,
    ...pocketNoteSessionPath(date).split("/"),
  );
  return {
    // Cite the TeamHub page, like Session sources, not the local staging file.
    path: `teamhub://pocket-notes/${date}`,
    content: await fs.readFile(filePath, "utf8"),
  };
}

async function readPreviousDailyFiles(
  memoryRoot: string,
  memorySubjectKey: string,
  currentDate: string,
): Promise<SessionSummaryFile[]> {
  const filePath = memoryFilePath(
    memoryRoot,
    memorySubjectKey,
    "timeline",
    "daily",
    `${previousDate(currentDate)}.md`,
  );
  try {
    return [
      {
        path: logicalMemoryPath(memoryRoot, memorySubjectKey, filePath),
        content: await fs.readFile(filePath, "utf8"),
      },
    ];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [];
  }
}

async function writeDailyPrompt(
  options: DailyOptions,
  collection: DailyCollection,
  artifacts: PromptArtifacts,
): Promise<void> {
  const { prompt, schema } = await dailyPrompt(options, collection);
  await writeTextFile(artifacts.promptPath, prompt);
  await writeJsonFile(artifacts.schemaPath, schema);
}

/** The Daily prompt and output schema for one collected day. */
export async function dailyPrompt(
  options: DailyOptions,
  collection: DailyCollection,
): Promise<{ prompt: string; schema: Record<string, unknown> }> {
  const template = await fs.readFile(
    path.join(promptRoot, "sync", "daily", "daily-summary.md"),
    "utf8",
  );
  const sourceCatalog = dailySourceCatalog(collection.sessionFiles);
  const promptCollection = {
    schemaVersion: collection.schemaVersion,
    date: collection.date,
    timeZone: collection.timeZone,
    generatedAt: collection.generatedAt,
    source: collection.source,
    memorySubjectKey: collection.memorySubjectKey,
    representedHuman: {
      actorId: options.subject.representedHumanActorId,
      displayName: options.subject.representedHumanDisplayName,
    },
    previousDailyFiles: collection.previousDailyFiles.filter(({ path }) =>
      path.includes("/timeline/daily/"),
    ),
    sessionFiles: collection.sessionFiles.map((file) => {
      const source = sourceCatalog.find(
        (entry) => entry.resource === file.path,
      )!;
      return { source_ref: source.sourceRef, content: file.content };
    }),
  };
  const prompt = template
    .replaceAll("{{date}}", options.date)
    .replaceAll("{{timeZone}}", collection.timeZone)
    .replaceAll("{{historyDate}}", previousDate(options.date))
    .replaceAll(
      "{{collectionJson}}",
      JSON.stringify(promptCollection, null, 2),
    );
  return {
    prompt: `${prompt}\n\n## Deterministic Source References\n\nThe session inputs expose only \`source_ref\` values. Select the report's evidence only through \`source_refs\`; the supplied JSON Schema enumerates every allowed value. Do not write a Session path, a \`teamhub://rooms/...\` URI, or a source list yourself. In field text, cite a selected source only as \`[[source:<source_ref>]]\`. The caller validates those markers and renders the report file, its sources and its Markdown links.\n\n${renderSyncPolicyBoundary("daily")}\n`,
    schema: dailyReportSchema(sourceCatalog.map(({ sourceRef }) => sourceRef)),
  };
}

async function applyDailyOutput(
  options: CliOptions,
  collection: DailyCollection,
  outputPath: string,
): Promise<void> {
  await applyCheckedDaily(
    options,
    collection,
    await prepareDailyOutput(options, collection, outputPath),
  );
}

/** Writes a Daily that checkDailyReport accepted. */
export async function applyCheckedDaily(
  options: CliOptions,
  collection: DailyCollection,
  output: MemoryUpdateOutput,
): Promise<void> {
  await applyMemoryUpdate(
    options.memoryRoot,
    output,
    dailyApplyOptions(collection),
  );
}

async function prepareDailyOutput(
  options: CliOptions,
  collection: DailyCollection,
  outputPath: string,
): Promise<MemoryUpdateOutput> {
  return checkDailyReport(
    options,
    collection,
    await fs.readFile(outputPath, "utf8"),
  );
}

/** Parses, renders and validates one Daily report answer. */
export async function checkDailyReport(
  options: CliOptions,
  collection: DailyCollection,
  answer: string,
): Promise<MemoryUpdateOutput> {
  const catalog = dailySourceCatalog(collection.sessionFiles);
  const report = parseReportOutput<DailyReportOutput>(
    answer,
    dailyReportSchema(catalog.map(({ sourceRef }) => sourceRef)),
    "Daily",
  );
  const output: MemoryUpdateOutput = {
    schema_version: 1,
    date: collection.date,
    files: [
      {
        path: collection.requiredOutputs.dailyMemoryPath,
        content: renderDailyReport(report, {
          date: collection.date,
          memorySubjectKey: collection.memorySubjectKey,
          hasYesterdayBaseline: collection.previousDailyFiles.some(({ path }) =>
            path.includes("/timeline/daily/"),
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
  await validateMemoryUpdate(
    options.memoryRoot,
    output,
    dailyApplyOptions(collection),
  );
  return output;
}

export function dailySourceCatalog(
  sessionFiles: readonly SessionSummaryFile[],
): ReportSourceReference[] {
  const refs = new Set<string>();
  return sessionFiles.map((file) => {
    const fields = parseOkfFrontmatter(file.content).fields;
    const sourceRef =
      [
        fields?.room_id,
        fields?.capture_id,
        /^teamhub:\/\/rooms\/([^/]+)\/messages$/u.exec(file.path)?.[1],
      ].find(
        (value): value is string => typeof value === "string" && value !== "",
      ) ??
      (fields?.source_kind === "pocket_note"
        ? POCKET_NOTE_SESSION_ID
        : path.basename(file.path, path.extname(file.path)));
    if (refs.has(sourceRef)) {
      throw new Error(`Daily source_ref is not unique: ${sourceRef}`);
    }
    refs.add(sourceRef);
    return {
      resource: file.path.replaceAll("\\", "/"),
      sourceRef,
      title:
        typeof fields?.title === "string" && fields.title.trim() !== ""
          ? fields.title.trim()
          : sourceRef,
    };
  });
}

function dailyApplyOptions(collection: DailyCollection) {
  return {
    allowedSubjectKeys: [collection.memorySubjectKey],
    allowedPathPrefixes: memoryOutputPrefixes("daily", "write"),
    allowedDeletePathPrefixes: memoryOutputPrefixes("daily", "delete"),
  };
}

function dailyArtifacts(options: CliOptions): PromptArtifacts {
  const root = path.join(
    options.memoryRoot,
    "updates",
    "daily",
    options.date,
    options.memorySubjectKey ?? "unknown-subject",
  );
  return {
    promptPath: path.join(root, "daily.prompt.md"),
    schemaPath: path.join(root, "daily.schema.json"),
    outputPath: path.join(root, "daily.llm-output.json"),
  };
}

function dailyCollectionPath(options: CliOptions): string {
  return path.join(
    options.memoryRoot,
    "updates",
    "daily",
    options.date,
    options.memorySubjectKey ?? "unknown-subject",
    "collection.json",
  );
}
