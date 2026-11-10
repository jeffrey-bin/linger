-- name: GetAgentSendMessageThreadRoom :one
SELECT thread_room.id AS room_id,
       thread_room.parent_room_id::text AS parent_room_id,
       thread_room.tenant_id,
       actor.id AS agent_id,
       actor.kind AS agent_kind,
       actor.display_name AS agent_display_name,
       actor.account_id AS agent_account_id,
       actor.handle AS agent_handle,
       actor.created_at AS agent_created_at
FROM rooms thread_room
JOIN room_members membership
  ON membership.room_id=thread_room.parent_room_id
 AND membership.tenant_id=thread_room.tenant_id
JOIN actors actor
  ON actor.id=membership.actor_id
 AND actor.tenant_id=thread_room.tenant_id
WHERE thread_room.id=sqlc.arg(thread_id)::text
  AND thread_room.tenant_id=sqlc.arg(tenant_id)::text
  AND thread_room.parent_room_id IS NOT NULL
  AND thread_room.deletion_started_at IS NULL
  AND thread_room.deleted_at IS NULL
  AND membership.actor_id=sqlc.arg(agent_actor_id)::text
  AND actor.kind='agent'
  AND (
      EXISTS (
          SELECT 1
          FROM messages root
          WHERE root.id=thread_room.root_message_id
            AND root.room_id=thread_room.parent_room_id
            AND root.tenant_id=thread_room.tenant_id
            AND root.author_actor_id=membership.actor_id
      ) OR EXISTS (
          SELECT 1
          FROM thread_room_list_actors listed
          WHERE listed.thread_room_id=thread_room.id
            AND listed.actor_id=membership.actor_id
            AND listed.tenant_id=thread_room.tenant_id
      )
  )
FOR SHARE OF thread_room,membership;

-- name: GetAgentSendMessageReplayMessage :one
SELECT message.id
FROM messages message
WHERE message.id=sqlc.arg(message_id)::text
  AND message.tenant_id=sqlc.arg(tenant_id)::text
  AND message.room_id=sqlc.arg(room_id)::text
  AND message.author_actor_id=sqlc.arg(agent_actor_id)::text;
