-- name: CreateVoiceLiveTask :one
-- Numbered per Room and user; the caller holds the per-user task lock.
INSERT INTO voice_live_tasks(work_item_id,room_id,owner_actor_id,home_room_id,ordinal,voice_session_id,goal,surface)
SELECT sqlc.arg(work_item_id)::text,sqlc.arg(room_id)::text,sqlc.arg(owner_actor_id)::text,sqlc.arg(home_room_id)::text,
  coalesce((SELECT max(ordinal) FROM voice_live_tasks
    WHERE room_id=sqlc.arg(room_id)::text AND owner_actor_id=sqlc.arg(owner_actor_id)::text),0)+1,
  sqlc.arg(voice_session_id)::text,sqlc.arg(goal)::text,sqlc.arg(surface)::text
RETURNING ordinal;

-- name: FindVoiceLiveRepeatedTask :one
-- The same goal handed off again moments ago, before any reply.
SELECT task.ordinal FROM voice_live_tasks task
WHERE task.room_id=sqlc.arg(room_id)::text AND task.owner_actor_id=sqlc.arg(owner_actor_id)::text
  AND task.goal=sqlc.arg(goal)::text AND task.canceled_at IS NULL
  AND task.created_at>sqlc.arg(since)::timestamptz
  AND NOT EXISTS(SELECT 1 FROM task_meta_callback_messages message WHERE message.task_id=task.work_item_id)
ORDER BY task.created_at DESC LIMIT 1;

-- name: GetVoiceLiveTask :one
SELECT * FROM voice_live_tasks
WHERE room_id=sqlc.arg(room_id)::text AND owner_actor_id=sqlc.arg(owner_actor_id)::text AND ordinal=sqlc.arg(ordinal)::int;

-- name: CancelVoiceLiveTask :execrows
UPDATE voice_live_tasks SET canceled_at=clock_timestamp()
WHERE work_item_id=sqlc.arg(work_item_id)::text AND canceled_at IS NULL;

-- name: ListVoiceLiveTasks :many
-- The user's tasks in this Room a call talks about: those it started, those
-- still running or waiting, and those that changed since a cutoff, with
-- their Task's execution state, latest report and the Run working on it now.
-- A report counts as delivered once published, or once another call of the
-- user's started after it: that call told it, heard in full or cut off, so
-- later calls do not tell it again.
SELECT task.ordinal,task.goal,task.surface,task.work_item_id,task.canceled_at,item.title,
  (task.voice_session_id IS NOT DISTINCT FROM sqlc.arg(voice_session_id)::text)::boolean AS started_here,
  coalesce(item.task_execution_status,'')::text AS execution_status,
  item.task_execution_updated_at AS execution_updated_at,
  coalesce(report.id,'')::text AS report_id,coalesce(report.body,'')::text AS report_body,
  coalesce(report.told,false)::boolean AS report_delivered,
  coalesce(run.run_id,'')::text AS run_id,run.created_at AS run_created_at
FROM voice_live_tasks task
JOIN work_items item ON item.id=task.work_item_id
LEFT JOIN LATERAL (
  SELECT current.run_id,current.created_at FROM agent_local_runs current
  WHERE current.context_key=sqlc.arg(context_key_prefix)::text||task.work_item_id||'"]'
    AND current.finished_at IS NULL
  ORDER BY current.created_at DESC LIMIT 1
) run ON true
LEFT JOIN LATERAL (
  -- The report its coordinator gets when a turn ends.
  SELECT message.id,message.body,
    (EXISTS(SELECT 1 FROM voice_live_report_deliveries delivery WHERE delivery.report_id=message.id)
      OR EXISTS(SELECT 1 FROM voice_sessions later
        WHERE later.room_id=task.room_id AND later.created_by_actor_id=task.owner_actor_id
          AND later.purpose='chat_live' AND later.id<>sqlc.arg(voice_session_id)::text
          AND later.created_at>message.created_at)) AS told
  FROM task_meta_callback_messages message
  WHERE message.task_id=task.work_item_id AND message.generation=item.task_execution_generation
  ORDER BY message.meta_seq DESC LIMIT 1
) report ON true
WHERE task.room_id=sqlc.arg(room_id)::text AND task.owner_actor_id=sqlc.arg(owner_actor_id)::text
  AND (task.voice_session_id=sqlc.arg(voice_session_id)::text
    OR task.canceled_at IS NULL AND item.task_execution_status IN ('running','waiting_for_approval')
    OR item.task_execution_updated_at>sqlc.arg(since)::timestamptz
 OR report.id IS NOT NULL AND NOT report.told)
ORDER BY task.ordinal DESC
LIMIT 20;

-- name: GetVoiceLiveAgentComputer :one
-- Where the Agent answering a live session runs, whether its computer is
-- online, and the Agent's upstream identity for its Tasks.
SELECT coalesce(computer.status,'')::text AS computer_status,
  coalesce(registration.agent_management_id,'')::text AS agent_management_id
FROM agent_registrations registration
LEFT JOIN local_computers computer ON computer.computer_id=registration.computer_id
WHERE registration.actor_id=sqlc.arg(actor_id)::text AND registration.tenant_id=sqlc.arg(tenant_id)::text;

-- name: ListVoiceLiveRoomPendingWakes :many
-- Proactive wakes still waiting for the call in this Room to end, oldest first.
SELECT id,source,body,connection_grant,agent_actor_id,tenant_id FROM proactive_pending_wakes
WHERE room_id=sqlc.arg(room_id)::text AND delivered_at IS NULL
ORDER BY created_at
LIMIT 20;

-- name: CountVoiceLiveRoomHumans :one
SELECT count(*) FROM active_room_members member JOIN actors actor ON actor.id=member.actor_id
WHERE member.room_id=sqlc.arg(room_id)::text AND actor.kind='human';

-- name: CreateVoiceLiveConfirmation :exec
INSERT INTO voice_live_confirmations(id,voice_session_id,turn_id,tool,arguments_hash,goal,surface)
VALUES(sqlc.arg(id)::text,sqlc.arg(voice_session_id)::text,sqlc.arg(turn_id)::text,sqlc.arg(tool)::text,
  sqlc.arg(arguments_hash)::text,sqlc.arg(goal)::text,sqlc.arg(surface)::text);

-- name: GetVoiceLiveConfirmation :one
-- A confirmation still usable from this turn, without using it.
SELECT goal,surface FROM voice_live_confirmations
WHERE id=sqlc.arg(id)::text AND voice_session_id=sqlc.arg(voice_session_id)::text AND tool=sqlc.arg(tool)::text
  AND turn_id<>sqlc.arg(turn_id)::text AND used_at IS NULL AND created_at>sqlc.arg(since)::timestamptz;

-- name: UseVoiceLiveConfirmation :one
-- A confirmation counts once, from a later turn of the same call, while fresh.
UPDATE voice_live_confirmations SET used_at=clock_timestamp(),used_turn_id=sqlc.arg(turn_id)::text
WHERE id=sqlc.arg(id)::text AND voice_session_id=sqlc.arg(voice_session_id)::text AND tool=sqlc.arg(tool)::text
  AND turn_id<>sqlc.arg(turn_id)::text AND used_at IS NULL AND created_at>sqlc.arg(since)::timestamptz
RETURNING goal,surface;

-- name: UseVoiceLiveConfirmationFor :execrows
-- The latest confirmation asked for exactly these arguments, used once; a
-- retry within the turn that used it is admitted again.
UPDATE voice_live_confirmations SET used_at=clock_timestamp(),used_turn_id=sqlc.arg(turn_id)::text
WHERE id=(SELECT pending.id FROM voice_live_confirmations pending
  WHERE pending.voice_session_id=sqlc.arg(voice_session_id)::text AND pending.tool=sqlc.arg(tool)::text
    AND pending.arguments_hash=sqlc.arg(arguments_hash)::text AND pending.turn_id<>sqlc.arg(turn_id)::text
    AND pending.used_at IS NULL AND pending.created_at>sqlc.arg(since)::timestamptz
  ORDER BY pending.created_at DESC LIMIT 1 FOR UPDATE SKIP LOCKED)
  OR id=(SELECT used.id FROM voice_live_confirmations used
  WHERE used.voice_session_id=sqlc.arg(voice_session_id)::text AND used.tool=sqlc.arg(tool)::text
    AND used.arguments_hash=sqlc.arg(arguments_hash)::text AND used.used_turn_id=sqlc.arg(turn_id)::text
  LIMIT 1);

-- name: CountVoiceLiveTurnConfirmations :one
-- Questions this turn asked about one tool that nobody answered yet.
SELECT count(*) FROM voice_live_confirmations
WHERE voice_session_id=sqlc.arg(voice_session_id)::text AND turn_id=sqlc.arg(turn_id)::text
  AND tool=sqlc.arg(tool)::text AND used_at IS NULL;

-- name: NotifyVoiceLiveTaskChanged :exec
-- Tells live calls in a voice task's Room that it changed; nothing for other
-- Tasks. Delivered on commit, to every TeamHub process.
SELECT pg_notify('teamhub_realtime', json_build_object(
  'topic','voicetasks:'||task.room_id,'kind','voice.tasks.changed','resource_id',task.work_item_id,
  'sequence',0,'revision',0)::text)
FROM voice_live_tasks task WHERE task.work_item_id=sqlc.arg(work_item_id)::text;

-- name: NotifyVoiceLiveRoomAlert :exec
-- Tells live calls in a Room that an app event waits to be told.
SELECT pg_notify('teamhub_realtime', json_build_object(
  'topic','voicetasks:'||sqlc.arg(room_id)::text,'kind','voice.tasks.changed','resource_id',sqlc.arg(wake_id)::text,
  'sequence',0,'revision',0)::text);

-- name: ListVoiceLivePendingApprovals :many
-- The approval cards the user's live tasks wait on and the user decides:
-- connector writes, Runtime permissions and Agent changes, with the card
-- version an answer names.
SELECT decision.id,coalesce(decision.alter_ego_task_id,'')::text AS task_id,decision.kind,decision.view,
  card.version AS card_version
FROM decisions decision
JOIN message_cards card ON card.message_id=decision.message_id
WHERE decision.alter_ego_task_id=ANY(sqlc.arg(task_ids)::text[])
  AND decision.decider_actor_id=sqlc.arg(decider_actor_id)::text
  AND decision.status='pending'
  AND (decision.expires_at IS NULL OR decision.expires_at>clock_timestamp())
  AND decision.kind IN ('connector_write','runtime_permission','agent_change')
ORDER BY decision.created_at,decision.id;
