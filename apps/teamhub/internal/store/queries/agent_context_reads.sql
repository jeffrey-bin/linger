-- name: GetAgentContextReadRoom :one
SELECT room.id AS room_id, collaboration_membership_room_id(room.id)::text AS membership_room_id,
 coalesce((SELECT max(event.room_seq) FROM room_events event
 WHERE event.room_id=collaboration_membership_room_id(room.id)
 AND event.event_type IN ('room.member.added','room.member.role_changed','room.member.removed')),0)::bigint AS membership_revision
FROM rooms room
WHERE room.id=agent_inbox_resource_room(sqlc.arg(tenant_id)::text,sqlc.arg(inbox_id)::text)
 AND room.tenant_id=sqlc.arg(tenant_id)::text
 AND actor_can_read_inbox(sqlc.arg(tenant_id)::text,sqlc.arg(actor_id)::text,sqlc.arg(inbox_id)::text);

-- name: ListAgentContextReadRoomMembers :many
WITH members AS (
 SELECT actor.id AS actor_id,actor.kind,actor.display_name
 FROM active_room_members member JOIN actors actor ON actor.id=member.actor_id AND actor.tenant_id=member.tenant_id
 WHERE member.tenant_id=sqlc.arg(tenant_id)::text AND member.room_id=sqlc.arg(room_id)::text
 UNION
 SELECT actor.id,actor.kind,actor.display_name FROM rooms thread
 JOIN messages root ON root.id=thread.root_message_id AND root.tenant_id=thread.tenant_id
 JOIN actors actor ON actor.id=root.author_actor_id AND actor.tenant_id=thread.tenant_id
 JOIN active_room_members parent_member ON parent_member.room_id=thread.parent_room_id AND parent_member.actor_id=actor.id AND parent_member.tenant_id=thread.tenant_id
 WHERE thread.id=sqlc.arg(room_id)::text AND thread.tenant_id=sqlc.arg(tenant_id)::text
 UNION
 SELECT actor.id,actor.kind,actor.display_name FROM thread_room_list_actors listed
 JOIN rooms thread ON thread.id=listed.thread_room_id AND thread.tenant_id=listed.tenant_id
 JOIN actors actor ON actor.id=listed.actor_id AND actor.tenant_id=listed.tenant_id
 JOIN active_room_members parent_member ON parent_member.room_id=thread.parent_room_id AND parent_member.actor_id=actor.id AND parent_member.tenant_id=thread.tenant_id
 WHERE thread.id=sqlc.arg(room_id)::text AND thread.tenant_id=sqlc.arg(tenant_id)::text
)
SELECT members.actor_id,members.kind,members.display_name,
 coalesce(registration.agent_type,'')::text AS agent_type,
 coalesce(registration.description,'')::text AS description
FROM members LEFT JOIN agent_registrations registration
 ON registration.actor_id=members.actor_id AND registration.tenant_id=sqlc.arg(tenant_id)::text AND members.kind='agent'
ORDER BY members.actor_id;
