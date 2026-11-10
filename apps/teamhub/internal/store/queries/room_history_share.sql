-- name: GetHumanRoomMembershipForShare :one
SELECT actor.id AS actor_id, member.membership_epoch_id, member.role
FROM active_room_members member
JOIN actors actor ON actor.id=member.actor_id
WHERE member.room_id=sqlc.arg(room_id)::text
  AND actor.account_id=sqlc.arg(account_id)::text
  AND actor.kind='human';

-- name: CreateRoomHistoryShare :one
INSERT INTO room_history_shares(
  id, room_id, creator_actor_id, creator_membership_epoch_id, token_hash,
  room_name, snapshot_room_seq, web_version
) VALUES (
  sqlc.arg(id)::text, sqlc.arg(room_id)::text, sqlc.arg(creator_actor_id)::text,
  sqlc.arg(creator_membership_epoch_id)::text, sqlc.arg(token_hash)::bytea,
  sqlc.arg(room_name)::text, sqlc.arg(snapshot_room_seq)::bigint, sqlc.arg(web_version)::text
)
RETURNING created_at;

-- name: SetRoomHistoryShareMessageCount :exec
UPDATE room_history_shares SET message_count=sqlc.arg(message_count)::int
WHERE id=sqlc.arg(id)::text;

-- name: ListRoomHistoryShares :many
SELECT id, room_name, created_at, message_count, snapshot_room_seq,
       (revoked_at IS NOT NULL)::boolean AS revoked
FROM room_history_shares
WHERE room_id=sqlc.arg(room_id)::text
ORDER BY created_at DESC, id DESC;

-- name: RevokeRoomHistoryShare :execrows
UPDATE room_history_shares SET revoked_at=coalesce(revoked_at, now())
WHERE room_id=sqlc.arg(room_id)::text AND id=sqlc.arg(id)::text;

-- name: RotateRoomHistoryShareToken :one
UPDATE room_history_shares
SET token_hash=sqlc.arg(token_hash)::bytea
WHERE id=sqlc.arg(id)::text AND room_id=sqlc.arg(room_id)::text AND revoked_at IS NULL
RETURNING id, room_name, created_at, message_count, snapshot_room_seq;

-- name: GetAuthorizedRoomHistoryShare :one
SELECT share.id, share.room_name, share.created_at, share.message_count, share.snapshot_room_seq
FROM room_history_shares share
JOIN rooms room ON room.id=share.room_id
JOIN active_room_members member
  ON member.room_id=share.room_id AND member.actor_id=share.creator_actor_id
 AND member.membership_epoch_id=share.creator_membership_epoch_id
WHERE share.token_hash=sqlc.arg(token_hash)::bytea AND share.revoked_at IS NULL
  AND room.deleted_at IS NULL AND room.deletion_started_at IS NULL;

-- name: GetRoomHistoryShareAsset :one
SELECT media_type, content FROM room_history_share_assets
WHERE share_id=sqlc.arg(share_id)::text AND id=sqlc.arg(id)::text;

-- name: ListRoomHistoryShareMessages :many
SELECT presentation FROM room_history_share_messages
WHERE share_id=sqlc.arg(share_id)::text AND position>sqlc.arg(after_position)::bigint
ORDER BY position
LIMIT 50;

-- name: GetDocumentVersionContentObjectID :one
SELECT content_object_id FROM document_versions WHERE id=sqlc.arg(id)::text;

-- name: CreateRoomHistoryShareAsset :exec
INSERT INTO room_history_share_assets(share_id, id, media_type, content)
VALUES (sqlc.arg(share_id)::text, sqlc.arg(id)::text, sqlc.arg(media_type)::text, sqlc.arg(content)::bytea);

-- name: GetHumanActorAvatarImage :one
SELECT account.profile_avatar_image
FROM actors actor
JOIN accounts account ON account.id=actor.account_id
WHERE actor.tenant_id=sqlc.arg(tenant_id)::text AND actor.id=sqlc.arg(actor_id)::text;

-- name: CreateRoomHistoryShareMessage :exec
INSERT INTO room_history_share_messages(share_id, position, message_id, presentation)
VALUES (sqlc.arg(share_id)::text, sqlc.arg(position)::bigint, sqlc.arg(message_id)::text, sqlc.arg(presentation)::jsonb);
