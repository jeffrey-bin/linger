import { teamHubFetch } from "./teamhub-transport.js";
import path from "node:path";
import { postTeamHubMemoryWikiRefresh } from "@linger/wire-contracts/teamhub-internal/client";
import type { components } from "@linger/wire-contracts/teamhub-internal/types";
import { isMainModule } from "../paths.js";
import { loadAnotherMeSubjects } from "./collector.js";
import { closeMemoryDatabase, memoryDatabaseConfigured } from "./database.js";
import { assertDateString } from "./date.js";
import { readJsonFile, walkFiles, writeJsonFile } from "./fs-utils.js";
import { parseOptions, type CliOptions } from "./options.js";
import { writeMemoryLog } from "./run-telemetry.js";
import {
  teamHubWikiAccess,
  waitForCurrentPublishedWiki,
} from "./teamhub-wiki.js";
import type { AnotherMeSubject, SessionlyCollection } from "./types.js";
import { createMemoryChunkIndexFromEnvironment } from "./chunk-index.js";

type WikiRefreshResponse = components["schemas"]["MemoryWikiRefreshResponse"];

// A meeting is not admitted while another refresh runs. It is sent again
// after that refresh finishes, a few times; past that the night's refresh
// takes it in.
const MEETING_RESENDS = 3;

export interface WikiSyncResult {
  agent_id: string;
  actor_id: string;
  memory_subject_key: string;
  refresh_id?: string;
  refresh_status: string;
  wiki_id: string;
}

export interface WikiSyncRuntime {
  /** Waits until the actor's running Wiki refresh has finished. */
  waitForRunningRefresh?: (actorId: string) => Promise<unknown>;
  /**
   * Indexes the subject's staged Session Raw. The Wiki reads its Sessions
   * from the Memory index, so a Session joins the refresh only once indexed.
   */
  indexSessionRaw?: (agentId: string) => Promise<unknown>;
  /** Rebuild runs of different subjects may share a date; each keeps its own
   * receipt under the subject so the calendar's per-date file is untouched. */
  subjectResult?: boolean;
}

if (isMainModule(import.meta.url)) {
  runWikiSyncCliFromEnvironment(process.argv.slice(2)).catch(
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}

async function runWikiSyncCliFromEnvironment(argv: string[]): Promise<void> {
  const { options } = parseWikiSyncOptions(argv);
  // Without a database only the refresh request is sent; TeamHub reads the
  // Sessions some other run indexed.
  const chunkIndex = memoryDatabaseConfigured()
    ? createMemoryChunkIndexFromEnvironment(options.memoryRoot)
    : undefined;
  try {
    await runWikiSyncCli(argv, {
      indexSessionRaw: chunkIndex
        ? (agentId) => chunkIndex.syncRawSources(agentId)
        : undefined,
    });
  } finally {
    await chunkIndex?.close();
    await closeMemoryDatabase();
  }
}

/**
 * Indexes each subject's staged Session Raw and, unless `--index-only`, asks
 * TeamHub to refresh the subject's Wiki over it. TeamHub reads the Sessions
 * from the index; no Session content is sent. Only a meeting (`--capture-id`,
 * which admits only that recording's Sessions) and the run that closes a day
 * ask for a refresh.
 */
export async function runWikiSyncCli(
  argv: string[],
  runtime: WikiSyncRuntime = {},
): Promise<WikiSyncResult[]> {
  const { dates, options, indexOnly, captureId } = parseWikiSyncOptions(argv);
  const access = teamHubWikiAccess();
  const waitForRunningRefresh =
    runtime.waitForRunningRefresh ??
    ((actorId: string) =>
      waitForCurrentPublishedWiki(access, actorId, { until: "idle" }));
  const subjects = await readSessionlySubjects(options, dates);
  const results: WikiSyncResult[] = [];

  for (const subject of subjects) {
    await runtime.indexSessionRaw?.(subject.agentManagementId);
    if (indexOnly) continue;
    const request = {
      actorId: subject.representedHumanActorId,
      date: options.date,
      tenantId: subject.tenantId,
      ...(captureId ? { captureId } : {}),
    };
    let refresh = await requestRefresh(access, request);
    for (
      let resend = 0;
      captureId && refresh.refresh_status === "in_progress";
      resend += 1
    ) {
      if (resend === MEETING_RESENDS) {
        writeMemoryLog(
          "memory_meeting_wiki_refresh_skipped",
          {
            memory_subject_key: subject.memorySubjectKey,
            capture_id: captureId,
            refresh_id: refresh.refresh_id,
          },
          "ERROR",
        );
        break;
      }
      await waitForRunningRefresh(subject.representedHumanActorId);
      refresh = await requestRefresh(access, request);
    }
    results.push({
      agent_id: subject.agentManagementId,
      actor_id: subject.representedHumanActorId,
      memory_subject_key: subject.memorySubjectKey,
      ...(refresh.refresh_id ? { refresh_id: refresh.refresh_id } : {}),
      refresh_status: refresh.refresh_status,
      wiki_id: refresh.wiki_id,
    });
  }

  const resultPath = path.join(
    options.memoryRoot,
    "updates",
    "wiki-sync",
    options.date,
    ...(runtime.subjectResult && options.memorySubjectKey
      ? [options.memorySubjectKey]
      : []),
    "result.json",
  );
  await writeJsonFile(resultPath, {
    date: options.date,
    generated_at: new Date().toISOString(),
    source_dates: dates,
    results,
  });
  console.log(
    `Requested ${results.length} Wiki refresh(es) for Sessions of ${dates.length} date(s): ${resultPath}`,
  );
  return results;
}

function parseWikiSyncOptions(argv: string[]): {
  dates: string[];
  options: CliOptions;
  indexOnly: boolean;
  captureId?: string;
} {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const remaining: string[] = [];
  const requestedDates: string[] = [];
  let indexOnly = false;
  let captureId: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--index-only") {
      indexOnly = true;
      continue;
    }
    if (args[index] === "--capture-id" && args[index + 1]) {
      captureId = args[index + 1]!;
      index += 1;
      continue;
    }
    if (args[index] === "--date" && args[index + 1]) {
      requestedDates.push(args[index + 1]!);
      index += 1;
      continue;
    }
    remaining.push(args[index]!);
  }
  const parsed = parseOptions(remaining);
  const dates = [
    ...new Set(requestedDates.length > 0 ? requestedDates : [parsed.date]),
  ].sort();
  const validDates = dates.map(assertDateString);
  const latestDate = validDates.at(-1);
  if (!latestDate) throw new Error("At least one Wiki source date is required");
  return {
    dates: validDates,
    options: { ...parsed, date: latestDate },
    indexOnly,
    ...(captureId ? { captureId } : {}),
  };
}

async function readSessionlySubjects(
  options: CliOptions,
  dates: readonly string[],
): Promise<AnotherMeSubject[]> {
  const subjects = new Map<string, AnotherMeSubject>();
  for (const date of dates) {
    const root = path.join(options.memoryRoot, "updates", "sessionly", date);
    for await (const filePath of walkFiles(root)) {
      if (path.basename(filePath) !== "collection.json") continue;
      const collection = await readJsonFile<SessionlyCollection>(filePath);
      if (
        !Array.isArray(collection.subjects) ||
        !Array.isArray(collection.rooms)
      ) {
        continue;
      }
      for (const subject of collection.subjects) {
        if (
          options.memorySubjectKey &&
          subject.memorySubjectKey !== options.memorySubjectKey
        ) {
          continue;
        }
        subjects.set(subject.memorySubjectKey, subject);
      }
    }
  }
  if (subjects.size === 0) {
    for (const subject of await loadAnotherMeSubjects()) {
      if (
        !options.memorySubjectKey ||
        subject.memorySubjectKey === options.memorySubjectKey
      ) {
        subjects.set(subject.memorySubjectKey, subject);
      }
    }
  }
  if (subjects.size === 0) {
    throw new Error(
      `No AnotherMe memory subjects matched Wiki source dates ${dates.join(", ")}`,
    );
  }
  return [...subjects.values()].sort((left, right) =>
    left.memorySubjectKey.localeCompare(right.memorySubjectKey),
  );
}

async function requestRefresh(
  access: ReturnType<typeof teamHubWikiAccess>,
  input: {
    actorId: string;
    date: string;
    tenantId: string;
    captureId?: string;
  },
): Promise<WikiRefreshResponse> {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await postTeamHubMemoryWikiRefresh({
      actorId: input.actorId,
      baseUrl: access.baseUrl,
      body: {
        date: input.date,
        tenant_id: input.tenantId,
        ...(input.captureId ? { capture_id: input.captureId } : {}),
      },
      fetch: teamHubFetch(access.fetch),
      serviceToken: access.token,
      signal: AbortSignal.timeout(120_000),
    });
    if (response.ok) {
      return (await response.json()) as WikiRefreshResponse;
    }
    if (
      attempt === 4 ||
      ![408, 429, 500, 502, 503, 504].includes(response.status)
    ) {
      throw new Error(
        `Memory Wiki refresh request failed with HTTP ${response.status}`,
      );
    }
    // TeamHub can exhaust its short transaction retries while Memory indexes
    // the same Sessions. The request is idempotent for the same Session set,
    // so retry it after that writer commits.
    await new Promise((resolve) => setTimeout(resolve, attempt * 250));
  }
  throw new Error("Memory Wiki refresh request exhausted retries");
}
