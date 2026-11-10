-- name: InsertPendingWake :exec
INSERT INTO proactive_pending_wakes (id, tenant_id, room_id, author_actor_id, agent_actor_id, body, tracking_item_id, source, connection_grant,
                                     fired_routine_id, fired_routine_instruction)
VALUES (sqlc.arg(id), sqlc.arg(tenant_id), sqlc.arg(room_id), sqlc.arg(author_actor_id),
        sqlc.arg(agent_actor_id), sqlc.arg(body), sqlc.narg(tracking_item_id), sqlc.arg(source), sqlc.arg(connection_grant),
        sqlc.narg(fired_routine_id), sqlc.narg(fired_routine_instruction));

-- name: LockRoomPendingWakes :exec
-- Serializes delivery for one Room so wakes go out once and in order.
SELECT pg_advisory_xact_lock(hashtextextended('proactive_pending_wakes:' || sqlc.arg(room_id)::text, 0));

-- name: GetPendingWakeRoom :one
SELECT room_id, delivered_at FROM proactive_pending_wakes WHERE id=sqlc.arg(id)::text;

-- name: ListUndeliveredWakes :many
SELECT * FROM proactive_pending_wakes
WHERE room_id=sqlc.arg(room_id)::text AND delivered_at IS NULL
ORDER BY created_at, id;

-- name: MarkWakeDelivered :exec
UPDATE proactive_pending_wakes SET delivered_at=clock_timestamp(), message_id=sqlc.arg(message_id)::text
WHERE id=sqlc.arg(id)::text;

-- name: DeleteOldDeliveredWakes :exec
-- Keep recent wake provenance for reply attribution; older replies are already quiet.
DELETE FROM proactive_pending_wakes
WHERE room_id=sqlc.arg(room_id)::text AND delivered_at < now() - interval '1 day';

-- name: GetRoomLastConversationAt :one
-- Only answers from a Run started by a delivered wake are excluded. Ordinary
-- replies, including late results and Runs merely steered by a wake, reset quiet.
SELECT coalesce(max(m.created_at), '-infinity'::timestamptz)::timestamptz
FROM messages m
JOIN actors author ON author.id=m.author_actor_id
WHERE m.room_id=sqlc.arg(room_id)::text AND m.message_kind='conversation'
  AND (author.kind='human' OR NOT EXISTS (
    SELECT 1 FROM agent_local_run_inputs relation
    JOIN agent_runtime_inputs input
      ON input.context_key=relation.context_key AND input.input_id=relation.input_id
    JOIN proactive_pending_wakes wake
      ON wake.room_id=m.room_id AND wake.agent_actor_id=m.author_actor_id
     AND wake.delivered_at IS NOT NULL AND wake.message_id IS NOT NULL
     AND (input.source_message_id=wake.message_id
          OR jsonb_typeof(input.payload->'invocationMessageIds')='array'
             AND input.payload->'invocationMessageIds' @> to_jsonb(wake.message_id))
    WHERE relation.run_id=m.local_run_id AND relation.relation='initial'
      AND NOT EXISTS (
        SELECT 1 FROM agent_local_run_inputs human_relation
        JOIN agent_runtime_inputs human_input
          ON human_input.context_key=human_relation.context_key
         AND human_input.input_id=human_relation.input_id
        JOIN messages human_message ON human_message.room_id=m.room_id
         AND (human_input.source_message_id=human_message.id
              OR jsonb_typeof(human_input.payload->'invocationMessageIds')='array'
                 AND human_input.payload->'invocationMessageIds' @> to_jsonb(human_message.id))
        JOIN actors human_author ON human_author.id=human_message.author_actor_id
        WHERE human_relation.run_id=m.local_run_id
          AND human_relation.created_at <= m.created_at
          AND human_message.message_kind='conversation' AND human_author.kind='human'
      )
  ));

-- name: GetAnotherMeDirectRoomAgent :one
-- The AnotherMe of a direct Room, when the Room is a Human's AnotherMe Room.
SELECT direct.direct_agent_actor_id::text AS agent_actor_id, direct.direct_human_actor_id::text AS human_actor_id
FROM rooms direct
JOIN agent_registrations registration
  ON registration.actor_id=direct.direct_agent_actor_id AND registration.represented_human_actor_id=direct.direct_human_actor_id
WHERE direct.id=sqlc.arg(room_id)::text AND registration.tenant_id=sqlc.arg(tenant_id)::text
  AND registration.agent_type='anotherme' AND registration.status<>'revoked';

-- name: GetAnotherMeRoomForAgent :one
-- The AnotherMe direct Room of an active AnotherMe, addressed by Agent Service.
SELECT direct.id AS room_id, direct.direct_agent_actor_id::text AS agent_actor_id,
       direct.direct_human_actor_id::text AS human_actor_id, registration.tenant_id
FROM agent_registrations registration
JOIN rooms direct
  ON direct.direct_agent_actor_id=registration.actor_id AND direct.direct_human_actor_id=registration.represented_human_actor_id
WHERE registration.agent_management_id=sqlc.arg(agent_management_id)::text AND direct.id=sqlc.arg(room_id)::text
  AND registration.agent_type='anotherme' AND registration.status='active';

-- name: CountRoomConversationMessages :one
SELECT count(*)::bigint FROM messages
WHERE room_id=sqlc.arg(room_id)::text AND message_kind='conversation';

-- name: ListRoomConversationWindow :many
-- One window of ordinary conversation, oldest first, after the judged ones.
SELECT m.id, m.body, m.created_at, author.kind AS author_kind
FROM messages m
JOIN actors author ON author.id=m.author_actor_id
WHERE m.room_id=sqlc.arg(room_id)::text AND m.message_kind='conversation'
ORDER BY m.created_at, m.id
OFFSET sqlc.arg(skip)::bigint LIMIT sqlc.arg(take)::bigint;

-- name: GetConversationWindowProgress :one
SELECT judged_count FROM proactive_conversation_windows WHERE room_id=sqlc.arg(room_id)::text;

-- name: StartConversationWindowProgress :exec
INSERT INTO proactive_conversation_windows (room_id, tenant_id, judged_count)
VALUES (sqlc.arg(room_id), sqlc.arg(tenant_id), sqlc.arg(judged_count))
ON CONFLICT (room_id) DO NOTHING;

-- name: AdvanceConversationWindowProgress :execrows
UPDATE proactive_conversation_windows SET judged_count=sqlc.arg(judged_count), updated_at=now()
WHERE room_id=sqlc.arg(room_id)::text AND judged_count=sqlc.arg(expected_judged_count);

-- name: ListOpenTrackingItemsByID :many
SELECT id, kind, content, due_at, due_text
FROM memory_index.tracking_items
WHERE tenant_id=sqlc.arg(tenant_id)::text AND owner_actor_id=sqlc.arg(owner_actor_id)::text
  AND id = ANY(sqlc.arg(ids)::text[]) AND status='open'
ORDER BY due_at NULLS LAST, id;

-- name: DeletePendingWake :exec
DELETE FROM proactive_pending_wakes WHERE id=sqlc.arg(id)::text AND delivered_at IS NULL;
