import { createHash } from "node:crypto";

import postgres from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  documentBodyStore,
  type DocumentBodySave,
} from "../../src/document/bodies.js";

const save: DocumentBodySave = {
  documentId: "document_store_unit",
  baseSeq: 4,
  state: Uint8Array.from([1, 2, 3]),
  stateVector: Uint8Array.from([9]),
  assetIds: [],
  threadIds: ["document_thread_unit"],
  editorIds: ["actor_a", "actor_b"],
  historyPoints: false,
};

// A stand-in for postgres.js that answers each statement in order and records
// the statement text, so a test can count what one save sends.
function scriptedSql(answers: Array<unknown[] | Error>) {
  const statements: string[] = [];
  const query = (parts: TemplateStringsArray) => {
    statements.push(parts.join("$").replaceAll(/\s+/g, " ").trim());
    const answer = answers.shift();
    if (answer === undefined) throw new Error("Unexpected statement");
    return answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve(answer);
  };
  const sql = Object.assign(query, {
    json: (value: unknown) => value,
    begin: async (run: (sql: unknown) => Promise<unknown>) => {
      statements.push("BEGIN");
      const result = await run(query);
      statements.push("COMMIT");
      return result;
    },
    end: async () => undefined,
  }) as unknown as postgres.Sql;
  return { sql, statements };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("Document body store", () => {
  it("saves with one UPDATE that checks the base sequence", async () => {
    const { sql, statements } = scriptedSql([[{ seq: "5" }]]);
    await expect(documentBodyStore(sql).save(save)).resolves.toEqual({
      kind: "saved",
      seq: 5,
    });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^UPDATE document_bodies SET seq=seq\+1,/);
    expect(statements[0]).toContain("WHERE document_id=$ AND seq=$");
  });

  it("reports a stale base when another writer saved first", async () => {
    const { sql, statements } = scriptedSql([
      [],
      [{ seq: "6", state_sha256: sha256(Uint8Array.from([7])) }],
    ]);
    await expect(documentBodyStore(sql).save(save)).resolves.toEqual({
      kind: "stale",
    });
    expect(statements).toHaveLength(2);
  });

  it("recognizes its own save when only the reply was lost", async () => {
    const { sql } = scriptedSql([
      [],
      [{ seq: "5", state_sha256: sha256(save.state) }],
    ]);
    await expect(documentBodyStore(sql).save(save)).resolves.toEqual({
      kind: "saved",
      seq: 5,
    });
  });

  it("rejects a save for a trashed Document", async () => {
    const { sql } = scriptedSql([[], []]);
    await expect(documentBodyStore(sql).save(save)).resolves.toEqual({
      kind: "rejected",
    });
  });

  it("rejects values the row refuses and rethrows connection failures", async () => {
    const refused = Object.assign(
      Object.create(postgres.PostgresError.prototype) as Error,
      { code: "23514", message: "check violation" },
    );
    await expect(
      documentBodyStore(scriptedSql([refused]).sql).save(save),
    ).resolves.toEqual({ kind: "rejected" });
    await expect(
      documentBodyStore(scriptedSql([new Error("ECONNRESET")]).sql).save(save),
    ).rejects.toThrow("ECONNRESET");
  });

  it("loads only an active native Document's body", async () => {
    const { sql, statements } = scriptedSql([
      [
        {
          permission_count: "2",
          seq: "4",
          state: Buffer.from([1]),
          state_vector: Buffer.from([2]),
          asset_ids: [],
          thread_ids: [],
          point_age_ms: "1000",
          unrecorded_age_ms: null,
        },
      ],
      [],
    ]);
    const store = documentBodyStore(sql);
    await expect(store.load("document_store_unit")).resolves.toMatchObject({
      permissionCount: 2,
      seq: 4,
    });
    await expect(store.load("document_store_missing")).resolves.toBeUndefined();
    expect(statements[0]).toContain(
      "document.status='active' AND document.format='blocknote'",
    );
  });
});

const rules = { idleAfterMs: 30_000, continuousAfterMs: 300_000 };
const editorSave: DocumentBodySave = { ...save, historyPoints: true };

function loadedRow(pointAgeMs: number, unrecordedAgeMs: number | null) {
  return {
    permission_count: "1",
    seq: "4",
    state: Buffer.from([1]),
    state_vector: Buffer.from([2]),
    asset_ids: [],
    thread_ids: [],
    point_age_ms: String(pointAgeMs),
    unrecorded_age_ms:
      unrecordedAgeMs === null ? null : String(unrecordedAgeMs),
  };
}

describe("Document History points", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a steady-state editor save to one UPDATE", async () => {
    vi.useFakeTimers();
    const { sql, statements } = scriptedSql([
      [loadedRow(1_000, null)],
      [{ seq: "5" }],
    ]);
    const store = documentBodyStore(sql, rules, () => Date.now());
    await store.load(save.documentId);
    await expect(store.save(editorSave)).resolves.toEqual({
      kind: "saved",
      seq: 5,
    });
    expect(statements.slice(1)).toHaveLength(1);
    expect(statements[1]).toMatch(/^UPDATE document_bodies SET/);
    await store.close();
  });

  it("records the continuous-editing point in the save transaction", async () => {
    vi.useFakeTimers();
    const { sql, statements } = scriptedSql([
      [loadedRow(1_000, null)],
      [{ seq: "5" }],
      [{ point: "document_revision_point", point_age_ms: "0" }],
      [{ seq: "6" }],
    ]);
    const store = documentBodyStore(sql, rules, () => Date.now());
    await store.load(save.documentId);
    vi.advanceTimersByTime(rules.continuousAfterMs);
    await store.save(editorSave);
    expect(statements.slice(1, 5)).toEqual([
      "BEGIN",
      expect.stringMatching(/^UPDATE document_bodies SET/),
      expect.stringContaining("record_document_history_point($,'idle')"),
      "COMMIT",
    ]);
    // The point just recorded makes the next save a single UPDATE again.
    await store.save({ ...editorSave, baseSeq: 5 });
    expect(statements.slice(5)).toEqual([
      expect.stringMatching(/^UPDATE document_bodies SET/),
    ]);
    await store.close();
  });

  it("records the idle point once saves stop", async () => {
    vi.useFakeTimers();
    const { sql, statements } = scriptedSql([
      [loadedRow(1_000, null)],
      [{ seq: "5" }],
      [{ seq: "6" }],
      [{ point: "document_revision_point", wait_ms: "0" }],
    ]);
    const store = documentBodyStore(sql, rules, () => Date.now());
    await store.load(save.documentId);
    await store.save(editorSave);
    await vi.advanceTimersByTimeAsync(rules.idleAfterMs - 1);
    await store.save({ ...editorSave, baseSeq: 5 });
    await vi.advanceTimersByTimeAsync(rules.idleAfterMs - 1);
    expect(statements).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(statements).toHaveLength(4);
    expect(statements[3]).toContain(
      "THEN record_document_history_point(body.document_id,'idle')",
    );
    await store.close();
  });

  it("waits again when the body was saved after the idle timer started", async () => {
    vi.useFakeTimers();
    const { sql, statements } = scriptedSql([
      [loadedRow(1_000, 0)],
      [{ point: null, wait_ms: "10000" }],
      [{ point: "document_revision_point", wait_ms: "0" }],
    ]);
    const store = documentBodyStore(sql, rules, () => Date.now());
    await store.load(save.documentId);
    await vi.advanceTimersByTimeAsync(rules.idleAfterMs);
    expect(statements).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(statements).toHaveLength(3);
    await store.close();
  });

  it("records a missed idle point when it loads an unrecorded body", async () => {
    vi.useFakeTimers();
    const { sql, statements } = scriptedSql([
      [loadedRow(600_000, 45_000)],
      [{ point: "document_revision_point", wait_ms: "0" }],
    ]);
    const store = documentBodyStore(sql, rules, () => Date.now());
    await store.load(save.documentId);
    await vi.advanceTimersByTimeAsync(0);
    expect(statements[1]).toContain("record_document_history_point");
    await store.close();
  });

  it("records on start the idle points a stopped Runtime missed", async () => {
    vi.useFakeTimers();
    const { sql, statements } = scriptedSql([
      [
        { document_id: "document_idle", unrecorded_age_ms: "45000" },
        { document_id: "document_recent", unrecorded_age_ms: "10000" },
      ],
      [{ point: "document_revision_idle", wait_ms: "0" }],
      [{ point: "document_revision_recent", wait_ms: "0" }],
    ]);
    const store = documentBodyStore(sql, rules, () => Date.now());
    await expect(store.recordUnrecordedPoints()).resolves.toBe(2);
    expect(statements[0]).toContain("cardinality(body.last_editor_ids)>0");
    await vi.advanceTimersByTimeAsync(0);
    expect(statements).toHaveLength(2);
    expect(statements[1]).toContain("record_document_history_point");
    await vi.advanceTimersByTimeAsync(rules.idleAfterMs - 10_000);
    expect(statements).toHaveLength(3);
    await store.close();
  });

  it("leaves the History point of a server change to TeamHub", async () => {
    vi.useFakeTimers();
    const { sql, statements } = scriptedSql([[{ seq: "5" }]]);
    const store = documentBodyStore(sql, rules, () => Date.now());
    await store.save(save);
    await vi.advanceTimersByTimeAsync(rules.idleAfterMs * 2);
    expect(statements).toHaveLength(1);
    await store.close();
  });

  it("records a server change's operation in its save UPDATE", async () => {
    const { sql, statements } = scriptedSql([[{ seq: "5" }]]);
    await documentBodyStore(sql).save({
      ...save,
      operation: { id: "document_semantic_mutation_unit", title: "Title" },
    });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("server_operations=CASE WHEN");
  });

  it("finds a server change the body already saved", async () => {
    const { sql } = scriptedSql([
      [
        {
          seq: "5",
          title: "Title",
          state_sha256: "a".repeat(64),
          asset_ids: [],
          thread_ids: ["document_thread_unit"],
        },
      ],
      [],
    ]);
    const store = documentBodyStore(sql);
    await expect(
      store.findOperation("document_store_unit", "operation_saved"),
    ).resolves.toEqual({
      seq: 5,
      title: "Title",
      stateHash: "a".repeat(64),
      assetIds: [],
      threadIds: ["document_thread_unit"],
    });
    await expect(
      store.findOperation("document_store_unit", "operation_new"),
    ).resolves.toBeUndefined();
  });
});
