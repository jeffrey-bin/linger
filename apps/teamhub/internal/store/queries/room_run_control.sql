-- name: ListRunningRoomIDsForTenantAccount :many
-- Only running (claimed) Local Runs that have not replied light the Room,
-- because a queued Run may wait indefinitely for an offline Computer; a
-- Thread lights its parent.
SELECT DISTINCT room.id
FROM (
    SELECT run.tenant_id,run.context_room_id AS room_id
    FROM room_agent_runs run
    WHERE run.status='running' AND NOT agent_local_run_replied(run.run_id)
) work
JOIN rooms room ON room.id=work.room_id AND room.tenant_id=work.tenant_id
JOIN actors caller ON caller.tenant_id=room.tenant_id
  AND caller.account_id=sqlc.arg(account_id)::text AND caller.kind='human'
JOIN active_room_members membership ON membership.room_id=room.id AND membership.actor_id=caller.id
WHERE work.tenant_id=sqlc.arg(tenant_id)::text
  AND room.deleted_at IS NULL AND room.deletion_started_at IS NULL
ORDER BY room.id;

-- name: ListFailedRoomIDsForTenantAccount :many
-- The latest Local Run of a visible Room in the last 7 days failed; a Thread's
-- Runs count for its parent.
SELECT latest.room_id
FROM (
    SELECT DISTINCT ON (room.id) room.id AS room_id, run.status
    FROM room_agent_runs run
    JOIN rooms room ON room.id=run.context_room_id AND room.tenant_id=run.tenant_id
    JOIN actors caller ON caller.tenant_id=room.tenant_id
      AND caller.account_id=sqlc.arg(account_id)::text AND caller.kind='human'
    JOIN active_room_members membership ON membership.room_id=room.id AND membership.actor_id=caller.id
    WHERE run.created_at > clock_timestamp() - interval '7 days'
      AND run.tenant_id=sqlc.arg(tenant_id)::text
      AND room.deleted_at IS NULL AND room.deletion_started_at IS NULL
    ORDER BY room.id, run.created_at DESC, run.run_id DESC
) latest
WHERE latest.status='failed'
ORDER BY latest.room_id;

-- name: GetRoomRunForControl :one
-- Stop finds a Run shown in the Room whatever its state. Such a Run belongs to
-- a Context of the Room or, for a Thread, of its parent.
SELECT run.run_id,run.status,run.context_room_id,run.agent_management_id,run.agent_actor_id,
       ARRAY(
           SELECT DISTINCT message.id
           FROM agent_runtime_inputs input
           LEFT JOIN agent_local_run_inputs link ON input.context_key=link.context_key AND input.input_id=link.input_id
           CROSS JOIN LATERAL (
               SELECT input.source_message_id AS message_id
               UNION
               SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(input.payload->'invocationMessageIds')='array'
                   THEN input.payload->'invocationMessageIds' ELSE '[]'::jsonb END)
           ) source
           JOIN messages message ON message.id=source.message_id AND message.room_id=sqlc.arg(room_id)::text AND message.tenant_id=run.tenant_id
           WHERE input.context_key=run.context_key
             AND (link.run_id=run.run_id OR (input.status='steering' AND run.status='running'))
           ORDER BY message.id
       )::text[] AS message_ids
FROM room_agent_runs run
WHERE run.room_id=sqlc.arg(room_id)::text
  AND run.context_room_id=collaboration_membership_room_id(sqlc.arg(room_id)::text)
  AND run.tenant_id=sqlc.arg(tenant_id)::text
  AND run.run_id=sqlc.arg(run_id)::text;
