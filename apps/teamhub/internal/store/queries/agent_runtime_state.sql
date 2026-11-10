-- name: AgentRuntimeDatabaseNow :one
SELECT clock_timestamp()::timestamptz;

-- name: GetMaterializableAgentRuntimeRegistrationByManagementID :one
SELECT registration.actor_id,registration.tenant_id,registration.status,
       registration.agent_management_id,registration.configuration_revision,
       registration.runtime_configuration_revision,registration.assignment_revision,
       registration.instructions,registration.runtime_model,registration.runtime_reasoning_effort,
       registration.computer_id,
       registration.local_runtime_type,registration.workspace_grant_id,
       registration.agent_type,registration.created_by_actor_id,
       actor.display_name
FROM agent_registrations registration
JOIN actors actor
  ON actor.id=registration.actor_id
 AND actor.tenant_id=registration.tenant_id
WHERE registration.agent_management_id=sqlc.arg(agent_management_id)::text
  AND registration.status='active';

-- name: GetAgentRuntimeRegistrationForRunnerByManagementID :one
SELECT registration.actor_id,registration.tenant_id,registration.status,
       registration.agent_management_id,registration.configuration_revision,
       registration.runtime_configuration_revision,registration.assignment_revision,
       registration.instructions,registration.runtime_model,registration.runtime_reasoning_effort,
       registration.computer_id,
       registration.local_runtime_type,registration.workspace_grant_id,
       registration.agent_type,registration.created_by_actor_id,
       actor.display_name
FROM agent_registrations registration
JOIN actors actor
  ON actor.id=registration.actor_id
 AND actor.tenant_id=registration.tenant_id
WHERE registration.agent_management_id=sqlc.arg(agent_management_id)::text
  AND registration.status IN ('active','revoked');

-- name: ListMaterializableAgentRuntimeRegistrationsAfter :many
SELECT COALESCE(registration.agent_management_id,'')::text AS agent_management_id
FROM agent_registrations registration
WHERE registration.agent_management_id IS NOT NULL
  AND registration.agent_management_id>sqlc.arg(after_management_id)::text
  AND registration.status='active'
ORDER BY registration.agent_management_id
LIMIT sqlc.arg(row_limit)::integer;

-- name: InsertAgentExecutionContext :execrows
INSERT INTO agent_execution_contexts(
    context_key,tenant_id,agent_actor_id,agent_management_id,
    context_kind,task_id,room_id,room_kind,membership_epoch_id,document_id,target_residency
)
SELECT
    sqlc.arg(context_key)::text,registration.tenant_id,registration.actor_id,
    registration.agent_management_id,sqlc.arg(context_kind)::text,
    sqlc.narg(task_id)::text,sqlc.narg(room_id)::text,
    CASE
        WHEN sqlc.arg(context_kind)::text='meta' AND sqlc.narg(room_id)::text IS NOT NULL THEN
            CASE WHEN EXISTS (
                SELECT 1 FROM rooms direct
                WHERE direct.id=sqlc.narg(room_id)::text
                  AND direct.tenant_id=registration.tenant_id
                  AND direct.direct_agent_actor_id IS NOT NULL
            ) THEN 'direct' ELSE 'collaboration' END
        ELSE NULL
    END,
    membership.membership_epoch_id,sqlc.narg(document_id)::text,
    sqlc.arg(target_residency)::text
FROM agent_registrations registration
LEFT JOIN active_room_members membership
  ON membership.actor_id=registration.actor_id
 AND membership.tenant_id=registration.tenant_id
 AND membership.room_id=sqlc.narg(room_id)::text
WHERE registration.agent_management_id=sqlc.arg(agent_management_id)::text
  AND registration.status='active'
  AND (
      (
          sqlc.arg(context_kind)::text='meta'
          AND sqlc.narg(task_id)::text IS NULL
          AND sqlc.narg(document_id)::text IS NULL
          AND sqlc.narg(room_id)::text IS NOT NULL
          AND membership.membership_epoch_id IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM work_item_room_links link
              JOIN work_items item ON item.id=link.work_item_id AND item.tenant_id=link.tenant_id
              WHERE link.tenant_id=registration.tenant_id
                AND link.room_id=sqlc.narg(room_id)::text
                AND link.link_type='work' AND item.kind='task'
          )
      )
      OR (
          sqlc.arg(context_kind)::text='alter_ego'
          AND sqlc.narg(task_id)::text IS NOT NULL
          AND sqlc.narg(room_id)::text IS NULL
          AND sqlc.narg(document_id)::text IS NULL
          AND EXISTS (
              SELECT 1
              FROM work_items item
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
              LEFT JOIN work_item_room_links work_room
                ON work_room.work_item_id=item.id
               AND work_room.tenant_id=item.tenant_id
               AND work_room.link_type='work'
              LEFT JOIN rooms room
                ON room.id=work_room.room_id
               AND room.tenant_id=work_room.tenant_id
               AND room.deleted_at IS NULL AND room.deletion_started_at IS NULL
              WHERE item.id=sqlc.narg(task_id)::text
                AND item.tenant_id=registration.tenant_id
                AND item.kind='task'
 AND (work_room.room_id IS NULL OR room.id IS NOT NULL)
                AND item.archived_at IS NULL
                AND item.state<>'resolved'
                AND item.task_execution_generation IS NOT NULL
          )
      )
      OR (
          sqlc.arg(context_kind)::text='document'
          AND sqlc.narg(task_id)::text IS NULL
          AND sqlc.narg(room_id)::text IS NULL
          AND sqlc.narg(document_id)::text IS NOT NULL
          AND (
              document_comment_agent_readable(
                  registration.tenant_id,sqlc.narg(document_id)::text,registration.actor_id
              )
          )
      )
  )
ON CONFLICT DO NOTHING;

-- name: ListAgentPerRoomMetaContextCandidates :many
SELECT registration.tenant_id,registration.actor_id AS agent_actor_id,
       registration.agent_management_id,membership.room_id,
       membership.membership_epoch_id
FROM agent_registrations registration
JOIN active_room_members membership
  ON membership.actor_id=registration.actor_id
 AND membership.tenant_id=registration.tenant_id
WHERE registration.actor_id=sqlc.arg(agent_actor_id)::text
  AND registration.agent_management_id IS NOT NULL
  AND registration.status='active'
  AND NOT EXISTS (
      SELECT 1
      FROM work_item_room_links work_link
      JOIN work_items task
        ON task.id=work_link.work_item_id
       AND task.tenant_id=work_link.tenant_id
       AND task.kind='task'
      WHERE work_link.room_id=membership.room_id
        AND work_link.tenant_id=membership.tenant_id
        AND work_link.link_type='work'
  )
ORDER BY membership.room_id;

-- name: UpsertAgentPerRoomMetaContext :execrows
INSERT INTO agent_execution_contexts(
    context_key,tenant_id,agent_actor_id,agent_management_id,
    context_kind,room_id,membership_epoch_id,target_residency
) VALUES(
    sqlc.arg(context_key)::text,sqlc.arg(tenant_id)::text,
    sqlc.arg(agent_actor_id)::text,sqlc.arg(agent_management_id)::text,
    'meta',sqlc.arg(room_id)::text,sqlc.arg(membership_epoch_id)::text,
    'suspended'
)
ON CONFLICT(context_key) DO UPDATE SET
    membership_epoch_id=excluded.membership_epoch_id,
    target_residency='active',
    terminal_reason=NULL,terminated_at=NULL,
    state_revision=agent_execution_contexts.state_revision+1,
    updated_at=clock_timestamp()
WHERE agent_execution_contexts.tenant_id=excluded.tenant_id
  AND agent_execution_contexts.agent_actor_id=excluded.agent_actor_id
  AND agent_execution_contexts.agent_management_id=excluded.agent_management_id
  AND agent_execution_contexts.context_kind='meta'
  AND agent_execution_contexts.task_id IS NULL
  AND agent_execution_contexts.room_id=excluded.room_id
  AND (agent_execution_contexts.terminal_reason IS NULL OR agent_execution_contexts.terminal_reason='context_deleted')
  AND agent_execution_contexts.membership_epoch_id IS DISTINCT FROM excluded.membership_epoch_id
  AND EXISTS (
      SELECT 1 FROM room_members membership
      WHERE membership.room_id=excluded.room_id
        AND membership.actor_id=excluded.agent_actor_id
        AND membership.membership_epoch_id=excluded.membership_epoch_id
  );

-- name: IsAgentExecutionContextRoomAuthorized :one
SELECT EXISTS (
    SELECT 1
    FROM room_members membership
    WHERE membership.tenant_id=sqlc.arg(tenant_id)::text
      AND membership.room_id=sqlc.arg(room_id)::text
      AND membership.actor_id=sqlc.arg(agent_actor_id)::text
      AND membership.membership_epoch_id=sqlc.arg(membership_epoch_id)::text
);

-- name: GetAgentExecutionContext :one
SELECT context_key, tenant_id, agent_actor_id, agent_management_id, context_kind,
    task_id, target_residency, next_input_sequence,
    state_revision, room_id, membership_epoch_id, terminal_reason, terminated_at,
    document_id, room_kind, task_archive_suspended
FROM agent_execution_contexts
WHERE context_key=sqlc.arg(context_key)::text;

-- name: LockMetaContextsForRoomMemberships :exec
-- Meta Contexts are locked in context_key order before any membership write
-- or Room lock.
SELECT context.context_key FROM agent_execution_contexts context
WHERE context.context_kind='meta'
  AND context.agent_actor_id=ANY(sqlc.arg(agent_actor_ids)::text[])
  AND context.room_id=ANY(sqlc.arg(room_ids)::text[])
ORDER BY context.context_key FOR NO KEY UPDATE;

-- name: LockAgentExecutionContext :one
-- Context identity never changes. NO KEY UPDATE serializes state commands
-- without blocking foreign-key KEY SHARE checks during Task Inbox binding.
SELECT context_key, tenant_id, agent_actor_id, agent_management_id, context_kind,
    task_id, target_residency, next_input_sequence,
    state_revision, room_id, membership_epoch_id, terminal_reason, terminated_at,
    document_id, room_kind, task_archive_suspended
FROM agent_execution_contexts
WHERE context_key=sqlc.arg(context_key)::text
FOR NO KEY UPDATE;

-- name: ListAgentExecutionContextsByManagementID :many
SELECT context_key, tenant_id, agent_actor_id, agent_management_id, context_kind,
    task_id, target_residency, next_input_sequence,
    state_revision, room_id, membership_epoch_id, terminal_reason, terminated_at,
    document_id, room_kind, task_archive_suspended
FROM agent_execution_contexts
WHERE agent_management_id=sqlc.arg(agent_management_id)::text
ORDER BY context_key;

-- name: ListRuntimeAgentExecutionContexts :many
SELECT context.context_key, context.tenant_id, context.agent_actor_id,
    context.agent_management_id, context.context_kind, context.task_id,
    context.target_residency, context.next_input_sequence,
    context.state_revision, context.room_id,
    context.membership_epoch_id, context.terminal_reason, context.terminated_at,
    context.document_id, context.room_kind, context.task_archive_suspended
FROM agent_execution_contexts context
WHERE NOT EXISTS (
    SELECT 1
    FROM agent_registrations registration
    WHERE registration.tenant_id=context.tenant_id
      AND registration.actor_id=context.agent_actor_id
      AND registration.status='revoked'
)
ORDER BY context.context_key;

-- name: ListRuntimeAgentExecutionContextsByManagementID :many
-- A revoked Agent's Contexts stay listed: Agent Service enumerates them to
-- stop and remove them after TeamHub revoked the Agent.
SELECT context.context_key, context.tenant_id, context.agent_actor_id,
    context.agent_management_id, context.context_kind, context.task_id,
    context.target_residency, context.next_input_sequence,
    context.state_revision, context.room_id,
    context.membership_epoch_id, context.terminal_reason, context.terminated_at,
    context.document_id, context.room_kind, context.task_archive_suspended
FROM agent_execution_contexts context
WHERE context.agent_management_id=sqlc.arg(agent_management_id)::text
ORDER BY context.context_key;

-- name: LockOpenAgentExecutionContextsForAgentRevocation :many
-- One ordered pass over every Context the deletion touches: open Contexts it
-- terminates, plus the meta Contexts membership revocation suspends in its
-- Rooms (LockMetaContextsForRoomMemberships), terminal or not.
SELECT context.context_key
FROM agent_execution_contexts context
WHERE context.tenant_id=sqlc.arg(tenant_id)::text
  AND context.agent_actor_id=sqlc.arg(agent_actor_id)::text
  AND (
    context.terminal_reason IS NULL
    OR (context.context_kind='meta'
        AND context.room_id=ANY(sqlc.arg(room_ids)::text[]))
  )
ORDER BY context.context_key
FOR UPDATE;

-- name: TerminateOpenAgentExecutionContextsForAgentRevocation :many
UPDATE agent_execution_contexts
SET target_residency='suspended',
    terminal_reason='context_deleted',
    terminated_at=clock_timestamp(),
    state_revision=state_revision+1,
    updated_at=clock_timestamp()
WHERE tenant_id=sqlc.arg(tenant_id)::text
  AND agent_actor_id=sqlc.arg(agent_actor_id)::text
  AND terminal_reason IS NULL
RETURNING context_key;

-- name: SetAgentExecutionContextResidency :execrows
UPDATE agent_execution_contexts
SET target_residency=sqlc.arg(target_residency)::text,
    task_archive_suspended=false,
    state_revision=state_revision+1,
    updated_at=clock_timestamp()
WHERE context_key=sqlc.arg(context_key)::text
  AND state_revision=sqlc.arg(expected_revision)::bigint
  AND (
      sqlc.arg(target_residency)::text<>'active'
      OR terminal_reason IS NULL
  )
  AND (
      sqlc.arg(target_residency)::text<>'active'
      OR context_kind<>'alter_ego'
      OR EXISTS (
          SELECT 1
          FROM work_items item
          JOIN task_execution_generations generation
            ON generation.task_id=item.id
           AND generation.tenant_id=item.tenant_id
           AND generation.generation=item.task_execution_generation
           AND generation.terminal_at IS NULL
          JOIN task_execution_participants participant
            ON participant.task_id=item.id
           AND participant.tenant_id=item.tenant_id
           AND participant.generation=item.task_execution_generation
           AND participant.actor_id=agent_execution_contexts.agent_actor_id
           AND participant.agent_management_id=agent_execution_contexts.agent_management_id
          JOIN work_item_room_links work_room
            ON work_room.work_item_id=item.id
           AND work_room.tenant_id=item.tenant_id
           AND work_room.link_type='work'
          JOIN rooms room
            ON room.id=work_room.room_id
           AND room.tenant_id=work_room.tenant_id
           AND room.deleted_at IS NULL
          WHERE item.id=agent_execution_contexts.task_id
            AND item.tenant_id=agent_execution_contexts.tenant_id
            AND item.kind='task'
            AND item.archived_at IS NULL
            AND item.state<>'resolved'
            AND item.task_execution_generation IS NOT NULL
      )
  )
  AND (
      sqlc.arg(target_residency)::text<>'active'
      OR context_kind<>'document'
      OR document_comment_agent_readable(
          agent_execution_contexts.tenant_id,
          agent_execution_contexts.document_id,
          agent_execution_contexts.agent_actor_id
      )
  );

-- name: DeleteAgentExecutionContext :execrows
DELETE FROM agent_execution_contexts context
WHERE context.context_key=sqlc.arg(context_key)::text
  AND context.state_revision=sqlc.arg(expected_revision)::bigint
  AND (
      context.context_kind<>'meta'
      OR NOT EXISTS (
          SELECT 1
          FROM agent_registrations registration
          WHERE registration.actor_id=context.agent_actor_id
            AND registration.tenant_id=context.tenant_id
            AND registration.agent_management_id=context.agent_management_id
            AND registration.status='active'
      )
  );

-- name: GetAgentExecutionContextRuntimeEventCount :one
SELECT count(*)::bigint
FROM agent_runtime_status_events event
JOIN agent_local_runs run ON run.run_id=event.local_run_id
WHERE run.context_key=sqlc.arg(context_key)::text;

-- name: ListRetirableWorkRoomPerRoomMetaContexts :many
SELECT context.context_key
FROM agent_execution_contexts context
WHERE context.agent_actor_id=sqlc.arg(agent_actor_id)::text
  AND context.context_kind='meta'
  AND context.room_id IS NOT NULL
  AND context.terminal_reason IS NULL
  AND EXISTS (
      SELECT 1
      FROM work_item_room_links work_link
      JOIN work_items task
        ON task.id=work_link.work_item_id
       AND task.tenant_id=work_link.tenant_id
       AND task.kind='task'
      WHERE work_link.room_id=context.room_id
        AND work_link.tenant_id=context.tenant_id
        AND work_link.link_type='work'
  )
ORDER BY context.context_key;

-- name: TerminateWorkRoomPerRoomMetaContext :one
UPDATE agent_execution_contexts
SET target_residency='suspended',
    terminal_reason='context_deleted',
    terminated_at=clock_timestamp(),
    state_revision=state_revision+1,
    updated_at=clock_timestamp()
WHERE context_key=sqlc.arg(context_key)::text
  AND context_kind='meta'
  AND terminal_reason IS NULL
RETURNING context_key;

-- name: ListUnfinishedAgentContextLocalRuns :many
SELECT run_id FROM agent_local_runs
WHERE context_key=sqlc.arg(context_key)::text
  AND status IN ('queued','running')
ORDER BY run_id;

-- name: SettleAgentContextInputsForContextDeletion :execrows
UPDATE agent_runtime_inputs
SET status='handled',
    selection_result=jsonb_build_object(
        'selected','discard','reason','context_deleted'
    ),
    steer_outcome='uncertain',
    updated_at=clock_timestamp()
WHERE context_key=sqlc.arg(context_key)::text
  AND status='steering';

-- name: TerminateAgentExecutionContextForDeletion :one
UPDATE agent_execution_contexts
SET target_residency='suspended',
    terminal_reason='context_deleted',
    terminated_at=clock_timestamp(),
    state_revision=state_revision+1,
    updated_at=clock_timestamp()
WHERE context_key=sqlc.arg(context_key)::text
  AND state_revision=sqlc.arg(expected_revision)::bigint
  AND terminal_reason IS NULL
RETURNING context_key;

-- name: DeleteAgentLocalRunInputsByContext :execrows
DELETE FROM agent_local_run_inputs
WHERE context_key=sqlc.arg(context_key)::text;

-- name: AcquireAgentRuntimeAdvisoryLock :exec
SELECT pg_advisory_xact_lock(hashtextextended(sqlc.arg(lock_key)::text,0));

-- name: GetAgentRuntimeInput :one
SELECT *
FROM agent_runtime_inputs
WHERE context_key=sqlc.arg(context_key)::text
  AND input_id=sqlc.arg(input_id)::text;

-- name: InsertAgentRuntimeInput :one
-- The global input sequence orders a Context's inputs without a per-Context
-- counter, so Message transactions queue inputs without the Context lock.
INSERT INTO agent_runtime_inputs(
    context_key,input_id,payload,payload_hash,source_kind,
    source_message_id,source_inbox_id,status,selection_result,
    steer_group_id,local_run_id,steer_outcome
) VALUES(
    sqlc.arg(context_key)::text,sqlc.arg(input_id)::text,
    sqlc.arg(payload)::jsonb,
    sqlc.arg(payload_hash)::bytea,sqlc.arg(source_kind)::text,
    sqlc.narg(source_message_id)::text,sqlc.narg(source_inbox_id)::text,
    sqlc.arg(status)::text,sqlc.narg(selection_result)::jsonb,
    sqlc.narg(steer_group_id)::text,sqlc.narg(local_run_id)::text,
    sqlc.narg(steer_outcome)::text
)
RETURNING input_sequence;

-- The returned state lets the Agent Service update its Context record without
-- reading it again.
-- name: ActivateAgentExecutionContextForInput :one
UPDATE agent_execution_contexts
SET next_input_sequence=greatest(next_input_sequence,sqlc.arg(input_sequence)::bigint),
    target_residency='active',
    state_revision=state_revision+1,updated_at=clock_timestamp()
WHERE context_key=sqlc.arg(context_key)::text
  AND terminal_reason IS NULL AND NOT task_archive_suspended
  AND (context_kind<>'alter_ego' OR EXISTS (
    SELECT 1 FROM work_items item WHERE item.id=agent_execution_contexts.task_id
      AND item.tenant_id=agent_execution_contexts.tenant_id AND item.archived_at IS NULL))
RETURNING state_revision,target_residency,next_input_sequence;

-- Document Comment enqueue must not wake the Agent until the comment
-- generation is active. Room/Meta use ActivateAgentExecutionContextForInput.
-- name: RecordAgentDocumentCommentContextInput :exec
UPDATE agent_execution_contexts
SET next_input_sequence=greatest(next_input_sequence,sqlc.arg(input_sequence)::bigint),
    state_revision=state_revision+1,updated_at=clock_timestamp()
WHERE context_key=sqlc.arg(context_key)::text
  AND context_kind='document';

-- name: RecordAgentExecutionContextClaimedRun :exec
-- A claim advances the Context revision and records the latest input the
-- Context has taken up.
UPDATE agent_execution_contexts
SET next_input_sequence=greatest(next_input_sequence,coalesce((
        SELECT max(input.input_sequence) FROM agent_local_run_inputs relation
        JOIN agent_runtime_inputs input ON input.context_key=relation.context_key AND input.input_id=relation.input_id
        WHERE relation.run_id=sqlc.arg(run_id)::text),0)),
    state_revision=state_revision+1,updated_at=clock_timestamp()
WHERE context_key=sqlc.arg(context_key)::text;

-- name: AgentContextHasInputBefore :one
SELECT EXISTS(
    SELECT 1 FROM agent_runtime_inputs
    WHERE context_key=sqlc.arg(context_key)::text AND input_sequence<sqlc.arg(input_sequence)::bigint
)::boolean;

-- name: BumpAgentExecutionContextStateRevision :one
UPDATE agent_execution_contexts
SET state_revision=state_revision+1,updated_at=clock_timestamp()
WHERE context_key=sqlc.arg(context_key)::text
RETURNING state_revision;

-- name: SuspendPerRoomMetaContextForMembershipRevocation :one
UPDATE agent_execution_contexts
SET target_residency='suspended',
    state_revision=state_revision+1,
    updated_at=clock_timestamp()
WHERE agent_actor_id=sqlc.arg(agent_actor_id)::text
  AND context_kind='meta'
  AND room_id=sqlc.arg(room_id)::text
  AND membership_epoch_id=sqlc.arg(membership_epoch_id)::text
RETURNING context_key;

-- name: TerminatePerRoomMetaContextForRoomDeletion :one
UPDATE agent_execution_contexts
SET target_residency='suspended',
    terminal_reason='room_deleted',
    terminated_at=clock_timestamp(),
    state_revision=state_revision+1,
    updated_at=clock_timestamp()
WHERE agent_actor_id=sqlc.arg(agent_actor_id)::text
  AND context_kind='meta'
  AND room_id=sqlc.arg(room_id)::text
  AND membership_epoch_id=sqlc.arg(membership_epoch_id)::text
  AND terminal_reason IS NULL
RETURNING context_key;

-- name: SuspendAlterEgoContextsForTaskTerminal :many
UPDATE agent_execution_contexts
SET target_residency='suspended',
    state_revision=state_revision+1,
    updated_at=clock_timestamp()
WHERE context_kind='alter_ego'
  AND task_id=sqlc.arg(task_id)::text
  AND target_residency='active'
RETURNING context_key;

-- name: SettleAgentContextInputsForTaskTerminal :execrows
UPDATE agent_runtime_inputs
SET status='handled',
    selection_result=jsonb_build_object(
        'selected','discard','reason','task_terminal'
    ),
    steer_outcome='uncertain',
    updated_at=clock_timestamp()
WHERE context_key=sqlc.arg(context_key)::text
  AND status='steering';

-- name: LockAgentRuntimeSteerInputs :many
SELECT *
FROM agent_runtime_inputs
WHERE context_key=sqlc.arg(context_key)::text
  AND steer_group_id=sqlc.arg(steer_group_id)::text
  AND status='steering'
ORDER BY input_sequence
FOR UPDATE;

-- name: ListAgentRuntimeSteeringInputs :many
SELECT *
FROM agent_runtime_inputs
WHERE context_key=sqlc.arg(context_key)::text
  AND status='steering'
ORDER BY input_sequence
FOR UPDATE;

-- name: AssignAgentRuntimeSteerInput :execrows
UPDATE agent_runtime_inputs
SET local_run_id=sqlc.arg(local_run_id)::text,
    updated_at=clock_timestamp()
WHERE context_key=sqlc.arg(context_key)::text
  AND input_id=sqlc.arg(input_id)::text
  AND status='steering'
  AND steer_group_id=sqlc.arg(steer_group_id)::text;

-- name: CompleteAgentRuntimeSteerInput :execrows
UPDATE agent_runtime_inputs
SET status='handled',selection_result=sqlc.arg(selection_result)::jsonb,
    steer_outcome=sqlc.narg(steer_outcome)::text,
    local_run_id=sqlc.arg(local_run_id)::text,
    updated_at=clock_timestamp()
WHERE context_key=sqlc.arg(context_key)::text
  AND input_id=sqlc.arg(input_id)::text
  AND status='steering'
  AND steer_group_id=sqlc.arg(steer_group_id)::text;

-- name: SettleUncertainAgentRuntimeSteerInput :execrows
UPDATE agent_runtime_inputs
SET status='handled',selection_result=sqlc.arg(selection_result)::jsonb,
    steer_outcome='uncertain',updated_at=clock_timestamp()
WHERE context_key=sqlc.arg(context_key)::text
  AND input_id=sqlc.arg(input_id)::text
  AND status='steering'
  AND steer_group_id=sqlc.arg(steer_group_id)::text;

-- name: DeleteAgentLocalRunInputByMessage :execrows
DELETE FROM agent_local_run_inputs
WHERE context_key=sqlc.arg(context_key)::text
  AND input_id=sqlc.arg(input_id)::text;

-- name: NextAgentLocalRunSteerOrdinal :one
SELECT COALESCE(max(ordinal)+1,0)::bigint
FROM agent_local_run_inputs
WHERE run_id=sqlc.arg(run_id)::text AND relation='steer';

-- name: InsertAgentLocalRunSteerInput :execrows
INSERT INTO agent_local_run_inputs(run_id,context_key,input_id,relation,ordinal)
VALUES(
    sqlc.arg(run_id)::text,sqlc.arg(context_key)::text,
    sqlc.arg(input_id)::text,'steer',sqlc.arg(ordinal)::bigint
)
ON CONFLICT(run_id,input_id) DO NOTHING;

-- name: CreateAgentLocalRun :one
INSERT INTO agent_local_runs(run_id,context_key,status)
VALUES(sqlc.arg(run_id)::text,sqlc.arg(context_key)::text,'queued')
RETURNING *;

-- name: InsertAgentLocalRunInput :exec
INSERT INTO agent_local_run_inputs(run_id,context_key,input_id,relation,ordinal)
VALUES(
    sqlc.arg(run_id)::text,sqlc.arg(context_key)::text,
    sqlc.arg(input_id)::text,sqlc.arg(relation)::text,sqlc.arg(ordinal)::bigint
);

-- name: GetAgentLocalRun :one
SELECT *
FROM agent_local_runs
WHERE context_key=sqlc.arg(context_key)::text
  AND run_id=sqlc.arg(run_id)::text;

-- name: ListAgentLocalRunInputs :many
SELECT input.*,
       relation.relation AS run_relation,relation.ordinal AS run_ordinal
FROM agent_local_run_inputs relation
JOIN agent_runtime_inputs input
  ON input.context_key=relation.context_key AND input.input_id=relation.input_id
WHERE relation.run_id=sqlc.arg(run_id)::text
ORDER BY relation.relation,relation.ordinal;

-- name: LockNextQueuedAgentLocalRun :one
SELECT run.*
FROM agent_local_runs run
WHERE run.context_key=sqlc.arg(context_key)::text AND run.status='queued'
  AND agent_document_run_claimable(run.run_id,run.context_key)
ORDER BY created_at,run_id
LIMIT 1
FOR UPDATE;

-- name: LockAgentLocalRunConfiguration :one
SELECT registration.status
FROM agent_registrations registration
JOIN agent_execution_contexts context
  ON context.agent_actor_id=registration.actor_id AND context.tenant_id=registration.tenant_id
WHERE context.context_key=$1
FOR SHARE OF registration;

-- name: RecordAgentLocalRunClaimProfileRevision :exec
UPDATE agent_local_runs SET claim_profile_revision=sqlc.arg(profile_revision)::bigint
WHERE run_id=sqlc.arg(run_id)::text;

-- name: GetRunningAgentLocalRun :one
SELECT * FROM agent_local_runs
WHERE context_key=sqlc.arg(context_key)::text AND status='running'
LIMIT 1;

-- name: AgentRuntimeContextHasQueuedRun :one
SELECT EXISTS(
    SELECT 1 FROM agent_local_runs run
    WHERE run.context_key=sqlc.arg(context_key)::text AND run.status='queued'
      AND agent_document_run_claimable(run.run_id,run.context_key)
)::boolean;

-- name: ClaimAgentLocalRun :one
UPDATE agent_local_runs
SET status='running',epoch=sqlc.arg(epoch)::text,claim_id=sqlc.arg(claim_id)::text,
    claim_configuration_revision=sqlc.arg(claim_configuration_revision)::bigint,
    attempt_count=attempt_count+1,
    started_at=clock_timestamp(),updated_at=clock_timestamp()
WHERE run_id=sqlc.arg(run_id)::text
  AND context_key=sqlc.arg(context_key)::text
  AND status='queued'
  AND agent_document_run_claimable(agent_local_runs.run_id,agent_local_runs.context_key)
RETURNING *;

-- name: RequeueAgentLocalRun :execrows
UPDATE agent_local_runs
SET status='queued',epoch=NULL,claim_id=NULL,claim_configuration_revision=NULL,
    started_at=NULL,updated_at=clock_timestamp()
WHERE run_id=sqlc.arg(run_id)::text
  AND context_key=sqlc.arg(context_key)::text
  AND status='running'
  AND epoch=sqlc.arg(epoch)::text;

-- name: TerminateAgentLocalRuns :many
UPDATE agent_local_runs
SET status=sqlc.arg(status)::text,terminal=sqlc.arg(terminal)::jsonb,
    finished_at=clock_timestamp(),updated_at=clock_timestamp()
WHERE run_id=ANY(sqlc.arg(run_ids)::text[])
  AND status IN ('queued','running')
RETURNING run_id,context_key;

-- name: AgentRuntimeContextHasPendingWork :one
SELECT EXISTS(
    SELECT 1 FROM agent_runtime_inputs
    WHERE context_key=sqlc.arg(context_key)::text AND status='steering'
    UNION ALL
    SELECT 1 FROM agent_local_runs
    WHERE context_key=sqlc.arg(context_key)::text AND status IN ('queued','running')
)::boolean;

-- name: GetAgentRuntimeSession :one
SELECT context_key, session, session_provider_kind, session_schema_version,
    session_thread_id, session_configuration_revision, session_profile_revision,
    session_revision, session_updated_at
FROM agent_execution_contexts
WHERE context_key=sqlc.arg(context_key)::text AND session IS NOT NULL;

-- name: AdvanceAgentRuntimeSessionProfileRevision :execrows
-- A claim hands the Session a newer profile once.
UPDATE agent_execution_contexts
SET session_profile_revision=sqlc.arg(profile_revision)::bigint,updated_at=clock_timestamp()
WHERE context_key=sqlc.arg(context_key)::text
  AND session IS NOT NULL
  AND session_profile_revision<sqlc.arg(profile_revision)::bigint;

-- name: DeleteAgentRuntimeSessionAtConfigurationRevision :execrows
UPDATE agent_execution_contexts
SET session=NULL,session_provider_kind=NULL,session_schema_version=NULL,
    session_thread_id=NULL,session_configuration_revision=NULL,
    session_profile_revision=NULL,session_revision=0,session_updated_at=NULL,
    updated_at=clock_timestamp()
WHERE context_key=sqlc.arg(context_key)::text
  AND session IS NOT NULL
  AND session_configuration_revision=sqlc.arg(configuration_revision)::bigint;

-- name: CheckpointAgentRuntimeSession :one
UPDATE agent_execution_contexts
SET session=sqlc.arg(session)::jsonb,
    session_provider_kind=sqlc.arg(provider_kind)::text,
    session_schema_version=sqlc.arg(session_schema_version)::bigint,
    -- A new native thread starts under the profile it was checkpointed with.
    session_profile_revision=CASE
        WHEN session IS NULL OR sqlc.narg(thread_id)::text IS DISTINCT FROM session_thread_id
        THEN sqlc.arg(configuration_revision)::bigint ELSE session_profile_revision END,
    session_thread_id=sqlc.narg(thread_id)::text,
    session_configuration_revision=sqlc.arg(configuration_revision)::bigint,
    session_revision=session_revision+1,
    session_updated_at=clock_timestamp(),
    updated_at=clock_timestamp()
WHERE context_key=sqlc.arg(context_key)::text
  AND session_revision=sqlc.arg(expected_session_revision)::bigint
RETURNING context_key, session, session_provider_kind, session_schema_version,
    session_thread_id, session_configuration_revision, session_profile_revision,
    session_revision, session_updated_at;

-- name: ListPublishedAgentRuntimePresentationEvents :many
SELECT *
FROM agent_runtime_status_events
WHERE local_run_id=sqlc.arg(local_run_id)::text
  AND event_ordinal>sqlc.arg(after_ordinal)::bigint
  AND event_ordinal<=sqlc.arg(published_through_ordinal)::bigint
ORDER BY event_ordinal
LIMIT sqlc.arg(result_limit)::integer;

-- name: ListPublishedRuntimeActivityIDs :many
SELECT event.event_ordinal,event.activity_id::text AS activity_id
FROM agent_runtime_status_events event
WHERE event.local_run_id=sqlc.arg(local_run_id)::text
  AND event.event_ordinal>sqlc.arg(after_ordinal)::bigint
  AND event.event_ordinal<=sqlc.arg(published_through_ordinal)::bigint
  AND event.activity_id IS NOT NULL
ORDER BY event.event_ordinal
LIMIT sqlc.arg(result_limit)::integer;

-- name: ListAgentRuntimeNativeOperationIDs :many
SELECT operation.operation_id::text AS operation_id
FROM agent_local_runs run
CROSS JOIN LATERAL jsonb_object_keys(coalesce(run.usage,'{}'::jsonb)) AS operation(operation_id)
WHERE run.run_id=sqlc.arg(local_run_id)::text
ORDER BY operation.operation_id;

-- name: GetAgentRuntimeTaskInboxRoom :one
SELECT link.room_id
FROM work_items item
JOIN work_item_room_links link
  ON link.work_item_id=item.id
 AND link.tenant_id=item.tenant_id
 AND link.link_type='work'
WHERE item.id=sqlc.arg(task_id)::text
  AND item.tenant_id=sqlc.arg(tenant_id)::text
  AND item.kind='task'
  AND item.archived_at IS NULL
  AND (
      EXISTS (
          SELECT 1 FROM work_item_assignments assignment
          WHERE assignment.work_item_id=item.id
            AND assignment.tenant_id=item.tenant_id
            AND assignment.actor_id=sqlc.arg(agent_actor_id)::text
      )
      OR EXISTS (
          SELECT 1 FROM task_execution_participants participant
          WHERE participant.task_id=item.id
            AND participant.tenant_id=item.tenant_id
            AND participant.actor_id=sqlc.arg(agent_actor_id)::text
      )
      OR EXISTS (
          SELECT 1
          FROM room_members membership
          WHERE membership.tenant_id=item.tenant_id
            AND membership.room_id=link.room_id
            AND membership.actor_id=sqlc.arg(agent_actor_id)::text
      )
  );

-- name: GetAgentRuntimeThreadInboxParentRoom :one
SELECT thread.parent_room_id::text AS parent_room_id
FROM rooms thread
JOIN active_room_members membership
  ON membership.room_id=thread.parent_room_id
 AND membership.tenant_id=thread.tenant_id
JOIN actors actor
  ON actor.id=membership.actor_id
 AND actor.tenant_id=thread.tenant_id
WHERE thread.id=sqlc.arg(thread_id)::text
  AND thread.tenant_id=sqlc.arg(tenant_id)::text
  AND thread.parent_room_id IS NOT NULL
  AND thread.deletion_started_at IS NULL
  AND thread.deleted_at IS NULL
  AND membership.actor_id=sqlc.arg(agent_actor_id)::text
  AND actor.kind='agent'
  AND (
      EXISTS (
          SELECT 1
          FROM messages root
          WHERE root.id=thread.root_message_id
            AND root.room_id=thread.parent_room_id
            AND root.tenant_id=thread.tenant_id
            AND root.author_actor_id=membership.actor_id
      ) OR EXISTS (
          SELECT 1
          FROM thread_room_list_actors listed
          WHERE listed.thread_room_id=thread.id
            AND listed.actor_id=membership.actor_id
            AND listed.tenant_id=thread.tenant_id
      )
  );

-- name: InsertAgentRuntimePresentationEvent :one
INSERT INTO agent_runtime_status_events(
    local_run_id,event_ordinal,segment_id,command_id,event_type,payload,
    invocation_id,outcome,message_id,activity_id
) VALUES(
    sqlc.arg(local_run_id)::text,sqlc.arg(event_ordinal)::bigint,
    sqlc.arg(segment_id)::text,sqlc.arg(command_id)::text,sqlc.arg(event_type)::text,
    sqlc.arg(payload)::jsonb,sqlc.narg(invocation_id)::text,
    sqlc.narg(outcome)::text,sqlc.narg(message_id)::text,
    sqlc.narg(activity_id)::text
)
RETURNING *;

-- name: GetAgentRuntimePresentationEventByCommand :one
SELECT *
FROM agent_runtime_status_events
WHERE command_id=sqlc.arg(command_id)::text;

-- name: GetAgentRuntimePresentationOutputEvent :one
SELECT *
FROM agent_runtime_status_events
WHERE local_run_id=sqlc.arg(local_run_id)::text
  AND event_type='presentation.output_created'
  AND payload->>'output_id'=sqlc.arg(output_id)::text;

-- name: GetLatestAgentRuntimeActivityEvent :one
SELECT event_type,outcome
FROM agent_runtime_status_events
WHERE local_run_id=sqlc.arg(local_run_id)::text
  AND activity_id=sqlc.arg(activity_id)::text
ORDER BY event_ordinal DESC
LIMIT 1;

-- name: ListAgentRuntimeLocalComputers :many
SELECT *
FROM local_computers
WHERE status<>'removed'
ORDER BY display_name,computer_id;

-- name: ListAgentRunnerPlacementsOnComputer :many
-- The Agent Runners a Computer should hold: every active Agent its owner placed on it.
SELECT COALESCE(registration.agent_management_id,'')::text AS agent_management_id,
       registration.actor_id,registration.tenant_id,registration.created_by_actor_id,
       COALESCE(registration.local_runtime_type,'')::text AS local_runtime_type,
       registration.runtime_model,registration.runtime_reasoning_effort,
       COALESCE(registration.workspace_grant_id,'')::text AS workspace_grant_id,
       registration.assignment_revision
FROM agent_registrations registration
JOIN local_computers computer ON computer.computer_id=registration.computer_id
  AND computer.owner_tenant_id=registration.tenant_id
  AND computer.owner_actor_id=registration.created_by_actor_id
WHERE registration.computer_id=sqlc.arg(computer_id)::text
  AND registration.status='active'
ORDER BY registration.agent_management_id;

-- name: ListOwnedLocalComputers :many
SELECT *
FROM local_computers
WHERE owner_tenant_id=sqlc.arg(tenant_id)::text
  AND owner_actor_id=sqlc.arg(owner_actor_id)::text
  AND status<>'removed'
ORDER BY computer_id;

-- name: GetAgentRuntimeLocalComputer :one
SELECT *
FROM local_computers
WHERE computer_id=sqlc.arg(computer_id)::text;

-- name: LockAgentRuntimeLocalComputer :one
SELECT *
FROM local_computers
WHERE computer_id=sqlc.arg(computer_id)::text
FOR UPDATE;

-- name: InsertAgentRuntimeLocalComputer :one
INSERT INTO local_computers(
    computer_id,display_name,status,capacity,owner_tenant_id,owner_actor_id
) VALUES(
    sqlc.arg(computer_id)::text,sqlc.arg(display_name)::text,'offline',1,
    sqlc.arg(owner_tenant_id)::text,sqlc.arg(owner_actor_id)::text
)
RETURNING *;

-- name: RotateAgentRuntimeLocalComputerCredential :one
UPDATE local_computers
SET display_name=sqlc.arg(display_name)::text,
    credential_generation=credential_generation+1,
    status='offline',updated_at=clock_timestamp()
WHERE computer_id=sqlc.arg(computer_id)::text
  AND status<>'removed'
  AND credential_generation<9007199254740991
RETURNING *;

-- name: ObserveAgentRuntimeLocalComputer :one
UPDATE local_computers
SET display_name=sqlc.arg(display_name)::text,
    status=sqlc.arg(status)::text,
    capacity=sqlc.narg(capacity)::integer,
    platform=COALESCE(sqlc.narg(platform)::text,platform),
    runtime_inventory=sqlc.arg(runtime_inventory)::jsonb,
    runtime_diagnostics=sqlc.arg(runtime_diagnostics)::jsonb,
    workspace_grants=sqlc.arg(workspace_grants)::jsonb,
    daemon_version=COALESCE(sqlc.narg(daemon_version)::text,daemon_version),
    recommended_version=COALESCE(sqlc.narg(recommended_version)::text,recommended_version),
    last_seen_at=sqlc.arg(last_seen_at)::timestamptz,
    updated_at=clock_timestamp()
WHERE computer_id=sqlc.arg(computer_id)::text AND status<>'removed'
RETURNING *;

-- name: TouchAgentRuntimeLocalComputer :one
UPDATE local_computers
SET status=sqlc.arg(status)::text,
    runtime_inventory=COALESCE(sqlc.narg(runtime_inventory)::jsonb,runtime_inventory),
    runtime_diagnostics=COALESCE(sqlc.narg(runtime_diagnostics)::jsonb,runtime_diagnostics),
    daemon_version=COALESCE(sqlc.narg(daemon_version)::text,daemon_version),
    recommended_version=COALESCE(sqlc.narg(recommended_version)::text,recommended_version),
    active_operations=CASE WHEN sqlc.arg(status)::text='online'
        THEN COALESCE(sqlc.narg(active_operations)::integer,active_operations) ELSE 0 END,
    last_seen_at=sqlc.arg(last_seen_at)::timestamptz,
    updated_at=clock_timestamp()
WHERE computer_id=sqlc.arg(computer_id)::text AND status<>'removed'
RETURNING *;

-- name: MarkAgentRuntimeLocalComputersOffline :many
UPDATE local_computers
SET status='offline',active_operations=0,updated_at=clock_timestamp()
WHERE status IN ('online','upgrade_required')
RETURNING *;

-- name: RemoveAgentRuntimeLocalComputer :one
-- A Daemon keeps its identity key across pairings, so the removed Computer
-- frees its Daemon Identity for the next Computer that machine pairs as.
UPDATE local_computers
SET status='removed',removed_at=clock_timestamp(),updated_at=clock_timestamp(),
    daemon_id=NULL,daemon_public_key=NULL
WHERE computer_id=sqlc.arg(computer_id)::text AND status<>'removed'
RETURNING *;

-- name: PurgeAgentRuntimeLocalComputerEnrollmentsByComputer :exec
DELETE FROM local_computer_enrollments
WHERE requested_computer_id=sqlc.arg(computer_id)::text;

-- name: BindAgentRuntimeLocalComputerDaemonIdentity :one
UPDATE local_computers
SET daemon_id=sqlc.arg(daemon_id)::text,
    daemon_public_key=sqlc.arg(daemon_public_key)::bytea,
    daemon_identity_version=sqlc.arg(identity_version)::bigint,
    updated_at=clock_timestamp()
WHERE computer_id=sqlc.arg(computer_id)::text
  AND status<>'removed'
  AND (
      daemon_id IS NULL
      OR (
          daemon_id=sqlc.arg(daemon_id)::text
          AND daemon_public_key=sqlc.arg(daemon_public_key)::bytea
          AND daemon_identity_version=sqlc.arg(identity_version)::bigint
      )
  )
RETURNING *;

-- name: DeletePendingAgentRuntimeLocalComputerEnrollments :exec
DELETE FROM local_computer_enrollments
WHERE tenant_id=sqlc.arg(tenant_id)::text
  AND owner_actor_id=sqlc.arg(owner_actor_id)::text
  AND exchanged_at IS NULL;

-- name: InsertAgentRuntimeLocalComputerEnrollment :one
INSERT INTO local_computer_enrollments(
    enrollment_id,tenant_id,owner_actor_id,requested_computer_id,
    renews_existing_computer,display_name,redirect_uri,code_challenge,
    authorization_code_hash,expires_at
) VALUES(
    sqlc.arg(enrollment_id)::text,sqlc.arg(tenant_id)::text,
    sqlc.arg(owner_actor_id)::text,sqlc.arg(computer_id)::text,
    sqlc.arg(renews_existing_computer)::boolean,sqlc.arg(display_name)::text,
    sqlc.arg(redirect_uri)::text,sqlc.arg(code_challenge)::text,
    sqlc.arg(authorization_code_hash)::bytea,sqlc.arg(expires_at)::timestamptz
)
RETURNING *;

-- name: LockAgentRuntimeLocalComputerEnrollment :one
SELECT *
FROM local_computer_enrollments
WHERE enrollment_id=sqlc.arg(enrollment_id)::text
FOR UPDATE;

-- name: DeleteAgentRuntimeLocalComputerEnrollment :exec
DELETE FROM local_computer_enrollments
WHERE enrollment_id=sqlc.arg(enrollment_id)::text;

-- name: ConsumeAgentRuntimeLocalComputerEnrollment :one
UPDATE local_computer_enrollments
SET exchanged_at=clock_timestamp(),
    exchanged_generation=sqlc.arg(exchanged_generation)::bigint
WHERE enrollment_id=sqlc.arg(enrollment_id)::text
  AND exchanged_at IS NULL
RETURNING *;

-- name: RequestAgentLocalRunCancellation :exec
UPDATE agent_local_runs SET cancellation_requested=true,updated_at=clock_timestamp()
WHERE context_key=sqlc.arg(context_key)::text AND run_id=sqlc.arg(run_id)::text AND status='running';

-- name: ListUnconfirmedAgentRuntimeRunInputs :many
SELECT input_id FROM agent_runtime_inputs
WHERE local_run_id=sqlc.arg(local_run_id)::text AND steer_outcome='uncertain'
ORDER BY input_sequence;

-- name: GetAgentLocalRunContextKey :one
SELECT context_key FROM agent_local_runs WHERE run_id=sqlc.arg(run_id)::text;

-- name: RedeliverAgentRuntimeInput :one
-- An empty input ID means the input was not placed again.
SELECT coalesce(redeliver_agent_runtime_input(sqlc.arg(context_key)::text,sqlc.arg(input_id)::text),'')::text AS input_id;

-- name: ListRecentlyUsedAgentExecutionContexts :many
-- Restart restore candidates. An active registration always runs on a Local
-- Computer (agent_registrations_placement_check), the same predicate as
-- ListPresencePreparableContextKeys, so the limit is not spent on Contexts the
-- Agent Service would discard.
SELECT context.context_key
FROM agent_execution_contexts context
JOIN agent_registrations registration ON registration.agent_management_id=context.agent_management_id
    AND registration.status='active'
CROSS JOIN LATERAL (
    SELECT run.created_at FROM agent_local_runs run
    WHERE run.context_key=context.context_key
    ORDER BY run.created_at DESC, run.run_id DESC
    LIMIT 1
) last
WHERE context.terminal_reason IS NULL
  AND last.created_at > clock_timestamp() - make_interval(secs => sqlc.arg(window_seconds)::integer)
  -- A Room-bound Context whose Agent has left that Room, or was readmitted, is not active.
  AND (context.room_id IS NULL OR EXISTS(SELECT 1 FROM active_room_members membership
    WHERE membership.tenant_id=context.tenant_id AND membership.actor_id=context.agent_actor_id
      AND membership.room_id=context.room_id AND membership.membership_epoch_id=context.membership_epoch_id))
ORDER BY last.created_at DESC, context.context_key
LIMIT sqlc.arg(row_limit)::integer;

-- name: IsAgentContextInboxAuthorized :one
SELECT agent_context_can_receive_inbox(sqlc.arg(context_key)::text,sqlc.arg(inbox_id)::text)::boolean;

-- name: SuspendAlterEgoContextsForTaskArchive :many
UPDATE agent_execution_contexts
SET task_archive_suspended=(target_residency='active' OR task_archive_suspended),
    target_residency='suspended',
    state_revision=state_revision+1, updated_at=clock_timestamp()
WHERE context_kind='alter_ego' AND task_id=sqlc.arg(task_id)::text
  AND terminal_reason IS NULL
RETURNING context_key;

-- name: RestoreAlterEgoContextsAfterTaskArchive :many
UPDATE agent_execution_contexts context
SET target_residency='active', task_archive_suspended=false,
    state_revision=state_revision+1, updated_at=clock_timestamp()
WHERE context.task_id=sqlc.arg(task_id)::text AND context.context_kind='alter_ego'
  AND context.task_archive_suspended AND context.target_residency='suspended'
  AND context.terminal_reason IS NULL
  AND EXISTS (
    SELECT 1 FROM work_items item
    JOIN task_execution_generations generation ON generation.task_id=item.id
      AND generation.tenant_id=item.tenant_id AND generation.generation=item.task_execution_generation
      AND generation.terminal_at IS NULL
    JOIN task_execution_participants participant ON participant.task_id=item.id
      AND participant.tenant_id=item.tenant_id AND participant.generation=item.task_execution_generation
      AND participant.actor_id=context.agent_actor_id AND participant.agent_management_id=context.agent_management_id
    JOIN agent_registrations registration ON registration.actor_id=context.agent_actor_id
      AND registration.tenant_id=context.tenant_id AND registration.agent_management_id=context.agent_management_id
      AND registration.status='active'
    LEFT JOIN work_item_room_links link ON link.work_item_id=item.id AND link.tenant_id=item.tenant_id AND link.link_type='work'
    LEFT JOIN rooms room ON room.id=link.room_id AND room.tenant_id=link.tenant_id
      AND room.deleted_at IS NULL AND room.deletion_started_at IS NULL
    WHERE item.id=context.task_id AND item.tenant_id=context.tenant_id AND item.archived_at IS NULL
      AND item.state<>'resolved'
      AND (link.room_id IS NULL OR room.id IS NOT NULL)
  )
RETURNING context.context_key;

-- name: SettleAgentContextInputsForTaskArchive :execrows
UPDATE agent_runtime_inputs
SET status='handled',selection_result=jsonb_build_object('selected','discard','reason','task_archived'),
    steer_outcome='uncertain',
    updated_at=clock_timestamp()
WHERE context_key=sqlc.arg(context_key)::text AND status='steering';

-- name: ListTaskCoordinatorContextKeys :many
-- Shared Task directories key on the frozen coordinator of the current
-- generation; one batched read serves a Context list.
SELECT item.id AS task_id, item.tenant_id, generation.coordinator_context_key
FROM work_items item
JOIN task_execution_generations generation
  ON generation.task_id=item.id AND generation.tenant_id=item.tenant_id
 AND generation.generation=item.task_execution_generation
WHERE item.id = ANY(sqlc.arg(task_ids)::text[])
  AND generation.coordinator_context_key IS NOT NULL;

-- name: ListAgentContextMessageSteers :many
-- Steers TeamHub queued from Messages for this Context that the Agent
-- Service has not settled yet, in input order.
SELECT * FROM agent_runtime_inputs
WHERE context_key=sqlc.arg(context_key)::text AND status='steering'
  AND selection_result->>'selected' IN ('trusted_inbox_notification','runtime_response')
ORDER BY input_sequence;

-- name: LockAgentServiceEpoch :one
-- Every Runtime write holds the current epoch for its transaction, so a new
-- process start waits for it and then interrupts what it claimed.
SELECT epoch FROM agent_service_epochs
WHERE epoch=sqlc.arg(epoch)::text
FOR KEY SHARE;

-- name: ReplaceAgentServiceEpoch :exec
-- Waits for every Runtime write of the previous epoch to commit.
DELETE FROM agent_service_epochs;

-- name: InsertAgentServiceEpoch :exec
INSERT INTO agent_service_epochs(epoch) VALUES(sqlc.arg(epoch)::text);

-- name: LockAgentContextsForEpochStart :many
-- Contexts holding a Run of an earlier epoch or an unsettled steer, in
-- context_key order, before their Runs.
SELECT context.context_key
FROM agent_execution_contexts context
WHERE EXISTS (
    SELECT 1 FROM agent_local_runs run
    WHERE run.context_key=context.context_key AND run.status='running'
      AND run.epoch IS DISTINCT FROM sqlc.arg(epoch)::text
) OR EXISTS (
    SELECT 1 FROM agent_runtime_inputs input
    WHERE input.context_key=context.context_key AND input.status='steering'
)
ORDER BY context.context_key
FOR NO KEY UPDATE;

-- name: ListAgentContextRunsOfEarlierEpoch :many
SELECT run_id FROM agent_local_runs
WHERE context_key=sqlc.arg(context_key)::text AND status='running'
  AND epoch IS DISTINCT FROM sqlc.arg(epoch)::text
ORDER BY run_id;

-- name: ListAgentContextsWithQueuedWork :many
-- Contexts a newly started process takes up at once: queued Runs and Message
-- steers, however recent.
SELECT DISTINCT waiting.context_key::text AS context_key
FROM (
    SELECT run.context_key FROM agent_local_runs run WHERE run.status='queued'
    UNION ALL
    SELECT input.context_key FROM agent_runtime_inputs input
    WHERE input.status='steering'
      AND input.selection_result->>'selected' IN ('trusted_inbox_notification','runtime_response')
) waiting
JOIN agent_execution_contexts context ON context.context_key=waiting.context_key AND context.terminal_reason IS NULL
ORDER BY 1
LIMIT 1000;

-- name: GetAgentSteerGroupRun :one
-- The Run a settled steer group became or joined.
SELECT local_run_id::text FROM agent_runtime_inputs
WHERE context_key=sqlc.arg(context_key)::text
  AND steer_group_id=sqlc.arg(steer_group_id)::text
  AND status='handled' AND local_run_id IS NOT NULL
ORDER BY input_sequence
LIMIT 1;

-- name: ExpireRunNativeQuestions :many
UPDATE decisions SET status='expired',finished_at=clock_timestamp()
WHERE request->'runtime'->>'execution_run_ref'=sqlc.arg(run_id)::text
  AND request ? 'runtime' AND status='pending'
  AND request->'runtime'->>'kind'='native_question'
RETURNING message_id;

-- name: GetAgentRunStatus :one
-- A Run with a status Room, with the Context facts its events and its
-- agent_run.status_changed Room Event need.
SELECT run.run_id,run.context_key,run.status,run.status_room_id::text AS status_room_id,
       run.created_at,run.updated_at,
       context.tenant_id,context.agent_actor_id,context.task_id,
       actor.kind AS agent_kind,actor.display_name AS agent_display_name,
       coalesce((SELECT max(event.event_ordinal) FROM agent_runtime_status_events event
                 WHERE event.local_run_id=run.run_id),0)::bigint AS event_ordinal,
       COALESCE(CASE WHEN run.status='canceled' THEN left(run.terminal->>'reason',1000) END,'')::text AS stop_reason,
       agent_local_run_replied(run.run_id)::boolean AS replied
FROM agent_local_runs run
JOIN agent_execution_contexts context ON context.context_key=run.context_key
JOIN actors actor ON actor.id=context.agent_actor_id AND actor.tenant_id=context.tenant_id
WHERE run.run_id=sqlc.arg(run_id)::text AND run.status_room_id IS NOT NULL;

-- name: SetAgentRunStatusRoom :execrows
UPDATE agent_local_runs
SET status_room_id=sqlc.arg(room_id)::text
WHERE run_id=sqlc.arg(run_id)::text AND status_room_id IS NULL;

-- name: LockAgentRunStatusRoom :one
-- Every writer of a Run's events holds its status Room row, so event ordinals
-- and the Room Events announcing them are allocated in one order.
SELECT (deletion_started_at IS NULL AND deleted_at IS NULL)::boolean AS publishable
FROM rooms
WHERE id=sqlc.arg(room_id)::text
FOR NO KEY UPDATE;

-- name: GetAgentRunStatusTail :one
-- The last event of a Run: its ordinal and the segment it belongs to. An
-- output or the stopped event closes its segment.
SELECT event_ordinal,segment_id,
       (event_type='presentation.output_created'
        OR (event_type='status.changed' AND payload->>'status'='stopped'))::boolean AS closes_segment
FROM agent_runtime_status_events
WHERE local_run_id=sqlc.arg(local_run_id)::text
ORDER BY event_ordinal DESC
LIMIT 1;

-- name: CountAgentRunStatusSegments :one
SELECT count(DISTINCT segment_id)::bigint
FROM agent_runtime_status_events
WHERE local_run_id=sqlc.arg(local_run_id)::text;

-- name: ListVisibleRoomRunStatusesForAccount :many
-- Unfinished Runs shown in the Room, and failed or canceled ones for a day
-- until the same Agent has a newer Run there. Succeeded Runs leave.
SELECT run.run_id,run.status,run.created_at,run.updated_at,
       context.agent_actor_id,actor.kind AS agent_kind,actor.display_name AS agent_display_name,
       coalesce((SELECT max(event.event_ordinal) FROM agent_runtime_status_events event
                 WHERE event.local_run_id=run.run_id),0)::bigint AS event_ordinal,
       COALESCE(CASE WHEN run.status='canceled' THEN left(run.terminal->>'reason',1000) END,'')::text AS stop_reason,
       agent_local_run_replied(run.run_id)::boolean AS replied
FROM rooms room
JOIN actors caller ON caller.tenant_id=room.tenant_id
 AND caller.account_id=sqlc.arg(account_id)::text AND caller.kind='human'
JOIN active_room_members membership
  ON membership.room_id=collaboration_membership_room_id(room.id) AND membership.actor_id=caller.id
 AND room_actor_participating(room.id,caller.id)
JOIN agent_local_runs run ON run.status_room_id=room.id
JOIN agent_execution_contexts context ON context.context_key=run.context_key AND context.tenant_id=room.tenant_id
JOIN actors actor ON actor.id=context.agent_actor_id AND actor.tenant_id=context.tenant_id
WHERE room.id=sqlc.arg(room_id)::text
  AND (run.status IN ('queued','running')
    OR (run.status IN ('failed','canceled')
      AND run.finished_at>clock_timestamp()-interval '24 hours'
      AND NOT EXISTS (
        SELECT 1 FROM agent_local_runs newer
        JOIN agent_execution_contexts newer_context ON newer_context.context_key=newer.context_key
        WHERE newer.status_room_id=run.status_room_id
          AND newer_context.agent_actor_id=context.agent_actor_id
          AND (newer.created_at,newer.run_id)>(run.created_at,run.run_id))))
ORDER BY run.created_at,run.run_id;

-- name: GetRoomRunStatusForAccount :one
SELECT run.run_id,run.context_key,run.status,run.created_at,run.updated_at,
       context.tenant_id,context.agent_actor_id,context.task_id,
       actor.kind AS agent_kind,actor.display_name AS agent_display_name,
       coalesce((SELECT max(event.event_ordinal) FROM agent_runtime_status_events event
                 WHERE event.local_run_id=run.run_id),0)::bigint AS event_ordinal,
       COALESCE(CASE WHEN run.status='canceled' THEN left(run.terminal->>'reason',1000) END,'')::text AS stop_reason,
       agent_local_run_replied(run.run_id)::boolean AS replied
FROM rooms room
JOIN actors caller ON caller.tenant_id=room.tenant_id
 AND caller.account_id=sqlc.arg(account_id)::text AND caller.kind='human'
JOIN active_room_members membership
  ON membership.room_id=collaboration_membership_room_id(room.id) AND membership.actor_id=caller.id
 AND room_actor_participating(room.id,caller.id)
JOIN agent_local_runs run ON run.status_room_id=room.id
JOIN agent_execution_contexts context ON context.context_key=run.context_key AND context.tenant_id=room.tenant_id
JOIN actors actor ON actor.id=context.agent_actor_id AND actor.tenant_id=context.tenant_id
WHERE room.id=sqlc.arg(room_id)::text AND run.run_id=sqlc.arg(run_id)::text;

-- name: ListRuntimePresentationRunsForAccountByRoom :many
-- At most 100 Runs shown in the Room: unfinished ones first, then finished
-- ones whose sources or published Messages are among the given Messages.
-- With a Run ID, only that Run in any state.
WITH latest AS (
  SELECT run.run_id,run.status,run.created_at,run.updated_at,
         context.tenant_id,context.agent_actor_id,
         COALESCE(CASE WHEN run.status='canceled' THEN left(run.terminal->>'reason',1000) END,'')::text AS stop_reason
  FROM rooms room
  JOIN actors caller ON caller.tenant_id=room.tenant_id
   AND caller.account_id=sqlc.arg(account_id)::text AND caller.kind='human'
  JOIN active_room_members membership
    ON membership.room_id=collaboration_membership_room_id(room.id) AND membership.actor_id=caller.id
   AND room_actor_participating(room.id,caller.id)
  JOIN agent_local_runs run ON run.status_room_id=room.id
  JOIN agent_execution_contexts context ON context.context_key=run.context_key AND context.tenant_id=room.tenant_id
  WHERE room.id=sqlc.arg(room_id)::text
    AND (sqlc.arg(run_id)::text='' OR run.run_id=sqlc.arg(run_id)::text)
    AND (
      sqlc.arg(run_id)::text<>''
      OR run.status IN ('queued','running')
      OR EXISTS (
        SELECT 1 FROM agent_local_run_inputs relation
        JOIN agent_runtime_inputs input
          ON input.context_key=relation.context_key AND input.input_id=relation.input_id
        JOIN messages source
          ON (source.id=input.source_message_id
              OR (input.source_kind='inbox' AND (input.payload->'invocationMessageIds') ? source.id))
         AND source.room_id=room.id
         AND source.tenant_id=room.tenant_id
        WHERE relation.run_id=run.run_id
          AND source.id=ANY(sqlc.arg(message_ids)::text[])
      )
      OR EXISTS (
        SELECT 1
        FROM messages message
        WHERE message.local_run_id=run.run_id
          AND message.tenant_id=room.tenant_id
          AND message.room_id=room.id
          AND message.author_actor_id=context.agent_actor_id
          AND message.id=ANY(sqlc.arg(message_ids)::text[])
      )
    )
  ORDER BY (run.status IN ('queued','running')) DESC,run.created_at DESC,run.run_id DESC
  LIMIT 100
)
SELECT latest.run_id,latest.status,latest.created_at,latest.updated_at,latest.agent_actor_id,latest.stop_reason,
       actor.kind AS agent_kind,actor.display_name AS agent_display_name,
       coalesce((SELECT max(event.event_ordinal) FROM agent_runtime_status_events event
                 WHERE event.local_run_id=latest.run_id),0)::bigint AS event_ordinal,
       agent_local_run_replied(latest.run_id)::boolean AS replied
FROM latest
JOIN actors actor ON actor.id=latest.agent_actor_id AND actor.tenant_id=latest.tenant_id
ORDER BY latest.created_at,latest.run_id;

-- name: GetAgentRunStatusForMessage :one
SELECT run.run_id,run.context_key,context.tenant_id,context.agent_actor_id,context.task_id,
       coalesce((SELECT max(event.event_ordinal) FROM agent_runtime_status_events event
                 WHERE event.local_run_id=run.run_id),0)::bigint AS event_ordinal
FROM messages message
JOIN agent_local_runs run ON run.run_id=message.local_run_id AND run.status_room_id IS NOT NULL
JOIN agent_execution_contexts context ON context.context_key=run.context_key
WHERE message.id=sqlc.arg(message_id)::text
  AND message.room_id=sqlc.arg(room_id)::text
  AND message.tenant_id=context.tenant_id
  AND message.author_actor_id=context.agent_actor_id;
