-- name: ListRunProgressEvents :many
-- What each Run reported: its latest status changes, latest plan and latest
-- output Messages, oldest first.
SELECT progress.local_run_id,progress.event_type,progress.payload,progress.created_at,
       coalesce(output.body,'')::text AS output_body
FROM (
  SELECT event.local_run_id,event.event_type,event.payload,event.created_at,event.event_ordinal,
         row_number() OVER (PARTITION BY event.local_run_id,event.event_type ORDER BY event.event_ordinal DESC) AS recency
  FROM agent_runtime_status_events event
  WHERE event.local_run_id=ANY(sqlc.arg(run_ids)::text[])
    AND event.event_type IN ('status.changed','plan.updated','presentation.output_created')
) progress
LEFT JOIN messages output
  ON progress.event_type='presentation.output_created' AND output.id=progress.payload->>'output_id'
WHERE (progress.event_type='status.changed' AND progress.recency<=24)
   OR (progress.event_type='plan.updated' AND progress.recency=1)
   OR (progress.event_type='presentation.output_created' AND progress.recency<=2)
ORDER BY progress.local_run_id,progress.event_ordinal;

-- name: ListCoordinatorActiveTasks :many
-- The Tasks one Meta Context coordinates that are still at work, oldest
-- first, with the latest Run of each that has started.
SELECT item.id AS task_id,item.title,coalesce(run.run_id,'')::text AS run_id
FROM work_items item
JOIN task_execution_generations generation
  ON generation.task_id=item.id AND generation.tenant_id=item.tenant_id
 AND generation.generation=item.task_execution_generation
LEFT JOIN LATERAL (
  SELECT latest.run_id FROM agent_execution_contexts context
  JOIN agent_local_runs latest ON latest.context_key=context.context_key AND latest.status<>'queued'
  WHERE context.context_kind='alter_ego' AND context.agent_actor_id=generation.result_agent_actor_id
    AND context.task_id=item.id
  ORDER BY latest.created_at DESC,latest.run_id DESC LIMIT 1
) run ON true
WHERE item.tenant_id=sqlc.arg(tenant_id)::text
  AND item.kind='task'
  AND item.archived_at IS NULL
  AND item.task_execution_status IN ('running','waiting_for_approval')
  AND generation.coordinator_context_key=sqlc.arg(coordinator_context_key)::text
ORDER BY item.created_at,item.id;

-- name: GetActorLastRoomMessageAt :one
-- When the actor last said something people see in the Room.
SELECT message.created_at FROM messages message
WHERE message.room_id=sqlc.arg(room_id)::text AND message.author_actor_id=sqlc.arg(actor_id)::text
  AND message.message_kind='conversation'
ORDER BY message.created_at DESC,message.id DESC
LIMIT 1;
