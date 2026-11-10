-- name: WriteWikiRefreshPreview :exec
UPDATE document_wiki_refreshes SET preview_pages = sqlc.arg(pages)::jsonb, preview_revision = preview_revision + 1
WHERE id = sqlc.arg(refresh_id) AND status = 'staging' AND preview_pages IS DISTINCT FROM sqlc.arg(pages)::jsonb;

-- name: ReadWikiRefreshPreview :one
SELECT coalesce(preview_pages, '{}'::jsonb)::jsonb AS pages FROM document_wiki_refreshes
WHERE id = sqlc.arg(refresh_id) AND wiki_id = sqlc.arg(wiki_id) AND status = 'staging';
