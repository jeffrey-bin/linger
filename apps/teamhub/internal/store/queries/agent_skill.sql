-- name: AuthorizeAgentSkillBinding :one
SELECT registration.actor_id,registration.tenant_id,caller.id AS caller_actor_id
FROM agent_registrations registration
JOIN actors caller ON caller.tenant_id=registration.tenant_id
WHERE registration.actor_id=$1 AND registration.tenant_id=$2
  AND registration.status='active'
  AND registration.agent_type IN ('general','anotherme')
  AND caller.account_id=$3 AND caller.kind='human';

-- name: AuthorizeAgentSkillBindingWrite :one
SELECT registration.actor_id,registration.tenant_id,caller.id AS caller_actor_id
FROM agent_registrations registration
JOIN actors caller ON caller.tenant_id=registration.tenant_id
WHERE registration.actor_id=$1 AND registration.tenant_id=$2
  AND registration.status='active'
  AND registration.agent_type IN ('general','anotherme')
  AND caller.account_id=$3 AND caller.kind='human'
  AND registration.created_by_actor_id=caller.id;

-- Authorizes an Agent publishing a Skill package it assembled itself. The
-- Agent Service is authenticated by its service credential and the Agent is
-- named by an active Context, so there is no Human caller to match. Ownership
-- still resolves to the Sponsor: an owner-scoped Skill owned by the Agent would
-- be invisible to the very person who has to review and apply it.
-- name: AuthorizeAgentSkillBindingRuntimeWrite :one
SELECT registration.actor_id,registration.tenant_id,
       registration.created_by_actor_id AS caller_actor_id,
       sponsor.account_id AS caller_account_id
FROM agent_registrations registration
JOIN actors sponsor ON sponsor.id=registration.created_by_actor_id
WHERE registration.agent_management_id=sqlc.arg(agent_management_id)::text
  AND registration.tenant_id=sqlc.arg(tenant_id)::text
  AND registration.status='active'
  AND registration.agent_type IN ('general','anotherme')
  AND sponsor.kind='human' AND sponsor.account_id IS NOT NULL;

-- name: GetUnifiedSkillIdentityForUpdate :one
SELECT owner_kind,COALESCE(tenant_id,'')::text AS tenant_id,name,
       access_scope,COALESCE(owner_actor_id,'')::text AS owner_actor_id
FROM skills
WHERE skill_id=sqlc.arg(skill_id)::text
FOR UPDATE;

-- The Agent binding version is the newest version any of its bindings carries;
-- an Agent without bindings is at version 1. Writers hold the Skill policy lock.
-- name: GetAgentSkillBindingVersion :one
SELECT COALESCE(max(binding_version),1)::bigint AS binding_version
FROM agent_skill_bindings
WHERE agent_actor_id=$1;

-- name: CreateAgentSkillBinding :one
INSERT INTO agent_skill_bindings(
    id,tenant_id,agent_actor_id,skill_id,manifest_version,enabled,config,
    binding_version,updated_by_actor_id
)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
ON CONFLICT(agent_actor_id,skill_id)
DO NOTHING
RETURNING id,tenant_id,agent_actor_id,skill_id,manifest_version,enabled,config,
          binding_version,updated_by_actor_id,updated_at,created_at,deleted_at;

-- name: UpdateAgentSkillBinding :one
-- Rewrites an existing binding, reviving it when it was removed.
UPDATE agent_skill_bindings
SET manifest_version=sqlc.arg(manifest_version)::text,
    enabled=sqlc.arg(enabled)::boolean,
    config=sqlc.arg(config)::jsonb,
    binding_version=sqlc.arg(binding_version)::bigint,
    updated_by_actor_id=sqlc.arg(updated_by_actor_id)::text,
    updated_at=now(),
    deleted_at=NULL
WHERE agent_actor_id=sqlc.arg(agent_actor_id)::text
  AND tenant_id=sqlc.arg(tenant_id)::text
  AND skill_id=sqlc.arg(skill_id)::text
RETURNING id,tenant_id,agent_actor_id,skill_id,manifest_version,enabled,config,
          binding_version,updated_by_actor_id,updated_at,created_at,deleted_at;

-- name: GetExplicitBindableSkillManifest :one
SELECT manifest.manifest_id,manifest.skill_id,manifest.manifest_version,
       skill.name,manifest.config_schema,manifest.state,
       (skill.owner_kind='tenant' OR skill.latest_manifest_id=manifest.manifest_id) AS current_version
FROM skills skill
JOIN skill_manifests manifest
  ON manifest.skill_id=skill.skill_id
 AND manifest.manifest_version=sqlc.arg(manifest_version)::text
 AND manifest.package_state='sealed'
WHERE skill.skill_id=sqlc.arg(skill_id)::text
  AND cardinality(skill.default_agent_types)=0
  AND (
      (skill.owner_kind='tenant' AND skill.tenant_id=sqlc.arg(tenant_id)::text
       AND (skill.access_scope='tenant'
            OR skill.owner_actor_id=sqlc.arg(sponsor_actor_id)::text))
      OR (skill.owner_kind='platform' AND skill.tenant_id IS NULL)
  );

-- name: ListAgentSkillBindings :many
SELECT binding.id,binding.tenant_id,binding.agent_actor_id,binding.skill_id,
       binding.manifest_version,binding.enabled,binding.config,
       binding.binding_version,binding.updated_by_actor_id,binding.updated_at,
       binding.created_at,binding.deleted_at
FROM agent_skill_bindings binding
JOIN skills skill
  ON skill.skill_id=binding.skill_id
 AND cardinality(skill.default_agent_types)=0
JOIN skill_manifests manifest
  ON manifest.skill_id=binding.skill_id
 AND manifest.manifest_version=binding.manifest_version
 AND manifest.package_state='sealed'
WHERE binding.agent_actor_id=sqlc.arg(agent_actor_id)::text
  AND binding.tenant_id=sqlc.arg(tenant_id)::text
  AND binding.deleted_at IS NULL
  AND (
      (skill.owner_kind='tenant' AND skill.tenant_id=binding.tenant_id)
      OR (skill.owner_kind='platform' AND skill.tenant_id IS NULL)
  )
ORDER BY binding.skill_id;

-- name: GetAgentSkillBinding :one
SELECT binding.id,binding.tenant_id,binding.agent_actor_id,binding.skill_id,
       binding.manifest_version,binding.enabled,binding.config,
       binding.binding_version,binding.updated_by_actor_id,binding.updated_at,
       binding.created_at,binding.deleted_at
FROM agent_skill_bindings binding
JOIN skills skill
  ON skill.skill_id=binding.skill_id
 AND cardinality(skill.default_agent_types)=0
JOIN skill_manifests manifest
  ON manifest.skill_id=binding.skill_id
 AND manifest.manifest_version=binding.manifest_version
 AND manifest.package_state='sealed'
WHERE binding.agent_actor_id=sqlc.arg(agent_actor_id)::text
  AND binding.tenant_id=sqlc.arg(tenant_id)::text
  AND binding.skill_id=sqlc.arg(skill_id)::text
  AND binding.deleted_at IS NULL
  AND (
      (skill.owner_kind='tenant' AND skill.tenant_id=binding.tenant_id)
      OR (skill.owner_kind='platform' AND skill.tenant_id IS NULL)
  );

-- name: DeleteAgentSkillBinding :one
-- Removal keeps the row, its Manifest and config; a later write revives it.
UPDATE agent_skill_bindings
SET enabled=false,
    binding_version=sqlc.arg(binding_version)::bigint,
    updated_by_actor_id=sqlc.arg(changed_by_actor_id)::text,
    updated_at=now(),
    deleted_at=now()
WHERE agent_actor_id=sqlc.arg(agent_actor_id)::text
  AND tenant_id=sqlc.arg(tenant_id)::text
  AND skill_id=sqlc.arg(skill_id)::text
  AND deleted_at IS NULL
RETURNING id;

-- name: ListAgentSkillRegistrationsForAgents :many
SELECT binding.agent_actor_id,skill.name,
       binding.skill_id,manifest.manifest_version,manifest.description,
       false AS is_default
FROM agent_skill_bindings binding
JOIN skills skill
  ON skill.skill_id=binding.skill_id
 AND cardinality(skill.default_agent_types)=0
JOIN skill_manifests manifest
  ON manifest.skill_id=binding.skill_id
 AND manifest.manifest_version=binding.manifest_version
 AND manifest.package_state='sealed'
 AND manifest.state='active'
WHERE binding.agent_actor_id=ANY(sqlc.arg(agent_actor_ids)::text[])
  AND binding.enabled AND binding.deleted_at IS NULL
  AND (
      (skill.owner_kind='tenant' AND skill.tenant_id=binding.tenant_id)
      OR (skill.owner_kind='platform' AND skill.tenant_id IS NULL)
  )
UNION ALL
SELECT registration.actor_id AS agent_actor_id,skill.name,
       manifest.skill_id,manifest.manifest_version,manifest.description,
       true AS is_default
FROM agent_registrations registration
JOIN skills skill
  ON skill.owner_kind='platform'
 AND skill.default_agent_types @> ARRAY[registration.agent_type]::text[]
JOIN skill_manifests manifest
  ON manifest.manifest_id=skill.latest_manifest_id
 AND manifest.skill_id=skill.skill_id
 AND manifest.package_state='sealed'
 AND manifest.state='active'
WHERE registration.actor_id=ANY(sqlc.arg(agent_actor_ids)::text[])
  AND registration.status='active'
ORDER BY agent_actor_id,skill_id;

-- name: ListAllowedRequiredPlatformSkillSnapshotPackagesForAgent :many
SELECT manifest.skill_id,manifest.manifest_version,
       skill.name AS name,
       skill.name AS package_name,manifest.content_hash
FROM agent_registrations registration
JOIN skills skill
  ON skill.owner_kind='platform'
 AND skill.default_agent_types @> ARRAY[registration.agent_type]::text[]
JOIN skill_manifests manifest
  ON manifest.manifest_id=skill.latest_manifest_id
 AND manifest.skill_id=skill.skill_id
 AND manifest.package_state='sealed'
 AND manifest.state='active'
WHERE registration.actor_id=sqlc.arg(agent_actor_id)::text
  AND registration.status<>'revoked'
ORDER BY manifest.skill_id COLLATE "C",manifest.manifest_version COLLATE "C";
