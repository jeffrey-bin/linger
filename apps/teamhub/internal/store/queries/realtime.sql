-- name: AllocateRoomSeq :one
UPDATE rooms
SET next_room_seq=next_room_seq+1
WHERE id=$1 AND deletion_started_at IS NULL AND deleted_at IS NULL
RETURNING next_room_seq;

-- name: AllocateDeletingRoomSeq :one
UPDATE rooms
SET next_room_seq=next_room_seq+1
WHERE id=$1 AND deletion_started_at IS NOT NULL AND deleted_at IS NULL
RETURNING next_room_seq;

-- name: AllocateRoomLifecycleSeq :one
UPDATE rooms
SET next_room_seq=next_room_seq+1
WHERE id=$1 AND deleted_at IS NULL
RETURNING next_room_seq;

-- name: CreateRoomEvent :one
INSERT INTO room_events(event_id, tenant_id, room_id, room_seq, event_type, actor_id, resource_id, payload)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING event_id, tenant_id, room_id, room_seq, event_type, actor_id, resource_id, payload, occurred_at;

-- name: CreateMessageCreatedRoomEvent :one
-- message.created stamps its unpublished Message with the Room sequence and
-- the Actors it mentions in the same statement.
WITH event AS (
    INSERT INTO room_events(event_id, tenant_id, room_id, room_seq, event_type, actor_id, resource_id, payload)
    VALUES (sqlc.arg(event_id), sqlc.arg(tenant_id), sqlc.arg(room_id), sqlc.arg(room_seq), 'message.created',
            sqlc.arg(actor_id), sqlc.arg(message_id), sqlc.arg(payload))
    RETURNING room_seq
), published AS (
    UPDATE messages
    SET room_seq=sqlc.arg(room_seq)::bigint, mentioned_actor_ids=sqlc.arg(mentioned_actor_ids)::text[]
    WHERE id=sqlc.arg(message_id)::text AND tenant_id=sqlc.arg(tenant_id)::text
      AND room_id=sqlc.arg(room_id)::text AND room_seq IS NULL
    RETURNING id
)
SELECT event.room_seq, (SELECT count(*) FROM published)::bigint AS published_messages
FROM event;

-- name: GetRoomEventWatermarkForAccount :one
-- Every allocated room_seq is listed, so the watermark matches the Room
-- snapshot sequence; hidden Messages appear as message.hidden placeholders.
SELECT coalesce(max(event.room_seq),0)::bigint AS next_room_seq
FROM rooms r
JOIN actors caller ON caller.tenant_id=r.tenant_id AND caller.account_id=$2 AND caller.kind='human'
JOIN active_room_members membership
  ON membership.room_id=collaboration_membership_room_id(r.id)
 AND membership.actor_id=caller.id
LEFT JOIN room_events event ON event.room_id=r.id
WHERE r.id=$1 AND room_actor_participating(r.id,caller.id)
GROUP BY r.id;

-- name: ListRoomEventsForAccount :many
-- Task terminal notices are Agent-only history. Humans receive a payload-free
-- message.hidden placeholder so their room_seq cursor stays contiguous.
SELECT e.event_id, e.tenant_id, e.room_id, e.room_seq,
       (CASE WHEN hidden_message.id IS NULL THEN e.event_type ELSE 'message.hidden' END)::text AS event_type,
       e.actor_id, e.resource_id,
       (CASE WHEN hidden_message.id IS NULL THEN e.payload ELSE '{"kind":"message.hidden"}'::jsonb END)::jsonb AS payload,
       e.occurred_at,
       actor.kind AS actor_kind, actor.display_name AS actor_display_name
FROM room_events e
JOIN rooms r ON r.id=e.room_id AND r.tenant_id=e.tenant_id
JOIN actors actor ON actor.id=e.actor_id AND actor.tenant_id=e.tenant_id
LEFT JOIN messages hidden_message
  ON e.event_type='message.created'
 AND hidden_message.id=e.resource_id
 AND hidden_message.room_id=e.room_id
 AND hidden_message.message_kind='task_terminal_notice'
WHERE e.room_id=$1
  AND EXISTS (
    SELECT 1 FROM actors caller
    JOIN active_room_members membership
      ON membership.actor_id=caller.id
     AND membership.room_id=collaboration_membership_room_id(r.id)
    WHERE caller.tenant_id=r.tenant_id AND caller.account_id=$2 AND caller.kind='human'
      AND room_actor_participating(r.id,caller.id)
  )
  AND e.room_seq > $3 AND e.room_seq <= $4
ORDER BY e.room_seq
LIMIT $5;

-- name: PublishInvalidation :exec
-- A browser invalidation hint. NOTIFY inside the caller's
-- transaction is delivered only after commit.
SELECT publish_teamhub_realtime_wake(
    sqlc.arg(topic)::text, sqlc.arg(kind)::text, sqlc.arg(resource_id)::text,
    sqlc.arg(sequence)::bigint, 0
);

-- name: ListRoomEventWatermarksForAccount :many
-- One read answers a burst of Room wakes: the listed Rooms the Account's Human
-- currently participates in, with their committed room_seq. room_seq is
-- allocated under the Room row lock held until commit, so the committed
-- events of a Room always form a prefix and this watermark never skips a
-- later commit.
SELECT r.id AS room_id,
       coalesce((SELECT max(event.room_seq) FROM room_events event WHERE event.room_id=r.id),0)::bigint AS latest_room_seq
FROM rooms r
WHERE r.id = ANY(sqlc.arg(room_ids)::text[])
  AND EXISTS (
    SELECT 1 FROM actors caller
    JOIN active_room_members membership
      ON membership.actor_id=caller.id
     AND membership.room_id=collaboration_membership_room_id(r.id)
    WHERE caller.tenant_id=r.tenant_id AND caller.account_id=sqlc.arg(account_id)::text AND caller.kind='human'
      AND room_actor_participating(r.id,caller.id)
  )
ORDER BY r.id;

-- name: ListRoomTenants :many
SELECT id, tenant_id FROM rooms WHERE id = ANY(sqlc.arg(room_ids)::text[]);
