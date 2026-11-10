-- name: ClaimTaskExecutionForWorker :one
WITH candidate AS (
  SELECT id
  FROM work_items
  WHERE task_execution_generation IS NOT NULL
    AND (
      task_execution_status='running'
      OR (
        task_execution_status<>'running'
        AND EXISTS (
          SELECT 1
          FROM task_effects effect
          WHERE effect.task_id=work_items.id
            AND effect.generation=work_items.task_execution_generation
            AND effect.operation='cleanup_runtime'
            AND (
              effect.status='pending'
              OR (effect.status='dispatching' AND effect.lease_expires_at<=clock_timestamp())
            )
        )
      )
    )
    AND task_next_reconcile_at<=clock_timestamp()
    AND (task_lease_expires_at IS NULL OR task_lease_expires_at<=clock_timestamp())
  ORDER BY task_next_reconcile_at,id
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE work_items item
SET task_worker_id=sqlc.arg(worker_id)::text,
    task_lease_token_hash=sqlc.arg(lease_token_hash)::bytea,
    task_lease_generation=task_lease_generation+1,
    task_lease_expires_at=clock_timestamp()+make_interval(secs=>sqlc.arg(lease_seconds)::int),
    task_next_reconcile_at=clock_timestamp()+make_interval(secs=>sqlc.arg(lease_seconds)::int)
FROM candidate
WHERE item.id=candidate.id
RETURNING item.id AS task_id,item.task_worker_id,item.task_lease_generation,item.task_lease_expires_at;

-- name: NextTaskExecutionClaimDelay :one
-- Milliseconds on the database clock until the earliest Task satisfies the
-- ClaimTaskExecutionForWorker predicate; no row when no Task can become
-- claimable without another commit.
SELECT ceil(GREATEST(0, EXTRACT(EPOCH FROM (min(ready.ready_at)-clock_timestamp()))*1000))::bigint AS delay_ms
FROM (
  SELECT GREATEST(
           item.task_next_reconcile_at,
           COALESCE(item.task_lease_expires_at,'-infinity'::timestamptz),
           CASE WHEN item.task_execution_status='running' THEN '-infinity'::timestamptz ELSE cleanup.ready_at END
         ) AS ready_at
  FROM work_items item
  LEFT JOIN LATERAL (
    SELECT min(CASE WHEN effect.status='pending' THEN '-infinity'::timestamptz ELSE effect.lease_expires_at END) AS ready_at
    FROM task_effects effect
    WHERE effect.task_id=item.id
      AND effect.generation=item.task_execution_generation
      AND effect.operation='cleanup_runtime'
      AND (effect.status='pending' OR (effect.status='dispatching' AND effect.lease_expires_at IS NOT NULL))
  ) cleanup ON true
  WHERE item.task_execution_generation IS NOT NULL
    AND (item.task_execution_status='running' OR cleanup.ready_at IS NOT NULL)
) ready
HAVING min(ready.ready_at) IS NOT NULL;

-- name: GetTaskExecutionWorkerLease :one
SELECT id AS task_id,task_worker_id,task_lease_generation,task_lease_expires_at
FROM work_items
WHERE id=sqlc.arg(task_id)::text
  AND task_worker_id=sqlc.arg(worker_id)::text
  AND task_lease_generation=sqlc.arg(lease_generation)::bigint
  AND task_lease_token_hash=sqlc.arg(lease_token_hash)::bytea
  AND task_lease_expires_at>clock_timestamp();

-- name: LockTaskExecutionWorkerLease :one
SELECT *
FROM work_items
WHERE id=sqlc.arg(task_id)::text
  AND task_worker_id=sqlc.arg(worker_id)::text
  AND task_lease_generation=sqlc.arg(lease_generation)::bigint
  AND task_lease_token_hash=sqlc.arg(lease_token_hash)::bytea
  AND task_lease_expires_at>clock_timestamp()
FOR UPDATE;

-- name: ExtendTaskExecutionWorkerLease :one
WITH extended_effects AS (
  UPDATE task_effects effect
  SET lease_expires_at=clock_timestamp()+make_interval(secs=>sqlc.arg(lease_seconds)::int)
  WHERE effect.task_id=sqlc.arg(task_id)::text
    AND effect.status='dispatching'
    AND effect.operation='cleanup_runtime'
    AND effect.worker_id=sqlc.arg(worker_id)::text
    AND effect.lease_token_hash=sqlc.arg(lease_token_hash)::bytea
    AND effect.lease_expires_at>clock_timestamp()
    AND EXISTS (
      SELECT 1
      FROM work_items item
      WHERE item.id=effect.task_id
        AND item.task_execution_generation=effect.generation
        AND item.task_worker_id=sqlc.arg(worker_id)::text
        AND item.task_lease_generation=sqlc.arg(lease_generation)::bigint
        AND item.task_lease_token_hash=sqlc.arg(lease_token_hash)::bytea
        AND item.task_lease_expires_at>clock_timestamp()
    )
  RETURNING effect.id
)
-- While a lease is held, the reconcile time falls due only when a writer such
-- as MakeRunningTaskDue sets it to now. A heartbeat keeps a future time at
-- least at the lease end and never moves a due time or makes any time earlier,
-- so the claimable-update wake trigger, which fires only when the time moves
-- earlier, never fires for a heartbeat.
UPDATE work_items
SET task_lease_expires_at=clock_timestamp()+make_interval(secs=>sqlc.arg(lease_seconds)::int),
  task_next_reconcile_at=CASE WHEN task_next_reconcile_at>clock_timestamp()
    THEN GREATEST(task_next_reconcile_at,clock_timestamp()+make_interval(secs=>sqlc.arg(lease_seconds)::int))
    ELSE task_next_reconcile_at END
WHERE id=sqlc.arg(task_id)::text
  AND task_worker_id=sqlc.arg(worker_id)::text
  AND task_lease_generation=sqlc.arg(lease_generation)::bigint
  AND task_lease_token_hash=sqlc.arg(lease_token_hash)::bytea
  AND task_lease_expires_at>clock_timestamp()
  AND (SELECT count(*) FROM extended_effects)>=0
RETURNING id AS task_id,task_worker_id,task_lease_generation,task_lease_expires_at;

-- name: ScheduleTaskExecutionReconcile :one
-- The running Attempt's deadline caps the delay, so the timeout needs no
-- polling; LEAST ignores the NULL of an Attempt without a deadline. A claim
-- sets the time to the lease end and each lease heartbeat keeps it there, so
-- a time already due during the lease comes from a writer that made the Task
-- due, such as a finished participant Run; it stays due instead of moving
-- later.
UPDATE work_items
SET task_next_reconcile_at=CASE
      WHEN task_next_reconcile_at<=clock_timestamp() THEN clock_timestamp()
      ELSE LEAST(
        clock_timestamp()+make_interval(secs=>sqlc.arg(reconcile_after_seconds)::int),
        (SELECT attempt.deadline_at FROM task_attempts attempt
         WHERE attempt.task_id=work_items.id
           AND attempt.generation=work_items.task_execution_generation
           AND attempt.status='running')
      )
    END,
    task_worker_id=NULL,
    task_lease_token_hash=NULL,
    task_lease_expires_at=NULL
WHERE id=sqlc.arg(task_id)::text
  AND tenant_id=sqlc.arg(tenant_id)::text
  AND task_execution_generation=sqlc.arg(generation)::bigint
  AND task_execution_revision=sqlc.arg(expected_execution_revision)::bigint
  AND task_control_revision=sqlc.arg(expected_control_revision)::bigint
  AND task_worker_id=sqlc.arg(worker_id)::text
  AND task_lease_generation=sqlc.arg(lease_generation)::bigint
  AND task_lease_token_hash=sqlc.arg(lease_token_hash)::bytea
  AND task_lease_expires_at>clock_timestamp()
RETURNING *;

-- name: BeginTaskEffectDispatch :one
UPDATE task_effects
SET status='dispatching',worker_id=sqlc.arg(worker_id)::text,
    lease_token_hash=sqlc.arg(lease_token_hash)::bytea,
    lease_generation=lease_generation+1,
    lease_expires_at=sqlc.arg(lease_expires_at)::timestamptz,
    dispatch_started_at=COALESCE(dispatch_started_at,clock_timestamp())
WHERE id=sqlc.arg(effect_id)::text
  AND task_id=sqlc.arg(task_id)::text
  AND generation=sqlc.arg(generation)::bigint
  AND (
    status='pending'
    OR (operation='cleanup_runtime' AND status='dispatching' AND lease_expires_at<=clock_timestamp())
  )
RETURNING *;

-- name: CompleteTaskRuntimeCleanupEffect :one
UPDATE task_effects effect
SET status='succeeded',
    observation=sqlc.arg(observation)::jsonb,
    observation_hash=sqlc.arg(observation_hash)::bytea,
    error=NULL,completed_at=clock_timestamp(),
    lease_expires_at=NULL,lease_token_hash=NULL,worker_id=NULL
WHERE effect.id=sqlc.arg(effect_id)::text
  AND effect.task_id=sqlc.arg(task_id)::text
  AND effect.generation=sqlc.arg(generation)::bigint
  AND effect.operation='cleanup_runtime'
  AND effect.status='dispatching'
  AND effect.worker_id=sqlc.arg(worker_id)::text
  AND effect.lease_token_hash=sqlc.arg(lease_token_hash)::bytea
  AND effect.lease_expires_at>clock_timestamp()
  AND EXISTS (
    SELECT 1
    FROM work_items item
    WHERE item.id=effect.task_id
      AND item.task_execution_generation=effect.generation
      AND item.task_worker_id=sqlc.arg(worker_id)::text
      AND item.task_lease_generation=sqlc.arg(lease_generation)::bigint
      AND item.task_lease_token_hash=sqlc.arg(lease_token_hash)::bytea
      AND item.task_lease_expires_at>clock_timestamp()
  )
RETURNING effect.*;

-- name: CancelStoppedTaskSubmitEffects :execrows
UPDATE task_effects effect
SET status='canceled',completed_at=clock_timestamp(),
    lease_expires_at=NULL,lease_token_hash=NULL,worker_id=NULL
WHERE effect.task_id=sqlc.arg(task_id)::text
  AND effect.generation=sqlc.arg(generation)::bigint
  AND effect.id=ANY(sqlc.arg(effect_ids)::text[])
  AND effect.operation='submit_agent_turn'
  AND effect.status IN ('pending','dispatching')
  AND EXISTS (
    SELECT 1 FROM task_input_revisions input
    JOIN task_attempts attempt ON attempt.id=input.attempt_id
      AND attempt.task_id=input.task_id AND attempt.generation=input.generation
    WHERE input.task_id=effect.task_id AND input.generation=effect.generation
      AND input.message_effect_ids ? effect.id AND attempt.status='stopped'
  );

-- name: CancelPendingTaskEffectsForTaskTerminal :execrows
UPDATE task_effects
SET status='canceled',
    error='task_terminal',
    completed_at=clock_timestamp(),
    lease_expires_at=NULL,
    lease_token_hash=NULL,
    worker_id=NULL
WHERE task_id=sqlc.arg(task_id)::text
  AND operation<>'cleanup_runtime'
  AND status IN ('pending','dispatching');

-- name: ReleaseTaskExecutionLeaseAfterRuntimeCleanup :execrows
UPDATE work_items item
SET task_worker_id=NULL,task_lease_token_hash=NULL,task_lease_expires_at=NULL,
    task_next_reconcile_at=clock_timestamp()
WHERE item.id=sqlc.arg(task_id)::text
  AND item.tenant_id=sqlc.arg(tenant_id)::text
  AND item.task_execution_generation=sqlc.arg(generation)::bigint
  AND item.task_execution_revision=sqlc.arg(expected_execution_revision)::bigint
  AND item.task_control_revision=sqlc.arg(expected_control_revision)::bigint
  AND item.task_worker_id=sqlc.arg(worker_id)::text
  AND item.task_lease_generation=sqlc.arg(lease_generation)::bigint
  AND item.task_lease_token_hash=sqlc.arg(lease_token_hash)::bytea
  AND item.task_lease_expires_at>clock_timestamp()
  AND NOT EXISTS (
    SELECT 1
    FROM task_effects effect
    WHERE effect.task_id=item.id
      AND effect.generation=item.task_execution_generation
      AND effect.operation='cleanup_runtime'
      AND effect.status IN ('pending','dispatching')
  );

-- name: CompleteTaskEffect :one
UPDATE task_effects
SET status=sqlc.arg(effect_status)::text,
    dispatch_started_at=COALESCE(dispatch_started_at,clock_timestamp()),
    observation=sqlc.narg(observation)::jsonb,
    observation_hash=sqlc.narg(observation_hash)::bytea,
    error=sqlc.narg(error)::text,
    completed_at=clock_timestamp(),
    lease_expires_at=NULL,
    lease_token_hash=NULL,
    worker_id=NULL
WHERE id=sqlc.arg(effect_id)::text
  AND task_id=sqlc.arg(task_id)::text
  AND generation=sqlc.arg(generation)::bigint
  AND status IN ('pending','dispatching')
RETURNING *;

-- name: UpdateTaskAgentTerminalObservation :one
UPDATE task_effects
SET observation=sqlc.arg(observation)::jsonb,
    observation_hash=sqlc.arg(observation_hash)::bytea
WHERE id=sqlc.arg(effect_id)::text
  AND task_id=sqlc.arg(task_id)::text
  AND generation=sqlc.arg(generation)::bigint
  AND operation='submit_agent_turn'
  AND status='succeeded'
RETURNING *;

-- name: AdvanceRunningTaskAttemptInput :execrows
UPDATE task_attempts
SET current_input_revision=sqlc.arg(next_input_revision)::bigint,
    updated_at=clock_timestamp()
WHERE id=sqlc.arg(attempt_id)::text
  AND task_id=sqlc.arg(task_id)::text
  AND generation=sqlc.arg(generation)::bigint
  AND status='running'
  AND current_input_revision=sqlc.arg(expected_input_revision)::bigint;

-- name: StopTaskAttemptForReconcile :execrows
UPDATE task_attempts
SET status='stopped',
    deadline_at=NULL,
    stop_reason_code=sqlc.arg(stop_reason_code)::text,
    updated_at=clock_timestamp(),
    finished_at=clock_timestamp()
WHERE id=sqlc.arg(attempt_id)::text
  AND task_id=sqlc.arg(task_id)::text
  AND generation=sqlc.arg(generation)::bigint
  AND status='running'
  AND current_input_revision=sqlc.arg(expected_input_revision)::bigint;

-- name: PassTaskAttemptForReconcile :execrows
UPDATE task_attempts
SET status='passed',
    deadline_at=NULL,
    updated_at=clock_timestamp(),
    finished_at=clock_timestamp()
WHERE id=sqlc.arg(attempt_id)::text
  AND task_id=sqlc.arg(task_id)::text
  AND generation=sqlc.arg(generation)::bigint
  AND status='running'
  AND current_input_revision=sqlc.arg(expected_input_revision)::bigint;

-- name: MakeRunningTaskDue :execrows
-- A participant Run finished: the running Task is due now. Its work_items
-- trigger wakes the Task Worker when that makes the Task claimable sooner:
-- at once without a lease, otherwise when the lease is released.
UPDATE work_items
SET task_next_reconcile_at=clock_timestamp()
WHERE id=sqlc.arg(task_id)::text
  AND task_execution_status='running'
  AND task_next_reconcile_at>clock_timestamp();
