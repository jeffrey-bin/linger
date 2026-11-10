-- name: GetRoomByID :one
SELECT id, tenant_id, name, description, created_by_actor_id,
       next_room_seq, created_at, updated_at,
       deletion_started_at, deletion_started_by_actor_id,
       deleted_at, deleted_by_actor_id,
       direct_human_actor_id, direct_agent_actor_id, parent_room_id, root_message_id,
       team_md_raw_markdown, team_md_collaborate_pattern, team_md_document,
       team_md_revision, team_md_updated_at, team_md_updated_by_actor_id
FROM rooms
WHERE id = sqlc.arg(id)::text AND deleted_at IS NULL;

-- name: SetThreadRoomParent :one
-- A new Thread Room is linked to its parent only after its room.created
-- event, so that event reaches no Account.
UPDATE rooms
SET parent_room_id=sqlc.arg(parent_room_id)::text,
    root_message_id=sqlc.arg(root_message_id)::text
WHERE id=sqlc.arg(room_id)::text
  AND tenant_id=sqlc.arg(tenant_id)::text
  AND parent_room_id IS NULL
RETURNING id;

-- name: GetThreadRoomByRoot :one
SELECT id AS room_id, tenant_id, parent_room_id::text AS parent_room_id,
       root_message_id::text AS root_message_id, created_by_actor_id, created_at
FROM rooms
WHERE parent_room_id = sqlc.arg(parent_room_id)::text
  AND root_message_id = sqlc.arg(root_message_id)::text;

-- name: GetThreadRoomByRoomID :one
SELECT id AS room_id, tenant_id, parent_room_id::text AS parent_room_id,
       root_message_id::text AS root_message_id, created_by_actor_id, created_at
FROM rooms
WHERE id = sqlc.arg(room_id)::text AND parent_room_id IS NOT NULL;

-- name: IsThreadRoom :one
SELECT EXISTS(SELECT 1 FROM rooms WHERE id = sqlc.arg(room_id)::text AND parent_room_id IS NOT NULL);

-- name: GetMessageInRoom :one
SELECT id, tenant_id, room_id, author_actor_id, body, segments, message_kind,
       created_at
FROM messages
WHERE id = sqlc.arg(id)::text AND room_id = sqlc.arg(room_id)::text;

-- name: GetThreadReplyStats :one
SELECT count(*)::bigint AS reply_count, max(message.created_at) AS latest_reply_at
FROM messages message
JOIN rooms thread ON thread.id=message.room_id AND thread.parent_room_id IS NOT NULL
WHERE message.room_id = sqlc.arg(room_id)::text
  AND message.message_kind='conversation';

-- name: ListLatestThreadReplyAuthors :many
WITH latest AS (
    SELECT DISTINCT ON (reply.author_actor_id)
           reply.author_actor_id, reply.created_at, reply.id
    FROM messages reply
    JOIN rooms thread ON thread.id=reply.room_id AND thread.parent_room_id IS NOT NULL
    WHERE reply.room_id = sqlc.arg(room_id)::text
      AND reply.message_kind='conversation'
    ORDER BY reply.author_actor_id, reply.created_at DESC, reply.id DESC
)
SELECT author.id, author.tenant_id, author.kind, author.display_name,
       author.account_id, author.handle, author.created_at
FROM latest
JOIN actors author ON author.id = latest.author_actor_id
ORDER BY latest.created_at DESC, latest.id DESC
LIMIT 3;

-- name: ListLatestThreadReplyAuthorsBatch :many
-- Keep the per-Thread distinct-author ordering and limit used by the single
-- Thread query, but fetch all requested Threads in one database round trip.
SELECT thread.id AS room_id, sqlc.embed(author)
FROM rooms thread
CROSS JOIN LATERAL (
    SELECT latest.author_actor_id, latest.created_at, latest.id
    FROM (
        SELECT DISTINCT ON (reply.author_actor_id)
               reply.author_actor_id, reply.created_at, reply.id
        FROM messages reply
        WHERE reply.room_id = thread.id
          AND reply.message_kind = 'conversation'
        ORDER BY reply.author_actor_id, reply.created_at DESC, reply.id DESC
    ) latest
    ORDER BY latest.created_at DESC, latest.id DESC
    LIMIT 3
) latest
JOIN actors author ON author.id = latest.author_actor_id
WHERE thread.id = ANY(sqlc.arg(room_ids)::text[])
  AND thread.parent_room_id IS NOT NULL
ORDER BY thread.id, latest.created_at DESC, latest.id DESC;

-- name: ListMessageThreadSummaries :many
SELECT thread.root_message_id::text AS root_message_id, thread.id AS room_id,
       coalesce(stats.reply_count, 0)::bigint AS reply_count,
       stats.latest_reply_at
FROM rooms thread
LEFT JOIN LATERAL (
    SELECT count(*)::bigint AS reply_count, max(reply.created_at) AS latest_reply_at
    FROM messages reply
    WHERE reply.room_id = thread.id
      AND reply.message_kind='conversation'
) stats ON true
WHERE thread.parent_room_id = sqlc.arg(parent_room_id)::text
  AND thread.root_message_id = ANY(sqlc.arg(message_ids)::text[]);

-- name: MarkThreadOpened :exec
-- Opening is the one Thread list reason that leaves no Message or mention
-- behind. A new row starts unread, as a missing read state does.
INSERT INTO room_member_states(room_id, actor_id, thread_opened_at)
VALUES (sqlc.arg(room_id)::text, sqlc.arg(actor_id)::text, now())
ON CONFLICT (room_id, actor_id) DO UPDATE
SET thread_opened_at=COALESCE(room_member_states.thread_opened_at, excluded.thread_opened_at);

-- name: InSameCollaborationRoom :one
-- A Thread shares its parent Room's collaboration.
SELECT (collaboration_membership_room_id(sqlc.arg(room_id)::text)
    =collaboration_membership_room_id(sqlc.arg(other_room_id)::text))::boolean AS same;
