-- name: AuthorizeTenantAgentTemplate :one
SELECT actor.id, actor.display_name, actor.kind
FROM actors actor
WHERE actor.tenant_id=$1 AND actor.account_id=$2 AND actor.kind='human';

-- name: ListAgentTemplates :many
SELECT template.*,
    publisher.display_name AS published_by_display_name,
    publisher.tenant_id AS published_by_tenant_id
FROM agent_templates template
LEFT JOIN actors publisher ON publisher.id=template.published_by_actor_id
ORDER BY template.origin COLLATE "C", template.created_at DESC, template.template_id COLLATE "C";

-- name: InsertPublishedAgentTemplate :one
INSERT INTO agent_templates (
    template_id, origin, tenant_id, name, description, instructions, avatar_key,
    skill_bindings, connector_bindings, published_by_actor_id, routines
) VALUES ($1,'published',$2,$3,$4,$5,$6,$7,$8,$9,$10)
RETURNING *;

-- name: DeletePublishedAgentTemplate :execrows
-- Removal is authorized before this runs: the Space's Human removes any
-- template published from this Space.
DELETE FROM agent_templates
WHERE template_id=$1 AND origin='published';

-- name: GetAgentTemplateOwner :one
SELECT origin, published_by_actor_id, tenant_id FROM agent_templates WHERE template_id=$1;

-- name: UpsertBuiltinAgentTemplate :exec
INSERT INTO agent_templates (
    template_id, origin, name, description, instructions, avatar_key,
    skill_bindings, connector_bindings, routines
) VALUES ($1,'builtin',$2,$3,$4,$5,$6,$7,$8)
ON CONFLICT (template_id) DO UPDATE SET
    name=EXCLUDED.name,
    description=EXCLUDED.description,
    instructions=EXCLUDED.instructions,
    avatar_key=EXCLUDED.avatar_key,
    skill_bindings=EXCLUDED.skill_bindings,
    connector_bindings=EXCLUDED.connector_bindings,
    routines=EXCLUDED.routines,
    updated_at=now()
WHERE agent_templates.origin='builtin';

-- name: DeleteBuiltinAgentTemplatesOutside :exec
DELETE FROM agent_templates
WHERE origin='builtin' AND NOT (template_id=ANY(sqlc.arg(kept_template_ids)::text[]));

-- name: GetAgentTemplate :one
SELECT * FROM agent_templates WHERE template_id=$1;

-- name: GetSkillIdentity :one
SELECT owner_kind,COALESCE(tenant_id,'')::text AS tenant_id,
       access_scope,COALESCE(owner_actor_id,'')::text AS owner_actor_id
FROM skills
WHERE skill_id=sqlc.arg(skill_id)::text;

-- name: GetAgentTemplateSkillSource :one
-- Publishing a template shares its Skill versions, so the source is read from
-- the publishing Tenant without the caller visibility filter.
SELECT manifest.manifest_id,skill.skill_id,manifest.manifest_version,skill.name,
       manifest.description,manifest.config_schema,manifest.frontmatter_extra,
       manifest.content_hash,manifest.file_count,manifest.size_bytes
FROM skills skill
JOIN skill_manifests manifest
  ON manifest.skill_id=skill.skill_id
 AND manifest.manifest_version=sqlc.arg(manifest_version)::text
 AND manifest.package_state='sealed'
WHERE skill.skill_id=sqlc.arg(skill_id)::text AND skill.owner_kind='tenant'
  AND skill.tenant_id=sqlc.arg(tenant_id)::text
  AND manifest.state='active';

-- name: FindOwnedSkillCopy :one
SELECT skill.skill_id,manifest.manifest_version,skill.name
FROM skills skill
JOIN skill_manifests manifest
  ON manifest.skill_id=skill.skill_id
 AND manifest.content_hash=sqlc.arg(content_hash)
 AND manifest.package_state='sealed'
WHERE skill.owner_kind='tenant' AND skill.tenant_id=sqlc.arg(tenant_id)::text
  AND skill.access_scope='owner' AND skill.owner_actor_id=sqlc.arg(owner_actor_id)::text
  AND skill.name=sqlc.arg(name)
  AND manifest.state='active'
ORDER BY manifest.created_at DESC,skill.skill_id COLLATE "C"
LIMIT 1;

-- name: ReserveAgentTemplateInstallation :execrows
UPDATE agent_registrations
SET template_id=sqlc.arg(template_id)::text,template_routines=sqlc.arg(routines)::jsonb
WHERE actor_id=sqlc.arg(agent_actor_id)::text AND template_id IS NULL;

-- name: GetAgentTemplateInstallation :one
SELECT template_id::text AS template_id,template_routines::jsonb AS routines,
       template_installed_at AS completed_at
FROM agent_registrations WHERE actor_id=$1 AND template_id IS NOT NULL;

-- name: CompleteAgentTemplateInstallation :exec
UPDATE agent_registrations SET template_installed_at=clock_timestamp()
WHERE actor_id=$1 AND template_id IS NOT NULL AND template_installed_at IS NULL;

-- name: PauseAgentTemplateRoutines :many
UPDATE room_reminders
SET enabled=false, next_run_at=NULL, revision=revision+1, updated_at=clock_timestamp()
WHERE template_agent_actor_id=$1
RETURNING *;
