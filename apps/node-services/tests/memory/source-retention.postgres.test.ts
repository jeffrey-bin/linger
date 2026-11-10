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
import { storeSessionSource } from "../../src/memory/search/source-store.js";
import type { SessionlyCollection } from "../../src/memory/types.js";

// Explicit opt-in to a disposable database that TeamHub migrations created.
// Memory reads Room and Agent lifecycle only through the memory_source views,
// so fixtures go into the TeamHub tables.
const testDatabase = process.env.MEMORY_SOURCE_TEST_DATABASE_URL;

describe.runIf(Boolean(testDatabase))(
  "Memory source retention in PostgreSQL",
  () => {
    let sql: postgres.Sql;
    let root: string;
    let index: MemoryChunkIndex;
    beforeAll(() => {
      const url = new URL(testDatabase!);
      if (
        url.pathname !== "/memory_source_test" ||
        !["127.0.0.1", "localhost"].includes(url.hostname)
      )
        throw new Error(
          "Use an isolated localhost memory_source_test database",
        );
      sql = postgres(testDatabase!, { max: 4, onnotice: () => undefined });
    });
    beforeEach(async () => {
      await sql.unsafe(`
      TRUNCATE memory_index.sources CASCADE;
      TRUNCATE accounts, actors CASCADE;
      INSERT INTO accounts(id,email,password_hash) VALUES ('account_1','retention-alice@example.com','x'), ('account_2','retention-bob@example.com','x');
      INSERT INTO actors(id,tenant_id,kind,display_name,account_id,handle) VALUES
        ('human_1','tenant_1','human','Alice','account_1',NULL), ('human_2','tenant_1','human','Bob','account_2',NULL),
        ('agent_actor','tenant_1','agent','Agent',NULL,'retention-agent'), ('agent_actor_2','tenant_1','agent','Agent 2',NULL,'retention-agent-2');
      INSERT INTO agent_registrations(actor_id,tenant_id,agent_management_id,status,instructions,runtime_model,created_by_actor_id,agent_type,represented_human_actor_id,computer_id,local_runtime_type,workspace_grant_id) VALUES
        ('agent_actor','tenant_1','agent_1','active','Remember.','test-model','human_1','anotherme','human_1','computer_1','codex','grant_1'),
        ('agent_actor_2','tenant_1','agent_2','active','Remember.','test-model','human_2','anotherme','human_2','computer_1','codex','grant_2');
      INSERT INTO rooms(id,tenant_id,name,created_by_actor_id) VALUES
        ('room_kept','tenant_1','Kept','human_1'), ('room_gone','tenant_1','Gone','human_1');
    `);
      root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-retention-"));
      index = new MemoryChunkIndex({
        dataRoot: root,
        sql,
      });
    });
    afterEach(async () => {
      await index?.close();
      if (root) await fs.rm(root, { recursive: true, force: true });
    });
    afterAll(async () => {
      await sql?.end({ timeout: 5 });
    });

    async function storeSession(
      agentId: string,
      humanId: string,
      roomId: string,
      body: string,
    ) {
      const date = "2026-09-15";
      const anchor = path.join(
        root,
        agentId,
        "memory-state/evidence",
        date,
        "sessions",
        `${roomId}.md`,
      );
      await fs.mkdir(path.dirname(anchor), { recursive: true });
      await fs.writeFile(anchor, `# ${roomId}\n`);
      const collection: SessionlyCollection = {
        schemaVersion: 1,
        date,
        timeZone: "Asia/Shanghai",
        generatedAt: `${date}T00:00:00Z`,
        source: { teamhubDatabaseUrlSet: true, memoryRoot: root },
        subjects: [
          {
            tenantId: "tenant_1",
            agentActorId: `actor_${agentId}`,
            agentManagementId: agentId,
            agentDisplayName: "Agent",
            representedHumanActorId: humanId,
            representedHumanDisplayName: "Human",
            representedHumanAccountId: null,
            memorySubjectKey: agentId,
          },
        ],
        rooms: [
          {
            tenantId: "tenant_1",
            roomId,
            roomName: roomId,
            agentActorId: `actor_${agentId}`,
            agentManagementId: agentId,
            representedHumanActorId: humanId,
            memorySubjectKey: agentId,
            relation: {
              agentIsMember: true,
              representedHumanIsMember: true,
              agentIsCreator: false,
              representedHumanIsCreator: true,
              includedBecause: ["represented_human_member"],
            },
            messages: [
              {
                id: `message_${roomId}`,
                roomId,
                authorActorId: humanId,
                authorDisplayName: "Human",
                authorKind: "human",
                messageKind: "text",
                createdAt: `${date}T10:00:00+08:00`,
                attachments: [],
                body,
              },
            ],
          },
        ],
        sourceCursor: {
          after: {
            messageId: `message_${roomId}`,
            createdAt: `${date}T10:00:00+08:00`,
          },
        },
      };
      await storeSessionSource(root, collection);
      return path.join(root, agentId, "memory-state/raw/2026/09/15", roomId);
    }

    const search = async (query: string) =>
      (
        await searchRawSources(
          "unused",
          {
            agent_id: "agent_1",
            agent_actor_id: "actor_agent_1",
            tenant_id: "tenant_1",
            user_artifact_owner_actor_id: "human_1",
            query,
          },
          index,
        )
      ).matches.map((match) => match.chunk.content);

    it("deletes a deleted Room's Session source, local Raw included, so Raw search misses it", async () => {
      const kept = await storeSession(
        "agent_1",
        "human_1",
        "room_kept",
        "Cobalt budget is 37.5.",
      );
      const gone = await storeSession(
        "agent_1",
        "human_1",
        "room_gone",
        "Saffron launch moved to Friday.",
      );
      await index.syncAgent("agent_1");
      expect(
        (await search("Saffron")).some((text) => text.includes("Saffron")),
      ).toBe(true);
      expect(
        await sql`SELECT room_id FROM memory_index.sources ORDER BY room_id`,
      ).toEqual([{ room_id: "room_gone" }, { room_id: "room_kept" }]);

      await sql`UPDATE rooms SET deletion_started_at=now(), deletion_started_by_actor_id='human_1',
        deleted_at=now(),
        deleted_by_actor_id='human_1' WHERE id='room_gone'`;
      await expect(index.syncAgent("agent_1")).resolves.toMatchObject({
        retired: 1,
      });

      expect(
        (await search("Saffron")).some((text) => text.includes("Saffron")),
      ).toBe(false);
      expect(
        (await search("Cobalt")).some((text) => text.includes("Cobalt")),
      ).toBe(true);
      expect(
        await sql`SELECT room_id FROM memory_index.sources ORDER BY room_id`,
      ).toEqual([{ room_id: "room_kept" }]);
      expect(
        await sql`SELECT 1 FROM memory_index.chunks WHERE content LIKE '%Saffron%'`,
      ).toHaveLength(0);
      await expect(fs.stat(gone)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(kept)).resolves.toBeDefined();
    });

    it("deletes a revoked Another Me's sources and keeps the others", async () => {
      await storeSession("agent_1", "human_1", "room_kept", "Alice notes.");
      await storeSession("agent_2", "human_2", "room_kept", "Bob notes.");
      await index.syncAgent("agent_1");
      await index.syncAgent("agent_2");
      await sql`UPDATE agent_registrations SET status='revoked' WHERE agent_management_id='agent_2'`;
      await expect(index.syncAll()).resolves.toMatchObject({ retired: 1 });

      expect(
        await sql`SELECT agent_id FROM memory_index.sources ORDER BY agent_id`,
      ).toEqual([{ agent_id: "agent_1" }]);
    });
  },
);
