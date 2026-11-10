import type {
  PersonalKnowledgeEvidenceReadRequest,
  PersonalKnowledgeEvidenceReadResponse,
  PersonalKnowledgeQueryRequest,
  PersonalKnowledgeQueryResponse,
} from "@linger/wire-contracts/node-services-internal/client";
import type { ChunkSearchProvider } from "./chunk-index.js";

import { chunkSource, type SourceChunk } from "./search/chunks.js";
import { tokenizeSearchText } from "../bm25.js";
import { contentWindow } from "./search/content-window.js";
import {
  searchRawSources,
  resolveSearchRawSources,
} from "./search/raw-query.js";
import { rawEvidenceId, rawSourceOriginKind } from "./search/source-store.js";
import { agentWorkspaceRoot } from "./paths.js";

const MAX_EVIDENCE_ITEMS = 20;
const MAX_DIRECTORY_ITEMS = 64;
// A candidate lists only its matched chunks and their neighbors; the full
// directory is returned by the evidence read.
const MAX_CANDIDATE_DIRECTORY_ITEMS = 8;
const CANDIDATE_EXCERPT_CHARS = 300;
// One-shot retrieval: the top candidates carry their matched chunk text so the
// Agent can answer without a second read round-trip.
// Inline content shares one character budget: each of the top sources first
// gets its best chunk, then the remaining budget goes to the next-ranked chunks
// of those same sources. A long chunk contributes the window around its best
// query match, so the same budget covers more sources; a user's short remark
// inside a long assistant reply otherwise leaves room for only three.
const INLINE_CONTENT_SOURCES = 6;
const INLINE_CONTENT_CHARS = 800;
const INLINE_CONTENT_BUDGET_CHARS = 6_000;
const INLINE_CONTENT_SEPARATOR = "\n\n…\n\n";
// A Runtime cuts the middle out of a tool result above its output limit, and
// Codex sets that limit as low as 4,000 tokens of four bytes each for a small
// model window. Search and read results stay within this many bytes of JSON,
// leaving room for the CLI's labels, so the Agent sees each result whole.
const KNOWLEDGE_OUTPUT_BUDGET_BYTES = 12_000;
const FACT_BUDGET_BYTES = KNOWLEDGE_OUTPUT_BUDGET_BYTES / 4;
// A section that does not fit still returns a page this large, so every read
// makes progress.
const MIN_SECTION_PAGE_BYTES = 512;
const RESULTS_TRIMMED_GAP = {
  code: "results_trimmed",
  detail:
    "Lower-ranked inline content, candidates or Session facts were left out to keep this result within its size budget. Read a candidate's sections for its full text, or search more narrowly.",
};

export class PersonalKnowledgeEvidenceNotFoundError extends Error {
  constructor() {
    super("Personal knowledge evidence was not found");
    this.name = "PersonalKnowledgeEvidenceNotFoundError";
  }
}

/**
 * One search over every source of the Agent's index: Sessions, recordings,
 * My pages, mail, Pocket Notes, the Profile, the published Wiki and Daily and
 * Weekly reports. Each item names its source kind.
 */
export async function queryPersonalKnowledge(
  dataRoot: string,
  input: PersonalKnowledgeQueryRequest,
  options: { chunkSearch?: ChunkSearchProvider } = {},
): Promise<PersonalKnowledgeQueryResponse> {
  const workspaceRoot = agentWorkspaceRoot(dataRoot, input.agent_id);
  // Facts rank in their own channel so they never displace Raw candidates.
  const [rawResult, facts] = await Promise.all([
    searchRawSources(workspaceRoot, input, options.chunkSearch),
    options.chunkSearch?.searchFacts?.(input) ?? [],
  ]);
  // A raw evidence ID identifies one immutable source version, not one
  // matching chunk. Preserve the highest-ranked match as its preview and
  // direct the follow-up read to every matched chunk of that source.
  const bySource = new Map<string, (typeof rawResult.matches)[number]>();
  const matchedChunkIds = new Map<string, Set<string>>();
  for (const match of rawResult.matches) {
    if (!bySource.has(match.source.id)) bySource.set(match.source.id, match);
    const ids = matchedChunkIds.get(match.source.id) ?? new Set<string>();
    ids.add(match.chunk.id);
    matchedChunkIds.set(match.source.id, ids);
  }
  const selected = [...bySource.values()].slice(0, MAX_EVIDENCE_ITEMS);
  const contentChunks = new Map<string, SourceChunk[]>();
  let contentChars = 0;
  for (const { source, chunk } of selected.slice(0, INLINE_CONTENT_SOURCES)) {
    contentChunks.set(source.id, [chunk]);
    contentChars += Math.min(chunk.content.length, INLINE_CONTENT_CHARS);
  }
  for (const match of rawResult.matches) {
    const chunks = contentChunks.get(match.source.id);
    if (!chunks || chunks.some(({ id }) => id === match.chunk.id)) continue;
    const chars = Math.min(match.chunk.content.length, INLINE_CONTENT_CHARS);
    if (contentChars + chars > INLINE_CONTENT_BUDGET_CHARS) continue;
    chunks.push(match.chunk);
    contentChars += chars;
  }
  const gaps = [
    ...(rawResult.unavailable
      ? [{ code: "raw_chunk_search_unavailable" }]
      : []),
    ...(rawResult.limited ? [{ code: "source_search_limited" }] : []),
  ];
  const dates = selected
    .map(({ source }) => Date.parse(source.date))
    .filter(Number.isFinite);
  const indexedAt = dates.length
    ? new Date(Math.max(...dates)).toISOString()
    : null;

  if (selected.length === 0) {
    return {
      gaps: rawResult.unavailable
        ? gaps
        : [...gaps, { code: "no_relevant_evidence" }],
      indexedAt,
      items: [],
      schemaVersion: 1,
      status: rawResult.unavailable ? "partial" : "empty",
    };
  }

  const terms = new Set(
    tokenizeSearchText([input.query, ...(input.alternates ?? [])].join(" ")),
  );
  const keptFacts = facts.slice(
    0,
    fittingPrefix(
      facts.length,
      (count) => outputBytes(facts.slice(0, count)),
      FACT_BUDGET_BYTES,
    ),
  );
  let itemCount = selected.length;
  let trimmed = keptFacts.length < facts.length;
  const response = (): PersonalKnowledgeQueryResponse => ({
    gaps: trimmed ? [...gaps, RESULTS_TRIMMED_GAP] : gaps,
    indexedAt,
    ...(keptFacts.length ? { facts: keptFacts } : {}),
    items: selected
      .slice(0, itemCount)
      .map(({ source, chunk, chunks }, index) => ({
        citeAs: `S${index + 1}`,
        directory: candidateDirectory(
          chunks,
          matchedChunkIds.get(source.id) ?? new Set([chunk.id]),
        ),
        excerpt: chunk.content
          .replace(/\s+/gu, " ")
          .trim()
          .slice(0, CANDIDATE_EXCERPT_CHARS),
        ...(contentChunks.has(source.id)
          ? { content: inlineContent(contentChunks.get(source.id)!, terms) }
          : {}),
        id: rawEvidenceId(source),
        metadata: {
          sourceId: source.id,
          sourceUri: source.sourceUri.slice(0, 512),
          contentHash: source.contentHash,
          linkedContentRef: source.anchorPath.slice(0, 512),
          matchedChunk: chunk.id,
          lineStart: String(chunk.lineStart),
          lineEnd: String(chunk.lineEnd),
          headingPath: chunk.headingPath.join(" > ").slice(0, 512),
        },
        representation: "source_excerpt",
        source: {
          kind: rawSourceOriginKind(source),
          label: source.title,
          ref: rawEvidenceId(source),
        },
        timeHint: source.date,
        title: source.title,
      })),
    schemaVersion: 1,
    status: "grounded",
  });
  // Inline chunks go from the lowest rank up until only the top candidate's
  // best chunk is left, then candidates go from the lowest rank up, then that
  // chunk. The top candidate always stays.
  const dropOne = (): boolean => {
    const withContent = [...contentChunks.keys()];
    const last = withContent.at(-1);
    if (
      last !== undefined &&
      (withContent.length > 1 || contentChunks.get(last)!.length > 1)
    ) {
      const chunks = contentChunks.get(last)!;
      chunks.pop();
      if (chunks.length === 0) contentChunks.delete(last);
      return true;
    }
    if (itemCount > 1) {
      itemCount -= 1;
      return true;
    }
    return last !== undefined && contentChunks.delete(last);
  };
  while (outputBytes(response()) > KNOWLEDGE_OUTPUT_BUDGET_BYTES && dropOne())
    trimmed = true;
  return response();
}

export async function readPersonalKnowledgeEvidence(
  dataRoot: string,
  input: PersonalKnowledgeEvidenceReadRequest,
  options: { rawSourceProvider?: ChunkSearchProvider } = {},
): Promise<PersonalKnowledgeEvidenceReadResponse> {
  if (!input.evidence_id.startsWith("raw_")) {
    throw new PersonalKnowledgeEvidenceNotFoundError();
  }
  return readRawEvidence(
    agentWorkspaceRoot(dataRoot, input.agent_id),
    input,
    options.rawSourceProvider,
  );
}

// A visible marker between windows tells the Agent that the rest of the
// source is only available through a read.
function inlineContent(
  chunks: readonly SourceChunk[],
  terms: ReadonlySet<string>,
): string {
  return [...chunks]
    .sort((left, right) => left.start - right.start)
    .map(({ content }) => contentWindow(content, terms, INLINE_CONTENT_CHARS))
    .join(INLINE_CONTENT_SEPARATOR);
}

function candidateDirectory(
  chunks: SourceChunk[],
  matchedIds: ReadonlySet<string>,
) {
  const keep = new Set<number>();
  chunks.forEach((chunk, index) => {
    if (!matchedIds.has(chunk.id)) return;
    for (const neighbor of [index - 1, index, index + 1])
      if (neighbor >= 0 && neighbor < chunks.length) keep.add(neighbor);
  });
  const ordered = [...keep].sort((a, b) => a - b);
  // Matched chunks win the bounded slots before neighbors.
  const selected = [
    ...ordered.filter((index) => matchedIds.has(chunks[index]!.id)),
    ...ordered.filter((index) => !matchedIds.has(chunks[index]!.id)),
  ]
    .slice(0, MAX_CANDIDATE_DIRECTORY_ITEMS)
    .sort((a, b) => a - b);
  return selected.map((index) => ({
    id: chunks[index]!.id,
    level: 2,
    title: chunks[index]!.heading.slice(0, 512),
  }));
}

function rawDirectory(chunks: SourceChunk[]) {
  return chunks.slice(0, MAX_DIRECTORY_ITEMS).map((chunk) => ({
    id: chunk.id,
    level: 2,
    title: chunk.heading.slice(0, 512),
  }));
}

async function readRawEvidence(
  workspaceRoot: string,
  input: PersonalKnowledgeEvidenceReadRequest,
  rawSourceProvider?: ChunkSearchProvider,
): Promise<PersonalKnowledgeEvidenceReadResponse> {
  const { sources } = await resolveSearchRawSources(
    workspaceRoot,
    input,
    [
      {
        sourceId: /^raw_([a-f0-9]{16})_/u.exec(input.evidence_id)?.[1] ?? "",
        anchorPath: "",
      },
    ],
    rawSourceProvider,
  );
  const matches = sources.filter(
    (entry) => rawEvidenceId(entry) === input.evidence_id,
  );
  // An ambiguous short ID never selects one of several sources.
  const source = matches.length === 1 ? matches[0] : undefined;
  const text = source
    ? await rawSourceProvider?.readRawSource?.(input, source)
    : undefined;
  if (!source || text === undefined)
    throw new PersonalKnowledgeEvidenceNotFoundError();
  const chunks = chunkSource(text);
  const pages = input.section_requests.flatMap((request) => {
    const chunk = chunks.find((entry) => entry.id === request.section_id);
    const offset = request.offset ?? 0;
    return chunk && offset <= chunk.content.length ? [{ chunk, offset }] : [];
  });
  const missingSections = input.section_requests
    .filter(
      (request) => !pages.some(({ chunk }) => chunk.id === request.section_id),
    )
    .map((request) => request.section_id);
  const response: PersonalKnowledgeEvidenceReadResponse = {
    schemaVersion: 1,
    evidenceId: input.evidence_id,
    title: source.title,
    source: {
      kind: rawSourceOriginKind(source),
      ref: rawEvidenceId(source),
      label: source.title,
    },
    timeHint: source.date,
    directory: rawDirectory(chunks),
    sections: [],
    missingSections,
    complete: false,
  };
  // Sections share what the rest of the response leaves in request order; a
  // section's unused share carries over to the ones after it.
  let remaining = KNOWLEDGE_OUTPUT_BUDGET_BYTES - outputBytes(response);
  pages.forEach(({ chunk, offset }, index) => {
    const share = Math.max(
      Math.floor(remaining / (pages.length - index)),
      MIN_SECTION_PAGE_BYTES,
    );
    const section = (length: number) => {
      const content = chunk.content.slice(offset, offset + length);
      const truncated = offset + content.length < chunk.content.length;
      return {
        id: chunk.id,
        title: chunk.heading.slice(0, 512),
        level: 2,
        offset,
        content,
        truncated,
        ...(truncated ? { nextOffset: offset + content.length } : {}),
      };
    };
    let length = fittingPrefix(
      chunk.content.length - offset,
      (count) => outputBytes(section(count)) + 1,
      share,
    );
    // A page never ends inside a surrogate pair, and never ends empty while
    // text remains.
    if (isHighSurrogate(chunk.content.charCodeAt(offset + length - 1)))
      length -= 1;
    if (length === 0 && offset < chunk.content.length)
      length = isHighSurrogate(chunk.content.charCodeAt(offset)) ? 2 : 1;
    const page = section(length);
    response.sections.push(page);
    remaining -= outputBytes(page) + 1;
  });
  response.complete =
    missingSections.length === 0 &&
    response.sections.every((section) => !section.truncated);
  return response;
}

function outputBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/** The largest count in [0, total] whose measured size stays within budget. */
function fittingPrefix(
  total: number,
  measure: (count: number) => number,
  budget: number,
): number {
  let [low, high] = [0, total];
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure(middle) <= budget) low = middle;
    else high = middle - 1;
  }
  return low;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
