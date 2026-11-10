-- name: GetVoiceNotifyDirectPeerForAccount :one
SELECT peer.id,peer.tenant_id,peer.kind,peer.display_name,
       peer.account_id,peer.handle,peer.created_at,
	   (registration.status='active')::boolean AS active,
	   registration.agent_management_id
FROM rooms direct
JOIN actors caller
  ON caller.id=direct.direct_human_actor_id
 AND caller.tenant_id=direct.tenant_id
 AND caller.account_id=sqlc.arg(account_id)::text
 AND caller.kind='human'
JOIN active_room_members caller_membership
  ON caller_membership.room_id=direct.id AND caller_membership.actor_id=caller.id
JOIN actors peer
  ON peer.id=direct.direct_agent_actor_id AND peer.tenant_id=direct.tenant_id
JOIN active_room_members peer_membership
  ON peer_membership.room_id=direct.id AND peer_membership.actor_id=peer.id
JOIN agent_registrations registration
  ON registration.actor_id=peer.id AND registration.tenant_id=peer.tenant_id
WHERE direct.id=sqlc.arg(room_id)::text
  AND peer.id=sqlc.arg(target_agent_id)::text
FOR KEY SHARE OF caller_membership,peer_membership,registration;

-- name: GetVoiceNotifyDirectPeerForAccountRoom :one
SELECT peer.id,peer.tenant_id,peer.kind,peer.display_name,
       peer.account_id,peer.handle,peer.created_at,
       (registration.status='active')::boolean AS active,
       registration.agent_management_id
FROM rooms direct
JOIN actors caller
  ON caller.id=direct.direct_human_actor_id
 AND caller.tenant_id=direct.tenant_id
 AND caller.account_id=sqlc.arg(account_id)::text
 AND caller.kind='human'
JOIN active_room_members caller_membership
  ON caller_membership.room_id=direct.id AND caller_membership.actor_id=caller.id
JOIN actors peer
  ON peer.id=direct.direct_agent_actor_id AND peer.tenant_id=direct.tenant_id
JOIN active_room_members peer_membership
  ON peer_membership.room_id=direct.id AND peer_membership.actor_id=peer.id
JOIN agent_registrations registration
  ON registration.actor_id=peer.id AND registration.tenant_id=peer.tenant_id
WHERE direct.id=sqlc.arg(room_id)::text
FOR KEY SHARE OF caller_membership,peer_membership,registration;
