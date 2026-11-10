-- name: InsertRoomRoutineListener :one
INSERT INTO room_routine_listeners (
    id, tenant_id, room_id, routine_id, ordinal, kind, connection_id,
    poll_cursor, poll_next_at, poll_interval_seconds
) VALUES (
    sqlc.arg(id), sqlc.arg(tenant_id), sqlc.arg(room_id), sqlc.arg(routine_id),
    sqlc.arg(ordinal), sqlc.arg(kind), sqlc.arg(connection_id),
    sqlc.narg(poll_cursor), sqlc.narg(poll_next_at), sqlc.narg(poll_interval_seconds)
)
RETURNING *;

-- name: GetRoomRoutineListener :one
SELECT *
FROM room_routine_listeners
WHERE id=sqlc.arg(id)::text
FOR UPDATE;

-- name: DelayRoutineListenerPoll :exec
-- A failed poll keeps its cursor and tries again after poll_next_at.
UPDATE room_routine_listeners
SET poll_next_at=sqlc.arg(poll_next_at)::timestamptz,
    updated_at=clock_timestamp()
WHERE id=sqlc.arg(id)::text;

-- name: LockInvalidRoutineListeners :many
-- Listener Routines whose connection is no longer active or no longer granted
-- to the Agent they serve. A binding or Routine that a poll or a write holds is
-- skipped, never waited for; a later sweep takes it.
SELECT listener.routine_id
FROM room_routine_listeners listener
JOIN room_reminders reminder ON reminder.id=listener.routine_id
WHERE NOT EXISTS (
    SELECT 1
    FROM external_connection_agent_grants delegation
    JOIN external_connections conn ON conn.id=delegation.connection_id AND conn.status='active'
    WHERE delegation.connection_id=listener.connection_id
      AND delegation.agent_actor_id=reminder.mention_actor_id
      AND delegation.tenant_id=listener.tenant_id
      AND delegation.status='active'
  )
FOR UPDATE OF listener, reminder SKIP LOCKED;

-- name: DeleteRoomRemindersByID :many
DELETE FROM room_reminders
WHERE id=ANY(sqlc.arg(ids)::text[])
RETURNING *;

-- name: ListDueListenerPolls :many
SELECT listener.*, reminder.enabled AS routine_enabled
FROM room_routine_listeners listener
JOIN room_reminders reminder ON reminder.id=listener.routine_id
WHERE listener.poll_next_at IS NOT NULL
  AND listener.poll_next_at<=clock_timestamp()
ORDER BY listener.poll_next_at, listener.id;

-- name: ResumeRoomRoutineListeners :exec
UPDATE room_routine_listeners
SET poll_next_at=clock_timestamp(),
    updated_at=clock_timestamp()
WHERE routine_id=sqlc.arg(routine_id)::text
  AND tenant_id=sqlc.arg(tenant_id)::text;

-- name: AdvanceRoutineListenerPoll :exec
UPDATE room_routine_listeners
SET poll_cursor=sqlc.narg(poll_cursor),
    poll_next_at=sqlc.arg(poll_next_at)::timestamptz,
    updated_at=clock_timestamp()
WHERE id=sqlc.arg(id)::text;

-- name: LockGrantedConnectionForListener :one
SELECT conn.id, conn.upstream_connection_id, conn.provider, conn.status,
       delegation.id AS grant_id, delegation.revision AS grant_revision
FROM external_connection_agent_grants delegation
JOIN external_connections conn ON conn.id=delegation.connection_id
JOIN agent_registrations registration
  ON registration.actor_id=delegation.agent_actor_id
 AND registration.tenant_id=delegation.tenant_id
WHERE delegation.connection_id=sqlc.arg(connection_id)::text
  AND delegation.agent_actor_id=sqlc.arg(agent_actor_id)::text
  AND delegation.tenant_id=sqlc.arg(tenant_id)::text
  AND delegation.status='active'
  AND registration.status='active'
  AND conn.status='active'
FOR SHARE OF delegation, conn, registration;

-- name: GetRoutineEventDelivery :one
SELECT routine_id, source, upstream_event_id, created_at
FROM routine_event_deliveries
WHERE routine_id=sqlc.arg(routine_id)::text
  AND source=sqlc.arg(source)::text
  AND upstream_event_id=sqlc.arg(upstream_event_id)::text;

-- name: InsertRoutineEventDelivery :one
INSERT INTO routine_event_deliveries (
    routine_id, source, upstream_event_id
) VALUES (
    sqlc.arg(routine_id), sqlc.arg(source), sqlc.arg(upstream_event_id)
)
ON CONFLICT (routine_id, source, upstream_event_id) DO NOTHING
RETURNING routine_id;
