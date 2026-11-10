-- name: ListMessageContextsForCreate :many
SELECT message.id AS context_message_id,message.body,message.segments,message.created_at,
       author.id AS author_actor_id,author.tenant_id AS author_tenant_id,
       author.kind AS author_kind,author.display_name AS author_display_name,
       author.account_id AS author_account_id,author.handle AS author_handle,
       author.created_at AS author_created_at
FROM messages message
JOIN actors author
  ON author.id=message.author_actor_id AND author.tenant_id=message.tenant_id
WHERE message.room_id=sqlc.arg(room_id)::text
  AND message.id=ANY(sqlc.arg(context_message_ids)::text[])
  AND message.message_kind<>'room_notice'
ORDER BY array_position(sqlc.arg(context_message_ids)::text[],message.id);

-- name: ListMessageContextsForMessages :many
SELECT message.id AS message_id,(context.ordinality-1)::smallint AS position,
       source.id AS context_message_id,source.message_kind AS context_message_kind,
       source.body,source.segments,source.created_at,
       author.id AS author_actor_id,author.tenant_id AS author_tenant_id,
       author.kind AS author_kind,author.display_name AS author_display_name,
       author.account_id AS author_account_id,author.handle AS author_handle,
       author.created_at AS author_created_at
FROM messages message
CROSS JOIN LATERAL unnest(message.context_message_ids) WITH ORDINALITY context(context_message_id,ordinality)
JOIN messages source
  ON source.id=context.context_message_id
 AND source.tenant_id=message.tenant_id
 AND source.room_id=message.room_id
JOIN actors author
  ON author.id=source.author_actor_id AND author.tenant_id=source.tenant_id
WHERE message.id=ANY(sqlc.arg(message_ids)::text[])
ORDER BY array_position(sqlc.arg(message_ids)::text[],message.id),context.ordinality;
