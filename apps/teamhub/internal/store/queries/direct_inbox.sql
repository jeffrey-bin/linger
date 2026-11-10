-- name: GetAgentContextInbox :one
-- The caller has already authorized this Inbox.
SELECT inbox.inbox_id::text AS inbox_id,inbox.head::bigint AS head,inbox.cursor_encoding::text AS cursor_encoding,
 coalesce(inbox.room_id,'')::text AS room_id,coalesce(inbox.parent_room_id,'')::text AS parent_room_id,
 coalesce(inbox.task_id,'')::text AS task_id,coalesce(inbox.coordinator_context_key,'')::text AS coordinator_context_key
FROM agent_context_inboxes(sqlc.arg(context_key)::text) inbox
WHERE inbox.inbox_id=sqlc.arg(inbox_id)::text;

-- name: ListRoomMessageDispositions :many
-- The dispositions of named Room Messages, for a trusted turn that names them.
SELECT message.id,decision.disposition::text AS disposition
FROM messages message
CROSS JOIN LATERAL agent_inbox_message_disposition(message.tenant_id,sqlc.arg(agent_actor_id)::text,sqlc.arg(context_key)::text,sqlc.arg(inbox_id)::text,message.id) decision
WHERE message.tenant_id=sqlc.arg(tenant_id)::text AND message.room_id=sqlc.arg(room_id)::text
 AND message.id=ANY(sqlc.arg(message_ids)::text[])
 AND message.message_kind IN ('conversation','agent_runtime','task_terminal_notice')
 AND EXISTS(SELECT 1 FROM room_events event WHERE event.resource_id=message.id AND event.room_id=message.room_id
  AND event.tenant_id=message.tenant_id AND event.event_type='message.created')
ORDER BY message.id;

-- name: LockDirectInboxRoomAuthority :many
SELECT room.id FROM rooms room
WHERE room.tenant_id=sqlc.arg(tenant_id)::text AND (room.id=sqlc.arg(room_id)::text OR room.id=collaboration_membership_room_id(sqlc.arg(room_id)::text))
ORDER BY room.id FOR SHARE;

-- name: LockDirectInboxTaskAuthority :many
SELECT item.id FROM work_items item WHERE item.id=sqlc.arg(task_id)::text AND item.tenant_id=sqlc.arg(tenant_id)::text FOR SHARE;

-- name: LockDirectInboxMembershipAuthority :many
-- Acquire active membership locks before Context and Room authority locks.
-- Thread reception is authorized by its parent Room membership.
SELECT source.room_id::text AS source_room_id,membership.room_id::text AS membership_room_id
FROM unnest(sqlc.arg(room_ids)::text[]) AS source(room_id)
JOIN room_members membership
 ON membership.room_id=collaboration_membership_room_id(source.room_id)
 AND membership.tenant_id=sqlc.arg(tenant_id)::text
 AND membership.actor_id=sqlc.arg(agent_actor_id)::text
ORDER BY membership.room_id,source.room_id
FOR SHARE OF membership;

-- name: ListAgentRuntimeSteerInputsAuthorityHint :many
-- Read immutable sources without locking Inputs before the Context authority lock.
SELECT * FROM agent_runtime_inputs
WHERE context_key=sqlc.arg(context_key)::text AND status='steering'
 AND (sqlc.arg(steer_group_id)::text='' OR steer_group_id=sqlc.arg(steer_group_id)::text)
ORDER BY input_sequence;

-- name: HasDirectTaskInboxNonmemberAuthority :one
-- The caller already holds Task SHARE. A late membership cannot grant reception.
SELECT EXISTS(
 SELECT 1 FROM work_items item
 JOIN task_execution_generations generation ON generation.task_id=item.id AND generation.tenant_id=item.tenant_id AND generation.generation=item.task_execution_generation
 WHERE item.id=sqlc.arg(task_id)::text AND item.tenant_id=sqlc.arg(tenant_id)::text
 AND (generation.coordinator_actor_id=sqlc.arg(agent_actor_id)::text
  OR EXISTS(SELECT 1 FROM work_item_assignments assignment WHERE assignment.work_item_id=item.id AND assignment.tenant_id=item.tenant_id AND assignment.actor_id=sqlc.arg(agent_actor_id)::text)
  OR EXISTS(SELECT 1 FROM task_execution_participants participant WHERE participant.task_id=item.id AND participant.tenant_id=item.tenant_id AND participant.generation=item.task_execution_generation AND participant.actor_id=sqlc.arg(agent_actor_id)::text))
)::boolean;
