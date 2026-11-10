-- name: GetVoiceLiveReplyAgent :one
-- The live reply speaks as the Agent of an Agent direct Room, otherwise as the
-- Human's own AnotherMe when it is an active member of the Room.
SELECT agent.id,agent.tenant_id,agent.kind,agent.display_name,agent.account_id,agent.handle,agent.created_at
FROM actors agent
JOIN agent_registrations registration
  ON registration.actor_id=agent.id AND registration.tenant_id=agent.tenant_id AND registration.status='active'
JOIN active_room_members membership
  ON membership.room_id=sqlc.arg(room_id)::text AND membership.actor_id=agent.id
WHERE agent.kind='agent'
  AND agent.id=coalesce(
    (SELECT direct.direct_agent_actor_id FROM rooms direct
     WHERE direct.id=sqlc.arg(room_id)::text AND direct.direct_human_actor_id=sqlc.arg(human_actor_id)::text),
    (SELECT another_me.actor_id FROM agent_registrations another_me
     WHERE another_me.represented_human_actor_id=sqlc.arg(human_actor_id)::text
       AND another_me.agent_type='anotherme' AND another_me.status='active'
     ORDER BY another_me.actor_id LIMIT 1)
  );

-- name: GetVoiceLiveSessionForTurn :one
SELECT voice.id
FROM voice_sessions voice
WHERE voice.id=sqlc.arg(voice_session_id)::text
  AND voice.created_by_actor_id=sqlc.arg(actor_id)::text
  AND voice.room_id=sqlc.arg(room_id)::text
  AND voice.purpose='chat_live'
  AND voice.status IN ('provisioning','connected','reconnecting') AND voice.live_lease_until>clock_timestamp();

-- name: CreateVoiceLiveTurn :execrows
INSERT INTO voice_live_turns(voice_session_id,turn_id,human_message_id)
VALUES (sqlc.arg(voice_session_id)::text,sqlc.arg(turn_id)::text,sqlc.arg(human_message_id)::text)
ON CONFLICT DO NOTHING;

-- name: LockVoiceLiveTurn :one
SELECT * FROM voice_live_turns
WHERE voice_session_id=sqlc.arg(voice_session_id)::text AND turn_id=sqlc.arg(turn_id)::text
FOR UPDATE;

-- name: GetVoiceLiveReply :one
SELECT message_id FROM voice_live_replies
WHERE voice_session_id=sqlc.arg(voice_session_id)::text AND event_id=sqlc.arg(event_id)::text;

-- name: CreateVoiceLiveReply :exec
INSERT INTO voice_live_replies(voice_session_id,event_id,turn_id,message_id)
VALUES (sqlc.arg(voice_session_id)::text,sqlc.arg(event_id)::text,sqlc.arg(turn_id)::text,sqlc.arg(message_id)::text);

-- name: CancelVoiceLiveMessageForRoomAgents :exec
-- A live turn is answered by the live model; reuse Stop's cancellation fact so
-- no Room Agent accepts it while it stays in ordinary Room history.
INSERT INTO room_agent_message_cancellations(tenant_id,room_id,agent_actor_id,message_id)
SELECT message.tenant_id,message.room_id,membership.actor_id,message.id
FROM messages message
JOIN active_room_members membership
  ON membership.room_id=coalesce((SELECT parent_room_id FROM rooms WHERE id=message.room_id),message.room_id)
JOIN actors agent ON agent.id=membership.actor_id AND agent.tenant_id=message.tenant_id AND agent.kind='agent'
WHERE message.id=sqlc.arg(message_id)::text
ON CONFLICT DO NOTHING;

-- name: GetVoiceLiveToolCall :one
SELECT output,request_hash,state,name FROM voice_live_tool_calls
WHERE voice_session_id=sqlc.arg(voice_session_id)::text AND call_id=sqlc.arg(call_id)::text;

-- name: ClaimVoiceLiveToolCall :execrows
-- Admission commits before external effects. Retries never execute a sent call twice.
INSERT INTO voice_live_tool_calls(voice_session_id,call_id,turn_id,name,arguments,request_hash)
SELECT voice.id,sqlc.arg(call_id)::text,sqlc.arg(turn_id)::text,sqlc.arg(name)::text,
 sqlc.arg(arguments)::text,sqlc.arg(request_hash)::text
FROM voice_sessions voice
WHERE voice.id=sqlc.arg(voice_session_id)::text AND voice.purpose='chat_live'
 AND voice.status IN ('provisioning','connected','reconnecting')
 AND voice.live_lease_until>clock_timestamp()
ON CONFLICT DO NOTHING;

-- name: CompleteVoiceLiveToolCall :exec
UPDATE voice_live_tool_calls SET output=sqlc.arg(output)::text,state=sqlc.arg(state)::text
WHERE voice_session_id=sqlc.arg(voice_session_id)::text AND call_id=sqlc.arg(call_id)::text;

-- name: ListVoiceLiveUncertainOperations :many
SELECT call_id,name,arguments,state,created_at FROM voice_live_tool_calls
WHERE voice_session_id=sqlc.arg(voice_session_id)::text AND state<>'completed'
ORDER BY created_at,call_id LIMIT 20;

-- name: FindVoiceLiveRoomsForAccount :many
-- Rooms the Human can post in, matched by Room name or direct peer name.
SELECT room.id,
  coalesce(nullif(coalesce(direct_peer.display_name,''),''),room.name)::text AS name
FROM rooms room
JOIN actors caller ON caller.tenant_id=room.tenant_id AND caller.id=sqlc.arg(human_actor_id)::text AND caller.kind='human'
JOIN active_room_members membership ON membership.room_id=room.id AND membership.actor_id=caller.id
LEFT JOIN room_member_states participation
  ON participation.room_id=room.id AND participation.actor_id=caller.id
 AND participation.participation_epoch_id=membership.membership_epoch_id
LEFT JOIN rooms direct ON direct.id=room.id
LEFT JOIN actors direct_peer ON direct_peer.id=direct.direct_agent_actor_id AND direct_peer.tenant_id=direct.tenant_id
WHERE room.deleted_at IS NULL AND room.deletion_started_at IS NULL
  AND participation.left_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM rooms thread WHERE thread.id=room.id AND thread.parent_room_id IS NOT NULL)
  -- Task Work Rooms are never listed, as in the Room list.
  AND NOT EXISTS (SELECT 1 FROM work_item_room_links work WHERE work.room_id=room.id AND work.link_type='work')
  AND strpos(lower(coalesce(direct_peer.display_name,'') || ' ' || room.name),
    lower(sqlc.arg(query)::text))>0
ORDER BY room.updated_at DESC,room.id
LIMIT 10;

-- name: GetVoiceLiveReplySessionContext :one
-- A reply may still be saved shortly after its session closed: the Human can
-- exit Voice Mode while the last answer plays. Membership is still required.
SELECT voice.*,actor.account_id
FROM voice_sessions voice
JOIN actors actor
  ON actor.id=voice.created_by_actor_id AND actor.tenant_id=voice.tenant_id AND actor.kind='human'
JOIN active_room_members member ON member.room_id=voice.room_id AND member.actor_id=actor.id
JOIN rooms room ON room.id=voice.room_id AND room.deleted_at IS NULL
WHERE voice.id=sqlc.arg(voice_session_id)::text AND voice.purpose='chat_live'
  AND (voice.status IN ('provisioning','connected','reconnecting','closing')
    OR (voice.status='closed' AND voice.closed_at > now() - interval '60 seconds'));

-- name: ListVoiceLiveRoomRuns :many
-- Room Agent Runs of this Room that are unfinished or started since the given time.
SELECT run.run_id,run.status,run.created_at,run.finished_at,actor.display_name
FROM agent_local_runs run
JOIN agent_execution_contexts context ON context.context_key=run.context_key
JOIN actors actor ON actor.id=context.agent_actor_id AND actor.tenant_id=context.tenant_id
WHERE context.tenant_id=sqlc.arg(tenant_id)::text
  AND context.room_id=sqlc.arg(room_id)::text
  AND context.context_kind='meta'
  AND (run.created_at >= sqlc.arg(since)::timestamptz OR run.status IN ('queued','running'))
ORDER BY run.created_at DESC,run.run_id DESC
LIMIT 50;

-- name: GetVoiceLiveRoomLabel :one
-- The name the Human sees for a Room: the other side of a direct Room, else its name.
SELECT coalesce(agent_peer.display_name,room.name)::text AS label
FROM rooms room
LEFT JOIN rooms direct ON direct.id=room.id
LEFT JOIN actors agent_peer ON agent_peer.id=direct.direct_agent_actor_id AND agent_peer.tenant_id=direct.tenant_id
WHERE room.id=sqlc.arg(room_id)::text;

-- name: ListVoiceLiveDocumentImages :many
-- Images the Document's body references, in Asset ID order. The caller has
-- already checked the Human can read the Document.
SELECT asset.filename
FROM document_bodies body
JOIN document_assets asset
  ON asset.id=ANY(body.asset_ids) AND asset.document_id=body.document_id
 AND asset.media_type LIKE 'image/%'
WHERE body.document_id=sqlc.arg(document_id)::text
ORDER BY asset.id
LIMIT 20;

-- name: ListVoiceLiveTodayMessages :many
-- Conversation Messages since the given time in Rooms the Human is an active
-- member of (threads through their parent Room), newest first: what Memory has
-- not indexed yet when the Human asks about today.
SELECT message.body,message.created_at,author.display_name AS author,room.name AS room_name,
       coalesce(direct_peer.display_name,'')::text AS direct_peer
FROM messages message
JOIN rooms room ON room.id=message.room_id AND room.tenant_id=message.tenant_id
LEFT JOIN rooms thread ON thread.id=room.id
JOIN rooms access_room
  ON access_room.id=coalesce(thread.parent_room_id,room.id)
 AND access_room.deleted_at IS NULL AND access_room.deletion_started_at IS NULL
JOIN active_room_members membership
  ON membership.room_id=access_room.id AND membership.actor_id=sqlc.arg(human_actor_id)::text
JOIN actors author ON author.id=message.author_actor_id AND author.tenant_id=message.tenant_id
LEFT JOIN rooms direct ON direct.id=access_room.id
LEFT JOIN actors direct_peer ON direct_peer.id=direct.direct_agent_actor_id AND direct_peer.tenant_id=direct.tenant_id
WHERE message.tenant_id=sqlc.arg(tenant_id)::text
  AND message.created_at >= sqlc.arg(since)::timestamptz
  AND message.message_kind='conversation'
  AND btrim(message.body)<>''
  AND NOT EXISTS (SELECT 1 FROM work_item_room_links work WHERE work.room_id=access_room.id AND work.link_type='work')
ORDER BY message.created_at DESC,message.id DESC
LIMIT 15;

-- name: GetVoiceLiveUserMemory :one
-- The user's name and latest memory.md, for the live voice to know who it
-- talks to without a lookup.
SELECT actor.display_name,
  coalesce(memory.markdown,'')::text AS markdown
FROM actors actor
LEFT JOIN LATERAL (
  SELECT revision.markdown FROM user_memory_revisions revision
  WHERE revision.tenant_id=actor.tenant_id AND revision.owner_actor_id=actor.id
  ORDER BY revision.version DESC LIMIT 1
) memory ON true
WHERE actor.id=sqlc.arg(actor_id)::text AND actor.tenant_id=sqlc.arg(tenant_id)::text;

-- name: ListVoiceLiveRoomDocuments :many
-- Documents and files shared in a Room's Messages, newest first, with their
-- indexed text. Being shown in the Room is what lets its members read them.
SELECT DISTINCT ON (document.id) document.id::text AS document_id,document.title,
  coalesce(search.search_text,'')::text AS body_text,greatest(document.updated_at,(SELECT body.updated_at FROM document_bodies body WHERE body.document_id=document.id))::timestamptz AS updated_at,message.created_at AS shared_at
FROM messages message
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(message.segments)='array' THEN message.segments ELSE '[]'::jsonb END) segment
JOIN documents document ON document.id=segment.value->>'document_id' AND document.tenant_id=message.tenant_id
  AND document.status='active'
LEFT JOIN document_texts search ON search.document_id=document.id AND search.status='ready'
WHERE message.room_id=sqlc.arg(room_id)::text
  AND message.tenant_id=sqlc.arg(tenant_id)::text
  AND segment.value->>'type' IN ('document','file')
ORDER BY document.id,message.created_at DESC
LIMIT 50;

-- name: GetVoiceLiveComputerTarget :one
SELECT registration.agent_management_id::text AS agent_management_id,
       registration.computer_id::text AS computer_id
FROM agent_registrations registration
JOIN local_computers computer ON computer.computer_id=registration.computer_id
WHERE registration.actor_id=sqlc.arg(agent_actor_id)::text
 AND registration.tenant_id=sqlc.arg(tenant_id)::text
 AND registration.created_by_actor_id=sqlc.arg(human_actor_id)::text
 AND registration.status='active' AND computer.status='online';

-- name: CountVoiceLiveTurnToolCalls :one
-- How many calls of one tool a live turn already made.
SELECT count(*)::bigint FROM voice_live_tool_calls
WHERE voice_session_id=sqlc.arg(voice_session_id)::text
  AND turn_id=sqlc.arg(turn_id)::text AND name=sqlc.arg(name)::text;

-- name: GetLatestVoiceLiveToolOutput :one
-- The newest output this session returned for the tool, such as the page
-- the cloud browser showed last.
SELECT output FROM voice_live_tool_calls
WHERE voice_session_id=sqlc.arg(voice_session_id)::text AND name=sqlc.arg(name)::text
ORDER BY created_at DESC LIMIT 1;

-- name: SearchVoiceLiveMessagesForAccount :many
-- Keyword search over conversation Messages the caller can read across one
-- Tenant. Visibility is the Message list's: membership through the parent Room
-- for threads, and after leaving, only Messages up to each Room's own frozen
-- left_room_seq. The Room list exclusions also apply, so every hit opens
-- through an existing route. The query is one substring; both sides are
-- lower-cased here. The page is chosen from narrow rows first and only its
-- hits are joined to authors and Rooms, so a word found in every Message sorts
-- ids instead of whole rows.
WITH page AS (
  SELECT m.id, m.created_at
  FROM messages m
  JOIN rooms r ON r.id=m.room_id
  JOIN actors caller ON caller.tenant_id=r.tenant_id AND caller.account_id=sqlc.arg(account_id)::text AND caller.kind='human'
  JOIN rooms access_room
    ON access_room.id=COALESCE(r.parent_room_id, r.id)
   AND access_room.deleted_at IS NULL
   AND access_room.deletion_started_at IS NULL
  JOIN active_room_members membership
    ON membership.room_id=access_room.id AND membership.actor_id=caller.id
  -- Leaving is recorded on the Room that grants membership, while the frozen
  -- position is each Room's own: a thread numbers its Messages separately.
  -- Joining both per Room keeps the check off every matching Message.
  LEFT JOIN room_member_states departure
    ON departure.room_id=access_room.id AND departure.actor_id=caller.id
   AND departure.participation_epoch_id=membership.membership_epoch_id
   AND departure.left_at IS NOT NULL
  LEFT JOIN room_member_states frozen
    ON frozen.room_id=r.id AND frozen.actor_id=caller.id
   AND frozen.participation_epoch_id=membership.membership_epoch_id
   AND frozen.left_at IS NOT NULL
  WHERE r.tenant_id=sqlc.arg(tenant_id)::text
    AND r.deleted_at IS NULL
    AND r.deletion_started_at IS NULL
    AND (sqlc.arg(room_id)::text='' OR m.room_id=sqlc.arg(room_id)::text)
    AND m.message_kind='conversation'
    AND m.card_context_message_id IS NULL
    AND (departure.room_id IS NULL OR EXISTS (
      SELECT 1 FROM room_events saved
      WHERE saved.tenant_id=r.tenant_id AND saved.room_id=r.id AND saved.resource_id=m.id
        AND saved.event_type='message.created' AND saved.room_seq<=frozen.left_room_seq
    ))
    AND NOT EXISTS (
      SELECT 1 FROM work_item_room_links work_room
      WHERE work_room.tenant_id=r.tenant_id AND work_room.room_id=r.id AND work_room.link_type='work'
    )
    AND strpos(lower(m.body),lower(sqlc.arg(query)::text))>0
    AND (sqlc.arg(cursor)::text='' OR (m.created_at,m.id) < (
      SELECT created_at,id FROM messages WHERE id=sqlc.arg(cursor)::text
    ))
  ORDER BY m.created_at DESC, m.id DESC
  LIMIT sqlc.arg(page_limit)::int
)
SELECT m.id, m.tenant_id, m.room_id, m.author_actor_id, m.body, m.segments, m.message_kind,
       m.card_context_message_id, m.card_title, m.card_kind, m.created_at,
       m.reply_to_message_id,
       author.kind AS author_kind, author.display_name AS author_display_name,
       author.account_id AS author_account_id, author.handle AS author_handle,
       author.created_at AS author_created_at,
       r.name AS room_name,
       (r.direct_agent_actor_id IS NOT NULL)::boolean AS is_direct,
       coalesce(direct_peer.display_name,'')::text AS direct_peer_display_name,
       (r.parent_room_id IS NOT NULL)::boolean AS is_thread,
       coalesce(r.parent_room_id,'')::text AS parent_room_id,
       coalesce(r.root_message_id,'')::text AS root_message_id
FROM page
JOIN messages m ON m.id=page.id
JOIN rooms r ON r.id=m.room_id
JOIN actors author ON author.id=m.author_actor_id AND author.tenant_id=m.tenant_id
LEFT JOIN actors direct_peer
  ON direct_peer.id=r.direct_agent_actor_id AND direct_peer.tenant_id=r.tenant_id
ORDER BY page.created_at DESC, page.id DESC;

-- name: RenewVoiceLiveLease :execrows
UPDATE voice_sessions SET live_lease_until=clock_timestamp()+interval '45 seconds'
WHERE id=sqlc.arg(voice_session_id)::text AND purpose='chat_live'
 AND status IN ('provisioning','connected','reconnecting') AND live_lease_until>clock_timestamp();

-- name: VoiceLiveOwnsContext :one
SELECT voice_live_owns_context(sqlc.arg(context_key)::text)::boolean;

-- name: GetVoiceLiveHandoverForContext :one
SELECT voice.id,voice.room_id,voice.created_by_actor_id,voice.live_agent_actor_id
FROM agent_execution_contexts context JOIN voice_sessions voice
 ON voice.tenant_id=context.tenant_id AND voice.live_agent_actor_id=context.agent_actor_id
WHERE context.context_key=sqlc.arg(context_key)::text AND context.context_kind='meta'
 AND voice.purpose='chat_live' AND (voice.status IN ('closing','closed') OR voice.live_lease_until<=now())
 AND (voice.room_id=context.room_id OR EXISTS(SELECT 1 FROM voice_live_tasks task
  WHERE task.room_id=voice.room_id AND task.owner_actor_id=voice.created_by_actor_id AND task.home_room_id=context.room_id))
 AND EXISTS(SELECT 1 FROM active_room_members member WHERE member.room_id=voice.room_id AND member.actor_id=context.agent_actor_id)
 AND NOT EXISTS(SELECT 1 FROM agent_live_handover_receipts receipt
  JOIN agent_runtime_inputs input ON input.context_key=receipt.context_key AND input.input_id=receipt.input_id
  WHERE receipt.context_key=context.context_key AND receipt.voice_session_id=voice.id
   AND (input.status='steering' OR EXISTS(SELECT 1 FROM agent_local_run_inputs link
    JOIN agent_local_runs run ON run.run_id=link.run_id
    WHERE link.context_key=receipt.context_key AND link.input_id=receipt.input_id
     AND run.status IN ('queued','running','succeeded'))))
ORDER BY voice.created_at DESC,voice.id DESC LIMIT 1;

-- name: RecordVoiceLiveHandoverReceipt :exec
INSERT INTO agent_live_handover_receipts(context_key,voice_session_id,input_id)
VALUES(sqlc.arg(context_key)::text,sqlc.arg(voice_session_id)::text,sqlc.arg(input_id)::text)
ON CONFLICT(context_key,voice_session_id) DO UPDATE SET input_id=excluded.input_id,created_at=clock_timestamp();

-- name: ListVoiceLiveHandoverMessages :many
SELECT message.id,message.author_actor_id,author.display_name AS author,author.kind AS author_kind,message.created_at,
 left(message.body,1500)::text AS body,(char_length(message.body)>1500)::boolean AS truncated,
 ARRAY(SELECT DISTINCT reference->>'document_id' FROM agent_history_messages history
  CROSS JOIN LATERAL jsonb_array_elements(history.resource_references) reference
  WHERE history.message_id=message.id AND history.tenant_id=message.tenant_id
  ORDER BY reference->>'document_id')::text[] AS document_ids
FROM messages message JOIN actors author ON author.id=message.author_actor_id
WHERE message.room_id=sqlc.arg(room_id)::text AND message.message_kind='conversation'
ORDER BY message.created_at DESC,message.id DESC LIMIT 20;

-- name: ListVoiceLiveHandoverTasks :many
SELECT task.work_item_id,task.ordinal,task.goal,task.home_room_id,
 coalesce(item.task_execution_status,'')::text AS state,
 coalesce(report.id,'')::text AS report_id,coalesce(left(report.body,1000),'')::text AS report,
 coalesce(char_length(report.body)>1000,false)::boolean AS report_truncated,
 coalesce((SELECT delivery.message_id FROM voice_live_report_deliveries delivery WHERE delivery.report_id=report.id),'')::text AS delivered_message_id
FROM voice_live_tasks task JOIN work_items item ON item.id=task.work_item_id
LEFT JOIN LATERAL(SELECT message.id,message.body FROM task_meta_callback_messages message
 WHERE message.task_id=task.work_item_id AND message.generation=item.task_execution_generation
 ORDER BY message.meta_seq DESC LIMIT 1) report ON true
WHERE task.room_id=sqlc.arg(room_id)::text AND task.owner_actor_id=sqlc.arg(owner_actor_id)::text
 AND task.canceled_at IS NULL AND item.archived_at IS NULL
ORDER BY task.ordinal DESC LIMIT 20;

-- name: AttachVoiceLiveHandoverToInput :exec
UPDATE agent_runtime_inputs SET payload=sqlc.arg(payload)::jsonb,payload_hash=sqlc.arg(payload_hash)::bytea,updated_at=clock_timestamp()
WHERE context_key=sqlc.arg(context_key)::text AND input_id=sqlc.arg(input_id)::text;

-- name: VoiceLiveForegroundSwitching :one
-- A running Meta Run of a Context the live voice owns means the previous
-- foreground is still stopping.
SELECT EXISTS(
  SELECT 1 FROM agent_local_runs run
  JOIN agent_execution_contexts context ON context.context_key=run.context_key
  WHERE run.status='running' AND context.context_kind='meta'
    AND context.agent_actor_id=sqlc.arg(agent_actor_id)::text AND context.tenant_id=sqlc.arg(tenant_id)::text
    AND voice_live_owns_context(context.context_key)
)::boolean;

-- name: LockVoiceLiveSessionCurrent :one
-- Locks the VoiceSession so close and lease loss serialize against a
-- publication, and reports whether it still holds the live lease.
SELECT (status IN ('provisioning','connected','reconnecting') AND live_lease_until>clock_timestamp())::boolean
FROM voice_sessions WHERE id=sqlc.arg(id)::text FOR UPDATE;

-- name: VoiceLiveTaskCoordinatedBy :one
SELECT EXISTS(
  SELECT 1 FROM task_meta_callbacks callback
  JOIN work_items item ON item.id=callback.task_id AND item.task_execution_generation=callback.generation
  WHERE callback.task_id=sqlc.arg(task_id)::text AND callback.tenant_id=sqlc.arg(tenant_id)::text
    AND callback.coordinator_actor_id=sqlc.arg(coordinator_actor_id)::text AND item.archived_at IS NULL
)::boolean;

-- name: GetVoiceLiveReportTask :one
SELECT message.task_id FROM task_meta_callback_messages message
JOIN task_meta_callbacks callback ON callback.task_id=message.task_id AND callback.generation=message.generation
WHERE message.id=sqlc.arg(report_id)::text AND message.task_id=sqlc.arg(task_id)::text
  AND callback.coordinator_actor_id=sqlc.arg(coordinator_actor_id)::text AND callback.tenant_id=sqlc.arg(tenant_id)::text;

-- name: GetVoiceLiveReportDelivery :one
SELECT message_id FROM voice_live_report_deliveries WHERE report_id=sqlc.arg(report_id)::text;

-- name: LockVoiceLiveReport :exec
SELECT id FROM task_meta_callback_messages WHERE id=sqlc.arg(report_id)::text FOR UPDATE;

-- name: CreateVoiceLiveReportDelivery :exec
INSERT INTO voice_live_report_deliveries(report_id,voice_session_id,message_id)
VALUES(sqlc.arg(report_id)::text,sqlc.arg(voice_session_id)::text,sqlc.arg(message_id)::text);

-- name: MarkVoiceLiveReportNonActionable :exec
UPDATE task_meta_callback_messages SET non_actionable=true WHERE id=sqlc.arg(report_id)::text;

-- name: ListVoiceLiveRecentToolCalls :many
-- This call's latest tool calls, newest first, for the Documents they named.
SELECT name, arguments, output FROM voice_live_tool_calls
WHERE voice_session_id=sqlc.arg(voice_session_id)::text
ORDER BY created_at DESC LIMIT 200;

-- name: ListVoiceLiveDocumentTitles :many
SELECT id::text AS document_id, title FROM documents
WHERE id=ANY(sqlc.arg(document_ids)::text[]) AND tenant_id=sqlc.arg(tenant_id)::text AND status='active';

-- name: GetVoiceLiveDocumentTitle :one
-- The title a file the live voice sends is named after; its download
-- already checked the Agent reads it.
SELECT title FROM documents WHERE id=sqlc.arg(document_id)::text AND tenant_id=sqlc.arg(tenant_id)::text;

-- name: SnapshotVoiceLiveCanvasRevision :one
SELECT snapshot_document_body(body.document_id)::text FROM document_bodies body
JOIN documents document ON document.id=body.document_id
WHERE body.document_id=sqlc.arg(document_id)::text AND document.tenant_id=sqlc.arg(tenant_id)::text;

-- name: GetVoiceLiveDocumentBodyState :one
-- The persisted sequence and full-state fingerprint a comment anchor attaches against.
SELECT body.seq, encode(sha256(body.state),'hex')::text AS fingerprint
FROM document_bodies body
JOIN documents document ON document.id=body.document_id
WHERE body.document_id=sqlc.arg(document_id)::text AND document.tenant_id=sqlc.arg(tenant_id)::text;

-- name: GetVoiceLiveSlackUser :one
-- The Slack user a connection was identified as, so the live voice need not
-- ask Slack who the user is on every call.
SELECT coalesce(remote_user_id,'')::text FROM external_connections
WHERE id=sqlc.arg(connection_id)::text AND provider='slack';

-- name: IsVoiceLiveTaskWorkRoom :one
-- A Task's own working Room: its results go back to the Room it came from,
-- so the live voice neither offers nor opens it unasked.
SELECT EXISTS(
  SELECT 1 FROM work_item_room_links
  WHERE room_id=sqlc.arg(room_id)::text AND link_type='work'
);
