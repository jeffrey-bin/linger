import { loadWikiGraphSubjectsForActor } from "../collector.js";
import { withDirectoryLock } from "../filesystem-lock.js";
import { markMemoryChanged, readJsonFile, writeJsonFile } from "../fs-utils.js";
import { buildWikiGraph, type StoredWikiGraph } from "../graph/build.js";
import { entityNamePatterns } from "../graph/inferred-edges.js";
import { indexedWikiRevision, readIndexedWiki } from "../wiki-index.js";
import { agentWorkspaceRoot, memoryFilePath } from "../paths.js";
import { writeMemoryLog } from "../run-telemetry.js";
import type {
  Flashback,
  FlashbackRecordRequest,
  FlashbackRequest,
  FlashbackResponse,
} from "../../flashback.js";
import { dailyReport, type DailyReport } from "./card.js";
import { indexedDailyRevision, readIndexedDailies } from "./dailies.js";
import {
  suggestFlashback,
  type FlashbackRecord,
  type FlashbackSettings,
} from "./suggest.js";

const HISTORY_FILE = "flashback-history.json";
const HISTORY_DAYS = 30;
const SUBJECT_TTL_MS = 5 * 60_000;

/**
 * Serves flashback suggestions for one represented Human. The graph is built
 * from the indexed published Wiki and the Daily reports are read from the
 * index, and both are cached until the index holds another revision of
 * either; the Human's Another Me is cached for a few minutes. A call is two
 * revision reads plus in-memory name matching and scoring. Suggesting is
 * read-only; the Agent records a flashback it used under the Another Me's
 * workspace lock, so the budgets hold across calls.
 */
export class FlashbackService implements Flashback {
  readonly #subjects = new Map<
    string,
    { at: number; key?: { agentId: string; subjectKey: string } }
  >();
  readonly #graphs = new Map<
    string,
    {
      revision: string;
      graph: StoredWikiGraph;
      aliases: Map<string, string[]>;
      dailies: DailyReport[];
    }
  >();

  constructor(
    private readonly dataRoot: string,
    private readonly options: {
      loadSubjects?: typeof loadWikiGraphSubjectsForActor;
      readWiki?: typeof readIndexedWiki;
      readRevision?: (
        tenantId: string,
        ownerActorId: string,
      ) => Promise<string | undefined>;
      readDailies?: typeof readIndexedDailies;
      readDailyRevision?: (
        tenantId: string,
        ownerActorId: string,
      ) => Promise<string | undefined>;
      settings?: FlashbackSettings;
      now?: () => Date;
    } = {},
  ) {}

  async suggest(request: FlashbackRequest): Promise<FlashbackResponse> {
    const started = performance.now();
    const response = await this.#suggest(request);
    writeMemoryLog("memory_flashback_suggest", {
      reason: response.reason,
      ...(response.suggestion
        ? { via: response.suggestion.cue.via, score: response.suggestion.score }
        : {}),
      duration_ms: Math.round(performance.now() - started),
    });
    return response;
  }

  async #suggest(request: FlashbackRequest): Promise<FlashbackResponse> {
    const subject = await this.#subject(
      request.tenant_id,
      request.owner_actor_id,
    );
    if (!subject) return { reason: "no_graph" };
    const loaded = await this.#graph(request.tenant_id, request.owner_actor_id);
    if (!loaded) return { reason: "no_graph" };
    const history = await readJsonFile<FlashbackRecord[]>(
      memoryFilePath(this.dataRoot, subject.subjectKey, HISTORY_FILE),
    ).catch(() => []);
    const result = suggestFlashback({
      graph: loaded.graph,
      aliases: loaded.aliases,
      dailies: loaded.dailies,
      text: request.text,
      roomId: request.room_id,
      now: this.options.now?.() ?? new Date(),
      history,
      settings: this.options.settings,
    });
    if (!result.suggestion) return { reason: result.reason };
    return {
      reason: result.reason,
      suggestion: {
        ...result.suggestion,
        ...(loaded.graph.wikiRevision
          ? { wikiRevision: loaded.graph.wikiRevision }
          : {}),
      },
    };
  }

  /**
   * Counts a flashback against the budgets once the Agent has actually used
   * it; a suggestion that arrived too late or was dropped costs nothing.
   */
  async record(request: FlashbackRecordRequest): Promise<void> {
    const subject = await this.#subject(
      request.tenant_id,
      request.owner_actor_id,
    );
    if (!subject) return;
    const now = this.options.now?.() ?? new Date();
    const historyPath = memoryFilePath(
      this.dataRoot,
      subject.subjectKey,
      HISTORY_FILE,
    );
    await withDirectoryLock(
      agentWorkspaceRoot(this.dataRoot, subject.agentId),
      async () => {
        const history = await readJsonFile<FlashbackRecord[]>(
          historyPath,
        ).catch(() => []);
        const cutoff = now.getTime() - HISTORY_DAYS * 86_400_000;
        // The history sits in the Agent's memory directory.
        await writeJsonFile(historyPath, [
          ...history.filter((record) => Date.parse(record.at) >= cutoff),
          {
            episode: request.episode,
            cue: request.cue_id,
            ...(request.room_id ? { roomId: request.room_id } : {}),
            at: now.toISOString(),
          },
        ]);
        await markMemoryChanged(this.dataRoot, subject.subjectKey);
      },
    );
    writeMemoryLog("memory_flashback_recorded", { episode: request.episode });
  }

  async #subject(tenantId: string, ownerActorId: string) {
    const cacheKey = `${tenantId}\n${ownerActorId}`;
    const cached = this.#subjects.get(cacheKey);
    if (cached && Date.now() - cached.at < SUBJECT_TTL_MS) return cached.key;
    const subject = (
      await (this.options.loadSubjects ?? loadWikiGraphSubjectsForActor)(
        ownerActorId,
      )
    ).find((candidate) => candidate.tenantId === tenantId);
    const key = subject
      ? {
          agentId: subject.agentManagementId,
          subjectKey: subject.memorySubjectKey,
        }
      : undefined;
    this.#subjects.set(cacheKey, { at: Date.now(), key });
    return key;
  }

  async #graph(tenantId: string, ownerActorId: string) {
    const cacheKey = `${tenantId}\n${ownerActorId}`;
    const cached = this.#graphs.get(cacheKey);
    const [wikiRevision, dailyRevision] = await Promise.all([
      (this.options.readRevision ?? indexedWikiRevision)(
        tenantId,
        ownerActorId,
      ),
      (this.options.readDailyRevision ?? indexedDailyRevision)(
        tenantId,
        ownerActorId,
      ),
    ]);
    if (!wikiRevision) return undefined;
    if (cached?.revision === `${wikiRevision}\n${dailyRevision ?? ""}`)
      return cached;
    const [wiki, dailies] = await Promise.all([
      (this.options.readWiki ?? readIndexedWiki)(tenantId, ownerActorId),
      (this.options.readDailies ?? readIndexedDailies)(tenantId, ownerActorId),
    ]);
    if (!wiki.revision || !wiki.pages.length) return undefined;
    const { graph, aliases } = buildWikiGraph(wiki.pages, wiki.revision);
    const names = entityNamePatterns(graph.nodes, aliases);
    const loaded = {
      revision: `${wiki.revision}\n${dailies.revision ?? ""}`,
      graph,
      aliases,
      dailies: dailies.reports.map((report) => dailyReport(report, names)),
    };
    this.#graphs.set(cacheKey, loaded);
    return loaded;
  }
}
