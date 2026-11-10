-- name: GetAnotherMeRegistration :one
SELECT registration.actor_id,registration.tenant_id,registration.agent_management_id,registration.status,
       registration.instructions,registration.runtime_model,registration.created_by_actor_id,
       registration.created_at,registration.updated_at,registration.computer_id,
       registration.local_runtime_type,registration.workspace_grant_id,registration.visibility_scope,
       registration.description,registration.configuration_revision,registration.agent_type,
       registration.represented_human_actor_id,
       registration.user_artifact_owner_actor_id,registration.runtime_reasoning_effort,
       registration.avatar_key,registration.runtime_configuration_revision,registration.assignment_revision
FROM agent_registrations registration
WHERE registration.tenant_id=sqlc.arg(tenant_id)::text
  AND registration.represented_human_actor_id=sqlc.arg(represented_human_actor_id)::text
  AND registration.agent_type='anotherme'
  AND registration.status='active';

-- name: ListAnotherMePlacements :many
-- The Agent Service runs a Human's background model calls on the Computer of
-- that Human's Another Me. An empty filter matches every tenant or owner.
SELECT registration.tenant_id,
       registration.represented_human_actor_id::text AS owner_actor_id,
       registration.agent_management_id::text AS agent_id,
       registration.actor_id AS agent_actor_id,
       registration.computer_id::text AS computer_id,
       registration.local_runtime_type::text AS local_runtime_type,
       registration.status
FROM agent_registrations registration
WHERE registration.agent_type='anotherme'
  AND registration.status='active'
  AND registration.represented_human_actor_id IS NOT NULL
  AND registration.agent_management_id IS NOT NULL
  AND registration.computer_id IS NOT NULL
  AND registration.local_runtime_type IS NOT NULL
  AND (sqlc.arg(tenant_id)::text='' OR registration.tenant_id=sqlc.arg(tenant_id)::text)
  AND (sqlc.arg(owner_actor_id)::text='' OR registration.represented_human_actor_id=sqlc.arg(owner_actor_id)::text)
ORDER BY registration.tenant_id,registration.represented_human_actor_id
LIMIT 1000;

-- name: GetAnotherMeChat :one
-- The Human's Another Me and its live direct Room with them. The Room is
-- absent while the pair has no live Room.
SELECT registration.actor_id AS agent_actor_id,room.id AS room_id
FROM agent_registrations registration
LEFT JOIN rooms room
  ON room.tenant_id=registration.tenant_id
 AND room.direct_human_actor_id=registration.represented_human_actor_id
 AND room.direct_agent_actor_id=registration.actor_id
 AND room.deletion_started_at IS NULL
WHERE registration.tenant_id=sqlc.arg(tenant_id)::text
  AND registration.represented_human_actor_id=sqlc.arg(human_actor_id)::text
  AND registration.agent_type='anotherme'
  AND registration.status='active';
