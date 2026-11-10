-- name: GetRoomDocumentCommentCreateAuthority :one
SELECT document.id AS document_id,document.tenant_id,
       ''::text AS room_id,
       caller.id AS actor_id,caller.kind AS actor_kind,
       caller.display_name AS actor_display_name
FROM documents document
JOIN actors caller ON caller.tenant_id=document.tenant_id
  AND caller.account_id=sqlc.arg(account_id)::text AND caller.kind='human'
WHERE document.id=sqlc.arg(document_id)::text
  AND document.status='active'
  AND EXISTS(SELECT 1 FROM resolve_human_document_access_v2(
      sqlc.arg(account_id)::text,sqlc.arg(document_id)::text
  ) access
  WHERE access.tenant_id=document.tenant_id AND access.can_read);

-- name: ListCurrentRoomDocumentCommentReferenceActors :many
SELECT actor.id,actor.tenant_id,actor.kind,actor.display_name,actor.account_id
FROM actors actor
JOIN active_room_members membership
  ON membership.tenant_id=actor.tenant_id
 AND membership.room_id=sqlc.arg(room_id)::text
 AND membership.actor_id=actor.id
WHERE actor.tenant_id=sqlc.arg(tenant_id)::text
  AND actor.id=ANY(sqlc.arg(actor_ids)::text[])
ORDER BY actor.id;

-- name: ListCurrentDocumentCommentRoomReferenceActorsForHuman :many
SELECT target.id,target.tenant_id,target.kind,target.display_name,target.account_id
FROM document_context_bindings binding
JOIN rooms room ON room.id=binding.room_id AND room.tenant_id=binding.tenant_id
  AND room.deletion_started_at IS NULL
JOIN actors caller ON caller.tenant_id=binding.tenant_id
  AND caller.account_id=sqlc.arg(account_id)::text AND caller.kind='human'
JOIN active_room_members caller_membership
  ON caller_membership.room_id=binding.room_id
 AND caller_membership.tenant_id=binding.tenant_id
 AND caller_membership.actor_id=caller.id
JOIN active_room_members target_membership
  ON target_membership.room_id=binding.room_id
 AND target_membership.tenant_id=binding.tenant_id
JOIN actors target ON target.id=target_membership.actor_id
 AND target.tenant_id=target_membership.tenant_id
WHERE binding.document_id=sqlc.arg(document_id)::text
  AND binding.binding_kind='room' AND binding.status='active'
  AND binding.room_id=sqlc.arg(room_id)::text
  AND target.id=ANY(sqlc.arg(actor_ids)::text[])
ORDER BY target.id;

-- name: ListCurrentDocumentCommentAgentReferenceActorsForHuman :many
SELECT target.id,target.tenant_id,target.kind,target.display_name,target.account_id
FROM resolve_human_document_access_v2(sqlc.arg(account_id)::text,sqlc.arg(document_id)::text) access
JOIN agent_registrations registration ON registration.tenant_id=access.tenant_id AND registration.status='active'
  AND (registration.created_by_actor_id=access.actor_id OR registration.visibility_scope='workspace')
JOIN actors target ON target.id=registration.actor_id AND target.tenant_id=registration.tenant_id
WHERE access.can_read AND target.id=ANY(sqlc.arg(actor_ids)::text[])
  AND EXISTS(SELECT 1 FROM resolve_agent_document_access_v2(registration.agent_management_id,sqlc.arg(document_id)::text) ordinary WHERE ordinary.can_read)
ORDER BY target.id;

-- name: ListCurrentDocumentCommentHumanReferenceActorsForAgent :many
SELECT target.id,target.tenant_id,target.kind,target.display_name,target.account_id
FROM agent_registrations registration
JOIN actors target ON target.tenant_id=registration.tenant_id AND target.kind='human'
WHERE registration.agent_management_id=sqlc.arg(agent_management_id)::text
  AND registration.status='active' AND target.id=ANY(sqlc.arg(actor_ids)::text[])
  AND EXISTS(SELECT 1 FROM resolve_human_document_access_expiry(
    target.account_id,sqlc.arg(document_id)::text,'read') access WHERE access.has_access)
  AND (document_comment_agent_readable(registration.tenant_id,sqlc.arg(document_id)::text,registration.actor_id))
ORDER BY target.id;

-- name: CreateRoomDocumentCommentThread :one
INSERT INTO room_document_comment_threads(
    id,tenant_id,room_id,document_id,current_anchor_id,anchor_status,created_by_actor_id,
    anchor_kind,anchor_document_version_id,anchor_quoted_text,anchor_block_id,
    anchor_context_before,anchor_context_after,anchor_version_number,anchor_created_by_actor_id
) VALUES(
    sqlc.arg(id)::text,sqlc.arg(tenant_id)::text,NULLIF(sqlc.arg(room_id)::text,''),
    sqlc.arg(document_id)::text,sqlc.arg(current_anchor_id)::text,
    sqlc.arg(anchor_status)::text,
    sqlc.arg(created_by_actor_id)::text,sqlc.arg(anchor_kind)::text,
    NULLIF(sqlc.arg(anchor_document_version_id)::text,''),sqlc.arg(anchor_quoted_text)::text,
    sqlc.arg(anchor_block_id)::text,sqlc.arg(anchor_context_before)::text,
    sqlc.arg(anchor_context_after)::text,1,sqlc.arg(created_by_actor_id)::text
)
RETURNING *;

-- name: GetDocumentCommentVersionAnchor :one
SELECT version.id,version.filename
FROM document_versions version
JOIN documents document ON document.id=version.document_id
 AND document.tenant_id=version.tenant_id AND document.status='active'
WHERE version.id=sqlc.arg(document_version_id)::text
  AND version.document_id=sqlc.arg(document_id)::text
FOR SHARE OF version,document;

-- name: CreateRoomDocumentComment :one
INSERT INTO room_document_comments(
    id,tenant_id,room_id,document_id,thread_id,parent_comment_id,
    author_actor_id,body,segments
) VALUES(
    sqlc.arg(id)::text,sqlc.arg(tenant_id)::text,NULLIF(sqlc.arg(room_id)::text,''),
    sqlc.arg(document_id)::text,sqlc.arg(thread_id)::text,
    sqlc.narg(parent_comment_id)::text,sqlc.arg(author_actor_id)::text,
    sqlc.arg(body)::text,sqlc.arg(segments)::jsonb
)
RETURNING *;

-- name: GetRoomDocumentCommentReadAuthority :one
SELECT document.id AS document_id,document.tenant_id,
       ''::text AS room_id
FROM documents document
WHERE document.id=sqlc.arg(document_id)::text
  AND document.status='active'
  AND EXISTS(SELECT 1 FROM resolve_human_document_access_v2(
      sqlc.arg(account_id)::text,sqlc.arg(document_id)::text
  ) access
  WHERE access.tenant_id=document.tenant_id AND access.can_read);

-- name: GetRoomDocumentCommentThreadForAccount :one
SELECT thread.id,thread.document_id,thread.anchor_status,thread.resolved_at,
       thread.created_at,thread.updated_at,
       creator.id AS creator_id,creator.tenant_id AS creator_tenant_id,
       creator.kind AS creator_kind,creator.display_name AS creator_display_name,
       resolver.id AS resolver_id,resolver.kind AS resolver_kind,
       resolver.display_name AS resolver_display_name,
       thread.current_anchor_id AS anchor_id,thread.anchor_kind,
       thread.anchor_document_version_id AS document_version_id,
       thread.anchor_quoted_text AS quoted_text,thread.anchor_block_id AS block_id,
       thread.anchor_context_before AS context_before,thread.anchor_context_after AS context_after,
       thread.anchor_created_at,
       anchor_creator.id AS anchor_creator_id,
       anchor_creator.kind AS anchor_creator_kind,
       anchor_creator.display_name AS anchor_creator_display_name
FROM room_document_comment_threads thread
JOIN documents document
  ON document.id=thread.document_id AND document.tenant_id=thread.tenant_id
 AND document.status='active'
JOIN actors creator
  ON creator.id=thread.created_by_actor_id AND creator.tenant_id=thread.tenant_id
LEFT JOIN actors resolver
  ON resolver.id=thread.resolved_by_actor_id AND resolver.tenant_id=thread.tenant_id
JOIN actors anchor_creator
  ON anchor_creator.id=thread.anchor_created_by_actor_id AND anchor_creator.tenant_id=thread.tenant_id
WHERE thread.id=sqlc.arg(thread_id)::text
  AND thread.anchor_status<>'orphaned'
  AND EXISTS(SELECT 1 FROM resolve_human_document_access_v2(
      sqlc.arg(account_id)::text,thread.document_id
  ) access
  WHERE access.tenant_id=thread.tenant_id AND access.can_read);

-- name: GetRoomDocumentCommentThreadForAgent :one
SELECT thread.id,thread.document_id,thread.anchor_status,thread.resolved_at,
       thread.created_at,thread.updated_at,
       creator.id AS creator_id,creator.tenant_id AS creator_tenant_id,
       creator.kind AS creator_kind,creator.display_name AS creator_display_name,
       resolver.id AS resolver_id,resolver.kind AS resolver_kind,
       resolver.display_name AS resolver_display_name,
       thread.current_anchor_id AS anchor_id,thread.anchor_kind,
       thread.anchor_document_version_id AS document_version_id,
       thread.anchor_quoted_text AS quoted_text,thread.anchor_block_id AS block_id,
       thread.anchor_context_before AS context_before,thread.anchor_context_after AS context_after,
       thread.anchor_created_at,
       anchor_creator.id AS anchor_creator_id,
       anchor_creator.kind AS anchor_creator_kind,
       anchor_creator.display_name AS anchor_creator_display_name
FROM room_document_comment_threads thread
JOIN documents document
  ON document.id=thread.document_id AND document.tenant_id=thread.tenant_id
 AND document.status='active'
JOIN agent_registrations registration
  ON registration.tenant_id=thread.tenant_id
 AND registration.agent_management_id=sqlc.arg(agent_management_id)::text
 AND registration.status='active'
JOIN actors creator
  ON creator.id=thread.created_by_actor_id AND creator.tenant_id=thread.tenant_id
LEFT JOIN actors resolver
  ON resolver.id=thread.resolved_by_actor_id AND resolver.tenant_id=thread.tenant_id
JOIN actors anchor_creator
  ON anchor_creator.id=thread.anchor_created_by_actor_id AND anchor_creator.tenant_id=thread.tenant_id
WHERE thread.id=sqlc.arg(thread_id)::text
  AND thread.anchor_status<>'orphaned'
  AND (
    document_comment_agent_readable(thread.tenant_id,thread.document_id,registration.actor_id)
  );

-- name: ListRoomDocumentCommentThreads :many
SELECT thread.id,thread.document_id,thread.anchor_status,thread.resolved_at,
       thread.created_at,thread.updated_at,
       creator.id AS creator_id,creator.tenant_id AS creator_tenant_id,
       creator.kind AS creator_kind,creator.display_name AS creator_display_name,
       resolver.id AS resolver_id,resolver.kind AS resolver_kind,
       resolver.display_name AS resolver_display_name,
       thread.current_anchor_id AS anchor_id,thread.anchor_kind,
       thread.anchor_document_version_id AS document_version_id,
       thread.anchor_quoted_text AS quoted_text,thread.anchor_block_id AS block_id,
       thread.anchor_context_before AS context_before,thread.anchor_context_after AS context_after,
       thread.anchor_created_at,
       anchor_creator.id AS anchor_creator_id,
       anchor_creator.kind AS anchor_creator_kind,
       anchor_creator.display_name AS anchor_creator_display_name
FROM room_document_comment_threads thread
JOIN actors creator
  ON creator.id=thread.created_by_actor_id AND creator.tenant_id=thread.tenant_id
LEFT JOIN actors resolver
  ON resolver.id=thread.resolved_by_actor_id AND resolver.tenant_id=thread.tenant_id
JOIN actors anchor_creator
  ON anchor_creator.id=thread.anchor_created_by_actor_id AND anchor_creator.tenant_id=thread.tenant_id
WHERE thread.document_id=sqlc.arg(document_id)::text
  AND thread.anchor_status<>'orphaned'
  AND (
    sqlc.arg(cursor)::text='' OR (thread.created_at,thread.id)>(
      SELECT cursor_thread.created_at,cursor_thread.id
      FROM room_document_comment_threads cursor_thread
      WHERE cursor_thread.id=sqlc.arg(cursor)::text
        AND cursor_thread.document_id=sqlc.arg(document_id)::text
    )
  )
ORDER BY thread.created_at,thread.id
LIMIT sqlc.arg(page_limit)::integer;

-- name: ListRoomDocumentCommentsForThreads :many
SELECT comment.id,comment.thread_id,comment.parent_comment_id,comment.deleted_at,
       comment.created_at,comment.updated_at,
       comment.version_number,comment.body,comment.segments,
       author.id AS author_id,author.tenant_id AS author_tenant_id,
       author.kind AS author_kind,author.display_name AS author_display_name
FROM room_document_comments comment
JOIN actors author
  ON author.id=comment.author_actor_id AND author.tenant_id=comment.tenant_id
WHERE comment.thread_id=ANY(sqlc.arg(thread_ids)::text[])
ORDER BY comment.thread_id,comment.created_at,comment.id;

-- name: CountRoomDocumentCommentsForThread :one
SELECT count(*)
FROM room_document_comments
WHERE thread_id=sqlc.arg(thread_id)::text;

-- name: GetRoomDocumentCommentReplyAuthority :one
SELECT thread.id AS thread_id,thread.document_id,thread.tenant_id,thread.room_id,
       thread.current_anchor_id,
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
  AND thread.anchor_status<>'orphaned'
  AND EXISTS(SELECT 1 FROM resolve_human_document_access_v2(
      sqlc.arg(account_id)::text,thread.document_id
  ) access
  WHERE access.tenant_id=thread.tenant_id AND access.can_read)
FOR UPDATE OF thread;

-- name: GetRoomDocumentCommentReplyScope :one
SELECT thread.id AS thread_id,thread.document_id,thread.tenant_id,thread.room_id
FROM room_document_comment_threads thread
JOIN documents document
  ON document.id=thread.document_id AND document.tenant_id=thread.tenant_id
 AND document.status='active'
WHERE thread.id=sqlc.arg(thread_id)::text
  AND thread.anchor_status<>'orphaned';

-- name: GetRoomDocumentCommentReplyAuthorityForAgent :one
SELECT thread.id AS thread_id,thread.document_id,thread.tenant_id,thread.room_id,
       thread.current_anchor_id,
       caller.id AS actor_id,caller.kind AS actor_kind,
       caller.display_name AS actor_display_name
FROM room_document_comment_threads thread
JOIN documents document
  ON document.id=thread.document_id AND document.tenant_id=thread.tenant_id
 AND document.status='active'
JOIN agent_registrations registration
  ON registration.tenant_id=thread.tenant_id
 AND registration.agent_management_id=sqlc.arg(agent_management_id)::text
 AND registration.status='active'
JOIN actors caller
  ON caller.id=registration.actor_id AND caller.tenant_id=registration.tenant_id
 AND caller.kind='agent'
WHERE thread.id=sqlc.arg(thread_id)::text
  AND thread.anchor_status<>'orphaned'
  AND (
    document_comment_agent_readable(thread.tenant_id,thread.document_id,registration.actor_id)
  )
FOR UPDATE OF thread;

-- name: GetRoomDocumentCommentParent :one
SELECT id
FROM room_document_comments
WHERE id=sqlc.arg(comment_id)::text
  AND thread_id=sqlc.arg(thread_id)::text;

-- name: TouchRoomDocumentCommentThread :one
UPDATE room_document_comment_threads
SET updated_at=now()
WHERE id=sqlc.arg(thread_id)::text
RETURNING updated_at;

-- name: GetRoomDocumentCommentMutationAuthority :one
SELECT comment.id,comment.thread_id,comment.parent_comment_id,
       comment.document_id,comment.tenant_id,comment.room_id,
       thread.current_anchor_id,
       comment.author_actor_id,comment.version_number,comment.deleted_at,
       comment.created_at,comment.updated_at,
       comment.body,comment.segments,
       author.kind AS author_kind,author.display_name AS author_display_name,
       caller.id AS caller_actor_id
FROM room_document_comments comment
JOIN room_document_comment_threads thread ON thread.id=comment.thread_id
JOIN documents document
  ON document.id=comment.document_id AND document.tenant_id=comment.tenant_id
 AND document.status='active'
JOIN actors author
  ON author.id=comment.author_actor_id AND author.tenant_id=comment.tenant_id
JOIN actors caller
  ON caller.tenant_id=comment.tenant_id
 AND caller.account_id=sqlc.arg(account_id)::text
 AND caller.kind='human'
WHERE comment.id=sqlc.arg(comment_id)::text
  AND thread.anchor_status<>'orphaned'
  AND EXISTS(SELECT 1 FROM resolve_human_document_access_v2(
      sqlc.arg(account_id)::text,comment.document_id
  ) access
  WHERE access.tenant_id=comment.tenant_id AND access.can_read)
FOR UPDATE OF thread,comment;

-- name: GetRoomDocumentCommentMutationScope :one
SELECT comment.id AS comment_id,comment.document_id,comment.tenant_id,comment.room_id
FROM room_document_comments comment
JOIN documents document
  ON document.id=comment.document_id AND document.tenant_id=comment.tenant_id
 AND document.status='active'
WHERE comment.id=sqlc.arg(comment_id)::text;

-- name: UpdateRoomDocumentCommentBody :one
UPDATE room_document_comments
SET body=sqlc.arg(body)::text,segments=sqlc.arg(segments)::jsonb,
    version_number=version_number+1,updated_at=now()
WHERE id=sqlc.arg(comment_id)::text
RETURNING version_number,updated_at;

-- name: SoftDeleteRoomDocumentComment :one
UPDATE room_document_comments
SET version_number=version_number+1,deleted_at=now(),updated_at=now()
WHERE id=sqlc.arg(comment_id)::text
RETURNING version_number,deleted_at,updated_at;
