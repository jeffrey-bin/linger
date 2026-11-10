-- name: GetRoomDocumentCommentResolutionAuthority :one
SELECT thread.id AS thread_id,thread.document_id,thread.tenant_id,thread.room_id,
       caller.id AS actor_id
FROM room_document_comment_threads thread
JOIN documents document
  ON document.id=thread.document_id AND document.tenant_id=thread.tenant_id
 AND document.status='active'
JOIN actors caller
  ON caller.tenant_id=thread.tenant_id
 AND caller.account_id=sqlc.arg(account_id)::text
 AND caller.kind='human'
WHERE thread.id=sqlc.arg(thread_id)::text
  AND thread.anchor_status<>'orphaned'
  AND EXISTS(SELECT 1 FROM resolve_human_document_access_v2(
      sqlc.arg(account_id)::text,thread.document_id
  ) access
  WHERE access.tenant_id=thread.tenant_id AND access.can_read)
FOR UPDATE OF thread;

-- name: ResolveRoomDocumentCommentThread :execrows
UPDATE room_document_comment_threads
SET resolved_by_actor_id=sqlc.arg(resolved_by_actor_id)::text,
    resolved_at=now(),updated_at=now()
WHERE id=sqlc.arg(thread_id)::text
  AND resolved_at IS NULL;

-- name: ReopenRoomDocumentCommentThread :execrows
UPDATE room_document_comment_threads
SET resolved_by_actor_id=NULL,resolved_at=NULL,updated_at=now()
WHERE id=sqlc.arg(thread_id)::text
  AND resolved_at IS NOT NULL;
