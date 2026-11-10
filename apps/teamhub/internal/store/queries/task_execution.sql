-- name: LockUnmanagedTaskForExecution :one
SELECT item.id,item.tenant_id,item.kind,item.state,item.resolution,item.version,item.archived_at,
       item.created_by_actor_id,item.updated_by_actor_id,
       COALESCE(work_room.room_id,origin.room_id)::text AS event_room_id
FROM work_items item
LEFT JOIN work_item_room_links origin
  ON origin.work_item_id=item.id AND origin.tenant_id=item.tenant_id AND origin.link_type='origin'
LEFT JOIN work_item_room_links work_room
  ON work_room.work_item_id=item.id AND work_room.tenant_id=item.tenant_id AND work_room.link_type='work'
WHERE item.id=sqlc.arg(task_id)::text
  AND item.kind='task'
  AND item.task_execution_generation IS NULL
FOR UPDATE OF item;

-- name: ResolveTaskParticipant :one
SELECT actor.id,actor.tenant_id,actor.kind,actor.display_name,
       registration.agent_management_id,registration.status AS registration_status
FROM actors actor
JOIN agent_registrations registration
  ON registration.actor_id=actor.id AND registration.tenant_id=actor.tenant_id
WHERE actor.id=sqlc.arg(actor_id)::text
  AND actor.tenant_id=sqlc.arg(tenant_id)::text
FOR KEY SHARE OF actor,registration;

-- name: TaskExecutionDatabaseNow :one
SELECT clock_timestamp()::timestamptz;

-- name: InsertTaskExecutionGeneration :one
INSERT INTO task_execution_generations(
    task_id,tenant_id,generation,source_key,
    result_agent_actor_id,spec,spec_hash,coordinator_actor_id,coordinator_context_key
) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
RETURNING *;

-- name: InsertTaskExecutionParticipant :one
INSERT INTO task_execution_participants(
    task_id,tenant_id,generation,actor_id,agent_management_id,execution_context_ref
) VALUES($1,$2,$3,$4,$5,$6)
RETURNING *;

-- name: InsertTaskAttempt :one
INSERT INTO task_attempts(
    id,task_id,tenant_id,generation,attempt_number,runtime_generation_key,
    status,current_input_revision,deadline_at
) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
RETURNING *;

-- name: InsertTaskInputRevision :one
INSERT INTO task_input_revisions(
    task_id,tenant_id,generation,attempt_id,input_revision,cause,
    recipient_actor_ids,input_manifest,message_effect_ids,capability_hash
) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
RETURNING *;

-- name: InsertHumanTaskInputRevision :one
INSERT INTO task_input_revisions(
    task_id,tenant_id,generation,attempt_id,input_revision,cause,
    recipient_actor_ids,input_manifest,message_effect_ids,capability_hash,
    source_message_id
)
SELECT
    sqlc.arg(task_id)::text,sqlc.arg(tenant_id)::text,sqlc.arg(generation)::bigint,
    sqlc.arg(attempt_id)::text,sqlc.arg(input_revision)::bigint,'human_message',
    sqlc.arg(recipient_actor_ids)::jsonb,sqlc.arg(input_manifest)::jsonb,
    sqlc.arg(message_effect_ids)::jsonb,sqlc.arg(capability_hash)::bytea,
    sqlc.arg(source_message_id)::text
FROM messages message
JOIN actors author
  ON author.id=message.author_actor_id AND author.tenant_id=message.tenant_id
WHERE message.id=sqlc.arg(source_message_id)::text
  AND message.tenant_id=sqlc.arg(tenant_id)::text
  AND author.id=sqlc.arg(author_actor_id)::text
  AND message.message_kind='conversation'
  AND author.kind='human'
  AND EXISTS (
    SELECT 1
    FROM work_item_room_links linked_room
    WHERE linked_room.work_item_id=sqlc.arg(task_id)::text
      AND linked_room.tenant_id=sqlc.arg(tenant_id)::text
      AND linked_room.link_type IN ('origin','work')
      AND linked_room.room_id=message.room_id
  )
RETURNING *;

-- name: InsertTaskEffect :one
INSERT INTO task_effects(
    id,task_id,tenant_id,generation,root_operation_id,effect_key,operation,
    owner_id,payload,payload_hash,root_payload_hash,
    dispatch_sequence,retry_of_effect_id,status
) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
RETURNING *;

-- name: InsertTaskRuntimeCleanupEffect :execrows
INSERT INTO task_effects(
    id,task_id,tenant_id,generation,root_operation_id,effect_key,operation,
    owner_id,payload,payload_hash,root_payload_hash,
    dispatch_sequence,status
) VALUES(
    sqlc.arg(id)::text,sqlc.arg(task_id)::text,sqlc.arg(tenant_id)::text,
    sqlc.arg(generation)::bigint,sqlc.arg(root_operation_id)::text,
    sqlc.arg(effect_key)::text,'cleanup_runtime',
    sqlc.arg(task_id)::text,sqlc.arg(payload)::jsonb,
    sqlc.arg(payload_hash)::bytea,sqlc.arg(payload_hash)::bytea,1,'pending'
)
ON CONFLICT (id) DO UPDATE SET id=task_effects.id
WHERE task_effects.task_id=EXCLUDED.task_id
  AND task_effects.tenant_id=EXCLUDED.tenant_id
  AND task_effects.generation=EXCLUDED.generation
  AND task_effects.root_operation_id=EXCLUDED.root_operation_id
  AND task_effects.effect_key=EXCLUDED.effect_key
  AND task_effects.operation=EXCLUDED.operation
  AND task_effects.owner_id=EXCLUDED.owner_id
  AND task_effects.payload_hash=EXCLUDED.payload_hash
  AND task_effects.root_payload_hash=EXCLUDED.root_payload_hash;

-- name: InsertTaskExecutionFact :one
INSERT INTO task_execution_facts(
    id,task_id,tenant_id,generation,execution_revision,fact_kind,execution_status,
    control_settled_revision,control_revision,source_operation_id,reason_code,
    payload,payload_hash,caused_by_actor_id
) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
RETURNING *;

-- name: PromoteTaskToManagedExecution :one
UPDATE work_items
SET state=sqlc.arg(work_item_state)::text,
    resolution=NULL,
    task_source_key=sqlc.narg(source_key)::text,
    task_execution_generation=sqlc.arg(generation)::bigint,
    task_execution_status=sqlc.arg(execution_status)::text,
    task_execution_revision=sqlc.arg(execution_revision)::bigint,
    task_execution_reason_code=NULL,
    task_desired_control='run',
    task_control_revision=0,
    task_control_settled_revision=0,
    task_control_outcome=NULL,
    task_execution_updated_at=clock_timestamp(),
    task_next_reconcile_at=clock_timestamp(),
    task_lease_generation=0
WHERE id=sqlc.arg(task_id)::text
  AND tenant_id=sqlc.arg(tenant_id)::text
  AND kind='task'
  AND task_execution_generation IS NULL
RETURNING *;

-- name: GetTaskExecutionSnapshot :one
SELECT item.id AS task_id,item.tenant_id,item.state AS work_item_state,item.resolution,
       item.task_source_key,item.task_execution_generation,
       item.task_execution_status,item.task_execution_revision,item.task_execution_reason_code,
       item.task_desired_control,item.task_control_revision,item.task_control_settled_revision,
       item.task_control_outcome,item.task_control_payload,item.task_execution_updated_at,
       generation.result_agent_actor_id,generation.spec,generation.spec_hash,
       generation.created_at AS generation_created_at,generation.terminal_at
FROM work_items item
JOIN task_execution_generations generation
  ON generation.task_id=item.id AND generation.tenant_id=item.tenant_id
 AND generation.generation=item.task_execution_generation
WHERE item.id=sqlc.arg(task_id)::text;

-- name: ResolveAgentParticipantTaskByWorkRoom :one
SELECT item.id AS task_id,
       work_room.room_id AS work_room_id,
       participant.generation AS execution_generation
FROM agent_registrations registration
JOIN work_items item
  ON item.tenant_id=registration.tenant_id
 AND item.kind='task'
 AND item.archived_at IS NULL
 AND item.state<>'resolved'
 AND item.task_execution_generation IS NOT NULL
JOIN work_item_room_links work_room
  ON work_room.work_item_id=item.id
 AND work_room.tenant_id=item.tenant_id
 AND work_room.link_type='work'
 AND work_room.room_id=sqlc.arg(work_room_id)::text
JOIN rooms room
  ON room.id=work_room.room_id
 AND room.tenant_id=work_room.tenant_id
 AND room.deleted_at IS NULL
JOIN task_execution_generations generation
  ON generation.task_id=item.id
 AND generation.tenant_id=item.tenant_id
 AND generation.generation=item.task_execution_generation
 AND generation.terminal_at IS NULL
JOIN task_execution_participants participant
  ON participant.task_id=item.id
 AND participant.tenant_id=item.tenant_id
 AND participant.generation=item.task_execution_generation
 AND participant.actor_id=registration.actor_id
 AND participant.agent_management_id=registration.agent_management_id
WHERE registration.agent_management_id=sqlc.arg(agent_management_id)::text
  AND registration.status='active';

-- name: LockTaskExecutionSnapshot :one
SELECT item.id AS task_id,item.tenant_id,item.title,item.state AS work_item_state,item.resolution,item.version,
       item.task_source_key,item.task_execution_generation,
       item.task_execution_status,item.task_execution_revision,item.task_execution_reason_code,
       item.task_desired_control,item.task_control_revision,item.task_control_settled_revision,
       item.task_control_outcome,item.task_control_payload,item.task_execution_updated_at,
       generation.result_agent_actor_id,generation.spec,generation.spec_hash,
       COALESCE(work_room.room_id,origin.room_id)::text AS event_room_id
FROM work_items item
JOIN task_execution_generations generation
  ON generation.task_id=item.id AND generation.tenant_id=item.tenant_id
 AND generation.generation=item.task_execution_generation
LEFT JOIN work_item_room_links origin
  ON origin.work_item_id=item.id AND origin.tenant_id=item.tenant_id AND origin.link_type='origin'
LEFT JOIN work_item_room_links work_room
  ON work_room.work_item_id=item.id AND work_room.tenant_id=item.tenant_id AND work_room.link_type='work'
WHERE item.id=sqlc.arg(task_id)::text
FOR UPDATE OF item;

-- name: ListTaskExecutionParticipants :many
SELECT * FROM task_execution_participants
WHERE task_id=$1 AND generation=$2
ORDER BY actor_id;

-- name: LockHumanTaskInputTargetByWorkRoom :one
SELECT item.id AS task_id,item.tenant_id,item.version,
       generation.generation,
       COALESCE(generation.source_key,'')::text AS source_key,
       COALESCE(item.task_execution_status,'')::text AS execution_status,
       COALESCE(item.task_execution_revision,0)::bigint AS execution_revision,
       COALESCE(item.task_desired_control,'')::text AS desired_control,
       COALESCE(item.task_control_revision,0)::bigint AS control_revision,
       COALESCE(item.task_control_settled_revision,0)::bigint AS control_settled_revision,
       (item.archived_at IS NOT NULL)::boolean AS archived,
       COALESCE(attempt.id,'')::text AS attempt_id,
       COALESCE(attempt.status,'')::text AS attempt_status,
       COALESCE(attempt.current_input_revision,0)::bigint AS current_input_revision
FROM work_item_room_links link
JOIN work_items item
  ON item.id=link.work_item_id AND item.tenant_id=link.tenant_id
JOIN task_execution_generations generation
  ON generation.task_id=item.id AND generation.tenant_id=item.tenant_id
 AND generation.generation=item.task_execution_generation
LEFT JOIN task_attempts attempt
  ON attempt.task_id=item.id AND attempt.tenant_id=item.tenant_id
 AND attempt.generation=generation.generation
 AND attempt.status='running'
WHERE link.room_id=sqlc.arg(room_id)::text
  AND link.tenant_id=sqlc.arg(tenant_id)::text
  AND link.link_type='work'
  AND item.kind='task'
FOR UPDATE OF item;

-- name: AdvanceTaskForHumanMessageInput :execrows
UPDATE work_items
SET task_execution_revision=task_execution_revision+1,
    task_execution_reason_code=NULL,
    task_execution_updated_at=clock_timestamp(),
    task_next_reconcile_at=clock_timestamp(),
    task_worker_id=NULL,
    task_lease_token_hash=NULL,
    task_lease_expires_at=NULL
WHERE id=sqlc.arg(task_id)::text
  AND tenant_id=sqlc.arg(tenant_id)::text
  AND task_execution_generation=sqlc.arg(generation)::bigint
  AND task_execution_revision=sqlc.arg(expected_execution_revision)::bigint
  AND task_control_revision=sqlc.arg(expected_control_revision)::bigint
  AND task_execution_status='running'
  AND task_desired_control='run';

-- name: ListTaskAttempts :many
SELECT * FROM task_attempts
WHERE task_id=$1 AND generation=$2
ORDER BY attempt_number,id;

-- name: ListTaskInputRevisions :many
SELECT input.* FROM task_input_revisions input
JOIN task_attempts attempt ON attempt.id=input.attempt_id
WHERE input.task_id=$1 AND input.generation=$2
ORDER BY attempt.attempt_number,input.input_revision;

-- name: ListTaskEffects :many
SELECT * FROM task_effects
WHERE task_id=$1 AND generation=$2
ORDER BY created_at,id;

-- name: ListTaskExecutionFacts :many
SELECT * FROM task_execution_facts
WHERE task_id=$1 AND generation=$2
ORDER BY execution_revision;

-- name: GetTaskEffect :one
SELECT * FROM task_effects
WHERE id=$1 AND task_id=$2 AND generation=$3;

-- name: AdvanceTaskExecutionStatus :one
UPDATE work_items
SET state=sqlc.arg(work_item_state)::text,
    resolution=sqlc.narg(resolution)::text,
    task_execution_status=sqlc.arg(next_status)::text,
    task_execution_reason_code=sqlc.narg(reason_code)::text,
    task_execution_revision=task_execution_revision+1,
    task_execution_updated_at=clock_timestamp(),
    task_next_reconcile_at=clock_timestamp()
WHERE id=sqlc.arg(task_id)::text
  AND tenant_id=sqlc.arg(tenant_id)::text
  AND task_execution_generation=sqlc.arg(generation)::bigint
  AND task_execution_revision=sqlc.arg(expected_execution_revision)::bigint
  AND task_control_revision=sqlc.arg(expected_control_revision)::bigint
  AND task_execution_status=sqlc.arg(expected_status)::text
RETURNING *;

-- name: CountRunningDelegatedTasksForAgent :one
-- One Agent may have at most a fixed number of running Tasks.
SELECT count(*)::bigint
FROM work_items item
JOIN task_execution_generations generation
  ON generation.task_id=item.id
 AND generation.tenant_id=item.tenant_id
 AND generation.generation=item.task_execution_generation
WHERE item.tenant_id=sqlc.arg(tenant_id)::text
  AND item.kind='task'
  AND item.archived_at IS NULL
  AND item.task_execution_status='running'
  AND generation.coordinator_actor_id=sqlc.arg(agent_actor_id)::text;
