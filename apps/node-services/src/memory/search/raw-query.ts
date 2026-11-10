import type { PersonalKnowledgeQueryRequest } from "@linger/wire-contracts/node-services-internal/client";
import type { ChunkSearchProvider, IndexedChunkMatch } from "../chunk-index.js";
import type { RawSourceReference } from "./source-store.js";
import { searchBm25, tokenizeSearchText } from "../../bm25.js";
import { rerankLexicalCandidates } from "./lexical-rerank.js";
import { chunkSource, type SourceChunk } from "./chunks.js";
import { type RawSource, type SourceIdentity } from "./source-store.js";
import { memoryLogger } from "../run-telemetry.js";

/**
 * The BM25 scan is a fallback for sources the chunk index cannot match, not a
 * second index: like a search engine's candidate window, it reads only the
 * newest sources (the database lists them by update time) within a small
 * budget, so a miss stays cheap and recent evidence is never cut first.
 */
export const RAW_BM25_FALLBACK_MAX_SOURCES = 30;
export const RAW_BM25_FALLBACK_MAX_BYTES = 3_000_000;

export interface RawMatch {
  source: RawSource;
  chunk: SourceChunk;
  score: number;
  chunks: SourceChunk[];
}

/** PostgreSQL selects current authorized Raw versions. Files are projections,
 * never a fallback authority when a source is absent or the DB is unavailable. */
export async function resolveSearchRawSources(
  _workspaceRoot: string,
  identity: SourceIdentity,
  references: readonly RawSourceReference[],
  provider?: ChunkSearchProvider,
): Promise<{ sources: RawSource[]; storedSourceIds: Set<string> }> {
  if (!provider?.resolveRawSources || !provider.readRawSource)
    return { sources: [], storedSourceIds: new Set() };
  const sources = (
    await provider.resolveRawSources(identity, references)
  ).filter(
    (source) =>
      source.identity.tenant_id === identity.tenant_id &&
      source.identity.agent_id === identity.agent_id &&
      source.identity.user_artifact_owner_actor_id ===
        identity.user_artifact_owner_actor_id,
  );
  return {
    sources,
    storedSourceIds: new Set(sources.map((source) => source.id)),
  };
}

export async function searchRawSources(
  ...args: Parameters<typeof searchAvailableRawSources>
): Promise<{ matches: RawMatch[]; limited: boolean; unavailable?: boolean }> {
  try {
    return await searchAvailableRawSources(...args);
  } catch (error) {
    // Never turn a failed authority read into an empty corpus or use local Raw.
    memoryLogger().log("warn", "memory.raw_search_unavailable", {
      fallback: "partial_knowledge_results",
      error,
    });
    return { matches: [], limited: false, unavailable: true };
  }
}

async function searchAvailableRawSources(
  workspaceRoot: string,
  input: PersonalKnowledgeQueryRequest,
  chunkSearch?: ChunkSearchProvider,
  references: readonly RawSourceReference[] = [],
): Promise<{ matches: RawMatch[]; limited: boolean }> {
  const sourcePriority = new Map<string, number>();
  for (const [index, reference] of references.entries()) {
    if (!sourcePriority.has(reference.sourceId)) {
      sourcePriority.set(reference.sourceId, index);
    }
  }
  if (chunkSearch) {
    const ranked: IndexedChunkMatch[] = await chunkSearch.search({
      agent_id: input.agent_id,
      tenant_id: input.tenant_id,
      user_artifact_owner_actor_id: input.user_artifact_owner_actor_id,
      query: input.query,
      ...(input.alternates?.length ? { alternates: input.alternates } : {}),
      ...(input.date_from ? { date_from: input.date_from } : {}),
      ...(input.event_from ? { event_from: input.event_from } : {}),
      ...(input.event_to ? { event_to: input.event_to } : {}),
      ...(input.date_to ? { date_to: input.date_to } : {}),
      ...(references.length
        ? { sourceIds: references.map((r) => r.sourceId) }
        : {}),
    });
    if (ranked.length) {
      const { sources } = await resolveSearchRawSources(
        workspaceRoot,
        input,
        ranked.map((match) => ({ sourceId: match.sourceId, anchorPath: "" })),
        chunkSearch,
      );
      const sourceById = new Map(sources.map((source) => [source.id, source]));
      const loaded = new Map<string, SourceChunk[]>();
      const matches: RawMatch[] = [];
      for (const match of ranked) {
        const source = sourceById.get(match.sourceId);
        if (
          !source ||
          (input.date_from && source.date < input.date_from) ||
          (input.date_to && source.date > input.date_to)
        )
          continue;
        let chunks = loaded.get(source.id);
        if (!chunks) {
          const text = await chunkSearch.readRawSource?.(input, source);
          if (text === undefined) continue;
          chunks = chunkSource(text);
          loaded.set(source.id, chunks);
        }
        const chunk = chunks.find((item) => item.id === match.chunkId);
        if (chunk)
          matches.push({
            source,
            chunk,
            chunks,
            score: match.score,
          });
      }
      if (matches.length > 0) return { matches, limited: false };
    }
  }
  const resolved = await resolveSearchRawSources(
    workspaceRoot,
    input,
    references,
    chunkSearch,
  );
  // Referenced sources first; otherwise keep the database's newest-first order.
  const sources = resolved.sources
    .filter(
      (source) =>
        (!input.date_from || source.date >= input.date_from) &&
        (!input.date_to || source.date <= input.date_to),
    )
    .sort(
      (a, b) =>
        (sourcePriority.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
        (sourcePriority.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    );
  // A missing derived chunk index can fall back to DB-backed Raw BM25, never local files.
  const documents: Array<{ value: Omit<RawMatch, "score">; text: string }> = [];
  let bytes = 0;
  let limited = sources.length > RAW_BM25_FALLBACK_MAX_SOURCES;
  for (const source of sources.slice(0, RAW_BM25_FALLBACK_MAX_SOURCES)) {
    const text = await chunkSearch?.readRawSource?.(input, source);
    if (text === undefined) continue;
    bytes += Buffer.byteLength(text);
    if (bytes > RAW_BM25_FALLBACK_MAX_BYTES) {
      limited = true;
      break;
    }
    const chunks = chunkSource(text);
    for (const chunk of chunks) {
      documents.push({
        value: { source, chunk, chunks },
        text: `${source.title}\n${chunk.heading}\n${chunk.content}`,
      });
    }
  }
  const seen = new Set<string>();
  // The scan has one ranking, so alternate wordings join the query's terms.
  const scanQuery = [input.query, ...(input.alternates ?? [])].join(" ");
  const terms = [...new Set(tokenizeSearchText(scanQuery))];
  const ranked = searchBm25(documents, scanQuery);
  const matches = rerankLexicalCandidates(
    ranked,
    terms,
    {
      matchedTerms: ({ coverage }) => coverage * terms.length,
      titleTerms: ({ value }) => tokenizeSearchText(value.source.title),
      score: ({ score }) => score,
    },
    ranked.length,
  )
    .flatMap(({ value, score }) => {
      if (seen.has(value.source.id)) return [];
      seen.add(value.source.id);
      return [{ ...value, score }];
    })
    .slice(0, 8);
  return { matches, limited };
}
