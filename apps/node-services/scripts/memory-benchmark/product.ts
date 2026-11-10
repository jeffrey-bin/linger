// The product boundary of the benchmark: the only file besides knowledge.ts
// that calls Memory and LLM Wiki code. Everything else (data, Room-day
// shaping, answering, judging, reports) stays the same when the Memory/Wiki
// pipeline is rewritten; adapt this file to the new pipeline instead.
//
// Stages, as the Memory role and the Wiki service run them:
// - Daytime: the Session staging step for every Room-day, the Raw chunk index
//   and the Session facts extracted from it.
// - Nightly, one dataset day after another: a Wiki update from that day's
//   Room-days (AgentWikiBackend), then the day read, which writes memory.md
//   and the Daily from the day's raw conversations.
// - Publication: the final Wiki pages and the Dailies are indexed beside the
//   Raw, as TeamHub's publication job and the report index do.
// - Questions: the Memory query and evidence-read handlers the Agent's
//   `teamhub knowledge search/read` reach, and memory.md as the Another Me's
//   instructions carry it.
// Weekly and Tracking Items do not run: neither feeds these answers' search.
// lifecycle.ts runs every stage on a small history instead.
import fs from "node:fs/promises";
import path from "node:path";

import type { AgentUserMemory } from "../../src/agent/executor/types.js";
import type { WikiInput } from "../../src/llm-wiki/backend.js";
import { renderSessionSource } from "../../src/llm-wiki/wiki-session-source.js";
import { collectAndPersistDaily } from "../../src/memory/daily-cli.js";
import { runDayRead } from "../../src/memory/day-read.js";
import { agentMemoryRoot, agentWorkspaceRoot } from "../../src/memory/paths.js";
import { ensureMemoryScaffold } from "../../src/memory/scaffold.js";
import {
  listRawSourcesForAgent,
  sessionSourceText,
} from "../../src/memory/search/source-store.js";
import { stageSessionRawForWiki } from "../../src/memory/sync-runners.js";
import {
  renderUserMemory,
  type UserMemoryRevision,
  type UserMemoryStore,
} from "../../src/memory/user-memory.js";
import type { ModelCall } from "../../src/runtime-model-call.js";
import { type Corpus, sha256 } from "./datasets.js";
import {
  indexReports,
  indexWikiPages,
  type Knowledge,
  openMemoryWorkspace,
  readPages,
  readReports,
  type Scope,
  step,
  type StepResult,
} from "./knowledge.js";
import {
  anotherMeSubject,
  corpusScope,
  sessionCollection,
} from "./sessions.js";

interface NightRecord {
  date: string;
  room_days: number;
  wiki: StepResult;
  day_read: StepResult;
  wiki_pages: number;
  memory_version: number;
}

export interface PreparedCorpus {
  scope: Scope;
  /** The same Human's Wiki pages and Dailies alone, for the `wiki` arm. */
  wiki_scope: Scope;
  corpus_id: string;
  stages: string[];
  raw_sources: number;
  indexed_chunks: number;
  facts: unknown;
  nights: number;
  failed_wiki_nights: number;
  failed_day_reads: number;
  wiki_pages: number;
  searchable_wiki_pages: number;
  dailies: number;
  /** memory.md after the last night, as the Another Me receives it. */
  memory: AgentUserMemory;
  seconds: number;
}

export interface Product extends Knowledge {
  /** Stages a corpus's history; repeated calls reuse the stored result. */
  prepare(corpus: Corpus): Promise<PreparedCorpus>;
  close(): Promise<void>;
}

const DAYTIME_STAGES = ["room_raw", "raw_index", "session_facts"];
const NIGHTLY_STAGES = ["nightly_wiki", "day_read", "wiki_daily_index"];

/** What `prepare` builds; the run manifest records it. */
export function productStages(nightly: boolean): string[] {
  return nightly ? [...DAYTIME_STAGES, ...NIGHTLY_STAGES] : DAYTIME_STAGES;
}

/**
 * Memory over one isolated data root and a disposable PostgreSQL database
 * that TeamHub's migrations created. Model calls go to `modelCall`. Without
 * `nightly`, only the daytime stages run.
 */
export async function openProduct(options: {
  dataRoot: string;
  databaseUrl: string;
  modelCall: ModelCall;
  nightly: boolean;
  /** Histories whose nightly replay runs at the same time. */
  nightlyConcurrency: number;
}): Promise<Product> {
  const { dataRoot } = options;
  const workspace = await openMemoryWorkspace(options);
  const { index, facts, wikiBackend } = workspace;
  const receipts = path.join(dataRoot, "prepared");
  const preparing = new Map<string, Promise<PreparedCorpus>>();
  // One corpus at a time stages its Room-days: staging writes the shared
  // data root. Nightly replays have their own Another Me and run in parallel.
  let daytime: Promise<unknown> = Promise.resolve();
  const nightlySlots = limiter(options.nightlyConcurrency);

  async function stageDaytime(corpus: Corpus) {
    const scope = corpusScope(dataRoot, corpus);
    await ensureMemoryScaffold(dataRoot, [anotherMeSubject(scope, corpus)]);
    let staged = 0;
    for (const [position, session] of corpus.sessions.entries()) {
      if (!session.turns.length) continue;
      const collection = sessionCollection(scope, corpus, position);
      await stageSessionRawForWiki(
        {
          date: collection.date,
          memoryRoot: dataRoot,
          memorySubjectKey: scope.agent_id,
          concurrency: 1,
        },
        collection,
      );
      staged += 1;
    }
    const sources = await listRawSourcesForAgent(
      agentWorkspaceRoot(dataRoot, scope.agent_id),
      scope.agent_id,
    );
    // Two sessions of one Room-day share a source; the dataset has none.
    if (sources.length !== staged)
      throw new Error(
        `Staged ${staged} Room-days but found ${sources.length} Raw sources`,
      );
    const indexed = await index.syncAgent(scope.agent_id);
    const extracted = await facts.syncAgent(scope.agent_id);
    return {
      raw_sources: sources.length,
      indexed_chunks: indexed.indexed,
      facts: extracted,
    };
  }

  async function prepareOnce(corpus: Corpus): Promise<PreparedCorpus> {
    const receipt = path.join(receipts, `${corpus.id}.json`);
    const stored = await fs.readFile(receipt, "utf8").catch(() => undefined);
    if (stored) return JSON.parse(stored) as PreparedCorpus;
    const started = performance.now();
    const scope = corpusScope(dataRoot, corpus);
    const wikiScope = { ...scope, agent_id: `${scope.agent_id}_wiki` };
    const day = daytime.then(() => stageDaytime(corpus));
    daytime = day.catch(() => undefined);
    const daytimeResult = await day;
    const night = options.nightly
      ? await nightlySlots(() =>
          replayNights(corpus, scope, wikiScope, receipt),
        )
      : undefined;
    const result: PreparedCorpus = {
      scope,
      wiki_scope: wikiScope,
      corpus_id: corpus.id,
      stages: productStages(options.nightly),
      ...daytimeResult,
      nights: night?.nights.length ?? 0,
      failed_wiki_nights:
        night?.nights.filter((record) => !record.wiki.ok).length ?? 0,
      failed_day_reads:
        night?.nights.filter((record) => !record.day_read.ok).length ?? 0,
      wiki_pages: night?.pages ?? 0,
      searchable_wiki_pages: night?.searchablePages ?? 0,
      dailies: night?.dailies ?? 0,
      memory: night?.memory ?? { version: 0, markdown: "" },
      seconds: (performance.now() - started) / 1000,
    };
    await fs.mkdir(receipts, { recursive: true });
    await fs.writeFile(`${receipt}.tmp`, JSON.stringify(result, null, 2));
    await fs.rename(`${receipt}.tmp`, receipt);
    return result;
  }

  /**
   * Replays the history night by night. Each finished night is checkpointed
   * under `<receipt>.nightly/`, so an interrupted run resumes at the next one.
   */
  async function replayNights(
    corpus: Corpus,
    scope: Scope,
    wikiScope: Scope,
    receipt: string,
  ) {
    const work = `${receipt.slice(0, -".json".length)}.nightly`;
    await fs.mkdir(work, { recursive: true });
    const subject = anotherMeSubject(scope, corpus);
    const checkpoint = path.join(work, "checkpoint.json");
    const state: {
      nights: NightRecord[];
      revisions: UserMemoryRevision[];
      pageDates: Record<string, string>;
    } = await fs
      .readFile(checkpoint, "utf8")
      .then((text) => JSON.parse(text) as typeof state)
      .catch(() => ({ nights: [], revisions: [], pageDates: {} }));
    const memoryStore = inMemoryUserMemoryStore(state.revisions);

    const byDate = new Map<string, number[]>();
    for (const [position, session] of corpus.sessions.entries()) {
      if (!session.turns.length) continue;
      const { date } = sessionCollection(scope, corpus, position);
      byDate.set(date, [...(byDate.get(date) ?? []), position]);
    }
    const dates = [...byDate.keys()].sort();
    let wiki = state.nights.length
      ? path.join(work, `wiki-${state.nights.at(-1)!.date}`)
      : path.join(work, "wiki-empty");
    await fs.mkdir(wiki, { recursive: true });

    for (const date of dates) {
      if (state.nights.some((night) => night.date === date)) continue;
      const inputs = path.join(work, "inputs");
      await fs.rm(inputs, { recursive: true, force: true });
      const added: WikiInput[] = [];
      for (const sessionPosition of byDate.get(date)!) {
        const collection = sessionCollection(scope, corpus, sessionPosition);
        const room = collection.rooms[0]!;
        const { markdown, routing } = renderSessionSource(
          room.roomName,
          sessionSourceText(collection),
          {
            kind: "room",
            date,
            sessionId: room.roomId,
            roomId: room.roomId,
            representedHumanActorId: subject.representedHumanActorId,
            representedHumanDisplayName: subject.representedHumanDisplayName,
          },
        );
        await fs.mkdir(path.join(inputs, room.roomId), { recursive: true });
        await fs.writeFile(
          path.join(inputs, room.roomId, "document.md"),
          markdown,
        );
        added.push({
          assetKey: room.roomId,
          contentPath: `${room.roomId}/document.md`,
          contentSha256: sha256(markdown),
          sourceUrl: `document://${room.roomId}/versions/${date}`,
          title: room.roomName,
          session: routing,
        });
      }
      const next = path.join(work, `wiki-${date}`);
      const mode = (await readPages(wiki)).length ? "update" : "initialize";
      const wikiStep = await step(async () => {
        await fs.rm(next, { recursive: true, force: true });
        await wikiBackend.generate({
          changes: { added, modified: [], removed: [] },
          generator: {
            tenantId: scope.tenant_id,
            agentActorId: scope.agent_actor_id,
          },
          existingOutputDirectory: wiki,
          inputsDirectory: inputs,
          mode,
          outputDirectory: next,
          generationId: `night-${date}`,
        });
      });
      // A failed refresh keeps the previous publication.
      if (!wikiStep.ok) {
        await fs.rm(next, { recursive: true, force: true });
        await fs.cp(wiki, next, { recursive: true });
      }
      const pages = await readPages(next);
      for (const page of pages) {
        const previous = path.join(wiki, page.key);
        const before = await fs.readFile(previous, "utf8").catch(() => null);
        if (before !== page.content) state.pageDates[page.key] = date;
      }
      const previousWiki = wiki;
      wiki = next;

      const dailyOptions = {
        date,
        memoryRoot: dataRoot,
        memorySubjectKey: scope.agent_id,
        concurrency: 1,
        subject,
      };
      const dayRead = await step(async () => {
        const collection = await collectAndPersistDaily(dailyOptions, false);
        await runDayRead(dailyOptions, collection, memoryStore);
      });
      state.nights.push({
        date,
        room_days: added.length,
        wiki: wikiStep,
        day_read: dayRead,
        wiki_pages: pages.length,
        memory_version: state.revisions.length,
      });
      await fs.writeFile(`${checkpoint}.tmp`, JSON.stringify(state));
      await fs.rename(`${checkpoint}.tmp`, checkpoint);
      // Only the checkpointed night's Wiki is needed to resume.
      await fs.rm(previousWiki, { recursive: true, force: true });
      await fs.rm(inputs, { recursive: true, force: true });
      console.log(
        `  ${corpus.id.slice(0, 8)} night ${state.nights.length}/${dates.length} ${date}: wiki ${wikiStep.ok ? "ok" : "FAILED"} ${Math.round(wikiStep.seconds)} s, day read ${dayRead.ok ? "ok" : "FAILED"} ${Math.round(dayRead.seconds)} s, ${pages.length} pages`,
      );
    }

    const pages = await readPages(wiki);
    const dailies = await readReports(
      path.join(agentMemoryRoot(dataRoot, scope.agent_id), "timeline/daily"),
    );
    let searchablePages = 0;
    for (const target of [scope, wikiScope]) {
      searchablePages = await indexWikiPages(
        index,
        target,
        pages,
        (key) => `${state.pageDates[key] ?? dates.at(-1)}T23:00:00+08:00`,
      );
      await indexReports(index, target, "daily", dailies);
    }
    const latest = state.revisions.at(-1);
    return {
      nights: state.nights,
      pages: pages.length,
      searchablePages,
      dailies: dailies.length,
      memory: {
        version: latest?.version ?? 0,
        markdown: latest ? renderUserMemory(latest.sections) : "",
      },
    };
  }

  return {
    prepare(corpus) {
      let work = preparing.get(corpus.id);
      if (!work) {
        work = prepareOnce(corpus);
        preparing.set(corpus.id, work);
      }
      return work;
    },
    search: workspace.search,
    read: workspace.read,
    async close() {
      await Promise.allSettled(preparing.values());
      await workspace.close();
    },
  };
}

/** TeamHub's memory.md revisions, kept in `revisions`. */
export function inMemoryUserMemoryStore(
  revisions: UserMemoryRevision[],
): UserMemoryStore {
  return {
    latest: async () => revisions.at(-1) ?? null,
    save: async (_owner, _base, next) => {
      const revision: UserMemoryRevision = {
        version: revisions.length + 1,
        sections: next.sections,
        baseProfileRevisionId: next.baseProfileRevisionId,
      };
      revisions.push(revision);
      return revision;
    },
  };
}

/** Runs at most `slots` tasks at a time. */
function limiter(slots: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= slots)
      await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}
