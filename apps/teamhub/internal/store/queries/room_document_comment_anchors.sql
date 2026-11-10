-- name: GetRoomDocumentCommentReanchorAuthority :one
SELECT thread.id AS thread_id,thread.document_id,thread.tenant_id,thread.room_id,
       thread.anchor_status,thread.resolved_at,
       caller.id AS actor_id,caller.kind AS actor_kind,
       caller.display_name AS actor_display_name
FROM room_document_comment_threads thread
JOIN documents document
  ON document.id=thread.document_id AND document.tenant_id=thread.tenant_id
 AND document.status='active'
JOIN actors caller
  ON caller.tenant_id=thread.tenant_id
 AND caller.account_id=sqlc.arg(account_id)::text
 AND caller.kind='human'
WHERE thread.id=sqlc.arg(thread_id)::text
  AND EXISTS(SELECT 1 FROM resolve_human_document_access_v2(
      sqlc.arg(account_id)::text,thread.document_id
  ) access
  WHERE access.tenant_id=thread.tenant_id AND access.can_read)
FOR UPDATE OF thread;

-- name: AdvanceRoomDocumentCommentThreadAnchor :exec
UPDATE room_document_comment_threads
SET current_anchor_id=sqlc.arg(anchor_id)::text,anchor_kind='selection',
    anchor_document_version_id=NULL,anchor_quoted_text=sqlc.arg(quoted_text)::text,
    anchor_block_id=sqlc.arg(block_id)::text,anchor_context_before=sqlc.arg(context_before)::text,
    anchor_context_after=sqlc.arg(context_after)::text,anchor_version_number=anchor_version_number+1,
    anchor_created_by_actor_id=sqlc.arg(actor_id)::text,anchor_created_at=now(),
    anchor_status='pending',updated_at=now()
WHERE id=sqlc.arg(thread_id)::text;
