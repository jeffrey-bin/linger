-- name: GetRuntimeInteractionAuthority :one
-- The Sponsor and Runtime of a live Context's Agent, and whether the Run is
-- still running without a cancellation request.
SELECT registration.created_by_actor_id,
       registration.local_runtime_type,
       EXISTS(
         SELECT 1 FROM agent_local_runs run
         WHERE run.run_id=sqlc.arg(run_id)::text AND run.context_key=sqlc.arg(context_key)::text
           AND run.status='running' AND NOT run.cancellation_requested
       )::boolean AS running
FROM agent_execution_contexts context
JOIN agent_registrations registration
  ON registration.actor_id=context.agent_actor_id AND registration.tenant_id=context.tenant_id
WHERE context.context_key=sqlc.arg(context_key)::text AND context.terminal_reason IS NULL;
