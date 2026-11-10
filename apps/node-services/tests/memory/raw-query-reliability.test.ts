import { describe, expect, it, vi } from "vitest";
import type { ChunkSearchInput } from "../../src/memory/chunk-index.js";
import type {
  SourceIdentity,
  RawSourceReference,
} from "../../src/memory/search/source-store.js";
import {
  RAW_BM25_FALLBACK_MAX_SOURCES,
  searchRawSources,
} from "../../src/memory/search/raw-query.js";
import { chunkSource } from "../../src/memory/search/chunks.js";
import {
  contentHash,
  type RawSource,
} from "../../src/memory/search/source-store.js";

const input = {
  agent_id: "agent",
  agent_actor_id: "actor",
  tenant_id: "tenant",
  user_artifact_owner_actor_id: "human",
  query: "older fact",
  date_from: "2026-01-01",
  date_to: "2026-12-31",
};
const content = "# Old evidence\n\nAn older fact absent from recent sources.";
const source: RawSource = {
  schemaVersion: 1,
  id: "old-source",
  identity: input,
  anchorPath: "memory/old.md",
  anchorHash: contentHash(content),
  contentHash: contentHash(content),
  title: "Old",
  sourceUri: "teamhub://rooms/old/messages",
  date: "2026-01-01",
};

describe("scoped Raw retrieval reliability", () => {
  it("searches the complete authorized scope before resolving only matching sources", async () => {
    const calls: string[] = [];
    const chunk = chunkSource(content)[0]!;
    const provider = {
      search: vi.fn(async (_input: ChunkSearchInput) => {
        expect(_input.query).toBe(input.query);
        calls.push("search");
        return [
          {
            chunkId: chunk.id,
            mergedChunkIds: [chunk.id],
            sourceId: source.id,
            score: 1,
          },
        ];
      }),
      resolveRawSources: vi.fn(
        async (
          _identity: SourceIdentity,
          references: readonly RawSourceReference[],
        ) => {
          calls.push("resolve");
          expect(references.map((r) => r.sourceId)).toEqual([source.id]);
          return [source];
        },
      ),
      readRawSource: vi.fn(async () => content),
    };
    const result = await searchRawSources("unused", input, provider);
    expect(calls).toEqual(["search", "resolve"]);
    expect(provider.search).toHaveBeenCalledWith(
      expect.objectContaining({
        date_from: input.date_from,
        date_to: input.date_to,
      }),
    );
    expect(provider.search.mock.calls[0]?.[0]).not.toHaveProperty("sourceIds");
    expect(result.matches[0]?.source.id).toBe("old-source");
  });

  it("scans only the newest sources when BM25 falls back, regardless of ID order", async () => {
    // The database lists newest first; IDs deliberately sort the other way.
    const sources = Array.from({ length: 40 }, (_, index) => {
      const text = index === 0 ? content : `# Note ${index}\n\nUnrelated text.`;
      return {
        ...source,
        id: `source-${String(99 - index).padStart(2, "0")}`,
        anchorHash: contentHash(text),
        contentHash: contentHash(text),
        text,
      };
    });
    const provider = {
      search: vi.fn(async () => []),
      resolveRawSources: vi.fn(async () => sources),
      readRawSource: vi.fn(
        async (_identity: SourceIdentity, raw: RawSource) =>
          sources.find(({ id }) => id === raw.id)!.text,
      ),
    };
    const result = await searchRawSources("unused", input, provider);
    expect(result.matches[0]?.source.id).toBe("source-99");
    expect(result.limited).toBe(true);
    expect(provider.readRawSource.mock.calls.map(([, raw]) => raw.id)).toEqual(
      sources.slice(0, RAW_BM25_FALLBACK_MAX_SOURCES).map(({ id }) => id),
    );
  });

  it.each(["search", "resolveRawSources", "readRawSource"] as const)(
    "marks %s failures as unavailable instead of rejecting or claiming no evidence",
    async (stage) => {
      const chunk = chunkSource(content)[0]!;
      const provider = {
        search: vi.fn(async () => [
          {
            chunkId: chunk.id,
            mergedChunkIds: [chunk.id],
            sourceId: source.id,
            score: 1,
          },
        ]),
        resolveRawSources: vi.fn(async () => [source]),
        readRawSource: vi.fn(async () => content),
      };
      provider[stage].mockRejectedValue(new Error("DB unavailable"));
      await expect(
        searchRawSources("unused", input, provider),
      ).resolves.toMatchObject({ unavailable: true, matches: [] });
    },
  );
});
