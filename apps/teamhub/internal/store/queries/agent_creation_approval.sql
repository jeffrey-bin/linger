-- name: ResolveAgentCreationActors :many
SELECT actor.id,actor.kind,actor.display_name,
       registration.agent_management_id,
       COALESCE(registration.status,'')::text AS registration_status
FROM actors actor
LEFT JOIN LATERAL (
    SELECT candidate.agent_management_id,candidate.status
    FROM agent_registrations candidate
    WHERE candidate.actor_id=actor.id AND candidate.tenant_id=actor.tenant_id
    FOR KEY SHARE
) registration ON true
WHERE actor.tenant_id=sqlc.arg(tenant_id)::text
  AND actor.id=ANY(sqlc.arg(actor_ids)::text[])
ORDER BY array_position(sqlc.arg(actor_ids)::text[],actor.id)
FOR KEY SHARE OF actor;

-- name: LockAgentRoomCreationFileArtifactHeads :many
SELECT document.id AS document_id,version.id AS document_version_id,
       version.filename,version.media_type
FROM documents document
JOIN document_context_bindings binding
  ON binding.document_id=document.id AND binding.tenant_id=document.tenant_id
 AND binding.binding_kind='room' AND binding.room_id=sqlc.arg(room_id)::text
 AND binding.status='active'
JOIN rooms room
  ON room.id=binding.room_id AND room.tenant_id=binding.tenant_id
JOIN document_versions version
  ON version.id=document.current_version_id
 AND version.tenant_id=document.tenant_id AND version.document_id=document.id
WHERE document.id=ANY(sqlc.arg(document_ids)::text[])
  AND document.tenant_id=sqlc.arg(tenant_id)::text
  AND document.format<>'blocknote'
  AND document.status='active' AND room.deletion_started_at IS NULL
ORDER BY array_position(sqlc.arg(document_ids)::text[],document.id)
FOR SHARE OF document,binding,room,version;

-- name: LockAgentRoomCreationNativeArtifactHeads :many
-- Each body is copied into a Revision first when none holds its current
-- state, so the approval freezes exact Revisions.
SELECT document.id AS document_id,snapshot_document_body(body.document_id)::text AS document_revision_id,document.title
FROM documents document
JOIN document_context_bindings binding
  ON binding.document_id=document.id AND binding.tenant_id=document.tenant_id
 AND binding.binding_kind='room' AND binding.room_id=sqlc.arg(room_id)::text
 AND binding.status='active'
JOIN rooms room
  ON room.id=binding.room_id AND room.tenant_id=binding.tenant_id
JOIN document_bodies body ON body.document_id=document.id
WHERE document.id=ANY(sqlc.arg(document_ids)::text[])
  AND document.tenant_id=sqlc.arg(tenant_id)::text
  AND document.format='blocknote'
  AND document.status='active' AND room.deletion_started_at IS NULL
ORDER BY array_position(sqlc.arg(document_ids)::text[],document.id)
FOR SHARE OF document,binding,room,body;
