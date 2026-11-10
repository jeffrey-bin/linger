-- +goose Up
-- A Human can resend a follow-up whose steer ended uncertain. The resend
-- places the same Inbox notification again the way a new Message would, so
-- placement moves into its own function that both callers share.
-- +goose StatementBegin
CREATE FUNCTION place_agent_inbox_input(
 p_context text, p_inbox text, p_message text, p_input text, p_payload jsonb, p_targeted boolean)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
 v_run text;
 v_candidate text;
 v_ordinal bigint := 0;
BEGIN
 IF p_targeted THEN
  SELECT run.run_id INTO v_run FROM agent_local_runs run
  WHERE run.context_key=p_context AND run.status='running' AND NOT run.cancellation_requested
   AND EXISTS (
    SELECT 1 FROM agent_local_run_inputs relation
    JOIN agent_runtime_inputs input ON input.context_key=relation.context_key AND input.input_id=relation.input_id
    WHERE relation.run_id=run.run_id AND input.payload->'sourceInboxIds' @> jsonb_build_array(p_inbox));
  IF v_run IS NOT NULL THEN
   INSERT INTO agent_runtime_inputs(context_key,input_id,payload,payload_hash,source_kind,source_message_id,source_inbox_id,
    status,selection_result,steer_group_id)
   VALUES(p_context,p_input,p_payload,sha256(convert_to(p_payload::text,'UTF8')),'inbox',p_message,p_inbox,
    'steering','{"selected":"trusted_inbox_notification"}'::jsonb,'steer-'||replace(gen_random_uuid()::text,'-',''));
   PERFORM publish_teamhub_realtime_wake('agent-inbox:all','run.steered',p_context,0,0);
   RETURN;
  END IF;
 END IF;
 SELECT run.run_id INTO v_candidate FROM agent_local_runs run
 WHERE run.context_key=p_context AND run.status='queued'
 ORDER BY run.created_at DESC,run.run_id DESC LIMIT 1;
 IF v_candidate IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM agent_local_run_inputs relation
  JOIN agent_runtime_inputs input ON input.context_key=relation.context_key AND input.input_id=relation.input_id
  WHERE relation.run_id=v_candidate AND (input.source_kind<>'inbox' OR input.source_inbox_id IS DISTINCT FROM p_inbox
   OR input.selection_result->>'selected' IS DISTINCT FROM 'trusted_inbox_notification')) THEN
  -- A Run being claimed or canceled keeps its Inputs; this Message starts the next one.
  SELECT run.run_id INTO v_run FROM agent_local_runs run
  WHERE run.run_id=v_candidate AND run.context_key=p_context AND run.status='queued' AND NOT run.cancellation_requested
  FOR NO KEY UPDATE SKIP LOCKED;
 END IF;
 IF v_run IS NULL THEN
  v_run := 'local-run-'||replace(gen_random_uuid()::text,'-','');
  INSERT INTO agent_local_runs(run_id,context_key,status) VALUES(v_run,p_context,'queued');
 ELSE
  SELECT coalesce(max(relation.ordinal)+1,0) INTO v_ordinal FROM agent_local_run_inputs relation
  WHERE relation.run_id=v_run AND relation.relation='initial';
 END IF;
 INSERT INTO agent_runtime_inputs(context_key,input_id,payload,payload_hash,source_kind,source_message_id,source_inbox_id,
  status,selection_result,local_run_id)
 VALUES(p_context,p_input,p_payload,sha256(convert_to(p_payload::text,'UTF8')),'inbox',p_message,p_inbox,
  'handled','{"selected":"trusted_inbox_notification","effective":"enqueue"}'::jsonb,v_run);
 INSERT INTO agent_local_run_inputs(run_id,context_key,input_id,relation,ordinal)
 VALUES(v_run,p_context,p_input,'initial',v_ordinal);
 PERFORM publish_teamhub_realtime_wake('agent-inbox:all','run.queued',p_context,0,0);
END;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION queue_agent_inbox_notification(
 p_context text, p_inbox text, p_tenant text, p_message text, p_sequence bigint, p_mentioned boolean)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
 v_context agent_execution_contexts%ROWTYPE;
 v_targeted boolean;
 v_input text := 'inbox-input-'||replace(gen_random_uuid()::text,'-','');
 v_payload jsonb;
BEGIN
 SELECT * INTO v_context FROM agent_execution_contexts WHERE context_key=p_context;
 IF NOT FOUND OR v_context.terminal_reason IS NOT NULL OR v_context.task_archive_suspended THEN
  RETURN;
 END IF;
 IF EXISTS (SELECT 1 FROM agent_runtime_inputs WHERE context_key=p_context AND source_message_id=p_message) THEN
  RETURN;
 END IF;
 v_targeted := p_mentioned OR starts_with(p_inbox,'taskmeta:');
 v_payload := agent_inbox_notification_payload(v_input,p_tenant,v_context.agent_actor_id,p_inbox,p_message,coalesce(p_sequence,0),p_mentioned,v_targeted);
 IF v_payload IS NULL THEN
  RETURN;
 END IF;
 PERFORM place_agent_inbox_input(p_context,p_inbox,p_message,v_input,v_payload,v_targeted);
END;
$$;
-- +goose StatementEnd

-- Returns the new input ID, or NULL when the input is not an uncertain Inbox
-- follow-up, its Message is gone, the Context no longer takes input, or the
-- Message already reached the Context again after it. That last guard makes a
-- repeated resend a no-op until the resent input itself ends uncertain.
-- Runtime question answers are internal inputs and never qualify: their Run
-- is gone, so placing them again has nothing to answer.
-- +goose StatementBegin
CREATE FUNCTION redeliver_agent_runtime_input(p_context text, p_input text)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
 v_context agent_execution_contexts%ROWTYPE;
 v_source agent_runtime_inputs%ROWTYPE;
 v_input text := 'inbox-input-'||replace(gen_random_uuid()::text,'-','');
 v_payload jsonb;
BEGIN
 SELECT * INTO v_context FROM agent_execution_contexts WHERE context_key=p_context;
 IF NOT FOUND OR v_context.terminal_reason IS NOT NULL OR v_context.task_archive_suspended THEN
  RETURN NULL;
 END IF;
 SELECT * INTO v_source FROM agent_runtime_inputs
 WHERE context_key=p_context AND input_id=p_input AND steer_outcome='uncertain' AND source_kind='inbox'
  AND source_message_id IS NOT NULL AND source_inbox_id IS NOT NULL;
 IF NOT FOUND THEN
  RETURN NULL;
 END IF;
 IF (starts_with(v_source.source_inbox_id,'taskmeta:') AND NOT EXISTS (SELECT 1 FROM task_meta_callback_messages message
    WHERE message.id=v_source.source_message_id AND message.tenant_id=v_context.tenant_id))
  OR (NOT starts_with(v_source.source_inbox_id,'taskmeta:') AND NOT EXISTS (SELECT 1 FROM messages message
    WHERE message.id=v_source.source_message_id AND message.tenant_id=v_context.tenant_id)) THEN
  RETURN NULL;
 END IF;
 IF EXISTS (SELECT 1 FROM agent_runtime_inputs input
  WHERE input.context_key=p_context AND input.source_message_id=v_source.source_message_id
   AND input.input_sequence>v_source.input_sequence) THEN
  RETURN NULL;
 END IF;
 v_payload := jsonb_set(v_source.payload,'{messageId}',to_jsonb(v_input));
 PERFORM place_agent_inbox_input(p_context,v_source.source_inbox_id,v_source.source_message_id,v_input,v_payload,
  (v_source.payload->'acceptedNotification'->>'targeted')::boolean);
 RETURN v_input;
END;
$$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
    RAISE EXCEPTION 'follow-up redelivery is forward-only';
END $$;
-- +goose StatementEnd
