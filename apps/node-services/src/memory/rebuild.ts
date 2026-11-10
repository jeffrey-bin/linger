import { teamHubFetch } from "./teamhub-transport.js";
import fs from "node:fs/promises";
import path from "node:path";
import { postTeamHubMemoryWikiRefresh } from "@linger/wire-contracts/teamhub-internal/client";
import type { components } from "@linger/wire-contracts/teamhub-internal/types";

import type { MemoryChunkIndex } from "./chunk-index.js";
import { loadAnotherMeSubjects } from "./collector.js";
import { memoryDatabase } from "./database.js";
import type { WikiIndex, WikiIndexCollection } from "./wiki-index.js";
import { markMemoryChanged } from "./fs-utils.js";
import { agentMemoryRoot, agentWorkspaceRoot } from "./paths.js";
import { queryRecordingCandidates } from "./recording-collector.js";
import { writeMemoryLog } from "./run-telemetry.js";
import type { MemoryRebuildStep, MemoryScheduledTask } from "./scheduler.js";
import { queryRoomActivity } from "./session-triggers.js";
import {
  teamHubWikiAccess,
  waitForCurrentPublishedWiki,
  type TeamHubWikiAccess,
} from "./teamhub-wiki.js";
import type { AnotherMeSubject } from "./types.js";

export type RebuildSubject = Pick<
  AnotherMeSubject,
  | "tenantId"
  | "agentActorId"
  | "agentManagementId"
  | "memorySubjectKey"
  | "representedHumanActorId"
>;

/** Session dates come from the same TeamHub evidence the Wiki task collects:
 * Room conversation days and finalized recording transcripts, both on
 * local business dates, for Rooms the Human or its Another Me belongs to. */
export async function discoverRebuildSessionDates(
  subject: RebuildSubject,
): Promise<string[]> {
  const sql = memoryDatabase();
  const since = new Date(0).toISOString();
  const rooms = await queryRoomActivity(sql, subject, since);
  const recordings = await queryRecordingCandidates(sql, subject, since);
  return [
    ...new Set([...rooms, ...recordings].map((item) => item.date)),
  ].sort();
}

/** Held subjects skip automatic indexing; resolving an owner costs nothing
 * while no rebuild is pending. */
export async function rebuildHoldsOwner(
  holds: ReadonlySet<string>,
  ownerActorId: string,
  loadSubjects: () => Promise<RebuildSubject[]> = loadAnotherMeSubjects,
): Promise<boolean> {
  if (!holds.size) return false;
  return (await loadSubjects()).some(
    (subject) =>
      subject.representedHumanActorId === ownerActorId &&
      holds.has(subject.memorySubjectKey),
  );
}

export interface RebuildStepDependencies {
  raw?: Pick<MemoryChunkIndex, "syncAgent">;
  wiki?: Pick<WikiIndex, "indexOwner">;
  access?: TeamHubWikiAccess;
  loadSubjects?: () => Promise<RebuildSubject[]>;
  pollMs?: number;
}

/** Runs the rebuild's own steps; Session/Daily/Weekly use the calendar task. */
export async function runRebuildStep(
  input: Extract<MemoryScheduledTask, { task: MemoryRebuildStep }>,
  dependencies: RebuildStepDependencies,
): Promise<void> {
  const subjects = (
    await (dependencies.loadSubjects ?? loadAnotherMeSubjects)()
  ).filter((subject) => subject.memorySubjectKey === input.memorySubjectKey);
  if (subjects.length !== 1)
    throw new Error("Rebuild subject is missing or ambiguous");
  const subject = subjects[0]!;
  const access = dependencies.access ?? teamHubWikiAccess();
  if (input.task === "init") {
    await initRebuildWiki(subject, access, input.date, dependencies.pollMs);
    return;
  }
  const collections: WikiIndexCollection[] =
    input.task === "index-initial" ? ["wiki"] : ["wiki", "daily", "weekly"];
  await Promise.all([
    dependencies.raw?.syncAgent(subject.agentManagementId),
    dependencies.wiki?.indexOwner(subject, collections),
  ]);
}

/** One Wiki refresh over the Human's current sources: My Pages, Connected
 * App files and the Sessions the index already holds; then the same
 * publication wait as the calendar, repeated until TeamHub confirms the
 * current source snapshot. */
async function initRebuildWiki(
  subject: RebuildSubject,
  access: TeamHubWikiAccess,
  date: string,
  pollMs?: number,
): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    const response = await postTeamHubMemoryWikiRefresh({
      actorId: subject.representedHumanActorId,
      baseUrl: access.baseUrl,
      body: { date, tenant_id: subject.tenantId },
      fetch: teamHubFetch(access.fetch),
      serviceToken: access.token,
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok)
      throw new Error(
        `Rebuild Wiki init refresh failed with HTTP ${response.status}`,
      );
    const result =
      (await response.json()) as components["schemas"]["MemoryWikiRefreshResponse"];
    writeMemoryLog("memory_rebuild_wiki_init", {
      memory_subject_key: subject.memorySubjectKey,
      refresh_status: result.refresh_status,
    });
    if (["already_latest", "no_sources"].includes(result.refresh_status))
      return;
    await waitForCurrentPublishedWiki(access, subject.representedHumanActorId, {
      ...(pollMs === undefined ? {} : { pollMs }),
    });
  }
  throw new Error("Rebuild Wiki init did not reach already_latest");
}

// Locks are shared service state, not subject evidence.
const SHARED_UPDATE_KINDS = new Set(["chunk-agent-locks"]);

/** Moves one subject's derived Memory state aside so a rebuild re-reads raw
 * sources: Session checkpoints, Daily/Weekly files and per-date artifacts
 * would otherwise make every replayed date look already processed. */
export async function archiveMemorySubjectState(
  dataRoot: string,
  subjectKey: string,
  now = new Date(),
): Promise<string> {
  const archive = path.join(
    agentWorkspaceRoot(dataRoot, subjectKey),
    `memory.pre-rebuild-${now.toISOString().replace(/[:.]/gu, "-")}`,
  );
  await move(agentMemoryRoot(dataRoot, subjectKey), archive);
  await move(
    path.join(agentWorkspaceRoot(dataRoot, subjectKey), "memory-state"),
    path.join(archive, ".state"),
  );
  const updates = path.join(dataRoot, "updates");
  const visit = async (directory: string, depth: number): Promise<void> => {
    for (const entry of await entries(directory)) {
      const source = path.join(directory, entry.name);
      if (entry.name === subjectKey || entry.name === `${subjectKey}.json`) {
        await move(
          source,
          path.join(archive, ".updates", path.relative(updates, source)),
        );
      } else if (
        entry.isDirectory() &&
        depth < 3 &&
        !(depth === 0 && SHARED_UPDATE_KINDS.has(entry.name))
      )
        await visit(source, depth + 1);
    }
  };
  await visit(updates, 0);
  await markMemoryChanged(dataRoot, subjectKey);
  return archive;
}

async function entries(directory: string) {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function move(source: string, target: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.rename(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
