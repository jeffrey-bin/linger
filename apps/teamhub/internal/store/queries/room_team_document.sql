-- name: UpsertRoomTeamDocument :one
-- The first team.md write is revision 1; each later write adds one. Writers
-- serialize on the Room row.
UPDATE rooms
SET team_md_raw_markdown=sqlc.arg(raw_markdown)::text,
    team_md_collaborate_pattern=sqlc.arg(collaborate_pattern)::text,
    team_md_document=sqlc.arg(document)::jsonb,
    team_md_revision=coalesce(team_md_revision,0)+1,
    team_md_updated_by_actor_id=sqlc.arg(updated_by_actor_id)::text,
    team_md_updated_at=now()
WHERE id=sqlc.arg(room_id)::text
  AND tenant_id=sqlc.arg(tenant_id)::text
RETURNING team_md_revision::bigint AS revision,
          team_md_updated_at::timestamptz AS updated_at;

-- name: GetRoomTeamDocument :one
SELECT team_md_raw_markdown::text AS raw_markdown,
       team_md_collaborate_pattern::text AS collaborate_pattern,
       team_md_document::jsonb AS document,
       team_md_revision::bigint AS revision,
       team_md_updated_at::timestamptz AS updated_at
FROM rooms
WHERE id=sqlc.arg(room_id)::text
  AND tenant_id=sqlc.arg(tenant_id)::text
  AND deleted_at IS NULL
  AND team_md_revision IS NOT NULL;

-- name: MarkMessageTeamProtocol :exec
UPDATE messages
SET team_protocol=sqlc.arg(collaborate_pattern)::text
WHERE id=sqlc.arg(message_id)::text
  AND tenant_id=sqlc.arg(tenant_id)::text;
