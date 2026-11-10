-- name: ListPocketNotes :many
SELECT note_date,body,updated_at
FROM pocket_notes
WHERE tenant_id=sqlc.arg(tenant_id)::text
  AND owner_actor_id=sqlc.arg(owner_actor_id)::text
  AND hidden_at IS NULL
  AND (sqlc.narg(before_date)::date IS NULL OR note_date<sqlc.narg(before_date)::date)
ORDER BY note_date DESC
LIMIT sqlc.arg(row_limit)::integer;

-- name: UpsertPocketNote :one
INSERT INTO pocket_notes(tenant_id,owner_actor_id,note_date,body)
VALUES(sqlc.arg(tenant_id)::text,sqlc.arg(owner_actor_id)::text,sqlc.arg(note_date)::date,sqlc.arg(body)::text)
ON CONFLICT (tenant_id,owner_actor_id,note_date) DO UPDATE
SET body=excluded.body,updated_at=clock_timestamp()
RETURNING note_date,body,updated_at;

-- name: DeletePocketNote :exec
DELETE FROM pocket_notes
WHERE tenant_id=sqlc.arg(tenant_id)::text
  AND owner_actor_id=sqlc.arg(owner_actor_id)::text
  AND note_date=sqlc.arg(note_date)::date;

-- name: HidePocketNote :exec
UPDATE pocket_notes
SET hidden_at=clock_timestamp()
WHERE tenant_id=sqlc.arg(tenant_id)::text
  AND owner_actor_id=sqlc.arg(owner_actor_id)::text
  AND note_date=sqlc.arg(note_date)::date
  AND hidden_at IS NULL;

-- name: GetPocketNoteUpdatedAt :one
-- When a day's page last changed; a cleared page has no row.
SELECT updated_at
FROM pocket_notes
WHERE tenant_id=sqlc.arg(tenant_id)::text
  AND owner_actor_id=sqlc.arg(owner_actor_id)::text
  AND note_date=sqlc.arg(note_date)::date;
