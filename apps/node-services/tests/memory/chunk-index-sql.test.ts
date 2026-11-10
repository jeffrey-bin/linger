import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { MemoryChunkIndex } from "../../src/memory/chunk-index.js";
import { searchRawSources } from "../../src/memory/search/raw-query.js";
import { chunkSource } from "../../src/memory/search/chunks.js";
import {
  contentHash,
  listRawSourcesForAgent,
  storePocketNoteSource,
} from "../../src/memory/search/source-store.js";

// Explicit opt-in to a disposable database that TeamHub migrations created;
// never reads TEAMHUB_DATABASE_URL or the application's .env.
const databaseUrl = process.env.MEMORY_CHUNK_TEST_DATABASE_URL;
const identity = {
  agent_id: "agent_1",
  tenant_id: "tenant_1",
  user_artifact_owner_actor_id: "human_1",
};
/**
 * The pool with its first transaction held until release, so a test can act
 * between an index's reads and its commit.
 */
function heldPool(sql: postgres.Sql) {
  let started!: () => void;
  const starting = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  const pool = new Proxy(sql, {
    get(target, property, receiver) {
      if (property !== "begin") return Reflect.get(target, property, receiver);
      return async (...args: unknown[]) => {
        if (!held) {
          held = true;
          started();
          await gate;
        }
        return (target.begin as (...input: unknown[]) => unknown)(...args);
      };
    },
  });
  return { pool, starting, release };
}
const original =
  "# Original\n\nCobalt evidence.\n\n## Obsolete\n\nRemove this old section.\n";
const replacement = "# Replacement\n\nSaffron evidence.\n";

describe.runIf(Boolean(databaseUrl))(
  "Chunk publication PostgreSQL transactions",
  () => {
    let sql: postgres.Sql;
    // The indexes share one pool, like the Memory role's.
    let indexSql: postgres.Sql;
    let root: string;
    let index: MemoryChunkIndex;
    beforeAll(async () => {
      const url = new URL(databaseUrl!);
      if (
        url.pathname !== "/memory_chunk_test" ||
        !["127.0.0.1", "localhost"].includes(url.hostname)
      )
        throw new Error("Use an isolated localhost memory_chunk_test database");
      sql = postgres(databaseUrl!, { max: 2 });
      indexSql = postgres(databaseUrl!, { max: 8 });
    });
    beforeEach(async () => {
      await sql.unsafe("TRUNCATE memory_index.sources CASCADE");
      root = await fs.mkdtemp(path.join(os.tmpdir(), "chunk-publication-sql-"));
      await fs.mkdir(path.join(root, identity.agent_id));
      index = new MemoryChunkIndex({
        dataRoot: root,
        sql: indexSql,
      });
    });
    afterEach(async () => {
      await index?.close();
      if (root) await fs.rm(root, { recursive: true, force: true });
    });
    afterAll(async () => {
      await sql?.end();
      await indexSql?.end();
    });

    it("finds old keyword evidence beyond 100 sources without relaxing dates or ownership", async () => {
      await publish("# Old\n\nUniqueRecallNeedle is 375000.", "2026-01-01");
      for (let i = 0; i < 114; i++)
        await publish(
          `# Recent ${i}\n\nUnrelated recent content.`,
          new Date(Date.UTC(2026, 1, 1 + i)).toISOString().slice(0, 10),
        );
      await index.syncAgent(identity.agent_id);
      // The persisted source title/path may be normalized; locate by immutable content instead.
      await sql`UPDATE memory_index.sources SET updated_at='2020-01-01' WHERE id IN (SELECT source_id FROM memory_index.source_versions WHERE content LIKE '%UniqueRecallNeedle%')`;
      const old = (
        await sql<
          { document_id: string }[]
        >`SELECT document_id FROM memory_index.sources ORDER BY updated_at LIMIT 1`
      )[0]!;
      const bounded = await index.resolveRawSources(identity, []);
      expect(bounded).toHaveLength(101);
      expect(bounded.some((s) => s.id === old.document_id)).toBe(false);
      const result = await searchRawSources(
        "unused",
        { ...identity, agent_actor_id: "actor_1", query: "UniqueRecallNeedle" },
        index,
      );
      expect(result.matches[0]?.source.id).toBe(old.document_id);
      expect(result.matches[0]?.chunk.content).toContain("375000");
      expect(
        await index.search({
          ...identity,
          query: "UniqueRecallNeedle",
          date_from: "2026-10-01",
        }),
      ).toEqual([]);
      expect(
        await index.search({
          ...identity,
          query: "UniqueRecallNeedle",
          tenant_id: "wrong",
        }),
      ).toEqual([]);
      expect(
        await index.search({
          ...identity,
          query: "UniqueRecallNeedle",
          user_artifact_owner_actor_id: "wrong",
        }),
      ).toEqual([]);
      expect(
        await index.search({
          ...identity,
          query: "UniqueRecallNeedle",
          sourceIds: [],
        }),
      ).toEqual([]);
    });

    it("finds a translated source through alternates and keeps an unchanged source", async () => {
      await publish(
        "# Wochenbesprechung\n\nDer Etat für das nächste Quartal beträgt 37.500 €.",
      );
      await index.syncAgent(identity.agent_id);
      expect(await index.search({ ...identity, query: "budget" })).toEqual([]);
      const [match] = await index.search({
        ...identity,
        query: "budget",
        alternates: ["Etat"],
      });
      expect(match?.sourceId).toBeDefined();
      expect(await index.syncAgent(identity.agent_id)).toMatchObject({
        indexed: 0,
      });
    });

    it("ranks keyword matches recorded inside the event window first", async () => {
      await publish(
        "# Early\n\nLanternfish launch review notes.",
        "2026-03-02",
      );
      await publish("# Late\n\nLanternfish launch review notes.", "2026-06-10");
      await publish("# Window\n\nUnrelated planning.", "2026-06-11");
      await index.syncAgent(identity.agent_id);
      const titles = async (window: {
        event_from?: string;
        event_to?: string;
      }) => {
        const matches = await index.search({
          ...identity,
          query: "Lanternfish",
          ...window,
        });
        const rows = await sql<{ document_id: string; title: string }[]>`
          SELECT document_id, title FROM memory_index.sources`;
        const byId = new Map(rows.map((row) => [row.document_id, row.title]));
        return matches.map((match) => byId.get(match.sourceId));
      };
      // Keywords alone tie; the window adds a vote only for its own period,
      // and a source without the keywords never enters through it.
      const early = await titles({
        event_from: "2026-03-01",
        event_to: "2026-03-31",
      });
      const late = await titles({
        event_from: "2026-06-01",
        event_to: "2026-06-30",
      });
      expect(early).toHaveLength(2);
      expect(late).toHaveLength(2);
      expect(early[0]).not.toBe(late[0]);
      expect(early[0]).toBe(late[1]);
    });

    // One Pocket Note Raw source per business date.
    async function publish(content: string, date = "2026-09-29") {
      const sessions = path.join(
        root,
        identity.agent_id,
        "memory-state/evidence",
        date,
        "sessions",
      );
      await fs.mkdir(sessions, { recursive: true });
      await fs.writeFile(path.join(sessions, "pocket-note.md"), "# Note\n");
      await storePocketNoteSource(
        root,
        {
          agentManagementId: identity.agent_id,
          tenantId: identity.tenant_id,
          representedHumanActorId: identity.user_artifact_owner_actor_id,
        },
        date,
        content,
      );
    }
    async function snapshot() {
      const workspace = path.join(root, identity.agent_id);
      const entries = (
        await fs.readdir(workspace, { recursive: true, withFileTypes: true })
      ).filter((entry) => entry.isFile());
      return Promise.all(
        entries.map(async (entry) => {
          const file = path.join(entry.parentPath, entry.name);
          return {
            file,
            text: await fs.readFile(file, "utf8"),
            mtime: (await fs.stat(file)).mtimeMs,
          };
        }),
      );
    }
    const chunks = () =>
      sql`SELECT source_id, id, source_sha256, content FROM memory_index.chunks ORDER BY source_id, chunk_no`;
    const sources = () =>
      sql`SELECT id, active_sha256 FROM memory_index.sources ORDER BY id`;

    it("publishes every chunk once and does not touch Raw files", async () => {
      await publish(original);
      const before = await snapshot();
      expect(await index.syncRawSources(identity.agent_id)).toBe(1);
      expect((await chunks()).length).toBe(chunkSource(original).length);
      expect(await snapshot()).toEqual(before);
      expect(await index.syncRawSources(identity.agent_id)).toBe(0);
    });

    it("fully replaces one source including removed chunks and old Raw while preserving other sources", async () => {
      await publish(original);
      await publish("# Other\n\nUntouched evidence.\n", "2026-09-30");
      await index.syncRawSources(identity.agent_id);
      const old = await chunks();
      const oldSource = old.find(
        (chunk) => chunk.source_sha256 === contentHash(original),
      )!.source_id;
      const other = old.filter((chunk) => chunk.source_id !== oldSource);
      await publish(replacement);
      const before = await snapshot();
      await index.syncRawSources(identity.agent_id);
      const current = await chunks();
      expect(current.filter((chunk) => chunk.source_id !== oldSource)).toEqual(
        other,
      );
      expect(
        current
          .filter((chunk) => chunk.source_id === oldSource)
          .map((chunk) => chunk.id),
      ).toEqual(chunkSource(replacement).map((chunk) => chunk.id));
      expect(
        current.some((chunk) => chunk.source_sha256 === contentHash(original)),
      ).toBe(false);
      // Readers only follow the active version, so the old one goes.
      const versions =
        await sql`SELECT content FROM memory_index.source_versions WHERE source_id = ${oldSource}`;
      expect(versions.map((version) => version.content)).toEqual([replacement]);
      expect(await snapshot()).toEqual(before);
    });

    it("keeps the old version readable until the replacement commits", async () => {
      await publish(original);
      await index.syncRawSources(identity.agent_id);
      const oldChunks = await chunks();
      const oldSources = await sources();
      await publish(replacement);
      const held = heldPool(indexSql);
      const slow = new MemoryChunkIndex({ dataRoot: root, sql: held.pool });
      const pending = slow.syncRawSources(identity.agent_id);
      try {
        await held.starting;
        expect(await sources()).toEqual(oldSources);
        expect(await chunks()).toEqual(oldChunks);
      } finally {
        held.release();
        await pending;
        await slow.close();
      }
      expect((await sources())[0]!.active_sha256).toBe(
        contentHash(replacement),
      );
    });

    it("rolls back the active pointer, Raw version and full chunk deletion on SQL insert failure", async () => {
      await publish(original);
      await index.syncRawSources(identity.agent_id);
      const oldChunks = await chunks();
      const oldSources = await sources();
      await publish(replacement);
      await sql.unsafe(`CREATE FUNCTION memory_index.reject_chunk() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected chunk failure'; END $$;
      CREATE TRIGGER reject_chunk BEFORE INSERT ON memory_index.chunks FOR EACH ROW EXECUTE FUNCTION memory_index.reject_chunk()`);
      try {
        await expect(index.syncRawSources(identity.agent_id)).rejects.toThrow(
          "injected chunk failure",
        );
        expect(await chunks()).toEqual(oldChunks);
        expect(await sources()).toEqual(oldSources);
        expect(
          await sql`SELECT sha256 FROM memory_index.source_versions`,
        ).toHaveLength(1);
      } finally {
        await sql.unsafe(
          "DROP TRIGGER reject_chunk ON memory_index.chunks; DROP FUNCTION memory_index.reject_chunk()",
        );
      }
    });

    it("repairs an already-published Raw hash whose old chunks were incorrectly considered current", async () => {
      await publish(original);
      await index.syncRawSources(identity.agent_id);
      await publish(replacement);
      const [source] = await listRawSourcesForAgent(
        path.join(root, identity.agent_id),
        identity.agent_id,
      );
      const [stored] = await sources();
      await sql`INSERT INTO memory_index.source_versions(source_id, sha256, manifest, content, size_bytes)
      VALUES (${stored!.id}, ${source!.contentHash}, ${sql.json(source! as unknown as postgres.JSONValue)}, ${replacement}, ${Buffer.byteLength(replacement)})`;
      await sql`UPDATE memory_index.sources SET active_sha256 = ${source!.contentHash} WHERE id = ${stored!.id}`;
      expect(await index.syncRawSources(identity.agent_id)).toBe(1);
      expect((await chunks()).map((chunk) => chunk.id)).toEqual(
        chunkSource(replacement).map((chunk) => chunk.id),
      );
    });

    it("does not let a slow writer delete or replace a newer committed source", async () => {
      await publish(original);
      await index.syncRawSources(identity.agent_id);
      await publish(replacement);
      const held = heldPool(indexSql);
      const slowIndex = new MemoryChunkIndex({
        dataRoot: root,
        sql: held.pool,
      });
      const slow = slowIndex.syncRawSources(identity.agent_id);
      // Independent workers have different projection roots. Using the same
      // root queues behind the filesystem lock and cannot exercise the DB CAS.
      const winnerRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "chunk-winner-"),
      );
      const winner = new MemoryChunkIndex({
        dataRoot: winnerRoot,
        sql: indexSql,
      });
      try {
        await held.starting;
        const newest = "# Latest\n\nThe concurrent winner.\n";
        await publish(newest);
        await fs.cp(
          path.join(root, identity.agent_id),
          path.join(winnerRoot, identity.agent_id),
          { recursive: true },
        );
        await winner.syncRawSources(identity.agent_id);
        const committed = await chunks();
        held.release();
        expect(await slow).toBe(0);
        expect(await chunks()).toEqual(committed);
        expect((await sources())[0]!.active_sha256).toBe(contentHash(newest));
        expect(
          await sql`SELECT sha256 FROM memory_index.source_versions`,
        ).toEqual([{ sha256: contentHash(newest) }]);
      } finally {
        held.release();
        await slow;
        await slowIndex.close();
        await winner.close();
        await fs.rm(winnerRoot, { recursive: true, force: true });
      }
    });

    it("retains database Raw and chunks without restoring a missing filesystem projection", async () => {
      await publish(original);
      await index.syncRawSources(identity.agent_id);
      const oldChunks = await chunks();
      const oldSources = await sources();
      const raw = path.join(root, identity.agent_id, "memory-state/raw");
      await fs.rm(raw, { recursive: true });
      await expect(index.syncAgent(identity.agent_id)).resolves.toMatchObject({
        indexed: 0,
        retired: 0,
      });
      expect(await chunks()).toEqual(oldChunks);
      expect(await sources()).toEqual(oldSources);
      expect(
        await sql`SELECT content FROM memory_index.source_versions`,
      ).toHaveLength(1);
      await expect(fs.stat(raw)).rejects.toMatchObject({ code: "ENOENT" });
    });
  },
);
