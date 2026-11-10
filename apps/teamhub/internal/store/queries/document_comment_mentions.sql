-- name: ListDocumentCommentInvokedAgents :many
-- An Agent's Runtime input names the comment that invoked it, so a later edit
-- of that comment does not invoke it again.
SELECT DISTINCT execution_context.agent_actor_id::text
FROM agent_runtime_inputs input
JOIN agent_execution_contexts execution_context
  ON execution_context.context_key=input.context_key
 AND execution_context.context_kind='document'
 AND execution_context.document_id=sqlc.arg(document_id)::text
WHERE input.source_kind='inbox'
  AND input.source_message_id=sqlc.arg(comment_id)::text
  AND input.source_inbox_id='document:'||sqlc.arg(document_id)::text
  AND execution_context.agent_actor_id=ANY(sqlc.arg(actor_ids)::text[]);

-- name: ListDocumentCommentAttentionActors :many
-- A Human gets Room attention the first time an Agent reply mentions them; the
-- comment's earlier Room Events record who already got it.
SELECT DISTINCT attention.actor_id::text
FROM room_events event
CROSS JOIN LATERAL jsonb_array_elements_text(event.payload->'attention_actor_ids') AS attention(actor_id)
WHERE event.event_type='document.comment.changed'
  AND event.payload->>'comment_id'=sqlc.arg(comment_id)::text
  AND attention.actor_id=ANY(sqlc.arg(actor_ids)::text[]);
