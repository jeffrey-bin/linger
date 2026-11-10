-- name: GetCurrentDocumentTextSource :one
-- Returns the Document's current version: its body sequence when native, its
-- current Version otherwise. A Version is immutable, so one whose text is
-- already ready returns no row: TeamHub writes the text of the Markdown
-- Versions it generates itself in the transaction that makes them current.
SELECT document.tenant_id::text AS tenant_id,
       (CASE WHEN document.format='blocknote' THEN 'native_body' ELSE 'file_version' END)::text AS source_kind,
       (CASE WHEN document.format='blocknote' THEN body.seq::text ELSE document.current_version_id END)::text AS source_id
FROM documents document
LEFT JOIN document_bodies body ON body.document_id=document.id
WHERE document.id=sqlc.arg(document_id)::text AND document.status='active'
  AND (CASE WHEN document.format='blocknote' THEN body.seq::text ELSE document.current_version_id END) IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM document_texts text
    WHERE text.document_id=document.id AND document.format<>'blocknote'
      AND text.source_kind='file_version' AND text.source_id=document.current_version_id
      AND text.status='ready');

-- name: UpsertDocumentText :execrows
-- Writes only while the Document's current version is still the one the sync
-- extracted. A zero row count means a newer version superseded this sync, and
-- that version has queued its own sync.
WITH current AS (
  SELECT document.id AS document_id, document.tenant_id,
         (CASE WHEN document.format='blocknote' THEN 'native_body' ELSE 'file_version' END)::text AS source_kind,
         (CASE WHEN document.format='blocknote' THEN body.seq::text ELSE document.current_version_id END)::text AS source_id
  FROM documents document
  LEFT JOIN document_bodies body ON body.document_id=document.id
  WHERE document.id=sqlc.arg(document_id)::text AND document.status='active'
)
INSERT INTO document_texts (document_id, tenant_id, source_kind, source_id, status,
                            markdown, markdown_sha256, search_text, scanned,
                            longest_line_bytes, updated_at)
SELECT current.document_id, current.tenant_id, current.source_kind, current.source_id,
       sqlc.arg(status)::text, sqlc.arg(markdown)::text, sqlc.narg(markdown_sha256)::text,
       sqlc.arg(search_text)::text, sqlc.arg(scanned)::boolean,
       sqlc.arg(longest_line_bytes)::bigint, clock_timestamp()
FROM current
WHERE current.source_kind=sqlc.arg(source_kind)::text AND current.source_id=sqlc.arg(source_id)::text
ON CONFLICT (document_id) DO UPDATE
SET source_kind=EXCLUDED.source_kind, source_id=EXCLUDED.source_id, status=EXCLUDED.status,
    markdown=EXCLUDED.markdown, markdown_sha256=EXCLUDED.markdown_sha256,
    search_text=EXCLUDED.search_text, scanned=EXCLUDED.scanned,
    longest_line_bytes=EXCLUDED.longest_line_bytes, updated_at=EXCLUDED.updated_at;
