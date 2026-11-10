import type postgres from "postgres";

import { memoryDatabase } from "../database.js";
import { contentHash } from "../search/source-store.js";

/** One Daily report of a Human as the index holds it. */
export interface IndexedDaily {
  date: string;
  title: string;
  content: string;
}

/**
 * The revision of the Human's indexed Daily reports. It names each report's
 * indexed content, so it changes whenever a report does.
 */
export async function indexedDailyRevision(
  tenantId: string,
  ownerId: string,
  sql: postgres.Sql = memoryDatabase(),
): Promise<string | undefined> {
  const rows = await sql<{ date: string; sha256: string }[]>`
    SELECT DISTINCT ON (metadata->>'period_start')
      metadata->>'period_start' AS date, active_sha256 AS sha256
    FROM memory_index.sources
    WHERE tenant_id = ${tenantId} AND owner_id = ${ownerId}
      AND origin_kind = 'period_summary' AND metadata->>'collection' = 'daily'
      AND active_sha256 IS NOT NULL
    ORDER BY metadata->>'period_start', updated_at DESC
  `;
  return dailyRevision(rows);
}

/** Reads the Human's indexed Daily reports, oldest first, with their revision. */
export async function readIndexedDailies(
  tenantId: string,
  ownerId: string,
  sql: postgres.Sql = memoryDatabase(),
): Promise<{ revision?: string; reports: IndexedDaily[] }> {
  const rows = await sql<
    { date: string; sha256: string; title: string; content: string }[]
  >`
    SELECT DISTINCT ON (source.metadata->>'period_start')
      source.metadata->>'period_start' AS date, source.active_sha256 AS sha256,
      source.title, version.content
    FROM memory_index.sources source
    JOIN memory_index.source_versions version
      ON version.source_id = source.id AND version.sha256 = source.active_sha256
    WHERE source.tenant_id = ${tenantId} AND source.owner_id = ${ownerId}
      AND source.origin_kind = 'period_summary'
      AND source.metadata->>'collection' = 'daily'
    ORDER BY source.metadata->>'period_start', source.updated_at DESC
  `;
  return {
    revision: dailyRevision(rows),
    reports: rows.map(({ date, title, content }) => ({ date, title, content })),
  };
}

function dailyRevision(
  rows: readonly { date: string; sha256: string }[],
): string | undefined {
  return rows.length
    ? contentHash(JSON.stringify(rows.map((row) => [row.date, row.sha256])))
    : undefined;
}
