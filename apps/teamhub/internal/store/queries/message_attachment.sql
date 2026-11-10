-- name: ListMessageAttachments :many
-- Only attachments shown by a file or Document card segment; HTML fragment
-- attachments stay hidden.
SELECT (item.value->>'id')::text AS id,message.id AS message_id,message.tenant_id,
       (item.value->>'document_id')::text AS document_id,
       (item.value->>'document_version_id')::text AS document_version_id,
       source.room_id AS source_room_id,
       version.filename,version.media_type,
       version.size_bytes,version.sha256,
       (document.status='active')::boolean AS available
FROM messages message
CROSS JOIN LATERAL jsonb_array_elements(message.attachments) WITH ORDINALITY item(value,ordinality)
JOIN documents document
  ON document.id=item.value->>'document_id' AND document.tenant_id=message.tenant_id
JOIN document_versions version
  ON version.id=item.value->>'document_version_id'
 AND version.tenant_id=message.tenant_id
 AND version.document_id=item.value->>'document_id'
LEFT JOIN LATERAL (
    SELECT binding.room_id
    FROM document_context_bindings binding
    WHERE binding.document_id=document.id
      AND binding.tenant_id=message.tenant_id
      AND binding.status='active' AND binding.binding_kind='room'
    ORDER BY binding.created_at,binding.id
    LIMIT 1
) source ON true
WHERE message.id=ANY(sqlc.arg(message_ids)::text[])
  AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(message.segments) segment(value)
      WHERE segment.value->>'document_id'=item.value->>'document_id'
        AND (
          (segment.value->>'type'='file'
            AND segment.value->>'document_version_id'=item.value->>'document_version_id')
          OR (segment.value->>'type'='document'
            AND segment.value->>'presentation'='card')
        )
  )
ORDER BY array_position(sqlc.arg(message_ids)::text[],message.id),item.ordinality;

-- name: GetMessageAttachmentDocumentVersions :many
SELECT version.id,version.document_id,binding.room_id AS source_room_id,
       version.filename,version.media_type,
       version.size_bytes,version.sha256
FROM document_versions version
JOIN documents document
  ON document.id=version.document_id AND document.tenant_id=version.tenant_id
JOIN document_context_bindings binding
  ON binding.document_id=version.document_id AND binding.tenant_id=version.tenant_id
 AND binding.binding_kind='room' AND binding.room_id=sqlc.arg(room_id)::text
 AND binding.status='active'
WHERE version.id=ANY(sqlc.arg(ids)::text[])
  AND version.tenant_id=sqlc.arg(tenant_id)::text
  AND document.status='active'
ORDER BY array_position(sqlc.arg(ids)::text[],version.id);

-- name: LockCurrentMessageFileDocumentVersions :many
SELECT document.id AS document_id,version.id AS document_version_id,
       version.filename,version.media_type
FROM documents document
JOIN document_context_bindings binding
  ON binding.document_id=document.id AND binding.tenant_id=document.tenant_id
 AND binding.binding_kind='room'
 AND binding.room_id=collaboration_membership_room_id(sqlc.arg(room_id)::text)
 AND binding.status='active'
JOIN rooms room
  ON room.id=binding.room_id AND room.tenant_id=binding.tenant_id
JOIN document_versions version
  ON version.id=document.current_version_id
 AND version.tenant_id=document.tenant_id AND version.document_id=document.id
WHERE document.id=ANY(sqlc.arg(document_ids)::text[])
  AND document.tenant_id=sqlc.arg(tenant_id)::text
  AND document.status='active' AND room.deletion_started_at IS NULL
ORDER BY array_position(sqlc.arg(document_ids)::text[],document.id)
FOR SHARE OF document,binding,room,version;

-- name: GetAuthorizedMessageContextDocumentVersions :many
SELECT version.id,version.document_id,NULL::text AS source_room_id,
       version.filename,version.media_type,
       version.size_bytes,version.sha256
FROM document_versions version
JOIN documents document
  ON document.id=version.document_id AND document.tenant_id=version.tenant_id
JOIN resolve_human_document_access_v2(sqlc.arg(account_id)::text,version.document_id) access
  ON access.tenant_id=version.tenant_id AND access.can_read
WHERE version.id=ANY(sqlc.arg(ids)::text[])
  AND version.tenant_id=sqlc.arg(tenant_id)::text
  AND document.status='active'
ORDER BY array_position(sqlc.arg(ids)::text[],version.id);

-- name: LockMessageAttachmentUpload :exec
-- Orders a send, a cancellation and the expiry job for one upload.
SELECT pg_advisory_xact_lock(hashtextextended('message-attachment-upload|'||sqlc.arg(object_key)::text, 0));

-- name: DocumentExists :one
SELECT EXISTS(SELECT 1 FROM documents WHERE id=sqlc.arg(id)::text)::boolean;
