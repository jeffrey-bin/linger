-- name: GetDelegatedTaskForCoordinator :one
-- Only the Meta of the Task's origin Room sees and manages it, so
-- a Task is addressed by its Agent and its origin Room together.
SELECT item.id AS task_id,item.tenant_id,item.title,item.created_at,
       item.task_execution_generation::bigint AS generation,
       sqlc.arg(origin_room_id)::text AS origin_room_id,
       COALESCE(work_room.room_id,'')::text AS work_room_id
FROM work_items item
JOIN task_execution_generations generation
  ON generation.task_id=item.id AND generation.tenant_id=item.tenant_id
 AND generation.generation=item.task_execution_generation
 AND generation.result_agent_actor_id=sqlc.arg(agent_actor_id)::text

LEFT JOIN work_item_room_links work_room
  ON work_room.work_item_id=item.id AND work_room.tenant_id=item.tenant_id
 AND work_room.link_type='work'
WHERE item.id=sqlc.arg(task_id)::text
  AND item.tenant_id=sqlc.arg(tenant_id)::text
  AND item.kind='task'
  AND item.archived_at IS NULL
  AND (EXISTS (SELECT 1 FROM work_item_room_links origin WHERE origin.work_item_id=item.id AND origin.link_type='origin' AND origin.room_id=sqlc.arg(origin_room_id)::text)
   OR EXISTS (SELECT 1 FROM voice_live_tasks voice WHERE voice.work_item_id=item.id AND voice.home_room_id=sqlc.arg(origin_room_id)::text));

-- name: ListDelegatedTasksForCoordinator :many
SELECT item.id AS task_id,item.title,item.created_at,
       COALESCE(item.task_execution_status,'')::text AS status,
       COALESCE(item.task_execution_reason_code,'')::text AS reason_code,
       item.task_execution_updated_at::timestamptz AS updated_at
FROM work_items item
JOIN task_execution_generations generation
  ON generation.task_id=item.id AND generation.tenant_id=item.tenant_id
 AND generation.generation=item.task_execution_generation
 AND generation.result_agent_actor_id=sqlc.arg(agent_actor_id)::text

WHERE item.tenant_id=sqlc.arg(tenant_id)::text
  AND item.kind='task'
  AND item.archived_at IS NULL
  AND (EXISTS (SELECT 1 FROM work_item_room_links origin WHERE origin.work_item_id=item.id AND origin.link_type='origin' AND origin.room_id=sqlc.arg(origin_room_id)::text)
   OR EXISTS (SELECT 1 FROM voice_live_tasks voice WHERE voice.work_item_id=item.id AND voice.home_room_id=sqlc.arg(origin_room_id)::text))
ORDER BY item.created_at DESC,item.id DESC
LIMIT 50;

-- name: ListDelegatedTaskPendingApprovals :many
-- Approvals the Task's AlterEgo is waiting on: Runtime permission cards of
-- its Context and the other approvals it asked for. Connection, computer
-- permission and Document access cards are not approvals.
SELECT CASE WHEN decision.kind='runtime_permission' THEN 'permission' ELSE 'connector' END::text AS kind,
       decision.id,
       COALESCE(decision.view->>'title','')::text AS title,
       decision.created_at,decision.expires_at
FROM decisions decision
WHERE decision.tenant_id=sqlc.arg(tenant_id)::text
  AND decision.alter_ego_task_id=sqlc.arg(task_id)::text
  AND decision.status='pending'
  AND decision.kind NOT IN ('connection_auth','provider_key','browser_connection','computer_permission','document_access')
  AND (decision.kind<>'runtime_permission' OR decision.request->>'context_key'=sqlc.arg(context_key)::text)
ORDER BY decision.created_at,decision.id;

-- name: GetAgentLocalRunFinalResponse :one
SELECT COALESCE(terminal->>'finalResponse','')::text AS final_response
FROM agent_local_runs
WHERE run_id=sqlc.arg(run_id)::text
  AND context_key=sqlc.arg(context_key)::text;

-- name: GetLatestTaskMetaCallbackMessage :one
SELECT body,created_at
FROM task_meta_callback_messages
WHERE task_id=sqlc.arg(task_id)::text
  AND tenant_id=sqlc.arg(tenant_id)::text
ORDER BY meta_seq DESC
LIMIT 1;

-- name: SetDelegatedTaskStatus :execrows
-- A Meta input or stop changes a Task outside the Worker lease, so it
-- releases any lease and makes the Task due at once.
UPDATE work_items
SET task_execution_status=sqlc.arg(next_status)::text,
    task_execution_reason_code=sqlc.narg(reason_code)::text,
    task_execution_revision=task_execution_revision+1,
    task_execution_updated_at=clock_timestamp(),
    task_next_reconcile_at=clock_timestamp(),
    task_worker_id=NULL,
    task_lease_token_hash=NULL,
    task_lease_expires_at=NULL
WHERE id=sqlc.arg(task_id)::text
  AND tenant_id=sqlc.arg(tenant_id)::text
  AND task_execution_generation=sqlc.arg(generation)::bigint
  AND task_execution_revision=sqlc.arg(expected_execution_revision)::bigint
  AND task_execution_status=sqlc.arg(expected_status)::text;

-- name: GetDelegatedTaskForAlterEgo :one
-- The Task an AlterEgo Context belongs to, for routing an approval result
-- back into that Task's input.
SELECT item.id AS task_id,item.tenant_id,generation.result_agent_actor_id
FROM work_items item
JOIN task_execution_generations generation
  ON generation.task_id=item.id AND generation.tenant_id=item.tenant_id
 AND generation.generation=item.task_execution_generation
JOIN task_execution_participants participant
  ON participant.task_id=item.id AND participant.tenant_id=item.tenant_id
 AND participant.generation=item.task_execution_generation
 AND participant.agent_management_id=sqlc.arg(agent_management_id)::text
WHERE item.id=sqlc.arg(task_id)::text
  AND item.kind='task'
  AND item.archived_at IS NULL;

-- name: ListRoomBackgroundTasks :many
-- The background Tasks this Room's Meta delegated that are still running,
-- oldest first. Waiting for an approval counts as running.
SELECT item.id, item.title, item.description, item.created_at, item.task_execution_status
FROM work_item_room_links origin
JOIN work_items item ON item.id=origin.work_item_id AND item.tenant_id=origin.tenant_id
WHERE origin.room_id=sqlc.arg(room_id)::text AND origin.tenant_id=sqlc.arg(tenant_id)::text
  AND origin.link_type='origin' AND item.kind='task' AND item.archived_at IS NULL
  AND item.task_execution_status IN ('running','waiting_for_approval')
ORDER BY item.created_at, item.id
LIMIT 50;

-- name: ListRoomRunningTasks :many
-- The Tasks running for this Room, oldest first: the background Tasks its Meta
-- delegated and the tasks Live started with it as their home Room.
SELECT item.id, item.title, item.description, item.created_at
FROM work_items item
WHERE item.id IN (
    SELECT origin.work_item_id FROM work_item_room_links origin
    WHERE origin.room_id=sqlc.arg(room_id)::text AND origin.tenant_id=sqlc.arg(tenant_id)::text AND origin.link_type='origin'
    UNION
    SELECT live.work_item_id FROM voice_live_tasks live WHERE live.home_room_id=sqlc.arg(room_id)::text
  )
  AND item.tenant_id=sqlc.arg(tenant_id)::text AND item.kind='task' AND item.archived_at IS NULL
  AND item.task_execution_status IN ('running','waiting_for_approval')
ORDER BY item.created_at, item.id
LIMIT 50;
