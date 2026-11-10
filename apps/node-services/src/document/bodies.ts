import { sha256Hex } from "@linger/service-kit/node";
import postgres from "postgres";

import { documentLogger } from "./log.js";

/**
 * A native Document's online body as the Runtime loads it. The Runtime saves
 * every edit of it; TeamHub owns the table's migrations and creates
 * the row with the Document.
 */
export interface LoadedDocumentBody {
  permissionCount: number;
  seq: number;
  state: Uint8Array;
  stateVector: Uint8Array;
  assetIds: string[];
  threadIds: string[];
}

export interface DocumentBodySave {
  documentId: string;
  baseSeq: number;
  state: Uint8Array;
  stateVector: Uint8Array;
  assetIds: string[];
  threadIds: string[];
  // Distinct editors of the saved mutations, the last author last.
  editorIds: string[];
  // Editor saves record the idle and continuous-editing History points. A
  // server change does not: TeamHub records its point after the apply.
  historyPoints: boolean;
  // A server change saves its operation ID with the body, so a retry of the
  // same change finds it applied.
  operation?: { id: string; title: string };
}

/**
 * A server change already saved by an earlier attempt: the sequence and title
 * it saved, and the body's current hash and references.
 */
export interface AppliedDocumentOperation {
  seq: number;
  title: string;
  stateHash: string;
  assetIds: string[];
  threadIds: string[];
}

/**
 * When the Runtime records a History point of editor saves: after this long
 * without a save (idle), and on the first save this long after the previous
 * History point (continuous editing).
 */
export interface DocumentHistoryRules {
  idleAfterMs: number;
  continuousAfterMs: number;
}

export const documentHistoryRules: DocumentHistoryRules = {
  idleAfterMs: 30_000,
  continuousAfterMs: 5 * 60_000,
};

export type DocumentBodySaveResult =
  | { kind: "saved"; seq: number }
  // Another writer saved first; its committed update moves the resident head.
  | { kind: "stale" }
  // The Document was trashed or the row refused the values: retrying fails
  // the same way.
  | { kind: "rejected" };

export type DocumentReferenceCheck =
  | "available"
  | "asset_unavailable"
  | "thread_unknown"
  | "document_unavailable";

export interface DocumentBodyStore {
  // Undefined when the ID names no active native Document.
  load(documentId: string): Promise<LoadedDocumentBody | undefined>;
  save(input: DocumentBodySave): Promise<DocumentBodySaveResult>;
  // Undefined when the body has not saved this server change.
  findOperation(
    documentId: string,
    operationId: string,
  ): Promise<AppliedDocumentOperation | undefined>;
  // Checks Asset and Comment Thread references a frame adds to the Document.
  checkReferences(input: {
    documentId: string;
    assetIds: string[];
    threadIds: string[];
  }): Promise<DocumentReferenceCheck>;
  close(): Promise<void>;
}

/**
 * The body store the Runtime's worker owns. On start it records the idle
 * points of edits that a stopped Runtime saved but never recorded, because a
 * History point is also what queues the body's text for search, Memory and
 * the Wiki: without it those would keep the previous version until someone
 * opened the Document again.
 */
export interface RuntimeDocumentBodyStore extends DocumentBodyStore {
  // Resolves to the number of Documents whose idle point it armed.
  recordUnrecordedPoints(): Promise<number>;
}

/**
 * The Runtime's body store on TeamHub's database. It writes only
 * document_bodies, one UPDATE per steady-state save; a save is durable once
 * the UPDATE returns, which is when the Runtime sends the durable ACK. It also
 * decides the idle and continuous-editing History points and records them
 * with record_document_history_point, which copies the body row into a
 * Revision.
 */
export function createDocumentBodyStore(
  databaseUrl: string,
): RuntimeDocumentBodyStore {
  return documentBodyStore(
    postgres(databaseUrl, { connect_timeout: 10, idle_timeout: 30, max: 4 }),
  );
}

export function documentBodyStore(
  sql: postgres.Sql,
  rules: DocumentHistoryRules = documentHistoryRules,
  now: () => number = Date.now,
): RuntimeDocumentBodyStore {
  // When each Document's latest History point was recorded, as this process
  // last learned it. It only picks the save path: the transactional save
  // checks the rule again in the database. An entry older than the
  // continuous-editing time means the same as no entry, so remembering a
  // point drops those and the map holds only recently recorded points.
  const latestPointAt = new Map<string, number>();
  const idleTimers = new Map<string, NodeJS.Timeout>();

  function armIdlePoint(documentId: string, delayMs: number): void {
    clearTimeout(idleTimers.get(documentId));
    const timer = setTimeout(() => {
      idleTimers.delete(documentId);
      void recordIdlePoint(documentId);
    }, delayMs);
    timer.unref();
    idleTimers.set(documentId, timer);
  }

  // Records the idle point once the body has had no save for the idle time.
  // A body saved since then waits for the rest of it; a failure retries after
  // the idle time, and a Runtime that stops first records it on the next load.
  async function recordIdlePoint(documentId: string): Promise<void> {
    try {
      const rows = await sql<
        Array<{ point: string | null; wait_ms: string }>
      >`SELECT CASE WHEN body.updated_at<=clock_timestamp()-${rules.idleAfterMs}::bigint*interval '1 millisecond'
            THEN record_document_history_point(body.document_id,'idle') END AS point,
          greatest(0,ceil(date_part('epoch',body.updated_at+${rules.idleAfterMs}::bigint*interval '1 millisecond'
            -clock_timestamp())*1000))::bigint::text AS wait_ms
        FROM document_bodies body WHERE body.document_id=${documentId}`;
      const row = rows[0];
      if (row === undefined) return;
      if (row.point !== null) rememberPoint(documentId, now());
      else armIdlePoint(documentId, Number(row.wait_ms));
    } catch (error) {
      documentLogger().log("warn", "document.history_point_retry", {
        document_id: documentId,
        error_name: error instanceof Error ? error.name : "unknown",
      });
      armIdlePoint(documentId, rules.idleAfterMs);
    }
  }

  function rememberPoint(documentId: string, recordedAt: number): void {
    const oldest = now() - rules.continuousAfterMs;
    for (const [id, at] of latestPointAt)
      if (at <= oldest) latestPointAt.delete(id);
    if (recordedAt > oldest) latestPointAt.set(documentId, recordedAt);
  }

  function continuousPointDue(documentId: string): boolean {
    const recordedAt = latestPointAt.get(documentId);
    return (
      recordedAt === undefined || now() - recordedAt >= rules.continuousAfterMs
    );
  }

  return {
    async recordUnrecordedPoints() {
      // A History point clears the editors, so editors left on a body are
      // edits since its latest point.
      const rows = await sql<
        Array<{ document_id: string; unrecorded_age_ms: string }>
      >`SELECT body.document_id,
          floor(date_part('epoch',clock_timestamp()-body.updated_at)*1000)::bigint::text
            AS unrecorded_age_ms
        FROM document_bodies body
        JOIN documents document ON document.id=body.document_id
        WHERE cardinality(body.last_editor_ids)>0
          AND document.status='active' AND document.format='blocknote'`;
      for (const row of rows)
        armIdlePoint(
          row.document_id,
          Math.max(0, rules.idleAfterMs - Number(row.unrecorded_age_ms)),
        );
      return rows.length;
    },

    async load(documentId) {
      const rows = await sql<
        Array<{
          permission_count: string;
          seq: string;
          state: Buffer;
          state_vector: Buffer;
          asset_ids: string[];
          thread_ids: string[];
          point_age_ms: string;
          unrecorded_age_ms: string | null;
        }>
      >`SELECT permission.permission_count::text,body.seq::text,body.state,body.state_vector,
          body.asset_ids,body.thread_ids,
          floor(date_part('epoch',clock_timestamp()-coalesce(point.recorded_at,document.created_at))*1000)::bigint::text
            AS point_age_ms,
          CASE WHEN body.seq>coalesce(point.seq,-1)
            THEN floor(date_part('epoch',clock_timestamp()-body.updated_at)*1000)::bigint::text END
            AS unrecorded_age_ms
        FROM documents document
        JOIN document_permission_counts permission ON permission.document_id=document.id
        JOIN document_bodies body ON body.document_id=document.id
        LEFT JOIN LATERAL (SELECT revision.persisted_seq AS seq,revision.history_recorded_at AS recorded_at
          FROM document_revisions revision
          WHERE revision.document_id=document.id AND revision.history_trigger IS NOT NULL
          ORDER BY revision.persisted_seq DESC,revision.history_recorded_at DESC LIMIT 1) point ON true
        WHERE document.id=${documentId}
          AND document.status='active' AND document.format='blocknote'`;
      const row = rows[0];
      if (row === undefined) return undefined;
      rememberPoint(documentId, now() - Number(row.point_age_ms));
      // Edits after the latest History point that a stopped Runtime never
      // recorded get their idle point now or once the idle time has passed.
      if (row.unrecorded_age_ms != null)
        armIdlePoint(
          documentId,
          Math.max(0, rules.idleAfterMs - Number(row.unrecorded_age_ms)),
        );
      return {
        permissionCount: Number(row.permission_count),
        seq: Number(row.seq),
        state: new Uint8Array(row.state),
        stateVector: new Uint8Array(row.state_vector),
        assetIds: row.asset_ids,
        threadIds: row.thread_ids,
      };
    },

    async save(input) {
      let rows: Array<{ seq: string }>;
      try {
        rows =
          input.historyPoints && continuousPointDue(input.documentId)
            ? await saveWithContinuousPoint(input)
            : await updateBody(sql, input);
      } catch (error) {
        if (isDataRejection(error)) return { kind: "rejected" };
        throw error;
      }
      const saved = rows[0];
      if (saved !== undefined) {
        if (input.historyPoints)
          armIdlePoint(input.documentId, rules.idleAfterMs);
        return { kind: "saved", seq: Number(saved.seq) };
      }
      // Only a refused save reads again: to find this save already applied by
      // an attempt whose reply was lost, or to tell a newer save from a trash.
      const current = await sql<
        Array<{ seq: string; state_sha256: string }>
      >`SELECT body.seq::text,encode(sha256(body.state),'hex') AS state_sha256
        FROM documents document
        JOIN document_bodies body ON body.document_id=document.id
        WHERE document.id=${input.documentId}
          AND document.status='active' AND document.format='blocknote'`;
      const head = current[0];
      if (head === undefined) return { kind: "rejected" };
      const seq = Number(head.seq);
      if (
        seq === input.baseSeq + 1 &&
        head.state_sha256 === sha256Hex(input.state)
      )
        return { kind: "saved", seq };
      return seq === input.baseSeq ? { kind: "rejected" } : { kind: "stale" };
    },

    async findOperation(documentId, operationId) {
      const rows = await sql<
        Array<{
          seq: string;
          title: string;
          state_sha256: string;
          asset_ids: string[];
          thread_ids: string[];
        }>
      >`SELECT operation.seq::text,operation.title,encode(sha256(body.state),'hex') AS state_sha256,
          body.asset_ids,body.thread_ids
        FROM document_bodies body
        CROSS JOIN LATERAL jsonb_to_recordset(body.server_operations)
          AS operation(operation_id text,seq bigint,title text)
        WHERE body.document_id=${documentId} AND operation.operation_id=${operationId}`;
      const row = rows[0];
      if (row === undefined) return undefined;
      return {
        seq: Number(row.seq),
        title: row.title,
        stateHash: row.state_sha256,
        assetIds: row.asset_ids,
        threadIds: row.thread_ids,
      };
    },

    async checkReferences(input) {
      const rows = await sql<
        Array<{ active: boolean; assets: string; threads: string }>
      >`SELECT
          EXISTS (SELECT 1 FROM documents WHERE id=${input.documentId}
            AND status='active' AND format='blocknote') AS active,
          (SELECT count(*) FROM document_assets WHERE document_id=${input.documentId}
            AND status='available' AND id=ANY(${input.assetIds}::text[]))::text AS assets,
          (SELECT count(*) FROM room_document_comment_threads WHERE document_id=${input.documentId}
            AND id=ANY(${input.threadIds}::text[]))::text AS threads`;
      const row = rows[0]!;
      if (!row.active) return "document_unavailable";
      if (Number(row.assets) !== new Set(input.assetIds).size)
        return "asset_unavailable";
      if (Number(row.threads) !== new Set(input.threadIds).size)
        return "thread_unknown";
      return "available";
    },

    async close() {
      for (const timer of idleTimers.values()) clearTimeout(timer);
      idleTimers.clear();
      await sql.end({ timeout: 5 });
    },
  };

  // Saves and, in the same transaction, records the continuous-editing point
  // when the latest History point is old enough.
  async function saveWithContinuousPoint(
    input: DocumentBodySave,
  ): Promise<Array<{ seq: string }>> {
    let recorded = false;
    let pointAgeMs: number | undefined;
    const rows = await sql.begin(async (sql) => {
      const saved = await updateBody(sql, input);
      if (saved[0] === undefined) return saved;
      const point = await sql<
        Array<{ point: string | null; point_age_ms: string }>
      >`SELECT CASE WHEN latest.recorded_at<=clock_timestamp()-${rules.continuousAfterMs}::bigint*interval '1 millisecond'
            THEN record_document_history_point(${input.documentId},'idle') END AS point,
          floor(date_part('epoch',clock_timestamp()-latest.recorded_at)*1000)::bigint::text AS point_age_ms
        FROM (SELECT coalesce(
          (SELECT max(revision.history_recorded_at) FROM document_revisions revision
            WHERE revision.document_id=${input.documentId} AND revision.history_trigger IS NOT NULL),
          (SELECT document.created_at FROM documents document WHERE document.id=${input.documentId})
        ) AS recorded_at) latest`;
      recorded = point[0]?.point != null;
      pointAgeMs = Number(point[0]?.point_age_ms ?? 0);
      return saved;
    });
    if (recorded) rememberPoint(input.documentId, now());
    else if (pointAgeMs !== undefined)
      rememberPoint(input.documentId, now() - pointAgeMs);
    return rows;
  }
}

function updateBody(
  sql: postgres.Sql | postgres.TransactionSql,
  input: DocumentBodySave,
): Promise<Array<{ seq: string }>> {
  // postgres.js serializes a jsonb parameter itself; a pre-encoded string
  // would be stored as a JSON string, and the next lookup of the list fails.
  const operation =
    input.operation === undefined
      ? null
      : sql.json({
          operation_id: input.operation.id,
          title: input.operation.title,
        });
  return sql<Array<{ seq: string }>>`UPDATE document_bodies SET
      seq=seq+1,state=${Buffer.from(input.state)},
      state_vector=${Buffer.from(input.stateVector)},
      asset_ids=${input.assetIds}::text[],thread_ids=${input.threadIds}::text[],
      last_editor_ids=(SELECT coalesce(array_agg(editor ORDER BY position),'{}'::text[])
        FROM unnest(last_editor_ids) WITH ORDINALITY kept(editor,position)
        WHERE NOT (editor=ANY(${input.editorIds}::text[])))||${input.editorIds}::text[],
      server_operations=CASE WHEN ${operation}::jsonb IS NULL THEN server_operations
        ELSE coalesce((SELECT jsonb_agg(entry ORDER BY position)
            FROM jsonb_array_elements(server_operations) WITH ORDINALITY kept(entry,position)
            WHERE position>jsonb_array_length(server_operations)-31),'[]'::jsonb)
          ||jsonb_build_array(${operation}::jsonb||jsonb_build_object('seq',seq+1)) END,
      updated_at=clock_timestamp()
    WHERE document_id=${input.documentId} AND seq=${input.baseSeq}
      AND EXISTS (SELECT 1 FROM documents WHERE id=${input.documentId}
        AND status='active' AND format='blocknote')
    RETURNING seq::text`;
}

// A data exception, integrity violation or program limit: the saved values
// themselves fail, so the same save cannot succeed later.
function isDataRejection(error: unknown): boolean {
  if (!(error instanceof postgres.PostgresError)) return false;
  return (
    error.code === "54000" ||
    error.code.startsWith("22") ||
    error.code.startsWith("23")
  );
}
