-- name: ListRoomPresenceRecipients :many
-- The Contexts the Room's next Message would reach. The single receive
-- predicate stays authoritative, including membership epoch and participation.
SELECT recipient.context_key::text AS context_key,recipient.agent_actor_id::text AS agent_actor_id
FROM agent_inbox_recipients('room:'||sqlc.arg(room_id)::text) recipient
ORDER BY recipient.context_key;

-- name: ListPresencePreparableContextKeys :many
-- Narrows authorized Inbox recipients to live Meta Contexts of active
-- Agents. An active registration always runs on a Local Computer.
SELECT DISTINCT context.context_key
FROM agent_execution_contexts context
JOIN agent_registrations registration ON registration.agent_management_id = context.agent_management_id
WHERE context.context_key = ANY(sqlc.arg(context_keys)::text[])
    AND context.context_kind = 'meta'
    AND context.terminal_reason IS NULL
    AND registration.status = 'active'
ORDER BY context.context_key;

-- name: ListAgentContextsWithWaitingRuns :many
-- The fallback scan for lost run.queued and run.steered hints: Contexts whose
-- queued Run has waited 30 seconds with nothing running, or whose Message
-- steer has waited as long.
SELECT DISTINCT waiting.context_key::text AS context_key
FROM (
    SELECT run.context_key FROM agent_local_runs run
    WHERE run.status='queued' AND run.created_at<clock_timestamp()-interval '30 seconds'
      AND NOT EXISTS (SELECT 1 FROM agent_local_runs active WHERE active.context_key=run.context_key AND active.status='running')
    UNION ALL
    SELECT input.context_key FROM agent_runtime_inputs input
    WHERE input.status='steering' AND input.created_at<clock_timestamp()-interval '30 seconds'
      AND input.selection_result->>'selected' IN ('trusted_inbox_notification','runtime_response')
) waiting
JOIN agent_execution_contexts context ON context.context_key=waiting.context_key AND context.terminal_reason IS NULL
ORDER BY 1
LIMIT 1000;
