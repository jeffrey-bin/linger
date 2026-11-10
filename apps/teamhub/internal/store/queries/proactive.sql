-- name: GetRunProactiveWakeSource :one
-- The source of the delivered proactive wake that started this Run in this
-- Room, if one did. A Room notification input names the Messages it carries
-- in payload invocationMessageIds. A wake steered into a Run already answering
-- the Human does not make that Run proactive. Mixed initial inputs and any
-- Human input already attached when this Message is sent keep it ordinary.
SELECT wake.source FROM agent_local_run_inputs relation
JOIN agent_runtime_inputs input
  ON input.context_key=relation.context_key AND input.input_id=relation.input_id
JOIN proactive_pending_wakes wake
  ON wake.room_id=sqlc.arg(room_id)::text AND wake.message_id IS NOT NULL
 AND (input.source_message_id=wake.message_id
      OR jsonb_typeof(input.payload->'invocationMessageIds')='array'
         AND input.payload->'invocationMessageIds' @> to_jsonb(wake.message_id))
WHERE relation.run_id=sqlc.arg(run_id)::text AND relation.relation='initial'
  AND wake.delivered_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM agent_local_run_inputs human_relation
    JOIN agent_runtime_inputs human_input
      ON human_input.context_key=human_relation.context_key
     AND human_input.input_id=human_relation.input_id
    JOIN messages human_message ON human_message.room_id=wake.room_id
     AND (human_input.source_message_id=human_message.id
          OR jsonb_typeof(human_input.payload->'invocationMessageIds')='array'
             AND human_input.payload->'invocationMessageIds' @> to_jsonb(human_message.id))
    JOIN actors human_author ON human_author.id=human_message.author_actor_id
    WHERE human_relation.run_id=relation.run_id
      AND human_message.message_kind='conversation' AND human_author.kind='human'
  )
ORDER BY wake.delivered_at, wake.id
LIMIT 1;

-- name: CreateProactiveOutput :exec
-- Only the first Message of a wake Run is its output.
INSERT INTO proactive_outputs(message_id,tenant_id,owner_actor_id,room_id,source,local_run_id)
VALUES (sqlc.arg(message_id)::text,sqlc.arg(tenant_id)::text,sqlc.arg(owner_actor_id)::text,
        sqlc.arg(room_id)::text,sqlc.arg(source)::text,sqlc.arg(local_run_id)::text)
ON CONFLICT DO NOTHING;

-- name: UpsertProactivePotentialItem :execrows
-- A source item enters once a day, tracked or reminded; a repeat judgment is
-- ignored.
INSERT INTO proactive_potential_items(id,tenant_id,owner_actor_id,content,source,source_key,reminded)
VALUES (sqlc.arg(id)::text,sqlc.arg(tenant_id)::text,sqlc.arg(owner_actor_id)::text,
        sqlc.arg(content)::text,sqlc.arg(source)::text,sqlc.arg(source_key)::text,sqlc.arg(reminded)::boolean)
ON CONFLICT (tenant_id,owner_actor_id,source,source_key) DO NOTHING;

-- name: HasProactiveSignalForSource :one
-- Whether this source item was already judged today: a candidate is judged
-- once a day.
SELECT EXISTS(
  SELECT 1 FROM proactive_potential_items
  WHERE tenant_id=sqlc.arg(tenant_id)::text AND owner_actor_id=sqlc.arg(owner_actor_id)::text
    AND source=sqlc.arg(source)::text AND source_key=sqlc.arg(source_key)::text
)::boolean;

-- name: GetLatestProactiveGuideline :one
SELECT version,specific FROM proactive_guidelines
WHERE tenant_id=sqlc.arg(tenant_id)::text AND owner_actor_id=sqlc.arg(owner_actor_id)::text
ORDER BY version DESC
LIMIT 1;

-- name: ListProactiveTrackingItems :many
-- The Human's current Tracking Items, by Memory's rule: current until due, or
-- for three months when undated.
SELECT id,kind,content,due_at FROM memory_index.tracking_items
WHERE tenant_id=sqlc.arg(tenant_id)::text AND owner_actor_id=sqlc.arg(owner_actor_id)::text AND status='open'
  AND coalesce(due_at>=now(),created_at>=now()-interval '3 months')
ORDER BY due_at NULLS LAST,created_at
LIMIT 100;

-- name: CountProactiveRemindedEvents :one
-- Events that woke AnotherMe today; the day's records are emptied each night.
SELECT count(*)::bigint FROM proactive_potential_items
WHERE tenant_id=sqlc.arg(tenant_id)::text AND owner_actor_id=sqlc.arg(owner_actor_id)::text
  AND source='event' AND reminded;

-- name: LockConnectionAutoReminders :one
-- Share-locks a connection against its auto reminders switch and reads the
-- switch, for the listener sweep's install.
SELECT auto_reminders FROM external_connections WHERE id=sqlc.arg(id)::text FOR SHARE;

-- name: ListAnotherMeConnectionsWithoutListener :many
-- The Human's own active connections of a listenable provider with auto
-- reminders on, granted to their active AnotherMe, with no listener Routine
-- for that connection yet. A connection ID narrows it to that connection.
SELECT registration.tenant_id, registration.represented_human_actor_id::text AS represented_human_actor_id,
       registration.actor_id AS agent_actor_id, room.id AS room_id,
       c.id AS connection_id, c.provider, c.identity_label
FROM agent_registrations registration
JOIN rooms room ON room.tenant_id=registration.tenant_id
  AND room.direct_human_actor_id=registration.represented_human_actor_id
  AND room.direct_agent_actor_id=registration.actor_id
  AND room.deletion_started_at IS NULL
JOIN external_connection_agent_grants d ON d.agent_actor_id=registration.actor_id AND d.tenant_id=registration.tenant_id
  AND d.represented_human_actor_id=registration.represented_human_actor_id AND d.status='active'
JOIN external_connections c ON c.id=d.connection_id AND c.status='active'
  AND c.provider=ANY(sqlc.arg(providers)::text[]) AND c.auto_reminders
  AND (sqlc.narg(connection_id)::text IS NULL OR c.id=sqlc.narg(connection_id)::text)
WHERE registration.agent_type='anotherme' AND registration.status='active'
  AND NOT EXISTS (
    SELECT 1 FROM room_reminders r
    WHERE r.template_agent_actor_id=registration.actor_id
      AND r.template_routine_key=sqlc.arg(routine_key_prefix)::text || c.id
  )
ORDER BY registration.tenant_id, registration.represented_human_actor_id, c.created_at, c.id
LIMIT 200;

-- name: GetAnotherMeHuman :one
SELECT represented_human_actor_id::text
FROM agent_registrations
WHERE actor_id=sqlc.arg(agent_actor_id)::text AND tenant_id=sqlc.arg(tenant_id)::text AND agent_type='anotherme';
