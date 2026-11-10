-- name: GetAgentRuntimeTaskParticipantRoom :one
SELECT link.room_id
FROM work_items item
JOIN task_execution_generations generation
  ON generation.task_id=item.id AND generation.tenant_id=item.tenant_id
 AND generation.generation=item.task_execution_generation
 AND generation.terminal_at IS NULL
JOIN task_execution_participants participant
  ON participant.task_id=item.id AND participant.tenant_id=item.tenant_id
 AND participant.generation=generation.generation
 AND participant.actor_id=sqlc.arg(agent_actor_id)::text
 AND participant.agent_management_id=sqlc.arg(agent_management_id)::text
JOIN agent_registrations registration
  ON registration.actor_id=participant.actor_id
 AND registration.agent_management_id=participant.agent_management_id
 AND registration.tenant_id=item.tenant_id AND registration.status='active'
JOIN work_item_room_links link
  ON link.work_item_id=item.id AND link.tenant_id=item.tenant_id AND link.link_type='work'
JOIN rooms room ON room.id=link.room_id AND room.tenant_id=item.tenant_id
 AND room.deleted_at IS NULL AND room.deletion_started_at IS NULL
WHERE item.id=sqlc.arg(task_id)::text AND item.tenant_id=sqlc.arg(tenant_id)::text
  AND item.kind='task' AND item.archived_at IS NULL;

-- name: GetTaskRuntimePresentationRoomForAccount :one
SELECT room.id
FROM work_item_room_links link
JOIN rooms room ON room.id=link.room_id AND room.tenant_id=link.tenant_id
 AND room.deleted_at IS NULL AND room.deletion_started_at IS NULL
JOIN actors caller ON caller.tenant_id=room.tenant_id
 AND caller.account_id=sqlc.arg(account_id)::text AND caller.kind='human'
JOIN active_room_members membership
  ON membership.room_id=room.id AND membership.actor_id=caller.id
WHERE link.work_item_id=sqlc.arg(task_id)::text AND link.link_type='work'
  AND room_actor_participating(room.id,caller.id);

-- name: ListTaskRuntimePresentationRuns :many
SELECT run.run_id,run.status,run.status_room_id::text AS room_id,run.created_at,run.updated_at,
       context.agent_actor_id,actor.kind AS agent_kind,actor.display_name AS agent_display_name,
       coalesce((SELECT max(event.event_ordinal) FROM agent_runtime_status_events event
                 WHERE event.local_run_id=run.run_id),0)::bigint AS event_ordinal,
       COALESCE(CASE WHEN run.status='canceled' THEN left(run.terminal->>'reason',1000) END,'')::text AS stop_reason,
       agent_local_run_replied(run.run_id)::boolean AS replied
FROM agent_local_runs run
JOIN agent_execution_contexts context ON context.context_key=run.context_key
JOIN actors actor ON actor.id=context.agent_actor_id AND actor.tenant_id=context.tenant_id
WHERE context.task_id=sqlc.arg(task_id)::text
  AND context.tenant_id=sqlc.arg(tenant_id)::text
  AND run.status_room_id=sqlc.arg(room_id)::text
  AND (NOT sqlc.arg(active_only)::boolean OR run.status IN ('queued','running'))
  AND (sqlc.narg(before_created_at)::timestamptz IS NULL
    OR (run.created_at,run.run_id)<(sqlc.narg(before_created_at)::timestamptz,sqlc.arg(before_run_id)::text))
ORDER BY run.created_at DESC,run.run_id DESC
LIMIT sqlc.narg(result_limit)::integer;
