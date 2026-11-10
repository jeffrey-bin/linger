-- name: GetVisibleActiveAgentForDirectRoom :one
SELECT agent.id,agent.tenant_id,agent.kind,agent.display_name,
       agent.account_id,agent.handle,agent.created_at,
       registration.created_by_actor_id,registration.visibility_scope
FROM agent_registrations registration
JOIN actors agent
  ON agent.id=registration.actor_id AND agent.tenant_id=registration.tenant_id
WHERE registration.tenant_id=sqlc.arg(tenant_id)::text
  AND registration.actor_id=sqlc.arg(agent_actor_id)::text
  AND registration.status='active'
  AND agent.kind='agent'
  AND (
    registration.visibility_scope='workspace' OR
    registration.created_by_actor_id=sqlc.arg(human_actor_id)::text OR
    EXISTS (
      SELECT 1
      FROM active_room_members human_membership
      JOIN active_room_members agent_membership
        ON agent_membership.room_id=human_membership.room_id
       AND agent_membership.actor_id=registration.actor_id
      WHERE human_membership.actor_id=sqlc.arg(human_actor_id)::text
    )
  )
FOR SHARE OF registration;

-- name: GetDirectRoomByPair :one
-- The pair's Room, whether live, being deleted or deleted: at most one Room
-- holds a pair.
SELECT id,tenant_id,name,description,created_by_actor_id,
       next_room_seq,created_at,updated_at,
       deletion_started_at,deletion_started_by_actor_id,
       deleted_at,deleted_by_actor_id,
       direct_human_actor_id,direct_agent_actor_id,parent_room_id,root_message_id,
       team_md_raw_markdown,team_md_collaborate_pattern,team_md_document,
       team_md_revision,team_md_updated_at,team_md_updated_by_actor_id
FROM rooms
WHERE tenant_id=sqlc.arg(tenant_id)::text
  AND direct_human_actor_id=sqlc.arg(human_actor_id)::text
  AND direct_agent_actor_id=sqlc.arg(agent_actor_id)::text;

-- name: ReleaseFinishedDirectRoomPair :exec
-- Reopening a pair whose Room finished deletion leaves that Room as history:
-- it stops holding the pair before MarkDirectRoom gives it to the new Room. A
-- live or deleting Room is never released.
UPDATE rooms
SET direct_human_actor_id=NULL,direct_agent_actor_id=NULL
WHERE tenant_id=sqlc.arg(tenant_id)::text
  AND direct_human_actor_id=sqlc.arg(human_actor_id)::text
  AND direct_agent_actor_id=sqlc.arg(agent_actor_id)::text
  AND deleted_at IS NOT NULL;

-- name: MarkDirectRoom :one
UPDATE rooms
SET direct_human_actor_id=sqlc.arg(human_actor_id)::text,
    direct_agent_actor_id=sqlc.arg(agent_actor_id)::text
WHERE id=sqlc.arg(room_id)::text AND tenant_id=sqlc.arg(tenant_id)::text
RETURNING id;

-- name: GetCurrentDirectRoom :one
-- The pair's direct Room while it is not being deleted and the Agent is still
-- in it. Lookups that only use a direct Room read it here; opening one goes
-- through roomcreation.OpenOrCreateDirectRoom.
SELECT room.id
FROM rooms room
JOIN active_room_members member
  ON member.room_id=room.id AND member.tenant_id=room.tenant_id AND member.actor_id=room.direct_agent_actor_id
WHERE room.tenant_id=sqlc.arg(tenant_id)::text
  AND room.direct_human_actor_id=sqlc.arg(human_actor_id)::text
  AND room.direct_agent_actor_id=sqlc.arg(agent_actor_id)::text
  AND room.deletion_started_at IS NULL;

-- name: GetDirectRoom :one
SELECT id AS room_id,tenant_id,
       direct_human_actor_id::text AS human_actor_id,
       direct_agent_actor_id::text AS agent_actor_id
FROM rooms
WHERE id=sqlc.arg(room_id)::text AND direct_agent_actor_id IS NOT NULL;

-- name: GetDirectRoomPeerForAccount :one
SELECT peer.id,peer.tenant_id,peer.kind,peer.display_name,
       peer.account_id,peer.handle,peer.created_at,
       (registration.status='active')::boolean AS active
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
JOIN agent_registrations registration
  ON registration.actor_id=peer.id AND registration.tenant_id=peer.tenant_id
WHERE direct.id=sqlc.arg(room_id)::text;

-- name: DirectRoomPeerIsActive :one
-- An Agent syncing its configuration is still a live peer: its direct Room
-- takes messages and cannot be deleted.
SELECT coalesce((
  SELECT registration.status='active'
  FROM rooms direct
  JOIN agent_registrations registration
    ON registration.actor_id=direct.direct_agent_actor_id
   AND registration.tenant_id=direct.tenant_id
  WHERE direct.id=sqlc.arg(room_id)::text
),true)::boolean;

-- name: IsDirectRoom :one
SELECT EXISTS(
  SELECT 1 FROM rooms WHERE id=sqlc.arg(room_id)::text AND direct_agent_actor_id IS NOT NULL
)::boolean;
