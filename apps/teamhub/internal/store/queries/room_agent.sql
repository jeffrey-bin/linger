-- name: GetRoomAgentMessageAuthority :one
SELECT room.id AS room_id,room.tenant_id,
       actor.id AS agent_id,actor.kind AS agent_kind,actor.display_name AS agent_display_name,
       actor.account_id AS agent_account_id,actor.handle AS agent_handle,actor.created_at AS agent_created_at,
       registration.created_by_actor_id AS agent_sponsor_actor_id
FROM rooms room
JOIN room_members membership
  ON membership.room_id=collaboration_membership_room_id(room.id)
 AND membership.tenant_id=room.tenant_id
JOIN actors actor
  ON actor.id=membership.actor_id
 AND actor.tenant_id=membership.tenant_id
 AND actor.kind='agent'
JOIN agent_registrations registration
  ON registration.actor_id=actor.id
 AND registration.tenant_id=actor.tenant_id
 AND registration.status='active'
WHERE room.id=sqlc.arg(room_id)::text
  AND registration.agent_management_id=sqlc.arg(agent_management_id)::text
FOR KEY SHARE OF room,membership,actor,registration;

