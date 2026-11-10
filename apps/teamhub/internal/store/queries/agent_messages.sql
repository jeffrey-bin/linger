-- name: ListAgentHistoryInboxes :many
WITH candidates AS (
    SELECT 'room:'||room.id AS inbox_id,'room'::text AS kind FROM rooms room
    WHERE room.tenant_id=sqlc.arg(tenant_id)::text AND room.parent_room_id IS NULL
    UNION SELECT 'thread:'||thread.id,'thread' FROM rooms thread
    WHERE thread.tenant_id=sqlc.arg(tenant_id)::text AND thread.parent_room_id IS NOT NULL
    UNION SELECT 'task:'||link.work_item_id,'task' FROM work_item_room_links link
    JOIN work_items task ON task.id=link.work_item_id AND task.tenant_id=link.tenant_id AND task.kind='task'
    WHERE link.tenant_id=sqlc.arg(tenant_id)::text AND link.link_type='work'
    UNION SELECT 'meta:'||inbox.agent_actor_id||':'||inbox.task_id,'meta' FROM task_meta_inboxes inbox WHERE inbox.tenant_id=sqlc.arg(tenant_id)::text
    UNION SELECT 'taskmeta:'||callback.task_id,'taskmeta' FROM task_meta_callbacks callback WHERE callback.tenant_id=sqlc.arg(tenant_id)::text
)
SELECT inbox_id::text AS inbox_id,kind FROM candidates
WHERE actor_can_read_inbox(sqlc.arg(tenant_id)::text,sqlc.arg(actor_id)::text,inbox_id)
ORDER BY inbox_id;

-- name: CanReadAgentHistoryInbox :one
SELECT actor_can_read_inbox(sqlc.arg(tenant_id)::text,sqlc.arg(actor_id)::text,sqlc.arg(inbox_id)::text)::boolean AS allowed;

-- name: ReadAgentHistoryMessages :many
-- Explicit resources authorize once in the current read snapshot. Room/Task
-- aliases share one source stream and must not duplicate history.
WITH requested_inboxes AS MATERIALIZED (
 SELECT selected.inbox_id
 FROM unnest(sqlc.arg(inbox_ids)::text[]) selected(inbox_id)
 UNION
 SELECT sqlc.arg(inbox_id)::text WHERE sqlc.arg(inbox_id)::text<>'' AND cardinality(sqlc.arg(inbox_ids)::text[])=0
), authorized_scopes AS MATERIALIZED (
 SELECT inbox_id,agent_inbox_resource_room(sqlc.arg(tenant_id)::text,inbox_id) AS room_id,
        actor_inbox_visible_through(sqlc.arg(tenant_id)::text,sqlc.arg(actor_id)::text,inbox_id) AS visible_through
 FROM requested_inboxes
 WHERE actor_can_read_inbox(sqlc.arg(tenant_id)::text,sqlc.arg(actor_id)::text,inbox_id)
), room_scopes AS MATERIALIZED (
 SELECT room_id,max(visible_through) AS visible_through FROM authorized_scopes WHERE room_id IS NOT NULL AND (sqlc.arg(inbox_id)::text='' OR room_id=agent_inbox_resource_room(sqlc.arg(tenant_id)::text,sqlc.arg(inbox_id)::text)) GROUP BY room_id
), private_scopes AS MATERIALIZED (
 SELECT inbox_id,max(visible_through) AS visible_through FROM authorized_scopes WHERE room_id IS NULL AND (sqlc.arg(inbox_id)::text='' OR inbox_id=sqlc.arg(inbox_id)::text) GROUP BY inbox_id
), authorized AS (
 SELECT message.*,
        CASE WHEN sqlc.arg(inbox_id)::text<>'' THEN sqlc.arg(inbox_id)::text ELSE message.inbox_id END AS read_inbox_id
 -- Filter visibility, search and paging before expanding view resources.
 FROM room_scopes scope
 CROSS JOIN LATERAL (
  -- Separate seek branches keep prepared generic plans indexable, including
  -- a cursor near the end of retained history. Each filters before LIMIT.
  (SELECT candidate.id,event.room_seq
  FROM messages candidate
  CROSS JOIN LATERAL (
   SELECT event.room_seq
   FROM room_events event
   JOIN actors author ON author.id=candidate.author_actor_id AND author.tenant_id=candidate.tenant_id
   WHERE event.tenant_id=candidate.tenant_id AND event.room_id=candidate.room_id
     AND event.resource_id=candidate.id AND event.event_type='message.created'
     AND event.room_seq<=scope.visible_through
   -- Keep messages in ordering-index order; a flattened join can scan and
   -- sort every retained creation event before applying the page limit.
   OFFSET 0
  ) event
  WHERE candidate.tenant_id=sqlc.arg(tenant_id)::text AND candidate.room_id=scope.room_id
    AND candidate.message_kind IN ('conversation','agent_runtime','task_terminal_notice')
    -- One optional-filter gate keeps a parameter-blind page from multiplying
    -- independent OR selectivities into an estimated single matching row,
    -- then preferring a full-Room bitmap scan/sort over the ordering index.
    AND CASE WHEN sqlc.arg(message_id)::text='' AND cardinality(sqlc.arg(message_ids)::text[])=0 AND sqlc.arg(query)::text='' THEN true
        ELSE (sqlc.arg(message_id)::text='' OR candidate.id=sqlc.arg(message_id)::text)
          AND (cardinality(sqlc.arg(message_ids)::text[])=0 OR candidate.id=ANY(sqlc.arg(message_ids)::text[]))
          AND (sqlc.arg(query)::text='' OR strpos(lower(candidate.body),lower(sqlc.arg(query)::text))>0) END
    AND sqlc.arg(cursor_id)::text=''
   ORDER BY candidate.created_at DESC,candidate.id DESC LIMIT sqlc.arg(page_limit)::int)
  UNION ALL
  (SELECT candidate.id,event.room_seq
  FROM messages candidate
  CROSS JOIN LATERAL (
   SELECT event.room_seq
   FROM room_events event
   JOIN actors author ON author.id=candidate.author_actor_id AND author.tenant_id=candidate.tenant_id
   WHERE event.tenant_id=candidate.tenant_id AND event.room_id=candidate.room_id
     AND event.resource_id=candidate.id AND event.event_type='message.created'
     AND event.room_seq<=scope.visible_through
   OFFSET 0
  ) event
  WHERE candidate.tenant_id=sqlc.arg(tenant_id)::text AND candidate.room_id=scope.room_id
    AND candidate.message_kind IN ('conversation','agent_runtime','task_terminal_notice')
    -- One optional-filter gate keeps a parameter-blind page from multiplying
    -- independent OR selectivities into an estimated single matching row,
    -- then preferring a full-Room bitmap scan/sort over the ordering index.
    AND CASE WHEN sqlc.arg(message_id)::text='' AND cardinality(sqlc.arg(message_ids)::text[])=0 AND sqlc.arg(query)::text='' THEN true
        ELSE (sqlc.arg(message_id)::text='' OR candidate.id=sqlc.arg(message_id)::text)
          AND (cardinality(sqlc.arg(message_ids)::text[])=0 OR candidate.id=ANY(sqlc.arg(message_ids)::text[]))
          AND (sqlc.arg(query)::text='' OR strpos(lower(candidate.body),lower(sqlc.arg(query)::text))>0) END
    AND sqlc.arg(cursor_id)::text<>''
    AND (candidate.created_at,candidate.id)<(sqlc.arg(cursor_time)::timestamptz,sqlc.arg(cursor_id)::text)
   ORDER BY candidate.created_at DESC,candidate.id DESC LIMIT sqlc.arg(page_limit)::int)
 ) candidate
 CROSS JOIN LATERAL (
  SELECT * FROM agent_history_messages message
  WHERE message.tenant_id=sqlc.arg(tenant_id)::text AND message.message_id=candidate.id
    AND message.source_room_id=scope.room_id AND message.source_sequence=candidate.room_seq
  -- Preserve parameterized hydration instead of flattening into a tenant scan.
  OFFSET 0
 ) message
 UNION ALL
 SELECT message.*,
        CASE WHEN sqlc.arg(inbox_id)::text<>'' THEN sqlc.arg(inbox_id)::text ELSE message.inbox_id END AS read_inbox_id
 FROM agent_history_messages message
 JOIN private_scopes scope ON message.inbox_id=scope.inbox_id AND message.source_sequence<=scope.visible_through
 WHERE message.tenant_id=sqlc.arg(tenant_id)::text AND message.source_room_id IS NULL

)
SELECT message_id,read_inbox_id::text AS inbox_id,author_actor_id,author,author_kind,body,segments,
       message_kind,created_at,context_message_ids,resource_references
FROM authorized
WHERE (sqlc.arg(message_id)::text='' OR message_id=sqlc.arg(message_id)::text)
  AND (cardinality(sqlc.arg(message_ids)::text[])=0 OR message_id=ANY(sqlc.arg(message_ids)::text[]))
  AND (sqlc.arg(query)::text='' OR strpos(lower(body),lower(sqlc.arg(query)::text))>0)
  AND (sqlc.arg(cursor_id)::text='' OR (created_at,message_id)<(sqlc.arg(cursor_time)::timestamptz,sqlc.arg(cursor_id)::text))
ORDER BY created_at DESC,message_id DESC
LIMIT sqlc.arg(page_limit)::int;

-- name: ReadUnscopedAgentHistoryMessages :many
-- Global get/search authorize every canonical Inbox in the current snapshot.
-- Keep this tenant-wide plan out of explicit-resource paging statements.
SELECT message_id,inbox_id::text AS inbox_id,author_actor_id,author,author_kind,body,segments,
       message_kind,created_at,context_message_ids,resource_references
FROM agent_history_messages message
WHERE message.tenant_id=sqlc.arg(tenant_id)::text
  AND actor_can_read_inbox(sqlc.arg(tenant_id)::text,sqlc.arg(actor_id)::text,message.inbox_id)
  AND message.source_sequence<=actor_inbox_visible_through(sqlc.arg(tenant_id)::text,sqlc.arg(actor_id)::text,message.inbox_id)
  AND (sqlc.arg(message_id)::text='' OR message_id=sqlc.arg(message_id)::text)
  AND (cardinality(sqlc.arg(message_ids)::text[])=0 OR message_id=ANY(sqlc.arg(message_ids)::text[]))
  AND (sqlc.arg(query)::text='' OR strpos(lower(body),lower(sqlc.arg(query)::text))>0)
  AND (sqlc.arg(cursor_id)::text='' OR (created_at,message_id)<(sqlc.arg(cursor_time)::timestamptz,sqlc.arg(cursor_id)::text))
ORDER BY created_at DESC,message_id DESC
LIMIT sqlc.arg(page_limit)::int;

-- name: FindAgentHistoryThread :one
SELECT thread.id AS room_id,thread.root_message_id::text AS root_message_id FROM rooms thread
LEFT JOIN messages reply ON reply.room_id=thread.id AND reply.id=sqlc.arg(message_id)::text
WHERE thread.tenant_id=sqlc.arg(tenant_id)::text AND thread.parent_room_id IS NOT NULL
 AND (thread.root_message_id=sqlc.arg(message_id)::text OR reply.id IS NOT NULL);

-- name: IsAgentReplySourceMessage :one
SELECT EXISTS(
  SELECT 1 FROM messages message
  WHERE message.tenant_id=sqlc.arg(tenant_id)::text
    AND message.room_id=sqlc.arg(room_id)::text
    AND message.id=sqlc.arg(message_id)::text
    AND (message.message_kind='conversation'
      OR (message.message_kind='agent_runtime'
        AND sqlc.arg(agent_actor_id)::text=ANY(message.mentioned_actor_ids))));
