import { createHash } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readIndexedWiki } from "../../src/memory/wiki-index.js";

// Explicit opt-in to a disposable database that TeamHub migrations created.
const testDatabase = process.env.MEMORY_SOURCE_TEST_DATABASE_URL;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

describe.runIf(Boolean(testDatabase))(
  "published Wiki pages in the PostgreSQL index",
  () => {
    let sql: postgres.Sql;
    beforeAll(() => {
      const url = new URL(testDatabase!);
      if (
        url.pathname !== "/memory_source_test" ||
        !["127.0.0.1", "localhost"].includes(url.hostname)
      )
        throw new Error(
          "Use an isolated localhost memory_source_test database",
        );
      sql = postgres(testDatabase!, { max: 2, onnotice: () => undefined });
    });
    beforeEach(async () => {
      await sql.unsafe("TRUNCATE memory_index.sources CASCADE");
    });
    afterAll(async () => {
      await sql?.end({ timeout: 5 });
    });

    async function indexPage(
      n: number,
      pageKey: string,
      content: string,
      updatedAt: string,
    ) {
      const id = `mis_${n.toString(16).padStart(24, "0")}`;
      const hash = sha(content);
      await sql`
        INSERT INTO memory_index.sources (
          id, tenant_id, owner_id, agent_id, document_id, source_path, title,
          mime_type, active_sha256, index_profile, source_kind, origin_kind,
          source_uri, source_version, representation_format, metadata, state,
          created_at, updated_at
        ) VALUES (
          ${id}, 'tenant_1', 'human_1', 'agent_1', ${sha(id)}, ${pageKey},
          ${pageKey}, 'text/markdown', NULL, 'default', 'wiki_page', 'wiki',
          ${`wiki://${pageKey}`}, ${`v${n}`}, 'markdown',
          ${sql.json({ page_key: pageKey, document_version_id: `version_${n}` })},
          'active', ${updatedAt}, ${updatedAt}
        )`;
      await sql`
        INSERT INTO memory_index.source_versions (source_id, sha256, manifest, content, size_bytes)
        VALUES (${id}, ${hash}, ${sql.json({})}, ${content}, ${content.length})`;
      await sql`UPDATE memory_index.sources SET active_sha256 = ${hash} WHERE id = ${id}`;
    }

    it("reads the newest indexed version of each page in byte order", async () => {
      await indexPage(1, "sessions/b.md", "old b", "2026-11-01T00:00:00Z");
      await indexPage(2, "sessions/b.md", "new b", "2026-11-02T00:00:00Z");
      await indexPage(3, "Projects/a.md", "a", "2026-11-01T00:00:00Z");

      const wiki = await readIndexedWiki("tenant_1", "human_1", undefined, sql);

      expect(wiki.pages.map((page) => [page.key, page.content])).toEqual([
        ["Projects/a.md", "a"],
        ["sessions/b.md", "new b"],
      ]);
      expect(wiki.revision).toBeDefined();
    });
  },
);
