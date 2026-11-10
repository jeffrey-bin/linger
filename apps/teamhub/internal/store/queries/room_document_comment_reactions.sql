-- name: GetRoomDocumentCommentReactionAuthority :one
SELECT comment.id AS comment_id,comment.thread_id,comment.document_id,
       comment.tenant_id,comment.room_id,caller.id AS actor_id
FROM room_document_comments comment
JOIN room_document_comment_threads thread ON thread.id=comment.thread_id
JOIN documents document
  ON document.id=comment.document_id AND document.tenant_id=comment.tenant_id
 AND document.status='active'
JOIN actors caller
  ON caller.tenant_id=comment.tenant_id
 AND caller.account_id=sqlc.arg(account_id)::text
 AND caller.kind='human'
WHERE comment.id=sqlc.arg(comment_id)::text
  AND comment.deleted_at IS NULL
  AND thread.anchor_status<>'orphaned'
  AND EXISTS(SELECT 1 FROM resolve_human_document_access_v2(
      sqlc.arg(account_id)::text,comment.document_id
  ) access
  WHERE access.tenant_id=comment.tenant_id AND access.can_read)
FOR UPDATE OF thread,comment;

-- name: PutRoomDocumentCommentReaction :execrows
INSERT INTO room_document_comment_reactions(
    tenant_id,room_id,document_id,thread_id,comment_id,actor_id,emoji
) VALUES(
    sqlc.arg(tenant_id)::text,NULLIF(sqlc.arg(room_id)::text,''),
    sqlc.arg(document_id)::text,sqlc.arg(thread_id)::text,
    sqlc.arg(comment_id)::text,sqlc.arg(actor_id)::text,sqlc.arg(emoji)::text
)
ON CONFLICT (comment_id,actor_id,emoji) DO NOTHING;

-- name: DeleteRoomDocumentCommentReaction :execrows
DELETE FROM room_document_comment_reactions
WHERE comment_id=sqlc.arg(comment_id)::text
  AND actor_id=sqlc.arg(actor_id)::text
  AND emoji=sqlc.arg(emoji)::text;

-- name: CountRoomDocumentCommentReactions :one
SELECT count(*)
FROM room_document_comment_reactions
WHERE comment_id=sqlc.arg(comment_id)::text;

-- name: RoomDocumentCommentReactionExists :one
SELECT EXISTS(
    SELECT 1
    FROM room_document_comment_reactions
    WHERE comment_id=sqlc.arg(comment_id)::text
      AND actor_id=sqlc.arg(actor_id)::text
      AND emoji=sqlc.arg(emoji)::text
);

-- name: ListRoomDocumentCommentReactionsForThreads :many
SELECT comment_id,emoji,actor_id,created_at
FROM room_document_comment_reactions
WHERE thread_id=ANY(sqlc.arg(thread_ids)::text[])
ORDER BY comment_id,emoji,actor_id;
