import { storePocketNoteSource } from "../../src/memory/search/source-store.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sql: Object.assign(vi.fn(), {
    begin: vi.fn(),
    unsafe: vi.fn(),
    json: vi.fn((value: unknown) => value),
  }),
}));

import {
  MemoryChunkIndex,
  rankChunkCandidates,
  type ChunkCandidateRow,
} from "../../src/memory/chunk-index.js";

function candidate(
  chunk: string,
  source: string,
  lineStart: number,
  lineEnd = lineStart,
): ChunkCandidateRow {
  return {
    chunk_id: chunk,
    chunk_no: lineStart,
    document_id: source,
    heading_path: ["Section"],
    line_end: lineEnd,
    line_start: lineStart,
    score: 1,
  };
}

/** One local Raw source, as the Pocket Note writer publishes it. */
async function stagePocketNoteRaw(root: string, agentId: string) {
  const sessions = path.join(
    root,
    agentId,
    "memory-state/evidence/2026-09-29/sessions",
  );
  await fs.mkdir(sessions, { recursive: true });
  await fs.writeFile(path.join(sessions, "pocket-note.md"), "# Pocket Note\n");
  await storePocketNoteSource(
    root,
    {
      agentManagementId: agentId,
      tenantId: "tenant_1",
      representedHumanActorId: "human_1",
    },
    "2026-09-29",
    "# Source\n\nRequired evidence text.",
  );
}

describe("Memory chunk ranking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sql.mockResolvedValue([]);
  });

  it("adds the event window's keyword matches as one more vote", async () => {
    const pooled = (chunk: string, source: string) => ({
      ...candidate(chunk, source, 1),
      title: "",
      matched_terms: 1,
    });
    const queries: string[] = [];
    mocks.sql.mockImplementation(async (parts: TemplateStringsArray) => {
      const query = parts.join("?");
      queries.push(query);
      return query.includes("BETWEEN")
        ? [
            {
              ...candidate("chunk-b", "source-b", 1),
              source_date: "2026-06-10",
            },
          ]
        : [pooled("chunk-a", "source-a"), pooled("chunk-b", "source-b")];
    });
    const index = new MemoryChunkIndex({
      dataRoot: "/tmp/memory-test",
      sql: mocks.sql as never,
    });
    const search = (window: { event_from?: string; event_to?: string }) =>
      index.search({
        agent_id: "agent_1",
        tenant_id: "tenant_1",
        user_artifact_owner_actor_id: "human_1",
        query: "Cobalt launch",
        ...window,
      });
    try {
      expect((await search({}))[0]).toMatchObject({ chunkId: "chunk-a" });
      expect(queries).toHaveLength(1);
      expect(
        (await search({ event_from: "2026-06-01", event_to: "2026-06-30" }))[0],
      ).toMatchObject({ chunkId: "chunk-b", lexicalRank: 2 });
      const temporal = queries.find((query) => query.includes("BETWEEN"));
      // Only chunks that match the query's keywords enter through the window.
      expect(temporal).toContain("search_tsv @@ to_tsquery");
      expect(temporal).toContain("ts_rank_cd");
    } finally {
      await index.close();
    }
  });

  it("lets alternate wordings vote as extra lists", () => {
    const lexical = [
      candidate("chunk-a", "source-a", 1),
      candidate("chunk-b", "source-b", 1),
    ];
    const alternate = [
      candidate("chunk-b", "source-b", 1),
      candidate("chunk-c", "source-c", 1),
    ];
    const ranked = rankChunkCandidates(lexical, 10, [alternate]);
    expect(ranked[0]).toMatchObject({ chunkId: "chunk-b", lexicalRank: 2 });
  });

  it("deduplicates adjacent chunks and softly caps each source at three", () => {
    const lexical = [
      candidate("chunk-a1", "source-a", 1, 10),
      candidate("chunk-a2", "source-a", 10, 20),
      candidate("chunk-a3", "source-a", 100),
      candidate("chunk-a4", "source-a", 200),
      candidate("chunk-a5", "source-a", 300),
      candidate("chunk-b1", "source-b", 1),
    ];
    const ranked = rankChunkCandidates(lexical, 4);
    expect(ranked[0]?.mergedChunkIds).toEqual(["chunk-a1", "chunk-a2"]);
    expect(ranked.filter((item) => item.sourceId === "source-a")).toHaveLength(
      3,
    );
    expect(ranked.map((item) => item.sourceId)).toContain("source-b");
  });

  it("keeps identical chunk IDs from different source documents separate", () => {
    const ranked = rankChunkCandidates([
      candidate("chunk-same", "source-a", 1),
      candidate("chunk-same", "source-b", 1),
    ]);
    expect(ranked).toHaveLength(2);
  });

  it("rejects failed indexing instead of reporting a successful scan", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "wiki-chunk-failure-"),
    );
    await stagePocketNoteRaw(root, "agent_1");
    mocks.sql.mockImplementation(async (parts: TemplateStringsArray) => {
      const query = parts.join("");
      if (query.includes("clock_timestamp() AS scan_started_at"))
        return [{ scan_started_at: new Date() }];
      if (query.includes("SELECT source.active_sha256"))
        throw new Error("source read failed");
      return [];
    });
    const index = new MemoryChunkIndex({
      dataRoot: root,
      sql: mocks.sql as never,
    });
    try {
      await expect(index.syncAgent("agent_1")).rejects.toThrow(
        "reconciliation failed",
      );
    } finally {
      await index.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("continues later agents after one source reconciliation fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "chunk-agents-"));
    await fs.mkdir(path.join(root, "agent_1"));
    await fs.mkdir(path.join(root, "agent_2"));
    for (const agent of ["agent_1", "agent_2"]) {
      await stagePocketNoteRaw(root, agent);
    }
    const visited: unknown[] = [];
    mocks.sql.mockImplementation(
      async (parts: TemplateStringsArray, ...values: unknown[]) => {
        const query = parts.join("");
        if (query.includes("human_is_tenant_member"))
          return [{ agent_id: "agent_1" }, { agent_id: "agent_2" }];
        if (query.includes("SELECT source.active_sha256")) {
          visited.push(values[0]);
          if (visited.length === 1) throw new Error("first agent unavailable");
          return [{ scan_started_at: new Date() }];
        }
        return [];
      },
    );
    const index = new MemoryChunkIndex({
      dataRoot: root,
      sql: mocks.sql as never,
    });
    try {
      await expect(index.syncAll()).rejects.toThrow("Some agents failed");
      expect(visited).toHaveLength(2);
    } finally {
      await index.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("deletes database sources only for deleted Rooms when the Raw projection is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-chunk-sync-"));
    const index = new MemoryChunkIndex({
      dataRoot: root,
      sql: mocks.sql as never,
    });
    try {
      await expect(index.syncAgent("agent_1")).resolves.toMatchObject({
        indexed: 0,
        retired: 0,
      });
      const queries = mocks.sql.mock.calls.map(([parts]) =>
        (parts as TemplateStringsArray).join("?"),
      );
      expect(
        queries.filter((query) =>
          /DELETE FROM memory_index\.(sources|source_versions)/u.test(query),
        ),
      ).toEqual([expect.stringContaining("USING memory_source.deleted_rooms")]);
    } finally {
      await index.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("initialized user discovery and post-publication ingestion", () => {
  it("finds registered users without requiring a Wiki or a local Agent directory", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "raw-user-discovery-"),
    );
    mocks.sql.mockImplementation(async (parts: TemplateStringsArray) => {
      const query = parts.join("?");
      if (query.includes("human_is_tenant_member")) {
        expect(query).toContain("FROM memory_source.another_me_subjects");
        // Users with only My Pages, Pocket Notes or a Profile have no Wiki.
        expect(query).not.toContain("wiki");
        return [{ agent_id: "agent_new" }];
      }
      return [];
    });
    const index = new MemoryChunkIndex({
      dataRoot: root,
      sql: mocks.sql as never,
    });
    try {
      await expect(index.syncAll()).resolves.toMatchObject({ indexed: 0 });
      await expect(
        fs.stat(path.join(root, "updates/chunk-agent-locks/agent_new")),
      ).resolves.toBeDefined();
    } finally {
      await index.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("My Pages texts and PostgreSQL-safe content", () => {
  const good = {
    document_id: "document_good",
    text_source_kind: "file_version",
    text_source_id: "version_good",
    title: "",
    filename: "good.md",
    media_type: "text/markdown",
    origin_kind: "my_pages",
    folder_path: "",
    markdown_sha256: "a".repeat(64),
    created_at: new Date("2026-09-29T02:00:00Z"),
  };
  const documents = [
    good,
    {
      ...good,
      document_id: "document_empty",
      text_source_id: "version_empty",
      title: "Empty",
      filename: "empty.md",
    },
  ];

  function database(goodBody: string) {
    const versions: string[] = [];
    const stored = new Map<string, string>();
    const chunkContents: string[] = [];
    const tx = Object.assign(
      vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
        const query = parts.join("?");
        if (query.includes("UPDATE memory_index.sources"))
          return [{ id: "source" }];
        if (query.includes("INSERT INTO memory_index.source_versions")) {
          versions.push(values[3] as string);
          stored.set(
            `${String(values[0])}:${String(values[1])}`,
            values[3] as string,
          );
        }
        if (query.includes("SELECT content FROM memory_index.source_versions"))
          return [
            {
              content: stored.get(`${String(values[0])}:${String(values[1])}`),
            },
          ];
        if (query.includes("INSERT INTO memory_index.chunks"))
          chunkContents.push(values[7] as string);
        return [];
      }),
      { json: (value: unknown) => value },
    );
    mocks.sql.begin.mockImplementation(
      async (operation: (sql: typeof tx) => Promise<unknown>) => operation(tx),
    );
    mocks.sql.mockImplementation(async (parts: TemplateStringsArray) => {
      const query = parts.join("?");
      if (query.includes("represented_human_actor_id="))
        return [{ agent_id: "agent_a" }];
      if (query.includes("clock_timestamp() AS scan_started_at"))
        return [
          {
            tenant_id: "tenant_a",
            user_artifact_owner_actor_id: "owner_a",
            scan_started_at: new Date(),
          },
        ];
      if (query.includes("memory_source.personal_documents(")) return documents;
      if (query.includes("memory_source.personal_document_markdown("))
        return [
          { document_id: "document_good", markdown: goodBody },
          { document_id: "document_empty", markdown: "" },
        ];
      return [];
    });
    return { versions, chunkContents };
  }

  it("skips an empty text and indexes the good one", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "raw-texts-"));
    const db = database("# Good\n\nUseful evidence.\n");
    const index = new MemoryChunkIndex({
      dataRoot: root,
      sql: mocks.sql as never,
    });
    try {
      await index.syncAgent("agent_a");
      expect(db.versions).toEqual(["# Good\n\nUseful evidence.\n"]);
    } finally {
      await index.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("strips NUL and lone surrogates before hashing and storing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "raw-sanitize-"));
    const db = database("# Good\n\nBad\u0000 byte \ud800 here.\n");
    const index = new MemoryChunkIndex({
      dataRoot: root,
      sql: mocks.sql as never,
    });
    try {
      await index.syncAgent("agent_a");
      const stored = db.versions.find((value) => value.startsWith("# Good"));
      expect(stored).toBe("# Good\n\nBad byte \ufffd here.\n");
      expect(db.chunkContents.join("")).not.toContain("\u0000");
      expect(db.chunkContents.join("")).not.toMatch(/[\ud800-\udfff]/u);
    } finally {
      await index.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
