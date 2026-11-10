import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { documentBodyStore } from "../../src/document/bodies.js";

// Explicit opt-in to a disposable localhost database; the test works in its
// own schema with just the columns the body store reads and writes.
const testDatabase = process.env.MEMORY_SOURCE_TEST_DATABASE_URL;

describe.runIf(Boolean(testDatabase))(
  "Document body store in PostgreSQL",
  () => {
    let sql: postgres.Sql;
    beforeAll(async () => {
      const url = new URL(testDatabase!);
      if (
        url.pathname !== "/memory_source_test" ||
        !["127.0.0.1", "localhost"].includes(url.hostname)
      )
        throw new Error(
          "Use an isolated localhost memory_source_test database",
        );
      const admin = postgres(testDatabase!, {
        max: 1,
        onnotice: () => undefined,
      });
      await admin.unsafe(`
        DROP SCHEMA IF EXISTS document_body_store_test CASCADE;
        CREATE SCHEMA document_body_store_test;
        CREATE TABLE document_body_store_test.documents (
          id text PRIMARY KEY, status text NOT NULL, format text NOT NULL);
        CREATE TABLE document_body_store_test.document_bodies (
          document_id text PRIMARY KEY, seq bigint NOT NULL, state bytea NOT NULL,
          state_vector bytea NOT NULL, asset_ids text[] NOT NULL DEFAULT '{}',
          thread_ids text[] NOT NULL DEFAULT '{}',
          last_editor_ids text[] NOT NULL DEFAULT '{}',
          server_operations jsonb NOT NULL DEFAULT '[]',
          updated_at timestamptz NOT NULL DEFAULT now());
        INSERT INTO document_body_store_test.documents VALUES ('document_pg', 'active', 'blocknote');
        INSERT INTO document_body_store_test.document_bodies (document_id, seq, state, state_vector)
          VALUES ('document_pg', 0, '\\x00', '\\x00');
      `);
      await admin.end({ timeout: 5 });
      sql = postgres(testDatabase!, {
        max: 2,
        onnotice: () => undefined,
        connection: { search_path: "document_body_store_test" },
      });
    });
    afterAll(async () => {
      // The store closed its client; drop the schema on a new connection.
      const admin = postgres(testDatabase!, {
        max: 1,
        onnotice: () => undefined,
      });
      await admin.unsafe(
        "DROP SCHEMA IF EXISTS document_body_store_test CASCADE",
      );
      await admin.end({ timeout: 5 });
    });

    it("finds each server change after a later one saved", async () => {
      const store = documentBodyStore(sql);
      for (const [baseSeq, id] of [
        [0, "operation_first"],
        [1, "operation_second"],
      ] as const) {
        await expect(
          store.save({
            documentId: "document_pg",
            baseSeq,
            state: Uint8Array.from([baseSeq + 1]),
            stateVector: Uint8Array.from([baseSeq + 1]),
            assetIds: [],
            threadIds: [],
            editorIds: ["actor_agent"],
            historyPoints: false,
            operation: { id, title: `Title ${id}` },
          }),
        ).resolves.toEqual({ kind: "saved", seq: baseSeq + 1 });
      }
      await expect(
        store.findOperation("document_pg", "operation_first"),
      ).resolves.toMatchObject({ seq: 1, title: "Title operation_first" });
      await expect(
        store.findOperation("document_pg", "operation_second"),
      ).resolves.toMatchObject({ seq: 2, title: "Title operation_second" });
      await store.close();
    });
  },
);
