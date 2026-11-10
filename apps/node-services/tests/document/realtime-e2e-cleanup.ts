import { rm } from "node:fs/promises";
import { join } from "node:path";

import type { Sql, TransactionSql } from "postgres";

import type { RoomDocumentE2EFixture } from "./realtime-e2e-fixture.js";

interface CleanupContext {
  artifactRoot: string;
  sql: Sql;
}

interface CleanupScope {
  documentIds: string[];
  objectKeys: string[];
}

export function cleanupRoomDocumentE2EFixture(
  context: CleanupContext,
  fixture: RoomDocumentE2EFixture,
): Promise<void> {
  return cleanupRoom(context, fixture.room_id, fixture);
}

export function cleanupPartialRoomDocumentE2ERoom(
  context: CleanupContext,
  roomId: string,
): Promise<void> {
  return cleanupRoom(context, roomId);
}

async function cleanupRoom(
  context: CleanupContext,
  roomId: string,
  expectedFixture?: RoomDocumentE2EFixture,
): Promise<void> {
  const objectKeys = await context.sql.begin(async (transaction) => {
    const scope = await loadCleanupScope(transaction, roomId, expectedFixture);
    await transaction.unsafe("SET LOCAL session_replication_role = replica");

    await deleteRowsByScopedColumn(
      transaction,
      "document_id",
      scope.documentIds,
      new Set(["documents"]),
    );
    await deleteRowsByScopedColumn(
      transaction,
      "room_id",
      [roomId],
      new Set(["rooms"]),
    );
    await transaction`
      DELETE FROM command_replays
      WHERE resource_id = ${roomId}
         OR resource_id = ANY(${scope.documentIds})
    `;
    await transaction`DELETE FROM documents WHERE id = ANY(${scope.documentIds})`;
    await transaction`DELETE FROM rooms WHERE id = ${roomId}`;

    const remaining = await transaction<{ count: number }[]>`
      SELECT count(*)::integer AS count FROM rooms WHERE id = ${roomId}
    `;
    if (remaining[0]?.count !== 0) {
      throw new Error("Room Document E2E cleanup did not delete its Room");
    }
    return scope.objectKeys;
  });

  await Promise.all(
    objectKeys.map((key) =>
      rm(join(context.artifactRoot, key), { force: true }),
    ),
  );
}

async function deleteRowsByScopedColumn(
  transaction: TransactionSql,
  columnName: "document_id" | "room_id",
  ids: string[],
  excludedTables: Set<string>,
): Promise<void> {
  if (ids.length === 0) return;
  const tables = await transaction<Array<{ table_name: string }>>`
    SELECT c.table_name
    FROM information_schema.columns AS c
    JOIN information_schema.tables relation
      ON relation.table_schema=c.table_schema
     AND relation.table_name=c.table_name
     AND relation.table_type='BASE TABLE'
    WHERE c.table_schema='public' AND c.column_name=${columnName}
    ORDER BY c.table_name
  `;
  for (const { table_name: tableName } of tables) {
    if (excludedTables.has(tableName)) continue;
    if (!/^[a-z][a-z0-9_]*$/.test(tableName)) {
      throw new Error(`Refusing to clean unexpected table ${tableName}`);
    }
    await transaction.unsafe(
      `DELETE FROM "${tableName}" WHERE "${columnName}" = ANY($1::text[])`,
      [ids],
    );
  }
}

async function loadCleanupScope(
  sql: TransactionSql,
  roomId: string,
  expectedFixture?: RoomDocumentE2EFixture,
): Promise<CleanupScope> {
  const rooms = await sql<
    Array<{ id: string; name: string; tenant_id: string }>
  >`
    SELECT id,name,tenant_id FROM rooms
    WHERE id = ${roomId}
    FOR UPDATE
  `;
  const room = rooms[0];
  if (
    rooms.length !== 1 ||
    room === undefined ||
    room.tenant_id !== (expectedFixture?.tenant_id ?? "tenant_acme") ||
    !isCleanupName(room.name)
  ) {
    throw new Error("Refusing to clean a Room outside the E2E namespace");
  }

  const documents = await sql<Array<{ id: string }>>`
    SELECT document.id
    FROM documents document
    JOIN document_context_bindings binding
      ON binding.document_id=document.id
     AND binding.tenant_id=document.tenant_id
     AND binding.binding_kind='room'
     AND binding.room_id=${roomId}
    ORDER BY document.id
    FOR UPDATE OF document
  `;
  if (
    expectedFixture !== undefined &&
    !documents.some((document) => document.id === expectedFixture.document_id)
  ) {
    throw new Error("Room Document E2E fixture identity no longer matches");
  }
  const documentIds = documents.map((document) => document.id);
  const objects =
    documentIds.length === 0
      ? []
      : await sql<Array<{ object_key: string }>>`
          SELECT content_object_id AS object_key FROM document_assets
          WHERE document_id = ANY(${documentIds})
          UNION
          SELECT content_object_id AS object_key FROM document_versions
          WHERE document_id = ANY(${documentIds})
          ORDER BY object_key
        `;
  if (
    objects.some((object) => !/^object_[a-f0-9]{32}$/.test(object.object_key))
  ) {
    throw new Error(
      "Refusing to clean Document objects outside the E2E namespace",
    );
  }
  return {
    documentIds,
    objectKeys: objects.map((object) => object.object_key),
  };
}

function isCleanupName(name: string): boolean {
  return name.startsWith("E2E ");
}
