-- Both creation paths write an Agent through these two inserts. A retry that
-- finds the rows already written reads them back instead.

-- name: CreateAgentActor :execrows
INSERT INTO actors(id,tenant_id,kind,display_name,handle)
VALUES(sqlc.arg(id)::text,sqlc.arg(tenant_id)::text,'agent',sqlc.arg(display_name)::text,sqlc.narg(handle))
ON CONFLICT (id) DO NOTHING;

-- name: CreateAgentRegistration :one
INSERT INTO agent_registrations(
    actor_id,tenant_id,agent_management_id,status,description,avatar_key,instructions,
    runtime_model,runtime_reasoning_effort,computer_id,local_runtime_type,workspace_grant_id,
    created_by_actor_id,visibility_scope,agent_type,represented_human_actor_id,receives_all_messages
)
VALUES(
    sqlc.arg(actor_id)::text,sqlc.arg(tenant_id)::text,sqlc.arg(agent_management_id)::text,'active',
    sqlc.arg(description)::text,sqlc.narg(avatar_key)::text,sqlc.arg(instructions)::text,
    sqlc.arg(runtime_model)::text,sqlc.narg(runtime_reasoning_effort)::text,
    sqlc.arg(computer_id)::text,sqlc.arg(local_runtime_type)::text,sqlc.arg(workspace_grant_id)::text,
    sqlc.arg(created_by_actor_id)::text,sqlc.arg(visibility_scope)::text,sqlc.arg(agent_type)::text,
    sqlc.narg(represented_human_actor_id)::text,sqlc.arg(receives_all_messages)::boolean
)
ON CONFLICT (actor_id) DO NOTHING
-- Registration reads name their columns so the avatar image and template
-- Routines are never loaded with them.
RETURNING actor_id,tenant_id,agent_management_id,status,instructions,runtime_model,created_by_actor_id,
          created_at,updated_at,computer_id,local_runtime_type,workspace_grant_id,visibility_scope,
          description,configuration_revision,agent_type,represented_human_actor_id,
          user_artifact_owner_actor_id,runtime_reasoning_effort,avatar_key,
          runtime_configuration_revision,assignment_revision;

-- name: GetAgentRegistration :one
SELECT actor_id,tenant_id,agent_management_id,status,instructions,runtime_model,created_by_actor_id,
       created_at,updated_at,computer_id,local_runtime_type,workspace_grant_id,visibility_scope,
       description,configuration_revision,agent_type,represented_human_actor_id,
       user_artifact_owner_actor_id,runtime_reasoning_effort,avatar_key,
       runtime_configuration_revision,assignment_revision
FROM agent_registrations
WHERE actor_id=sqlc.arg(actor_id)::text AND tenant_id=sqlc.arg(tenant_id)::text;

-- name: GetAgentRegistrationByActor :one
SELECT actor_id,tenant_id,agent_management_id,status,description,avatar_key,configuration_revision,instructions,runtime_model,runtime_reasoning_effort,
       computer_id,local_runtime_type,workspace_grant_id,
       created_by_actor_id,visibility_scope,agent_type,created_at,updated_at
FROM agent_registrations
WHERE actor_id=$1 AND tenant_id=$2;

-- name: GetAgentRegistrationForDeletion :one
SELECT actor_id,tenant_id,agent_management_id,status,description,avatar_key,configuration_revision,instructions,runtime_model,runtime_reasoning_effort,
       computer_id,local_runtime_type,workspace_grant_id,
       created_by_actor_id,visibility_scope,agent_type,created_at,updated_at
FROM agent_registrations
WHERE actor_id=$1 AND tenant_id=$2
FOR UPDATE;

-- name: RevokeAgentRegistration :execrows
UPDATE agent_registrations
SET status='revoked',updated_at=now()
WHERE actor_id=$1 AND tenant_id=$2 AND status='active';

-- name: HasPendingAgentLocalWork :one
-- Work a Computer holds: running Runs and their steers. Queued Runs belong to
-- no Computer and run after the update.
SELECT EXISTS (
  SELECT 1 FROM agent_execution_contexts context
  WHERE context.tenant_id=$1 AND context.agent_actor_id=$2
    AND (EXISTS (SELECT 1 FROM agent_local_runs run
                 WHERE run.context_key=context.context_key AND run.status='running')
      OR EXISTS (SELECT 1 FROM agent_runtime_inputs input
                 WHERE input.context_key=context.context_key AND input.status='steering'))
);

-- name: CountLocalAgentRegistrationsByComputer :one
SELECT count(*)
FROM agent_registrations
WHERE tenant_id=sqlc.arg(tenant_id)::text
  AND computer_id=sqlc.arg(computer_id)::text
  AND status<>'revoked';

-- name: ListAgentRoomIDsForDeletion :many
SELECT membership.room_id
FROM room_members membership
WHERE membership.tenant_id=$1 AND membership.actor_id=$2
  AND NOT EXISTS (SELECT 1 FROM rooms direct
    WHERE direct.id=membership.room_id AND direct.direct_agent_actor_id IS NOT NULL)
ORDER BY membership.room_id;

-- name: ListAgentRoomIDsForPendingDecisionCheck :many
SELECT membership.room_id
FROM room_members membership
WHERE membership.tenant_id=$1 AND membership.actor_id=$2
ORDER BY membership.room_id;

-- name: GetActiveAgentRegistrationForAdmission :one
SELECT actor_id,tenant_id,agent_management_id,status,description,avatar_key,configuration_revision,instructions,runtime_model,runtime_reasoning_effort,
       computer_id,local_runtime_type,workspace_grant_id,
       created_by_actor_id,visibility_scope,agent_type,created_at,updated_at
FROM agent_registrations
WHERE actor_id=$1 AND tenant_id=$2 AND status='active'
FOR SHARE;

-- name: GetActiveAgentRegistrationByExternalID :one
SELECT actor_id,tenant_id,agent_management_id,status,description,avatar_key,configuration_revision,instructions,runtime_model,runtime_reasoning_effort,
       computer_id,local_runtime_type,workspace_grant_id,
       created_by_actor_id,visibility_scope,agent_type,created_at,updated_at
FROM agent_registrations
WHERE agent_management_id=$1 AND status='active';

-- name: GetAgentRegistrationForIdentityByExternalID :one
SELECT actor_id,tenant_id,agent_management_id,status,instructions,runtime_model,created_by_actor_id,
       created_at,updated_at,computer_id,local_runtime_type,workspace_grant_id,visibility_scope,
       description,configuration_revision,agent_type,represented_human_actor_id,
       user_artifact_owner_actor_id,runtime_reasoning_effort,avatar_key,
       runtime_configuration_revision,assignment_revision
FROM agent_registrations
WHERE agent_management_id=$1 AND status='active';

-- name: GetAnotherMeRepresentedHumanIdentityByExternalID :one
SELECT human.id AS actor_id,
       human.display_name,
       -- Version 0 means the Human has no memory.md yet.
       COALESCE(memory.version, 0)::integer AS memory_version,
       COALESCE(memory.markdown, '')::text AS memory_markdown
FROM agent_registrations registration
JOIN actors human
  ON human.id=registration.represented_human_actor_id
 AND human.tenant_id=registration.tenant_id
 AND human.kind='human'
LEFT JOIN LATERAL (
    SELECT revision.version, revision.markdown
    FROM user_memory_revisions revision
    WHERE revision.tenant_id=registration.tenant_id
      AND revision.owner_actor_id=registration.represented_human_actor_id
    ORDER BY revision.version DESC
    LIMIT 1
) memory ON true
WHERE registration.agent_management_id=$1
  AND registration.status='active'
  AND registration.agent_type='anotherme';

-- name: AgentRegistrationCursorExists :one
SELECT EXISTS (
  SELECT 1 FROM agent_registrations registration
  JOIN actors caller
    ON caller.tenant_id=registration.tenant_id
   AND caller.account_id=sqlc.arg(account_id)::text
   AND caller.kind='human'
  WHERE registration.actor_id=sqlc.arg(actor_id)::text
    AND registration.tenant_id=sqlc.arg(tenant_id)::text
    AND registration.status='active'
    AND (
      registration.visibility_scope='workspace' OR
      registration.created_by_actor_id=caller.id OR
      EXISTS (
        SELECT 1
        FROM active_room_members caller_membership
        JOIN active_room_members agent_membership
          ON agent_membership.room_id=caller_membership.room_id
         AND agent_membership.actor_id=registration.actor_id
        WHERE caller_membership.actor_id=caller.id
      )
    )
);

-- name: ListTenantAgentsForAccount :many
SELECT registration.actor_id,
       registration.tenant_id,
       registration.agent_management_id,
       registration.status,
       registration.description,
       registration.avatar_key,
       registration.configuration_revision,
       registration.instructions,
       
       registration.runtime_model,
       registration.runtime_reasoning_effort,
       registration.computer_id,
       registration.local_runtime_type,
       registration.workspace_grant_id,
       registration.created_by_actor_id,
       registration.visibility_scope,
       registration.agent_type,
       registration.created_at,
       registration.updated_at,
       agent.kind AS agent_kind,
       agent.display_name AS agent_display_name,
       agent.account_id AS agent_account_id,
       agent.handle AS agent_handle,
       agent.created_at AS agent_created_at,
       creator.kind AS creator_kind,
       creator.display_name AS creator_display_name,
       creator.account_id AS creator_account_id,
       creator.handle AS creator_handle,
       creator.created_at AS creator_created_at,
       coalesce(active_tasks.count,0)::bigint AS active_task_count
FROM agent_registrations registration
JOIN actors agent
  ON agent.id=registration.actor_id AND agent.tenant_id=registration.tenant_id
JOIN actors creator
  ON creator.id=registration.created_by_actor_id AND creator.tenant_id=registration.tenant_id
JOIN actors caller
  ON caller.tenant_id=registration.tenant_id
 AND caller.account_id=sqlc.arg(account_id)::text
 AND caller.kind='human'
LEFT JOIN LATERAL (
  SELECT count(*)::bigint AS count
  FROM task_execution_participants participant
  JOIN work_items item
    ON item.id=participant.task_id AND item.tenant_id=participant.tenant_id
   AND item.task_execution_generation=participant.generation
  WHERE participant.tenant_id=registration.tenant_id
    AND participant.actor_id=registration.actor_id
    AND item.task_execution_status='running'
) active_tasks ON true
WHERE registration.tenant_id=sqlc.arg(tenant_id)::text
  AND registration.status='active'
  AND (
    registration.visibility_scope='workspace' OR
    registration.created_by_actor_id=caller.id OR
    EXISTS (
      SELECT 1
      FROM active_room_members caller_membership
      JOIN active_room_members agent_membership
        ON agent_membership.room_id=caller_membership.room_id
       AND agent_membership.actor_id=registration.actor_id
      WHERE caller_membership.actor_id=caller.id
    )
  )
  AND (
    sqlc.arg(cursor)::text='' OR
    (registration.created_at,registration.actor_id)>(
      SELECT created_at,actor_id
      FROM agent_registrations
      WHERE actor_id=sqlc.arg(cursor)::text AND tenant_id=sqlc.arg(tenant_id)::text
    )
  )
ORDER BY registration.created_at,registration.actor_id
LIMIT sqlc.arg(page_limit)::int;

-- name: GetAgentRegistrationForUpdate :one
SELECT actor_id,tenant_id,agent_management_id,status,description,avatar_key,configuration_revision,instructions,runtime_model,runtime_reasoning_effort,
       computer_id,local_runtime_type,workspace_grant_id,
       created_by_actor_id,visibility_scope,agent_type,created_at,updated_at,
       runtime_configuration_revision,assignment_revision
FROM agent_registrations
WHERE actor_id=$1 AND tenant_id=$2
FOR UPDATE;

-- name: UpdateAgentActorDisplayName :execrows
UPDATE actors SET display_name=$3
WHERE id=$1 AND tenant_id=$2 AND kind='agent';

-- name: ApplyAgentProfileUpdate :execrows
-- A profile-only change: it advances the revision without
-- replacing the execution definition.
UPDATE agent_registrations
SET instructions=sqlc.arg(instructions)::text,
    description=sqlc.arg(description)::text,
    configuration_revision=configuration_revision+1,
    updated_at=now()
WHERE actor_id=sqlc.arg(actor_id)::text
  AND tenant_id=sqlc.arg(tenant_id)::text
  AND status='active'
  AND configuration_revision=sqlc.arg(expected_revision)::bigint;

-- name: CountSponsorGeneralAgents :one
SELECT count(*)::bigint
FROM agent_registrations
WHERE tenant_id=sqlc.arg(tenant_id)::text
  AND created_by_actor_id=sqlc.arg(sponsor_actor_id)::text
  AND agent_type='general'
  AND status='active';

-- name: ApplyAgentConfigurationUpdate :execrows
-- A new Computer, local Runtime or workspace grant is a new Runtime
-- Assignment: its revision fences the Runners and Operations of the old one.
UPDATE agent_registrations
SET description=sqlc.arg(description)::text,runtime_model=sqlc.arg(runtime_model)::text,
    runtime_reasoning_effort=sqlc.narg(runtime_reasoning_effort)::text,
    assignment_revision=assignment_revision+CASE WHEN
        computer_id IS DISTINCT FROM sqlc.arg(computer_id)::text
        OR local_runtime_type IS DISTINCT FROM sqlc.arg(local_runtime_type)::text
        OR workspace_grant_id IS DISTINCT FROM sqlc.arg(workspace_grant_id)::text
        THEN 1 ELSE 0 END,
    computer_id=sqlc.arg(computer_id)::text,local_runtime_type=sqlc.arg(local_runtime_type)::text,
    workspace_grant_id=sqlc.arg(workspace_grant_id)::text,
    configuration_revision=sqlc.arg(next_revision)::bigint,
    runtime_configuration_revision=sqlc.arg(next_revision)::bigint,
    instructions=sqlc.arg(instructions)::text,updated_at=now()
WHERE actor_id=sqlc.arg(actor_id)::text AND tenant_id=sqlc.arg(tenant_id)::text AND status='active'
  AND configuration_revision=sqlc.arg(expected_revision)::bigint;

-- name: UpdateAgentRegistrationAvatarKey :exec
UPDATE agent_registrations
SET avatar_key=sqlc.arg(avatar_key)::text,updated_at=now()
WHERE actor_id=sqlc.arg(actor_id)::text AND tenant_id=sqlc.arg(tenant_id)::text;

-- name: UpsertAgentAvatarImage :exec
UPDATE agent_registrations
SET avatar_image=sqlc.arg(avatar_image)::text,avatar_updated_at=now()
WHERE actor_id=sqlc.arg(actor_id)::text AND tenant_id=sqlc.arg(tenant_id)::text;

-- name: DeleteAgentAvatarImage :exec
UPDATE agent_registrations
SET avatar_image=NULL,avatar_updated_at=NULL
WHERE actor_id=sqlc.arg(actor_id)::text AND tenant_id=sqlc.arg(tenant_id)::text;

-- Agent directories carry only each image's version; the bytes are fetched by
-- URL, once per version.
-- name: ListAgentAvatarImageVersions :many
SELECT actor_id,avatar_updated_at::timestamptz AS updated_at
FROM agent_registrations
WHERE tenant_id=sqlc.arg(tenant_id)::text AND actor_id=ANY(sqlc.arg(actor_ids)::text[])
  AND avatar_image IS NOT NULL;

-- The image is visible exactly when its Agent is in the caller's Tenant Agent
-- directory (ListTenantAgentsForAccount).
-- name: GetVisibleAgentAvatarImage :one
SELECT registration.avatar_image::text AS avatar_image,registration.avatar_updated_at::timestamptz AS updated_at
FROM agent_registrations registration
JOIN actors caller
  ON caller.tenant_id=registration.tenant_id
 AND caller.account_id=sqlc.arg(account_id)::text
 AND caller.kind='human'
WHERE registration.tenant_id=sqlc.arg(tenant_id)::text
  AND registration.actor_id=sqlc.arg(actor_id)::text
  AND registration.avatar_image IS NOT NULL
  AND registration.status='active'
  AND (
    registration.visibility_scope='workspace' OR
    registration.created_by_actor_id=caller.id OR
    EXISTS (
      SELECT 1
      FROM active_room_members caller_membership
      JOIN active_room_members agent_membership
        ON agent_membership.room_id=caller_membership.room_id
       AND agent_membership.actor_id=registration.actor_id
      WHERE caller_membership.actor_id=caller.id
    )
  );

-- name: ListLocalAgentComputerObservations :many
SELECT registration.actor_id, computer.computer_id, computer.display_name,
       computer.status, computer.runtime_diagnostics, computer.last_seen_at
FROM agent_registrations registration
JOIN local_computers computer ON computer.computer_id=registration.computer_id
  AND computer.owner_tenant_id=registration.tenant_id
  AND computer.owner_actor_id=registration.created_by_actor_id
WHERE registration.tenant_id=sqlc.arg(tenant_id)::text
  AND registration.actor_id=ANY(sqlc.arg(actor_ids)::text[])
  AND computer.status<>'removed';

-- name: IsActiveRoomMember :one
SELECT EXISTS(
  SELECT 1 FROM active_room_members
  WHERE room_id=sqlc.arg(room_id)::text AND tenant_id=sqlc.arg(tenant_id)::text AND actor_id=sqlc.arg(actor_id)::text
)::boolean;

-- name: IsTenantDirectRoom :one
SELECT EXISTS(
  SELECT 1 FROM rooms
  WHERE id=sqlc.arg(room_id)::text AND tenant_id=sqlc.arg(tenant_id)::text AND direct_agent_actor_id IS NOT NULL
)::boolean;

-- name: GetAgentLocalComputerPlacement :one
-- The Computer an Agent runs on, while its Sponsor still owns it.
SELECT registration.computer_id::text AS computer_id, computer.owner_actor_id
FROM agent_registrations registration
JOIN local_computers computer
  ON computer.computer_id=registration.computer_id AND computer.removed_at IS NULL
 AND computer.owner_tenant_id=registration.tenant_id AND computer.owner_actor_id=registration.created_by_actor_id
WHERE registration.actor_id=sqlc.arg(actor_id)::text AND registration.tenant_id=sqlc.arg(tenant_id)::text
  AND coalesce(registration.computer_id,'')<>'';
