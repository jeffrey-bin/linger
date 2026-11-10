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
import { storePocketNoteSource } from "../../src/memory/search/source-store.js";
import { SessionFactIndex } from "../../src/memory/session-fact-index.js";
import type { ExtractedFact } from "../../src/memory/session-fact-extraction.js";
import { readTimelineEvents } from "../../src/memory/graph-visualization.js";

// Explicit opt-in: never reads TEAMHUB_DATABASE_URL or the application's .env.
// Explicit opt-in to a disposable database that TeamHub migrations created.
const databaseUrl = process.env.MEMORY_CHUNK_TEST_DATABASE_URL;
const identity = {
  agent_id: "agent_1",
  tenant_id: "tenant_1",
  user_artifact_owner_actor_id: "human_1",
};
const morning =
  "## 2026-05-24T01:00:00.000Z · Ann\n\nI cleaned my white Adidas last month and they look new.\n";
const afternoon = `${morning}\n## 2026-05-24T07:00:00.000Z · Ann\n\nMax is a Golden Retriever.\n`;
// Three messages of about 1,400 characters: the first two share one 3,000
// character extraction window, the third starts the next.
const long = (label: string) =>
  `${label} ${"The user described their week in more detail. ".repeat(28)}`;
const longDay = [
  "## 2026-05-24T01:00:00.000Z · Ann\n\nI cleaned my white Adidas last month and they look new. " +
    long("A"),
  "## 2026-05-24T02:00:00.000Z · Ann\n\n" + long("B"),
  "## 2026-05-24T03:00:00.000Z · Ann\n\n" + long("C"),
].join("\n\n");

describe.runIf(Boolean(databaseUrl))("Session facts in PostgreSQL", () => {
  let sql: postgres.Sql;
  // The indexes share one pool, like the Memory role's.
  let indexSql: postgres.Sql;
  let root: string;
  let chunks: MemoryChunkIndex;
  let facts: SessionFactIndex;
  const extracted: string[] = [];
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
    root = await fs.mkdtemp(path.join(os.tmpdir(), "session-facts-sql-"));
    await fs.mkdir(path.join(root, identity.agent_id));
    chunks = new MemoryChunkIndex({
      dataRoot: root,
      sql: indexSql,
    });
    extracted.length = 0;
    facts = new SessionFactIndex({
      sql: indexSql,
      sourceUris: "%",
      // Stand-in for the Hindsight-prompt model call, keyed on window text.
      extract: async (batch) =>
        new Map(
          batch.map(({ window }) => {
            extracted.push(window.text);
            return [
              window.sha256,
              [
                ...(window.text.includes("white Adidas") ? [shoes] : []),
                ...(window.text.includes("Golden Retriever") ? [dog] : []),
              ],
            ];
          }),
        ),
    });
    chunks.factIndex = facts;
  });
  afterEach(async () => {
    await chunks?.close();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });
  afterAll(async () => {
    await sql?.end();
    await indexSql?.end();
  });

  // The day's Raw is one Pocket Note source whose text is the transcript.
  async function stageRaw(owner: typeof identity, markdown: string) {
    const sessions = path.join(
      root,
      owner.agent_id,
      "memory-state/evidence/2026-05-24/sessions",
    );
    await fs.mkdir(sessions, { recursive: true });
    await fs.writeFile(path.join(sessions, "pocket-note.md"), "# Note\n");
    await storePocketNoteSource(
      root,
      {
        agentManagementId: owner.agent_id,
        tenantId: owner.tenant_id,
        representedHumanActorId: owner.user_artifact_owner_actor_id,
      },
      "2026-05-24",
      markdown,
    );
  }
  async function publishRaw(markdown: string) {
    await stageRaw(identity, markdown);
    await chunks.syncAgent(identity.agent_id);
  }
  const shoes = {
    what: "User cleaned white Adidas sneakers in April 2026",
    when: "April 2026",
    where: "N/A",
    who: "user",
    why: "N/A",
    fact_kind: "event",
    fact_type: "world",
    occurred_start: "2026-04-01",
    occurred_end: "2026-04-30",
    entities: ["user", "white Adidas"],
  } satisfies ExtractedFact;
  const dog = {
    what: "Max (user's dog) is a Golden Retriever",
    when: "N/A",
    where: "N/A",
    who: "Max (user's dog)",
    why: "N/A",
    fact_kind: "conversation",
    fact_type: "world",
    entities: ["Max", "Golden Retriever"],
  } satisfies ExtractedFact;
  const shoesText =
    "User cleaned white Adidas sneakers in April 2026 | When: April 2026 | Involving: user";
  const dogText =
    "Max (user's dog) is a Golden Retriever | Involving: Max (user's dog)";

  it("extracts facts from Raw windows with message time and recalls them by keywords in the event window", async () => {
    await publishRaw(morning);
    expect(await facts.syncAgent(identity.agent_id)).toMatchObject({
      sources: 1,
      windows: 1,
      extracted: 1,
      facts: 1,
      failed: 0,
    });
    const [row] = await sql<
      {
        chunk_id: string;
        mentioned_at: Date;
        speaker: string;
        occurred_start: string;
      }[]
    >`
      SELECT chunk_id, mentioned_at, speaker, occurred_start::text FROM memory_index.session_facts`;
    expect(row).toMatchObject({ speaker: "Ann", occurred_start: "2026-04-01" });
    expect(new Date(row!.mentioned_at).toISOString()).toBe(
      "2026-05-24T01:00:00.000Z",
    );
    const [hit] = await chunks.searchFacts({
      ...identity,
      query: "which Adidas did I clean",
      event_from: "2026-04-01",
      event_to: "2026-04-30",
    });
    expect(hit).toMatchObject({
      text: shoesText,
      entities: ["user", "white Adidas"],
      occurredStart: "2026-04-01",
      mentionedAt: "2026-05-24T01:00:00.000Z",
      evidenceId: expect.stringMatching(/^raw_[a-f0-9]{16}_[a-f0-9]{16}$/u),
      sectionId: row!.chunk_id,
    });
  });

  it("lists only current, owned, precisely dated past events in the timeline", async () => {
    await publishRaw(morning);
    await facts.syncAgent(identity.agent_id);
    await sql`UPDATE memory_index.session_facts SET occurred_start = '2001-04-01', occurred_end = '2001-04-30', mentioned_at = '2001-05-24'`;
    expect(
      await readTimelineEvents("tenant_1", "human_1", "agent_1", sql),
    ).toEqual([]);
    await sql`UPDATE memory_index.session_facts SET occurred_end = occurred_start`;
    const events = await readTimelineEvents(
      "tenant_1",
      "human_1",
      "agent_1",
      sql,
    );
    expect(events).toEqual([
      expect.objectContaining({ day: "2001-04-01", title: shoesText }),
    ]);
    expect(
      await readTimelineEvents("tenant_1", "other", "agent_1", sql),
    ).toEqual([]);
    expect(
      await readTimelineEvents("other", "human_1", "agent_1", sql),
    ).toEqual([]);
    expect(
      await readTimelineEvents("tenant_1", "human_1", "other", sql),
    ).toEqual([]);
    await sql`UPDATE memory_index.session_facts SET mentioned_at = '2001-03-01'`;
    expect(
      await readTimelineEvents("tenant_1", "human_1", "agent_1", sql),
    ).toEqual([]);
    await sql`UPDATE memory_index.session_facts SET mentioned_at = '2001-05-24'`;
    await sql`UPDATE memory_index.sources SET state = 'failed'`;
    expect(
      await readTimelineEvents("tenant_1", "human_1", "agent_1", sql),
    ).toEqual([]);
  });

  it("recalls facts through alternates", async () => {
    await publishRaw(afternoon);
    await facts.syncAgent(identity.agent_id);
    expect(await chunks.searchFacts({ ...identity, query: "puppy" })).toEqual(
      [],
    );
    const hits = await chunks.searchFacts({
      ...identity,
      query: "puppy",
      alternates: ["Golden Retriever"],
    });
    expect(hits.map(({ text }) => text)).toEqual([dogText]);
  });

  it("ranks keyword facts inside the event window first and never adds others", async () => {
    await publishRaw(afternoon);
    await facts.syncAgent(identity.agent_id);
    const search = (window: { event_from?: string; event_to?: string }) =>
      chunks.searchFacts({ ...identity, query: "Max Adidas", ...window });
    // The shoe event happened in April; the dog fact was only mentioned in May.
    expect(
      (await search({ event_from: "2026-04-01", event_to: "2026-04-30" })).map(
        ({ text }) => text,
      ),
    ).toEqual([shoesText, dogText]);
    expect(
      (
        await chunks.searchFacts({
          ...identity,
          query: "Retriever",
          event_from: "2026-04-01",
          event_to: "2026-04-30",
        })
      ).map(({ text }) => text),
    ).toEqual([dogText]);
  });

  it("keeps Raw candidates identical whether fact recall is on or off", async () => {
    await publishRaw(afternoon);
    await facts.syncAgent(identity.agent_id);
    const input = {
      ...identity,
      agent_actor_id: "actor_1",
      query: "Max Golden Retriever white Adidas",
      event_from: "2026-04-01",
      event_to: "2026-04-30",
    };
    const withFacts = await searchRawSources("unused", input, chunks);
    chunks.factIndex = undefined;
    const withoutFacts = await searchRawSources("unused", input, chunks);
    expect(withFacts).toEqual(withoutFacts);
  });

  it("sends an Agent's pending windows to its owner's Runtime in batches", async () => {
    const other = { ...identity, agent_id: "agent_2" };
    await fs.mkdir(path.join(root, other.agent_id));
    await stageRaw(other, longDay);
    await chunks.syncAgent(other.agent_id);
    const batches: number[] = [];
    const owners: unknown[] = [];
    const batched = new SessionFactIndex({
      sql: indexSql,
      sourceUris: "%",
      extract: async (batch, owner) => {
        batches.push(batch.length);
        owners.push(owner);
        return new Map(batch.map(({ window }) => [window.sha256, []]));
      },
    });
    expect((await batched.syncAgent(other.agent_id)).extracted).toBe(2);
    expect(batches).toEqual([2]);
    expect(owners).toEqual([
      {
        tenantId: other.tenant_id,
        ownerActorId: other.user_artifact_owner_actor_id,
      },
    ]);
  });

  it("extracts only changed windows and re-binds kept facts to a new Raw version", async () => {
    await publishRaw(longDay);
    expect(await facts.syncAgent(identity.agent_id)).toMatchObject({
      windows: 2,
      extracted: 2,
      facts: 1,
    });
    // Unchanged content is never extracted twice.
    expect((await facts.syncAgent(identity.agent_id)).extracted).toBe(0);

    // A new message changes only the last window; the first keeps its fact.
    await publishRaw(
      `${longDay}\n\n## 2026-05-24T07:00:00.000Z · Ann\n\nMax is a Golden Retriever.\n`,
    );
    extracted.length = 0;
    expect(await facts.syncAgent(identity.agent_id)).toMatchObject({
      windows: 2,
      extracted: 1,
      facts: 1,
    });
    expect(extracted).toHaveLength(1);
    expect(extracted[0]).toContain("Golden Retriever");
    const bound = await sql<{ text: string }[]>`
      SELECT fact.text FROM memory_index.session_facts fact
      JOIN memory_index.sources source
        ON source.id = fact.source_id AND source.active_sha256 = fact.source_sha256
      JOIN memory_index.chunks chunk
        ON chunk.id = fact.chunk_id AND chunk.source_sha256 = fact.source_sha256
      ORDER BY fact.text`;
    expect(bound.map(({ text }) => text)).toEqual([
      "Max (user's dog) is a Golden Retriever | Involving: Max (user's dog)",
      shoesText,
    ]);
  });
});
