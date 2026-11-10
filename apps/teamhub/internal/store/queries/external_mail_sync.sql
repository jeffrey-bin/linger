-- name: ListMailSyncConnections :many
-- The mail Connections whose snapshot completed at their current revision
-- and whose sync position is before due.
SELECT id, revision
FROM external_connections
WHERE provider IN ('gmail', 'outlook') AND status = 'active'
  AND mail_import_status = 'completed' AND mail_import_revision = revision
  AND mail_synced_until < sqlc.arg(due)::timestamptz
ORDER BY id;

-- name: GetMailSync :one
-- One Connection's sync position while it is still active at the revision
-- its sync was queued for.
SELECT account_id, mail_import_tenant_id::text AS tenant_id, provider, upstream_connection_id,
       mail_synced_until::timestamptz AS synced_until
FROM external_connections
WHERE id = sqlc.arg(id)::text AND revision = sqlc.arg(revision)::bigint AND status = 'active'
  AND mail_import_status = 'completed' AND mail_import_revision = revision
  AND mail_synced_until IS NOT NULL;

-- name: AdvanceMailSync :execrows
-- Moves the sync position from the one the sync read on from. No row means
-- the Connection changed meanwhile.
UPDATE external_connections
SET mail_synced_until = sqlc.arg(synced_until)::timestamptz
WHERE id = sqlc.arg(id)::text AND revision = sqlc.arg(revision)::bigint AND status = 'active'
  AND mail_import_status = 'completed' AND mail_import_revision = revision
  AND mail_synced_until = sqlc.arg(previous)::timestamptz;
