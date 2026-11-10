-- name: CreateTenantSkill :exec
INSERT INTO skills(
    skill_id,owner_kind,tenant_id,name,access_scope,owner_actor_id,created_by_actor_id
)
VALUES(
    sqlc.arg(skill_id),'tenant',sqlc.arg(tenant_id),sqlc.arg(name),sqlc.arg(access_scope),
    sqlc.narg(owner_actor_id),sqlc.arg(created_by_actor_id)
);

-- name: CreateSkillManifest :exec
-- files is the validated list from skill.EncodeManifestFiles.
INSERT INTO skill_manifests(
    manifest_id,skill_id,manifest_version,description,config_schema,
    frontmatter_extra,content_hash,file_count,size_bytes,created_by_actor_id,files
)
VALUES(
    sqlc.arg(manifest_id),sqlc.arg(skill_id),sqlc.arg(manifest_version),
    sqlc.arg(description),sqlc.arg(config_schema),sqlc.arg(frontmatter_extra)::jsonb,
    sqlc.arg(content_hash),sqlc.arg(file_count),sqlc.arg(size_bytes),
    sqlc.arg(created_by_actor_id),sqlc.arg(files)::jsonb
);

-- name: SealSkillManifest :exec
UPDATE skill_manifests
SET package_state='sealed',sealed_at=now()
WHERE manifest_id=$1 AND package_state='uploading';

-- name: SkillManifestVersionExists :one
SELECT EXISTS(
    SELECT 1 FROM skill_manifests
    WHERE skill_id=$1 AND manifest_version=$2
);

-- name: ListBindableSkillManifests :many
-- One keyset page of every Tenant Skill version the caller can see and the
-- current version of every Platform Skill that is not an Agent Type default.
SELECT skill.skill_id,
       manifest.manifest_version,
       skill.name,
       manifest.description,
       manifest.config_schema,
       manifest.content_hash,
       manifest.file_count,
       manifest.size_bytes,
       CASE WHEN manifest.state='active' THEN 'active' ELSE 'disabled' END AS availability,
       skill.access_scope,
       skill.owner_actor_id,
       COALESCE(manifest.created_by_actor_id,sqlc.arg(caller_actor_id)::text) AS created_by_actor_id,
       manifest.created_at,
       manifest.sealed_at
FROM skills skill
JOIN skill_manifests manifest
  ON manifest.skill_id=skill.skill_id
 AND manifest.package_state='sealed'
 AND manifest.state IN ('active','disabled')
WHERE cardinality(skill.default_agent_types)=0
  AND (
      (skill.owner_kind='tenant' AND skill.tenant_id=sqlc.arg(tenant_id)::text
       AND (skill.access_scope='tenant'
            OR skill.owner_actor_id=sqlc.arg(caller_actor_id)::text))
      OR (skill.owner_kind='platform' AND skill.tenant_id IS NULL
          AND manifest.manifest_id=skill.latest_manifest_id)
  )
  AND (sqlc.arg(cursor_skill_id)::text=''
       OR (skill.skill_id COLLATE "C",manifest.manifest_version COLLATE "C")
          > (sqlc.arg(cursor_skill_id)::text COLLATE "C",
             sqlc.arg(cursor_manifest_version)::text COLLATE "C"))
ORDER BY skill.skill_id COLLATE "C",manifest.manifest_version COLLATE "C"
LIMIT sqlc.arg(page_limit);
