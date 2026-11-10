-- name: AcquireUnifiedSkillPolicySharedLock :exec
SELECT pg_advisory_xact_lock_shared(hashtextextended('unified-agent-skill-policy',0));

-- name: AcquireUnifiedSkillPolicyExclusiveLock :exec
SELECT pg_advisory_xact_lock(hashtextextended('unified-agent-skill-policy',0));

-- name: GetSkillAgentForShare :one
SELECT actor_id,tenant_id,agent_management_id,agent_type
FROM agent_registrations
WHERE actor_id=sqlc.arg(agent_actor_id)::text
  AND tenant_id=sqlc.arg(tenant_id)::text
  AND status='active'
FOR SHARE;

-- name: GetAgentSkillPackageManifest :one
SELECT manifest.manifest_id,manifest.content_hash,manifest.package_state,
       skill.name,skill.owner_kind,skill.tenant_id,skill.access_scope,skill.owner_actor_id,
       manifest.state
FROM skill_manifests manifest
JOIN skills skill ON skill.skill_id=manifest.skill_id
WHERE manifest.manifest_id=$1;

-- name: ListAgentSkillPackageFiles :many
SELECT file.path::text AS path,file.media_type::text AS media_type,file.size_bytes::bigint AS size_bytes,
       decode(file.sha256,'hex')::bytea AS sha256,file.object_key::text AS object_key
FROM skill_manifests manifest
CROSS JOIN LATERAL jsonb_to_recordset(manifest.files)
    AS file(path text,media_type text,size_bytes bigint,sha256 text,object_key text)
WHERE manifest.manifest_id=$1
ORDER BY file.path COLLATE "C";
