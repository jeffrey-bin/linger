import fs from "node:fs/promises";
import type postgres from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncMyPagesChunkSources } from "../../src/memory/my-pages-chunk-sources.js";
import { contentHash } from "../../src/memory/search/source-store.js";

const identity = {
  agent_id: "agent_1",
  tenant_id: "tenant_1",
  user_artifact_owner_actor_id: "human_1",
};
const markdown = "# Document\n\nUnchanged original evidence.\n";
const document = {
  document_id: "document_1",
  text_source_kind: "file_version",
  text_source_id: "version_1",
  title: "Document",
  filename: "document.md",
  media_type: "text/markdown",
  origin_kind: "my_pages",
  folder_path: "Personal",
  markdown_sha256: contentHash(markdown),
  // 01:00 on 2026-09-30 in the tests' time zone, still 2026-09-29 in UTC.
  created_at: new Date("2026-09-29T17:00:00Z"),
};
const scanStartedAt = new Date("2026-09-29T00:00:00Z");

afterEach(() => vi.restoreAllMocks());

function fixture(cached = false, documents = [document]) {
  const sql = vi.fn(async (parts: TemplateStringsArray) => {
    const query = parts.join("?");
    if (query.includes("clock_timestamp() AS scan_started_at"))
      return [{ ...identity, scan_started_at: scanStartedAt }];
    if (query.includes("memory_source.personal_documents(")) return documents;
    if (query.includes("memory_source.personal_document_markdown("))
      return documents.map((entry) => ({
        document_id: entry.document_id,
        markdown,
      }));
    if (query.includes("version.content"))
      return cached
        ? [{ document_id: document.document_id, content: markdown }]
        : [];
    return [];
  });
  Object.assign(sql, { json: (value: unknown) => value });
  const ingest = vi.fn(async () => true);
  return {
    sql,
    ingest,
    options: {
      agentId: identity.agent_id,
      ingest,
      sql: sql as unknown as postgres.Sql,
    },
  };
}

function queries(test: ReturnType<typeof fixture>): string[] {
  return test.sql.mock.calls.map(([parts]) => parts.join("?"));
}

describe("read-only Document chunk ingestion", () => {
  it("indexes TeamHub's normalized Markdown without writing files", async () => {
    const writes = [
      vi.spyOn(fs, "writeFile"),
      vi.spyOn(fs, "rename"),
      vi.spyOn(fs, "unlink"),
      vi.spyOn(fs, "rm"),
      vi.spyOn(fs, "mkdir"),
    ];
    const test = fixture();
    await expect(syncMyPagesChunkSources(test.options)).resolves.toMatchObject({
      indexed: 1,
      retired: 0,
    });
    expect(test.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        identity,
        sourceVersion: "version_1",
        contentHash: contentHash(markdown),
        // The version's local date, not its UTC date.
        date: "2026-09-30",
        metadata: expect.objectContaining({ document_id: "document_1" }),
      }),
      markdown,
    );
    for (const write of writes) expect(write).not.toHaveBeenCalled();
  });

  it("indexes imported mail as its own origin", async () => {
    const test = fixture(false, [
      { ...document, origin_kind: "mail", folder_path: "" },
    ]);
    await expect(syncMyPagesChunkSources(test.options)).resolves.toMatchObject({
      indexed: 1,
    });
    const [source] = test.ingest.mock.calls[0]! as unknown as [
      { originKind: string; metadata: Record<string, string> },
    ];
    expect(source.originKind).toBe("mail");
    expect(source.metadata).not.toHaveProperty("folder_path");
  });

  it("reads no Markdown for a Document whose indexed text is current", async () => {
    const test = fixture(true);
    await syncMyPagesChunkSources(test.options);
    expect(
      queries(test).some((query) =>
        query.includes("memory_source.personal_document_markdown("),
      ),
    ).toBe(false);
    expect(test.ingest).toHaveBeenCalledWith(expect.anything(), markdown);
  });

  it("names a native Document by its body without a Version", async () => {
    const test = fixture(false, [
      { ...document, text_source_kind: "native_body", text_source_id: "12" },
    ]);
    await syncMyPagesChunkSources(test.options);
    const [source] = test.ingest.mock.calls[0]! as unknown as [
      { sourceUri: string; sourceVersion: string },
    ];
    expect(source).toMatchObject({
      sourceUri: "teamhub://documents/document_1",
      sourceVersion: "12",
    });
  });

  it("deletes scoped sources of documents missing from the authoritative inventory", async () => {
    const test = fixture(false, []);
    await syncMyPagesChunkSources(test.options);
    const deletes = queries(test).filter((query) =>
      query.includes("DELETE FROM memory_index.sources"),
    );
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toContain("updated_at <");
    expect(deletes[0]).toContain("origin_kind IN ('my_pages', 'mail')");
  });

  it("reports an ingestion failure without deleting the source", async () => {
    const test = fixture();
    test.ingest.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(syncMyPagesChunkSources(test.options)).rejects.toThrow(
      "My Pages Chunk ingestion failed for 1 source(s)",
    );
    const deletes = queries(test).filter((query) =>
      query.includes("DELETE FROM memory_index.sources"),
    );
    expect(deletes[0]).toContain("<> ALL(");
  });

  it("does nothing for an Agent that is not an Another Me", async () => {
    const sql = vi.fn(async () => []);
    Object.assign(sql, { json: (value: unknown) => value });
    const ingest = vi.fn(async () => true);
    await expect(
      syncMyPagesChunkSources({
        agentId: "agent_unknown",
        ingest,
        sql: sql as unknown as postgres.Sql,
      }),
    ).resolves.toEqual({ indexed: 0, retired: 0, skipped: 0 });
    expect(ingest).not.toHaveBeenCalled();
  });
});
