import type postgres from "postgres";

import {
  contentHash,
  documentRawSource,
  type RawSource,
  type SourceIdentity,
} from "./search/source-store.js";
import { localDate } from "./date.js";
import { memoryLogger } from "./run-telemetry.js";

interface AgentIdentityRow {
  scan_started_at: Date;
  tenant_id: string;
  user_artifact_owner_actor_id: string;
}

interface PersonalDocumentRow {
  created_at: Date;
  document_id: string;
  filename: string;
  folder_path: string;
  markdown_sha256: string;
  media_type: string;
  origin_kind: "my_pages" | "mail";
  text_source_id: string;
  text_source_kind: "native_body" | "file_version";
  title: string;
}

export interface MyPagesSourceSyncResult {
  identity?: SourceIdentity;
  indexed: number;
  retired: number;
  skipped: number;
}

/**
 * Indexes the Human's My pages and imported mail from the Markdown TeamHub
 * normalized once per version (document_texts). Only Documents whose
 * Markdown hash differs from the indexed version are read.
 */
export async function syncMyPagesChunkSources(options: {
  agentId: string;
  ingest: (source: RawSource, content: string) => Promise<boolean>;
  mapSources?: <T, R>(
    sources: readonly T[],
    operation: (source: T, index: number) => Promise<R>,
  ) => Promise<R[]>;
  sql: postgres.Sql;
}): Promise<MyPagesSourceSyncResult> {
  const [scope] = await options.sql<AgentIdentityRow[]>`
    SELECT tenant_id, represented_human_actor_id AS user_artifact_owner_actor_id,
      clock_timestamp() AS scan_started_at
    FROM memory_source.another_me_subjects
    WHERE agent_management_id = ${options.agentId}
  `;
  if (!scope) return { indexed: 0, retired: 0, skipped: 0 };
  const identity: SourceIdentity = {
    agent_id: options.agentId,
    tenant_id: scope.tenant_id,
    user_artifact_owner_actor_id: scope.user_artifact_owner_actor_id,
  };
  const documents = await options.sql<PersonalDocumentRow[]>`
    SELECT folder_path, origin_kind, document_id, text_source_kind,
      text_source_id, title, filename, media_type, markdown_sha256, created_at
    FROM memory_source.personal_documents(
      ${identity.tenant_id}, ${identity.user_artifact_owner_actor_id}
    )
    ORDER BY folder_path, document_id
  `;
  const documentIds = documents.map((document) => document.document_id);
  const stored = await options.sql<
    Array<{ document_id: string; content: string }>
  >`
    SELECT source.metadata->>'document_id' AS document_id, version.content
    FROM memory_index.sources source
    JOIN memory_index.source_versions version
      ON version.source_id = source.id AND version.sha256 = source.active_sha256
    WHERE source.tenant_id = ${identity.tenant_id}
      AND source.owner_id = ${identity.user_artifact_owner_actor_id}
      AND source.agent_id = ${identity.agent_id}
      AND source.metadata->>'document_id' = ANY(${documentIds}::text[])
  `;
  const indexedContent = new Map(
    stored.map((source) => [source.document_id, source.content]),
  );
  const changed = documents.filter(
    (document) =>
      contentHash(indexedContent.get(document.document_id) ?? "") !==
      document.markdown_sha256,
  );
  const markdown = new Map<string, string>();
  if (changed.length) {
    const rows = await options.sql<
      Array<{ document_id: string; markdown: string }>
    >`
      SELECT document_id, markdown
      FROM memory_source.personal_document_markdown(
        ${identity.tenant_id}, ${identity.user_artifact_owner_actor_id},
        ${changed.map((document) => document.document_id)}::text[]
      )
    `;
    for (const row of rows) markdown.set(row.document_id, row.markdown);
  }
  const failures: unknown[] = [];
  const mapSources = options.mapSources ?? mapSequentially;
  const outcomes = await mapSources(documents, async (document) => {
    // A text replaced since the inventory was read joins the next sync.
    const content =
      markdown.get(document.document_id) ??
      indexedContent.get(document.document_id);
    if (content === undefined || !content.trim())
      return { indexed: false, skipped: true };
    try {
      const source = documentRawSource({
        identity,
        documentId: document.document_id,
        textSourceKind: document.text_source_kind,
        textSourceId: document.text_source_id,
        title: document.title.trim() || document.filename.trim() || "Untitled",
        filename: document.filename.trim() || "untitled",
        mediaType: document.media_type,
        originKind: document.origin_kind,
        date: localDate(document.created_at),
        markdown: content,
        ...(document.folder_path ? { folderPath: document.folder_path } : {}),
      });
      return (await options.ingest(source, content))
        ? { indexed: true, skipped: false }
        : { indexed: false, skipped: true };
    } catch (error) {
      memoryLogger().log("warn", "memory.my_pages_chunk_source_skipped", {
        document_id: document.document_id,
        error,
      });
      failures.push(error);
      return { indexed: false, skipped: true };
    }
  });
  const indexed = outcomes.filter((outcome) => outcome.indexed).length;
  const skipped = outcomes.filter((outcome) => outcome.skipped).length;
  // Only the authoritative TeamHub inventory retires documents: a document no
  // longer in it is deleted with its versions and chunks. A
  // concurrent publication newer than this inventory must not be deleted.
  const retired = await options.sql<{ id: string }[]>`
    DELETE FROM memory_index.sources
    WHERE tenant_id = ${identity.tenant_id}
      AND owner_id = ${identity.user_artifact_owner_actor_id}
      AND agent_id = ${identity.agent_id}
      AND origin_kind IN ('my_pages', 'mail')
      AND metadata->>'document_id' <> ALL(${documentIds}::text[])
      AND updated_at < ${scope.scan_started_at}
    RETURNING id
  `;
  if (failures.length)
    throw new AggregateError(
      failures,
      `My Pages Chunk ingestion failed for ${failures.length} source(s)`,
    );
  return { identity, indexed, retired: retired.length, skipped };
}

async function mapSequentially<T, R>(
  sources: readonly T[],
  operation: (source: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (const [index, source] of sources.entries()) {
    results.push(await operation(source, index));
  }
  return results;
}
