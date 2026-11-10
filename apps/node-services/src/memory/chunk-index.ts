import { ChunkSyncCoordinator } from "./chunk-sync-coordinator.js";
import { withDirectoryLock } from "./filesystem-lock.js";
import path from "node:path";

import type postgres from "postgres";

import { memoryDatabase } from "./database.js";
import { agentWorkspaceRoot } from "./paths.js";
import { writeMemoryLog, memoryLogger } from "./run-telemetry.js";
import { syncMyPagesChunkSources } from "./my-pages-chunk-sources.js";
import { syncProfileChunkSource } from "./profile-chunk-source.js";
import type {
  FactSearchInput,
  SessionFactHit,
  SessionFactIndex,
} from "./session-fact-index.js";
import { tokenizeSearchText } from "../bm25.js";
import { HYBRID_SEARCH_CANDIDATES, RRF_K } from "./search/rrf.js";
import {
  LEXICAL_RERANK_POOL_FACTOR,
  rerankLexicalCandidates,
} from "./search/lexical-rerank.js";
import { chunkSource } from "./search/chunks.js";
import {
  selectWithTemporalCoverage,
  TEMPORAL_POOL_SIZE,
  windowBounds,
} from "./search/temporal-window.js";
import {
  contentHash,
  databaseSourceId,
  deleteRawSources,
  listRawSourcesForAgent,
  rawSourceContentPath,
  rawSourceOriginKind,
  readRawSource,
  sourceSearchText,
  type RawOriginKind,
  type RawSource,
  type RawSourceKind,
  MAX_SOURCE_FILES,
  PENDING_INDEX_PROFILE,
  RAW_EVIDENCE_PREFIX_LENGTH,
  type SourceIdentity,
} from "./search/source-store.js";
import type { RawSourceReference } from "./search/source-store.js";

const DEFAULT_RESULT_LIMIT = 10;
/** The Memory scheduler runs a full sync this often, first at startup. */
export const CHUNK_SYNC_INTERVAL_MS = 60 * 60 * 1_000;
const DEFAULT_SOURCE_CONCURRENCY = 4;
const INDEX_PROFILE = "raw-md-v5";

export interface IndexedChunkMatch {
  chunkId: string;
  lexicalRank?: number;
  mergedChunkIds: string[];
  score: number;
  sourceId: string;
}

export interface ChunkSearchInput extends SourceIdentity {
  limit?: number;
  query: string;
  /** Synonyms and translations the caller expects in the evidence. */
  alternates?: readonly string[];
  // Omitted searches the complete authorized scope; [] means no sources.
  sourceIds?: readonly string[];
  date_from?: string;
  date_to?: string;
}

export interface ChunkSearchProvider {
  search(input: FactSearchInput): Promise<IndexedChunkMatch[]>;
  searchFacts?(input: FactSearchInput): Promise<SessionFactHit[]>;
  resolveRawSources?(
    identity: SourceIdentity,
    references: readonly RawSourceReference[],
  ): Promise<RawSource[]>;
  /** The text search chunked, which chunk IDs and offsets refer to. */
  readRawSource?(
    identity: SourceIdentity,
    source: RawSource,
  ): Promise<string | undefined>;
}

interface IndexableChunkSource {
  content: string;
  contentHash: string;
  documentId: string;
  identity: SourceIdentity;
  manifest: Record<string, unknown>;
  metadata: Record<string, string>;
  originKind: RawOriginKind;
  sourceKind: RawSourceKind;
  sourcePath: string;
  sourceUri: string;
  sourceVersion: string;
  title: string;
  /** A source kept only to be read, such as a Wiki index page, has no chunks. */
  searchable?: boolean;
}

interface SourceVersionRow {
  active_sha256: string | null;
  index_profile: string;
  raw_present: boolean;
  chunk_count: number;
  indexed_chunk_count: number;
}

export interface ChunkCandidateRow {
  chunk_id: string;
  chunk_no: number;
  document_id: string;
  heading_path: string[];
  line_end: number;
  line_start: number;
  score: number;
}

interface RankedCandidate extends ChunkCandidateRow {
  lexicalRank?: number;
  rrfScore: number;
}

export interface ChunkIndexSyncResult {
  indexed: number;
  retired: number;
  skipped: number;
}

export class MemoryChunkIndex implements ChunkSearchProvider {
  readonly #dataRoot: string;
  /** Optional Session fact recall; needs the Raw database. */
  factIndex?: Pick<SessionFactIndex, "search">;
  /** Runs after an Agent's Raw sources are indexed, such as Session facts. */
  afterAgentSync?: (agentId: string) => Promise<unknown>;
  readonly #sql: postgres.Sql;
  readonly #coordinator: ChunkSyncCoordinator;
  #queue = Promise.resolve<ChunkIndexSyncResult>({
    indexed: 0,
    retired: 0,
    skipped: 0,
  });
  /** Scheduled full syncs skip an Another Me whose history rebuild is pending. */
  indexHold: (agentId: string) => boolean = () => false;

  constructor(options: {
    dataRoot: string;
    /** Memory's shared pool; the role ends it, not the index. */
    sql: postgres.Sql;
    sourceConcurrency?: number;
  }) {
    this.#dataRoot = options.dataRoot;
    this.#coordinator = new ChunkSyncCoordinator(
      options.sourceConcurrency ?? DEFAULT_SOURCE_CONCURRENCY,
    );
    this.#sql = options.sql;
  }

  /**
   * Read-only diagnostics; failed sources are retried by the next sync. A
   * document that never indexed has a source row holding only its recorded
   * normalization failure.
   */
  async failedSources(limit: number) {
    const failed = this.#sql`
      SELECT tenant_id,owner_id,agent_id,source_kind,origin_kind,title,last_index_error,updated_at,id
      FROM memory_index.sources WHERE state='failed'`;
    const byOwner = await this.#sql<
      { tenant_id: string; owner_id: string; count: number }[]
    >`SELECT tenant_id,owner_id,count(*)::int AS count FROM (${failed}) failed
      GROUP BY tenant_id,owner_id ORDER BY count DESC,tenant_id,owner_id LIMIT ${limit}`;
    const items = await this.#sql<
      {
        tenant_id: string;
        owner_id: string;
        agent_id: string;
        source_kind: string;
        origin_kind: string;
        title: string;
        last_index_error: string | null;
        updated_at: Date;
      }[]
    >`SELECT tenant_id,owner_id,agent_id,source_kind,origin_kind,left(title,120) AS title,
        left(last_index_error,300) AS last_index_error,updated_at
      FROM (${failed}) failed ORDER BY updated_at DESC,id LIMIT ${limit}`;
    const [count] = await this.#sql<
      { total: number }[]
    >`SELECT count(*)::int AS total FROM (${failed}) failed`;
    return { total: count!.total, by_owner: byOwner, items };
  }

  async close(): Promise<void> {
    await this.#queue.catch(() => undefined);
    await this.#coordinator.idle();
  }

  syncAll(): Promise<ChunkIndexSyncResult> {
    const operation = this.#queue.then(() => this.#syncAll());
    this.#queue = operation.catch((error: unknown) => {
      memoryLogger().log("error", "memory.chunk_index_sync_failed", { error });
      return { indexed: 0, retired: 0, skipped: 0 };
    });
    return operation;
  }

  async syncAgent(agentId: string): Promise<ChunkIndexSyncResult> {
    return this.#runAgentOperation(agentId, "full", () =>
      this.#syncAgent(agentId),
    );
  }

  /**
   * Indexes one Raw source that only PostgreSQL stores, such as a published
   * Wiki page or a report. An unchanged source is left as it is.
   */
  async indexDatabaseSource(
    source: RawSource,
    content: string,
    options: { searchable?: boolean } = {},
  ): Promise<boolean> {
    const sourcePath = rawSourceContentPath(source);
    if (!sourcePath || contentHash(content) !== source.contentHash)
      throw new Error(`Raw source is invalid: ${source.id}`);
    return this.#indexChunkSource({
      ...rawChunkSource(source, sourcePath, content),
      searchable: options.searchable ?? true,
    });
  }

  /**
   * Deletes an Agent's sources of one origin, optionally of one collection,
   * except the kept source IDs, with their versions and chunks.
   */
  async retireDatabaseSources(
    identity: SourceIdentity,
    originKind: NonNullable<RawSource["originKind"]>,
    keep: readonly string[],
    collection?: string,
  ): Promise<number> {
    const retired = await this.#sql<{ id: string }[]>`
      DELETE FROM memory_index.sources
      WHERE tenant_id = ${identity.tenant_id}
        AND owner_id = ${identity.user_artifact_owner_actor_id}
        AND agent_id = ${identity.agent_id}
        AND origin_kind = ${originKind}
        AND (${collection ?? null}::text IS NULL OR metadata->>'collection' = ${collection ?? null})
        AND document_id <> ALL(${[...keep]}::text[])
      RETURNING id
    `;
    return retired.length;
  }

  /** Opportunistic indexing; authoritative Raw publication is independent. */
  async syncRawSources(agentId: string, date?: string): Promise<number> {
    void date;
    // Date-specific wakes are only low-latency signals. One coalesced follow-up
    // re-reads every current Raw manifest, so a later version cannot be lost.
    return this.#runAgentOperation(agentId, "raw", () =>
      this.#syncRawSources(agentId),
    );
  }

  async #syncRawSources(agentId: string): Promise<number> {
    const workspaceRoot = agentWorkspaceRoot(this.#dataRoot, agentId);
    const { sources } = await this.#localRawSources(agentId);
    const results = await this.#coordinator.mapSources(
      sources,
      async (source) => {
        const sourcePath = rawSourceContentPath(source);
        if (!sourcePath) return false;
        const projected = await readRawSource(workspaceRoot, source);
        if (
          projected === undefined ||
          contentHash(projected) !== source.contentHash
        ) {
          throw new Error(`Raw source projection is invalid: ${source.id}`);
        }
        return this.#indexChunkSource(
          rawChunkSource(source, sourcePath, projected),
        );
      },
    );
    return results.filter(Boolean).length;
  }

  #runAgentOperation<T>(
    agentId: string,
    operationKey: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.#coordinator.runAgent(agentId, operationKey, () =>
      withDirectoryLock(
        path.join(this.#dataRoot, "updates", "chunk-agent-locks", agentId),
        operation,
      ),
    );
  }

  async search(input: FactSearchInput): Promise<IndexedChunkMatch[]> {
    const sourceIds = input.sourceIds
      ? [...new Set(input.sourceIds)]
      : undefined;
    if (!input.query.trim() || sourceIds?.length === 0) return [];
    // The query and each alternate wording search keywords in parallel and
    // vote as separate RRF lists, so a synonym is not outranked by documents
    // that only repeat the query's own words.
    const lexicalRoutes = [input.query, ...(input.alternates ?? [])].map(
      (route) => {
        const tokens = lexicalQueryTokens(route);
        return tokens.length
          ? this.#lexicalCandidates(input, sourceIds, tokens)
          : Promise.resolve<ChunkCandidateRow[]>([]);
      },
    );
    // A time window adds the period's chunks that match the query's keywords
    // as one more ranked vote.
    const queryTokens = lexicalQueryTokens(input.query);
    const temporalPromise =
      queryTokens.length && (input.event_from || input.event_to)
        ? this.#temporalCandidates(input, sourceIds, queryTokens)
        : Promise.resolve<ChunkCandidateRow[]>([]);
    const [[lexical = [], ...alternates], temporal] = await Promise.all([
      Promise.all(lexicalRoutes),
      temporalPromise,
    ]);
    return rankChunkCandidates(lexical, input.limit ?? DEFAULT_RESULT_LIMIT, [
      temporal,
      ...alternates,
    ]);
  }

  /**
   * Session facts form a separate channel, as in Hindsight's typed recall: they
   * never vote in or displace the Raw chunk ranking above.
   */
  async searchFacts(input: FactSearchInput): Promise<SessionFactHit[]> {
    if (!this.factIndex || !input.query.trim()) return [];
    const tokens = lexicalQueryTokens(
      [input.query, ...(input.alternates ?? [])].join(" "),
    );
    try {
      return await this.factIndex.search(input, tokens);
    } catch (error) {
      memoryLogger().log("warn", "memory.session_fact_recall_unavailable", {
        error,
      });
      return [];
    }
  }

  async resolveRawSources(
    identity: SourceIdentity,
    references: readonly RawSourceReference[],
  ): Promise<RawSource[]> {
    const timeRange = identity as SourceIdentity & {
      date_from?: string;
      date_to?: string;
    };
    const dateFrom = timeRange.date_from ?? null;
    const dateTo = timeRange.date_to ?? null;
    const sourceIds = [
      ...new Set(references.map((reference) => reference.sourceId)),
    ];
    // A short evidence ID carries a source ID prefix, not the full ID.
    const isPrefix = (sourceId: string) =>
      sourceId.length === RAW_EVIDENCE_PREFIX_LENGTH;
    const fullIds = sourceIds.filter((sourceId) => !isPrefix(sourceId));
    const prefixes = sourceIds.filter(isPrefix);
    const rows = await this.#sql<{ document_id: string; manifest: unknown }[]>`
      SELECT source.document_id, version.manifest
      FROM memory_index.sources source
      JOIN memory_index.source_versions version
        ON version.source_id = source.id
        AND version.sha256 = source.active_sha256
      WHERE source.tenant_id = ${identity.tenant_id}
        AND source.owner_id = ${identity.user_artifact_owner_actor_id}
        AND source.agent_id = ${identity.agent_id}
        AND (${dateFrom}::text IS NULL OR version.manifest->>'date' >= ${dateFrom})
        AND (${dateTo}::text IS NULL OR version.manifest->>'date' <= ${dateTo})
        AND (${sourceIds.length === 0}
          OR source.document_id = ANY(${fullIds}::text[])
          OR left(source.document_id, ${RAW_EVIDENCE_PREFIX_LENGTH}) = ANY(${prefixes}::text[]))
      ORDER BY source.updated_at DESC, source.document_id
      LIMIT ${sourceIds.length ? sourceIds.length + prefixes.length : MAX_SOURCE_FILES + 1}
    `;
    const byId = new Map<string, RawSource>();
    for (const row of rows) {
      const source = storedRawSource(row.manifest, identity);
      if (source && source.id === row.document_id) byId.set(source.id, source);
    }
    if (sourceIds.length === 0) return [...byId.values()];
    return sourceIds.flatMap((sourceId) => {
      if (isPrefix(sourceId))
        return [...byId.values()].filter((source) =>
          source.id.startsWith(sourceId),
        );
      const source = byId.get(sourceId);
      return source ? [source] : [];
    });
  }

  async readRawSource(
    identity: SourceIdentity,
    source: RawSource,
  ): Promise<string | undefined> {
    if (!sameSourceIdentity(identity, source.identity)) return undefined;
    const [stored] = await this.#sql<{ content: string; manifest: unknown }[]>`
      SELECT version.content, version.manifest
      FROM memory_index.sources active
      JOIN memory_index.source_versions version
        ON version.source_id = active.id
        AND version.sha256 = active.active_sha256
      WHERE active.tenant_id = ${identity.tenant_id}
        AND active.owner_id = ${identity.user_artifact_owner_actor_id}
        AND active.agent_id = ${identity.agent_id}
        AND active.document_id = ${source.id}
        AND active.active_sha256 = ${source.contentHash}
    `;
    const manifest = storedRawSource(stored?.manifest, identity);
    if (
      !stored ||
      !manifest ||
      manifest.id !== source.id ||
      manifest.contentHash !== source.contentHash ||
      manifest.anchorHash !== source.anchorHash ||
      contentHash(stored.content) !== source.contentHash
    ) {
      return undefined;
    }
    return sourceSearchText(manifest.sourceKind, stored.content);
  }

  async #syncAll(): Promise<ChunkIndexSyncResult> {
    // A revoked Another Me takes its sources with it.
    const revoked = await this.#sql<{ id: string }[]>`
      DELETE FROM memory_index.sources source
      USING memory_source.revoked_another_me_agents agent
      WHERE source.tenant_id = agent.tenant_id
        AND source.owner_id = agent.represented_human_actor_id
        AND source.agent_id = agent.agent_management_id
      RETURNING source.id
    `;
    // Discover authorized users from TeamHub, even if they have never had a
    // local Session/Wiki directory. Filesystem presence is not user authority.
    const agents = await this.#sql<{ agent_id: string }[]>`
      SELECT agent_management_id AS agent_id FROM memory_source.another_me_subjects
      WHERE human_is_tenant_member
      ORDER BY agent_id
    `;
    const totals: ChunkIndexSyncResult = {
      indexed: 0,
      retired: revoked.length,
      skipped: 0,
    };
    const failures: Error[] = [];
    const results = await this.#coordinator.mapSources(
      agents,
      async (entry) => {
        if (this.indexHold(entry.agent_id)) {
          writeMemoryLog("memory_rebuild_index_hold_skipped", {
            memory_subject_key: entry.agent_id,
            index: "raw",
          });
          return undefined;
        }
        try {
          return await this.#runAgentOperation(entry.agent_id, "full", () =>
            this.#syncAgent(entry.agent_id),
          );
        } catch (error) {
          failures.push(
            new Error(`Chunk sync failed for ${entry.agent_id}`, {
              cause: error,
            }),
          );
          memoryLogger().log("error", "memory.chunk_agent_sync_failed", {
            agent_id: entry.agent_id,
            continuing_other_agents: true,
            error,
          });
          return undefined;
        }
      },
    );
    for (const result of results) {
      if (!result) continue;
      totals.indexed += result.indexed;
      totals.retired += result.retired;
      totals.skipped += result.skipped;
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        "Some agents failed Chunk synchronization",
      );
    return totals;
  }

  async #syncAgent(agentId: string): Promise<ChunkIndexSyncResult> {
    const workspaceRoot = agentWorkspaceRoot(this.#dataRoot, agentId);
    let indexed = 0;
    let skipped = 0;
    let retired = 0;
    const failures: Error[] = [];
    try {
      const result = await syncMyPagesChunkSources({
        agentId,
        sql: this.#sql,
        mapSources: (sources, operation) =>
          this.#coordinator.mapSources(sources, operation),
        ingest: (source, content) => {
          return this.#indexChunkSource(
            rawChunkSource(source, rawSourceContentPath(source)!, content),
          );
        },
      });
      indexed += result.indexed;
      skipped += result.skipped;
      retired += result.retired;
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
    try {
      const profile = await syncProfileChunkSource({
        agentId,
        sql: this.#sql,
        ingest: (source, content) =>
          this.#indexChunkSource(
            rawChunkSource(source, rawSourceContentPath(source)!, content),
          ),
      });
      if (profile.indexed) indexed += 1;
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
    const local = await this.#localRawSources(agentId);
    retired += local.retired;
    const rawSources = local.sources;
    const sourceTasks = rawSources.map((source) => ({
      kind: "raw" as const,
      source,
    }));
    const sourceResults = await this.#coordinator.mapSources(
      sourceTasks,
      async (task) => {
        try {
          const changed = await this.#indexSource(workspaceRoot, task.source);
          return { changed };
        } catch (error) {
          failures.push(
            error instanceof Error ? error : new Error(String(error)),
          );
          const message =
            error instanceof Error ? error.message : "Unknown indexing error";
          await this.#sql`
            UPDATE memory_index.sources
            SET last_index_error = ${message.slice(0, 2048)}, state = 'failed',
                updated_at = now()
            WHERE tenant_id = ${task.source.identity.tenant_id}
              AND owner_id = ${task.source.identity.user_artifact_owner_actor_id}
              AND agent_id = ${task.source.identity.agent_id}
              AND document_id = ${task.source.id}
          `;
          memoryLogger().log("error", "memory.chunk_source_indexing_failed", {
            source_id: task.source.id,
            error,
          });
          return { changed: false };
        }
      },
    );
    indexed += sourceResults.filter((result) => result.changed).length;
    skipped += sourceResults.filter((result) => !result.changed).length;
    if (failures.length) {
      throw new AggregateError(
        failures,
        `Chunk reconciliation failed for ${failures.length} source(s): ${failures[0]!.message}`,
      );
    }
    // Session facts follow indexed Raw without delaying chunk indexing.
    if (this.afterAgentSync)
      void this.afterAgentSync(agentId).catch((error: unknown) => {
        memoryLogger().log("error", "memory.session_fact_sync_failed", {
          agent_id: agentId,
          error,
        });
      });
    // A missing local projection is not an authoritative deletion. Only the
    // source owner's lifecycle deletes Raw: a TeamHub inventory without the
    // document, a deleted Room, a revoked Another Me.
    return { indexed, retired, skipped };
  }

  /**
   * The Agent's local Session, recording and Pocket Note Raw; TeamHub
   * documents are read separately. A deleted Room takes its Session and
   * recording sources with it, local Raw and index alike (M08-N9).
   */
  async #localRawSources(
    agentId: string,
  ): Promise<{ sources: RawSource[]; retired: number }> {
    const listed = (
      await listRawSourcesForAgent(
        agentWorkspaceRoot(this.#dataRoot, agentId),
        agentId,
      )
    ).filter((source) => source.originKind !== "period_summary");
    const roomIds = [
      ...new Set(listed.flatMap((source) => source.metadata?.room_id ?? [])),
    ];
    const deletedRooms = new Set(
      roomIds.length === 0
        ? []
        : (
            await this.#sql<{ tenant_id: string; room_id: string }[]>`
              SELECT tenant_id, room_id FROM memory_source.deleted_rooms
              WHERE room_id = ANY(${roomIds}::text[])
            `
          ).map((row) => roomKey(row.tenant_id, row.room_id)),
    );
    const inDeletedRoom = (source: RawSource) =>
      source.metadata?.room_id !== undefined &&
      deletedRooms.has(
        roomKey(source.identity.tenant_id, source.metadata.room_id),
      );
    const removed = listed.filter(inDeletedRoom);
    if (removed.length > 0)
      await deleteRawSources(this.#dataRoot, agentId, removed);
    const deleted = await this.#sql<{ id: string }[]>`
      DELETE FROM memory_index.sources source
      USING memory_source.deleted_rooms room
      WHERE source.agent_id = ${agentId}
        AND source.tenant_id = room.tenant_id AND source.room_id = room.room_id
      RETURNING source.id
    `;
    return {
      sources: listed.filter((source) => !inDeletedRoom(source)),
      retired: deleted.length,
    };
  }

  async #indexSource(
    workspaceRoot: string,
    source: RawSource,
  ): Promise<boolean> {
    const sourcePath = rawSourceContentPath(source);
    if (!sourcePath) return false;
    const projected = await readRawSource(workspaceRoot, source);
    if (
      projected === undefined ||
      contentHash(projected) !== source.contentHash
    )
      return false;
    return this.#indexChunkSource(
      rawChunkSource(source, sourcePath, projected),
    );
  }

  async #indexChunkSource(source: IndexableChunkSource): Promise<boolean> {
    const sourceId = databaseSourceId(source);
    const prepared = (
      source.searchable === false
        ? []
        : chunkSource(sourceSearchText(source.sourceKind, source.content))
    ).map((chunk, chunkNo) => ({
      chunk,
      chunkNo,
      contentSha256: contentHash(chunk.content),
    }));
    const [current] = await this.#sql<SourceVersionRow[]>`
      SELECT source.active_sha256, source.index_profile,
        EXISTS (
          SELECT 1 FROM memory_index.source_versions version
          WHERE version.source_id = source.id
            AND version.sha256 = source.active_sha256
        ) AS raw_present,
        (SELECT count(*)::int FROM memory_index.chunks chunk
          WHERE chunk.source_id = source.id) AS chunk_count,
        (SELECT count(*)::int FROM memory_index.chunks chunk
          WHERE chunk.source_id = source.id
            AND chunk.source_sha256 = source.active_sha256) AS indexed_chunk_count
      FROM memory_index.sources source
      WHERE tenant_id = ${source.identity.tenant_id}
        AND owner_id = ${source.identity.user_artifact_owner_actor_id}
        AND agent_id = ${source.identity.agent_id}
        AND document_id = ${source.documentId}
    `;
    if (
      current?.active_sha256 === source.contentHash &&
      current.index_profile === INDEX_PROFILE &&
      current.raw_present &&
      current.chunk_count === prepared.length &&
      current.indexed_chunk_count === prepared.length
    )
      return false;

    const committed = await this.#sql.begin(async (sql) => {
      await sql`
          INSERT INTO memory_index.sources(
            id, tenant_id, owner_id, agent_id, document_id, source_path,
            title, active_sha256, index_profile, source_kind, origin_kind,
            source_uri, source_version, representation_format, metadata, state,
            room_id
          ) VALUES(
            ${sourceId}, ${source.identity.tenant_id},
            ${source.identity.user_artifact_owner_actor_id},
            ${source.identity.agent_id}, ${source.documentId}, ${source.sourcePath},
            ${source.title}, NULL, ${PENDING_INDEX_PROFILE},
            ${source.sourceKind}, ${source.originKind},
            ${source.sourceUri}, ${source.sourceVersion},
            'markdown', ${sql.json(source.metadata)}, 'active',
            ${source.metadata.room_id ?? null}
          )
          ON CONFLICT DO NOTHING
        `;
      const updated = await sql<{ id: string }[]>`
          UPDATE memory_index.sources
          SET source_path = ${source.sourcePath}, title = ${source.title},
              active_sha256 = ${source.contentHash}, index_profile = ${INDEX_PROFILE},
              source_kind = ${source.sourceKind}, origin_kind = ${source.originKind},
              source_uri = ${source.sourceUri}, source_version = ${source.sourceVersion},
              representation_format = 'markdown', metadata = ${sql.json(source.metadata)},
              room_id = ${source.metadata.room_id ?? null}, state = 'active',
              indexed_at = now(), updated_at = now(), last_index_error = NULL
          WHERE id = ${sourceId}
            AND tenant_id = ${source.identity.tenant_id}
            AND owner_id = ${source.identity.user_artifact_owner_actor_id}
            AND agent_id = ${source.identity.agent_id}
            AND active_sha256 IS NOT DISTINCT FROM ${current?.active_sha256 ?? null}
          RETURNING id
        `;
      if (updated.length === 0) return false;
      await sql`
          INSERT INTO memory_index.source_versions(
            source_id, sha256, manifest, content, size_bytes
          ) VALUES(
            ${sourceId}, ${source.contentHash},
            ${sql.json(source.manifest as postgres.JSONValue)}, ${source.content},
            ${Buffer.byteLength(source.content)}
          )
          ON CONFLICT (source_id, sha256) DO NOTHING
        `;
      const [stored] = await sql<{ content: string }[]>`
        SELECT content FROM memory_index.source_versions
        WHERE source_id = ${sourceId} AND sha256 = ${source.contentHash}
      `;
      if (!stored || contentHash(stored.content) !== source.contentHash)
        throw new Error(`Stored Raw source is invalid: ${source.documentId}`);
      // Raw bytes, the active pointer and the full replacement are one commit.
      // A failure restores the old version and all its chunks; no source file is written.
      await sql`DELETE FROM memory_index.chunks WHERE source_id = ${sourceId}`;
      for (const item of prepared) {
        await sql`
            INSERT INTO memory_index.chunks(
              id, tenant_id, owner_id, agent_id, source_id, source_sha256,
              chunk_no, content, heading_path, line_start, line_end,
              content_sha256, search_tsv
            ) VALUES(
              ${item.chunk.id}, ${source.identity.tenant_id},
              ${source.identity.user_artifact_owner_actor_id}, ${source.identity.agent_id},
              ${sourceId}, ${source.contentHash}, ${item.chunkNo}, ${item.chunk.content},
              ${item.chunk.headingPath}, ${item.chunk.lineStart}, ${item.chunk.lineEnd},
              ${item.contentSha256},
              setweight(to_tsvector('simple', ${lexicalText(item.chunk.headingPath.join(" "))}), 'A') ||
                setweight(to_tsvector('simple', ${lexicalText(item.chunk.content)}), 'B') ||
                setweight(to_tsvector('simple', ${lexicalText(source.title)}), 'B') ||
                setweight(to_tsvector('simple', ${lexicalText(source.sourcePath)}), 'C')
            )
          `;
      }
      // Readers only follow the active version.
      await sql`
        DELETE FROM memory_index.source_versions
        WHERE source_id = ${sourceId} AND sha256 <> ${source.contentHash}
      `;
      return true;
    });
    return committed;
  }

  async #lexicalCandidates(
    input: ChunkSearchInput,
    sourceIds: string[] | undefined,
    tokens: string[],
  ): Promise<ChunkCandidateRow[]> {
    const query = tokens.join(" | ");
    const pool = await this.#sql<
      (ChunkCandidateRow & { title: string; matched_terms: number })[]
    >`
      SELECT pool.chunk_id, pool.chunk_no, pool.document_id, pool.heading_path,
        pool.line_start, pool.line_end, pool.score, pool.title,
        (SELECT count(*) FROM unnest(${tokens}::text[]) term
          WHERE pool.search_tsv @@ to_tsquery('simple', term))::int AS matched_terms
      FROM (
      SELECT
        chunk.id AS chunk_id,
        chunk.chunk_no,
        source.document_id,
        chunk.heading_path,
        chunk.line_start,
        chunk.line_end,
        source.title,
        chunk.search_tsv,
        ts_rank_cd(chunk.search_tsv, to_tsquery('simple', ${query}))::float8 AS score
      FROM memory_index.chunks chunk
      JOIN memory_index.sources source ON source.id = chunk.source_id
      JOIN memory_index.source_versions version ON version.source_id = source.id AND version.sha256 = source.active_sha256
      WHERE chunk.tenant_id = ${input.tenant_id}
        AND chunk.owner_id = ${input.user_artifact_owner_actor_id}
        AND chunk.agent_id = ${input.agent_id}
        AND source.active_sha256 = chunk.source_sha256
        AND (${sourceIds === undefined} OR source.document_id = ANY(${sourceIds ?? []}::text[]))
        AND (${input.date_from ?? null}::text IS NULL OR version.manifest->>'date' >= ${input.date_from ?? null})
        AND (${input.date_to ?? null}::text IS NULL OR version.manifest->>'date' <= ${input.date_to ?? null})
        AND chunk.search_tsv @@ to_tsquery('simple', ${query})
      ORDER BY score DESC, chunk.id
      LIMIT ${HYBRID_SEARCH_CANDIDATES * LEXICAL_RERANK_POOL_FACTOR}
      ) pool
      ORDER BY pool.score DESC, pool.chunk_id
    `;
    return rerankLexicalCandidates(
      pool,
      tokens,
      {
        matchedTerms: (row) => row.matched_terms,
        titleTerms: (row) => tokenizeSearchText(row.title ?? ""),
        score: (row) => row.score,
      },
      HYBRID_SEARCH_CANDIDATES,
    ).map((row) => ({
      chunk_id: row.chunk_id,
      chunk_no: row.chunk_no,
      document_id: row.document_id,
      heading_path: row.heading_path,
      line_start: row.line_start,
      line_end: row.line_end,
      score: row.score,
    }));
  }

  async #temporalCandidates(
    input: FactSearchInput,
    sourceIds: string[] | undefined,
    tokens: string[],
  ): Promise<ChunkCandidateRow[]> {
    const window = { from: input.event_from, to: input.event_to };
    const bounds = windowBounds(window);
    const query = tokens.join(" | ");
    const rows = await this.#sql<
      (ChunkCandidateRow & { source_date: string })[]
    >`
      SELECT chunk.id AS chunk_id, chunk.chunk_no, source.document_id,
        chunk.heading_path, chunk.line_start, chunk.line_end,
        ts_rank_cd(chunk.search_tsv, to_tsquery('simple', ${query}))::float8 AS score,
        version.manifest->>'date' AS source_date
      FROM memory_index.chunks chunk
      JOIN memory_index.sources source ON source.id = chunk.source_id
      JOIN memory_index.source_versions version ON version.source_id = source.id AND version.sha256 = source.active_sha256
      WHERE chunk.tenant_id = ${input.tenant_id}
        AND chunk.owner_id = ${input.user_artifact_owner_actor_id}
        AND chunk.agent_id = ${input.agent_id}
        AND source.active_sha256 = chunk.source_sha256
        AND (${sourceIds === undefined} OR source.document_id = ANY(${sourceIds ?? []}::text[]))
        AND (${input.date_from ?? null}::text IS NULL OR version.manifest->>'date' >= ${input.date_from ?? null})
        AND (${input.date_to ?? null}::text IS NULL OR version.manifest->>'date' <= ${input.date_to ?? null})
        AND version.manifest->>'date' BETWEEN ${bounds.from} AND ${bounds.to}
        AND chunk.search_tsv @@ to_tsquery('simple', ${query})
      ORDER BY score DESC, chunk.id
      LIMIT ${TEMPORAL_POOL_SIZE}
    `;
    return selectWithTemporalCoverage(rows, (row) => row.source_date, window);
  }
}

export function createMemoryChunkIndexFromEnvironment(
  dataRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): MemoryChunkIndex {
  return new MemoryChunkIndex({ dataRoot, sql: memoryDatabase(environment) });
}

export function rankChunkCandidates(
  lexical: readonly ChunkCandidateRow[],
  limit = DEFAULT_RESULT_LIMIT,
  extraBranches: readonly (readonly ChunkCandidateRow[])[] = [],
): IndexedChunkMatch[] {
  const byKey = new Map<string, RankedCandidate>(
    lexical.map((row, index) => [
      candidateKey(row),
      { ...row, lexicalRank: index + 1, rrfScore: 1 / (RRF_K + index + 1) },
    ]),
  );
  // The temporal window and each alternate wording vote as one more RRF list.
  for (const branch of extraBranches) {
    for (const [index, row] of branch.entries()) {
      const key = candidateKey(row);
      const current = byKey.get(key) ?? { ...row, rrfScore: 0 };
      current.rrfScore += 1 / (RRF_K + index + 1);
      byKey.set(key, current);
    }
  }
  const ranked = [...byKey.values()].sort(
    (left, right) =>
      right.rrfScore - left.rrfScore ||
      candidateKey(left).localeCompare(candidateKey(right)),
  );
  const deduplicated: Array<RankedCandidate & { merged: string[] }> = [];
  for (const candidate of ranked) {
    const adjacent = deduplicated.find(
      (selected) =>
        selected.document_id === candidate.document_id &&
        sameArray(selected.heading_path, candidate.heading_path) &&
        Math.max(selected.line_start, candidate.line_start) <=
          Math.min(selected.line_end, candidate.line_end) + 1 &&
        Math.max(selected.line_end, candidate.line_end) -
          Math.min(selected.line_start, candidate.line_start) <=
          80,
    );
    if (adjacent) {
      adjacent.line_start = Math.min(adjacent.line_start, candidate.line_start);
      adjacent.line_end = Math.max(adjacent.line_end, candidate.line_end);
      adjacent.merged.push(candidate.chunk_id);
    } else {
      deduplicated.push({ ...candidate, merged: [candidate.chunk_id] });
    }
  }
  const selected: typeof deduplicated = [];
  const deferred: typeof deduplicated = [];
  const perSource = new Map<string, number>();
  for (const candidate of deduplicated) {
    const count = perSource.get(candidate.document_id) ?? 0;
    if (count < 3) {
      selected.push(candidate);
      perSource.set(candidate.document_id, count + 1);
    } else deferred.push(candidate);
  }
  selected.push(...deferred.slice(0, Math.max(0, limit - selected.length)));
  return selected.slice(0, limit).map((candidate) => ({
    chunkId: candidate.chunk_id,
    ...(candidate.lexicalRank ? { lexicalRank: candidate.lexicalRank } : {}),
    mergedChunkIds: candidate.merged,
    score: candidate.rrfScore,
    sourceId: candidate.document_id,
  }));
}

/** PostgreSQL text and jsonb reject U+0000 and ill-formed UTF-16. */
function postgresText(value: string): string {
  // Node 26 provides the ES2024 method; the shared tsconfig lib is ES2022.
  const text = value.replaceAll("\u0000", "") as string & {
    toWellFormed(): string;
  };
  return text.toWellFormed();
}

function roomKey(tenantId: string, roomId: string): string {
  return `${tenantId}\n${roomId}`;
}

// The one point where Session, Room and document content is finalized for
// storage: sanitize before hashing so the insert and the stored hash check
// cannot fail.
function rawChunkSource(
  raw: RawSource,
  sourcePath: string,
  projected: string,
): IndexableChunkSource {
  const content = postgresText(projected);
  const title = postgresText(raw.title);
  const source =
    content === projected && title === raw.title
      ? raw
      : { ...raw, contentHash: contentHash(content), title };
  return {
    content,
    contentHash: source.contentHash,
    documentId: source.id,
    identity: source.identity,
    manifest: source as unknown as Record<string, unknown>,
    metadata: { ...(source.metadata ?? {}) },
    originKind: rawSourceOriginKind(source),
    sourceKind: rawSourceKind(source),
    sourcePath,
    sourceUri: source.sourceUri,
    sourceVersion: source.sourceVersion ?? source.contentHash,
    title: source.title,
  };
}

function rawSourceKind(
  source: RawSource,
): NonNullable<RawSource["sourceKind"]> {
  if (source.sourceKind) return source.sourceKind;
  return source.anchorPath.includes("/recordings/")
    ? "recording_transcript"
    : "room_message";
}

function lexicalQueryTokens(query: string): string[] {
  return [...new Set(tokenizeSearchText(query))]
    .filter((token) => /^[\p{L}\p{N}_]+$/u.test(token))
    .slice(0, 64);
}

function lexicalText(value: string): string {
  return tokenizeSearchText(value).join(" ");
}

function storedRawSource(
  value: unknown,
  identity: SourceIdentity,
): RawSource | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const source = value as Partial<RawSource>;
  if (
    source.schemaVersion !== 1 ||
    typeof source.id !== "string" ||
    !/^[a-f0-9]{64}$/u.test(source.id) ||
    typeof source.anchorPath !== "string" ||
    typeof source.anchorHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(source.anchorHash) ||
    typeof source.contentHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(source.contentHash) ||
    typeof source.title !== "string" ||
    typeof source.sourceUri !== "string" ||
    typeof source.date !== "string" ||
    !source.identity ||
    !sameSourceIdentity(identity, source.identity)
  ) {
    return undefined;
  }
  return source as RawSource;
}

function sameSourceIdentity(
  left: SourceIdentity,
  right: SourceIdentity,
): boolean {
  return (
    left.agent_id === right.agent_id &&
    left.tenant_id === right.tenant_id &&
    left.user_artifact_owner_actor_id === right.user_artifact_owner_actor_id
  );
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function candidateKey(candidate: ChunkCandidateRow): string {
  return `${candidate.document_id}:${candidate.chunk_id}`;
}
