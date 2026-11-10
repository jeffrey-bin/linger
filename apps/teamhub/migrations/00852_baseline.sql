-- TeamHub schema baseline: pg_dump --schema-only of the complete schema on PostgreSQL 17.
-- Business tables start empty; TeamHub installs the built-in Skills at startup.
-- A few view columns carry same-type casts so sqlc infers their Go types;
-- PostgreSQL drops those casts, so the stored schema matches the dump.
-- +goose Up
-- +goose StatementBegin
SET LOCAL check_function_bodies = false;
DO $$ BEGIN
    IF to_regclass('public.accounts') IS NOT NULL THEN
        RAISE EXCEPTION 'The TeamHub schema baseline needs an empty database; this database already holds a TeamHub schema. Recreate it before migrating.';
    END IF;
END $$;

CREATE SCHEMA memory_index;

CREATE SCHEMA memory_source;

CREATE TYPE public.river_job_state AS ENUM (
    'available',
    'cancelled',
    'completed',
    'discarded',
    'pending',
    'retryable',
    'running',
    'scheduled'
);

CREATE FUNCTION memory_source.clear_proactive_learning(p_tenant_id text, p_owner_actor_id text, p_before timestamp with time zone) RETURNS void
    LANGUAGE sql
    AS $$
DELETE FROM proactive_outputs
WHERE tenant_id = p_tenant_id AND owner_actor_id = p_owner_actor_id AND created_at < p_before;
DELETE FROM proactive_potential_items
WHERE tenant_id = p_tenant_id AND owner_actor_id = p_owner_actor_id AND created_at < p_before;
$$;

CREATE FUNCTION memory_source.human_can_read_document(p_actor_id text, p_tenant_id text, p_document_id text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
SELECT EXISTS (
    SELECT 1 FROM actors principal
    JOIN documents document ON document.id=p_document_id AND document.tenant_id=principal.tenant_id
      AND document.status='active'
    WHERE principal.id=p_actor_id AND principal.tenant_id=p_tenant_id AND principal.kind='human'
)
$$;

CREATE FUNCTION memory_source.personal_document_markdown(p_tenant_id text, p_owner_actor_id text, p_document_ids text[]) RETURNS TABLE(document_id text, markdown_sha256 text, markdown text)
    LANGUAGE sql STABLE
    AS $$
SELECT personal.document_id, text.markdown_sha256, text.markdown
FROM memory_source.personal_documents(p_tenant_id, p_owner_actor_id) personal
JOIN document_texts text
  ON text.document_id = personal.document_id
 AND text.status = 'ready'
 AND text.markdown_sha256 = personal.markdown_sha256
WHERE personal.document_id = ANY(p_document_ids)
$$;

CREATE FUNCTION memory_source.personal_documents(p_tenant_id text, p_owner_actor_id text) RETURNS TABLE(folder_path text, origin_kind text, document_id text, text_source_kind text, text_source_id text, title text, filename text, media_type text, markdown_sha256 text, created_at timestamp with time zone)
    LANGUAGE sql STABLE
    AS $$
WITH RECURSIVE tree AS (
    SELECT placement.id, placement.parent_id, placement.node_kind,
        placement.name, placement.document_id,
        CASE WHEN placement.node_kind = 'folder' THEN placement.name ELSE '' END AS folder_path
    FROM document_placements placement
    WHERE placement.tenant_id = p_tenant_id
      AND placement.owner_human_actor_id = p_owner_actor_id
      AND placement.scope_kind = 'personal'
      AND placement.parent_id IS NULL
      AND placement.deleted_at IS NULL
    UNION ALL
    SELECT child.id, child.parent_id, child.node_kind, child.name,
        child.document_id,
        CASE WHEN child.node_kind = 'folder'
            THEN concat_ws('/', nullif(tree.folder_path, ''), child.name)
            ELSE tree.folder_path END
    FROM document_placements child
    JOIN tree ON tree.id = child.parent_id
    WHERE child.tenant_id = p_tenant_id
      AND child.owner_human_actor_id = p_owner_actor_id
      AND child.scope_kind = 'personal'
      AND child.deleted_at IS NULL
), candidates AS (
    SELECT tree.document_id, tree.folder_path, 'my_pages'::text AS origin_kind
    FROM tree
    WHERE tree.node_kind = 'document'
    UNION ALL
    SELECT item.document_id, '', 'mail'
    FROM wiki_source_items item
    JOIN document_context_bindings binding
      ON binding.document_id = item.document_id
     AND binding.tenant_id = item.tenant_id
     AND binding.binding_kind = 'wiki_source'
     AND binding.status = 'active'
    JOIN personal_wikis wiki
      ON wiki.id = binding.wiki_id
     AND wiki.tenant_id = item.tenant_id
     AND wiki.owner_actor_id = item.owner_actor_id
     AND wiki.deleted_at IS NULL
    WHERE item.tenant_id = p_tenant_id
      AND item.owner_actor_id = p_owner_actor_id
), current_documents AS (
    SELECT DISTINCT ON (candidates.document_id)
        candidates.document_id, candidates.folder_path, candidates.origin_kind
    FROM candidates
    ORDER BY candidates.document_id, candidates.origin_kind, candidates.folder_path
)
SELECT current_documents.folder_path,
    current_documents.origin_kind,
    document.id,
    text.source_kind,
    text.source_id,
    document.title,
    coalesce(version.filename, document.title),
    coalesce(version.media_type, 'text/markdown'),
    text.markdown_sha256,
    coalesce(version.created_at, text.updated_at)
FROM current_documents
JOIN documents document
  ON document.id = current_documents.document_id
 AND document.tenant_id = p_tenant_id
 AND document.status = 'active'
JOIN document_texts text
  ON text.document_id = document.id
 AND text.status = 'ready'
LEFT JOIN document_versions version
  ON text.source_kind = 'file_version'
 AND version.id = text.source_id
 AND version.document_id = document.id
WHERE NOT EXISTS (
    SELECT 1 FROM document_context_bindings page
    WHERE page.document_id = document.id AND page.tenant_id = document.tenant_id
      AND page.binding_kind = 'wiki_page')
  AND (text.source_kind = 'native_body'
       OR EXISTS (SELECT 1 FROM document_text_heads head
                  WHERE head.id = document.id AND head.tenant_id = document.tenant_id))
ORDER BY current_documents.folder_path, document.id
$$;

CREATE FUNCTION memory_source.proactive_exchanges(p_tenant_id text, p_owner_actor_id text, p_before timestamp with time zone) RETURNS TABLE(message_id text, source text, output_body text, output_at timestamp with time zone, "position" integer, author text, author_kind text, body text, at timestamp with time zone)
    LANGUAGE sql STABLE
    AS $$
SELECT output.message_id, output.source, first_message.body,
    first_message.created_at,
    coalesce(later.position, 0)::int,
    coalesce(later.author, ''),
    coalesce(later.author_kind, ''),
    coalesce(later.body, ''),
    later.created_at
FROM proactive_outputs output
JOIN messages first_message ON first_message.id = output.message_id
LEFT JOIN LATERAL (
    SELECT row_number() OVER (ORDER BY next_message.created_at, next_message.id)::int AS position,
        author.display_name AS author, author.kind AS author_kind, next_message.body,
        next_message.created_at
    FROM messages next_message
    JOIN actors author ON author.id = next_message.author_actor_id AND author.tenant_id = next_message.tenant_id
    WHERE next_message.room_id = output.room_id
      AND next_message.tenant_id = output.tenant_id
      AND next_message.message_kind = 'conversation'
      AND (next_message.created_at, next_message.id) > (first_message.created_at, first_message.id)
    ORDER BY next_message.created_at, next_message.id
    LIMIT 20
) later ON true
WHERE output.tenant_id = p_tenant_id AND output.owner_actor_id = p_owner_actor_id
  AND output.created_at < p_before
ORDER BY output.created_at, output.message_id, later.position
$$;

CREATE FUNCTION memory_source.record_proactive_guideline(p_tenant_id text, p_owner_actor_id text, p_version integer, p_specific jsonb, p_clues jsonb, p_change_note text) RETURNS void
    LANGUAGE sql
    AS $$
INSERT INTO proactive_guidelines (tenant_id, owner_actor_id, version, specific, clues, change_note)
VALUES (p_tenant_id, p_owner_actor_id, p_version, p_specific, p_clues, p_change_note)
$$;

CREATE FUNCTION memory_source.record_user_memory_revision(p_tenant_id text, p_owner_actor_id text, p_version integer, p_sections jsonb, p_markdown text, p_base_profile_revision_id text, p_change_note text, p_source text, p_evidence jsonb) RETURNS void
    LANGUAGE sql
    AS $$
INSERT INTO user_memory_revisions (tenant_id, owner_actor_id, version, sections, markdown, base_profile_revision_id, change_note, source, evidence)
VALUES (p_tenant_id, p_owner_actor_id, p_version, p_sections, p_markdown, p_base_profile_revision_id, p_change_note, p_source, p_evidence)
$$;

CREATE FUNCTION public.actor_can_read_inbox(p_tenant text, p_actor text, p_inbox text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
 SELECT CASE
 WHEN left(p_inbox,5)='room:' OR left(p_inbox,7)='thread:' THEN EXISTS(
   SELECT 1 FROM rooms room JOIN rooms parent ON parent.id=collaboration_membership_room_id(room.id) AND parent.tenant_id=room.tenant_id
   JOIN active_room_members membership ON membership.room_id=parent.id AND membership.tenant_id=p_tenant AND membership.actor_id=p_actor
   WHERE room.id=agent_inbox_resource_room(p_tenant,p_inbox) AND room.tenant_id=p_tenant
     AND room.deleted_at IS NULL AND room.deletion_started_at IS NULL AND parent.deleted_at IS NULL AND parent.deletion_started_at IS NULL)
 WHEN left(p_inbox,5)='task:' THEN EXISTS(
   SELECT 1 FROM work_items item JOIN work_item_room_links link ON link.work_item_id=item.id AND link.tenant_id=item.tenant_id AND link.link_type='work'
   JOIN rooms room ON room.id=link.room_id AND room.tenant_id=item.tenant_id AND room.deleted_at IS NULL AND room.deletion_started_at IS NULL
   LEFT JOIN task_execution_generations generation ON generation.task_id=item.id AND generation.tenant_id=item.tenant_id AND generation.generation=item.task_execution_generation
   WHERE item.id=substring(p_inbox FROM 6) AND item.tenant_id=p_tenant AND item.kind='task'
    AND (generation.coordinator_actor_id=p_actor
     OR EXISTS(SELECT 1 FROM active_room_members membership WHERE membership.room_id=room.id AND membership.actor_id=p_actor AND room_actor_participating(room.id,p_actor))
     OR EXISTS(SELECT 1 FROM work_item_assignments assignment WHERE assignment.work_item_id=item.id AND assignment.tenant_id=p_tenant AND assignment.actor_id=p_actor)
     OR EXISTS(SELECT 1 FROM task_execution_participants participant WHERE participant.task_id=item.id AND participant.tenant_id=p_tenant AND participant.generation=item.task_execution_generation AND participant.actor_id=p_actor)))
 WHEN left(p_inbox,5)='meta:' THEN EXISTS(
   SELECT 1 FROM task_meta_inboxes inbox JOIN work_items item ON item.id=inbox.task_id AND item.tenant_id=inbox.tenant_id AND item.kind='task'
   JOIN task_execution_generations generation ON generation.task_id=item.id AND generation.tenant_id=item.tenant_id AND generation.generation=item.task_execution_generation
   JOIN task_execution_participants participant ON participant.task_id=item.id AND participant.tenant_id=item.tenant_id AND participant.generation=item.task_execution_generation AND participant.actor_id=inbox.agent_actor_id
   JOIN actors actor ON actor.id=p_actor AND actor.tenant_id=p_tenant AND actor.kind='agent'
   WHERE inbox.tenant_id=p_tenant AND p_inbox='meta:'||inbox.agent_actor_id||':'||inbox.task_id AND (inbox.agent_actor_id=p_actor OR generation.coordinator_actor_id=p_actor))
 WHEN left(p_inbox,9)='taskmeta:' THEN EXISTS(
   SELECT 1 FROM task_meta_callbacks callback JOIN work_items item ON item.id=callback.task_id AND item.tenant_id=callback.tenant_id AND item.kind='task' AND item.task_execution_generation=callback.generation
   JOIN task_execution_generations generation ON generation.task_id=item.id AND generation.tenant_id=item.tenant_id AND generation.generation=item.task_execution_generation AND generation.coordinator_actor_id=callback.coordinator_actor_id AND generation.coordinator_context_key=callback.coordinator_context_key
   WHERE callback.task_id=substring(p_inbox FROM 10) AND callback.tenant_id=p_tenant AND callback.coordinator_actor_id=p_actor)
 ELSE false END;
$$;

CREATE FUNCTION public.actor_inbox_visible_through(p_tenant text, p_actor text, p_inbox text) RETURNS bigint
    LANGUAGE sql STABLE
    AS $$
 SELECT CASE WHEN NOT actor_can_read_inbox(p_tenant,p_actor,p_inbox) THEN 0
 WHEN (left(p_inbox,5)='room:' OR left(p_inbox,7)='thread:') AND NOT room_actor_participating(agent_inbox_resource_room(p_tenant,p_inbox),p_actor) THEN
   coalesce((SELECT state.left_room_seq FROM room_member_states state JOIN active_room_members membership ON membership.room_id=collaboration_membership_room_id(state.room_id) AND membership.actor_id=state.actor_id AND membership.membership_epoch_id=state.participation_epoch_id WHERE state.room_id=agent_inbox_resource_room(p_tenant,p_inbox) AND state.actor_id=p_actor AND state.left_at IS NOT NULL),0)
 ELSE 9223372036854775807 END::bigint;
$$;

CREATE FUNCTION public.agent_context_can_receive_inbox(p_context text, p_inbox text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
 SELECT EXISTS(SELECT 1 FROM agent_execution_contexts context WHERE context.context_key=p_context AND context.terminal_reason IS NULL
  AND actor_can_read_inbox(context.tenant_id,context.agent_actor_id,p_inbox)
  AND NOT (left(p_inbox,5)='room:' AND (
    EXISTS(SELECT 1 FROM rooms thread WHERE thread.id=substring(p_inbox FROM 6) AND thread.tenant_id=context.tenant_id AND thread.parent_room_id IS NOT NULL)
    OR EXISTS(SELECT 1 FROM work_item_room_links link JOIN work_items item ON item.id=link.work_item_id AND item.tenant_id=link.tenant_id AND item.kind='task'
      WHERE link.room_id=substring(p_inbox FROM 6) AND link.tenant_id=context.tenant_id AND link.link_type='work')))
  AND CASE
  WHEN left(p_inbox,5)='meta:' THEN context.context_kind='alter_ego' AND context.task_id IS NOT NULL AND p_inbox='meta:'||context.agent_actor_id||':'||context.task_id
    AND EXISTS(SELECT 1 FROM work_items item JOIN task_execution_participants participant ON participant.task_id=item.id AND participant.tenant_id=item.tenant_id AND participant.generation=item.task_execution_generation AND participant.actor_id=context.agent_actor_id AND participant.agent_management_id=context.agent_management_id WHERE item.id=context.task_id AND item.tenant_id=context.tenant_id AND item.archived_at IS NULL)
  WHEN left(p_inbox,9)='taskmeta:' THEN context.context_kind='meta' AND EXISTS(SELECT 1 FROM task_meta_callbacks callback JOIN work_items item ON item.id=callback.task_id AND item.tenant_id=callback.tenant_id AND item.task_execution_generation=callback.generation AND item.archived_at IS NULL WHERE callback.task_id=substring(p_inbox FROM 10) AND callback.tenant_id=context.tenant_id AND callback.coordinator_actor_id=context.agent_actor_id AND callback.coordinator_context_key=p_context)
  WHEN left(p_inbox,5)='task:' THEN context.context_kind='meta' AND EXISTS(
    SELECT 1 FROM work_items item JOIN work_item_room_links link ON link.work_item_id=item.id AND link.tenant_id=item.tenant_id AND link.link_type='work'
    JOIN task_execution_generations generation ON generation.task_id=item.id AND generation.tenant_id=item.tenant_id AND generation.generation=item.task_execution_generation
    WHERE item.id=substring(p_inbox FROM 6) AND item.tenant_id=context.tenant_id AND item.archived_at IS NULL
    AND (generation.coordinator_context_key=p_context AND generation.coordinator_actor_id=context.agent_actor_id
     OR generation.coordinator_context_key IS NULL AND (context.room_id=link.room_id AND EXISTS(SELECT 1 FROM active_room_members membership WHERE membership.room_id=context.room_id AND membership.tenant_id=context.tenant_id AND membership.actor_id=context.agent_actor_id AND membership.membership_epoch_id=context.membership_epoch_id))))
  WHEN left(p_inbox,5)='room:' OR left(p_inbox,7)='thread:' THEN context.context_kind='meta'
    AND room_actor_participating(agent_inbox_resource_room(context.tenant_id,p_inbox),context.agent_actor_id)
    AND (context.room_id=collaboration_membership_room_id(agent_inbox_resource_room(context.tenant_id,p_inbox))
      AND EXISTS(SELECT 1 FROM active_room_members membership WHERE membership.room_id=context.room_id AND membership.tenant_id=context.tenant_id AND membership.actor_id=context.agent_actor_id AND membership.membership_epoch_id=context.membership_epoch_id))
    AND (left(p_inbox,7)<>'thread:' OR EXISTS(SELECT 1 FROM rooms thread JOIN messages root ON root.id=thread.root_message_id WHERE thread.id=substring(p_inbox FROM 8) AND thread.tenant_id=context.tenant_id AND (root.author_actor_id=context.agent_actor_id OR EXISTS(SELECT 1 FROM thread_room_list_actors listed WHERE listed.thread_room_id=thread.id AND listed.tenant_id=thread.tenant_id AND listed.actor_id=context.agent_actor_id))))
  ELSE false END);
$$;

CREATE FUNCTION public.agent_context_inboxes(p_context text) RETURNS TABLE(inbox_id text, head bigint, cursor_encoding text, room_id text, parent_room_id text, task_id text, coordinator_context_key text)
    LANGUAGE sql STABLE
    AS $$
 WITH owner AS (
  SELECT context.* FROM agent_execution_contexts context
  WHERE context.context_key=p_context AND context.terminal_reason IS NULL
 )
 SELECT 'room:'||room.id,room.next_room_seq,'room_event_v1',room.id,NULL::text,NULL::text,NULL::text
 FROM owner JOIN rooms room ON room.id=owner.room_id AND room.tenant_id=owner.tenant_id
 WHERE owner.context_kind='meta'
  AND room.parent_room_id IS NULL
  AND NOT EXISTS(SELECT 1 FROM work_item_room_links link JOIN work_items item ON item.id=link.work_item_id AND item.tenant_id=link.tenant_id AND item.kind='task'
   WHERE link.room_id=room.id AND link.link_type='work')
 UNION ALL
 SELECT 'thread:'||room.id,room.next_room_seq,'room_event_v1',room.id,room.parent_room_id,NULL,NULL
 FROM owner JOIN rooms room ON room.parent_room_id=owner.room_id AND room.tenant_id=owner.tenant_id
 WHERE owner.context_kind='meta'
 UNION ALL
 SELECT 'task:'||item.id,room.next_room_seq,'room_event_v1',room.id,NULL,item.id,generation.coordinator_context_key
 FROM owner
 -- The Task's current coordinator, or the Work Room's own Meta while no
 -- coordinator is bound.
 JOIN LATERAL (
  SELECT generation.task_id FROM task_execution_generations generation
  WHERE generation.tenant_id=owner.tenant_id AND generation.coordinator_context_key=owner.context_key
  UNION
  SELECT link.work_item_id FROM work_item_room_links link
  WHERE link.room_id=owner.room_id AND link.tenant_id=owner.tenant_id AND link.link_type='work'
 ) candidate ON true
 JOIN work_items item ON item.id=candidate.task_id AND item.tenant_id=owner.tenant_id AND item.kind='task' AND item.archived_at IS NULL
 JOIN work_item_room_links link ON link.work_item_id=item.id AND link.tenant_id=item.tenant_id AND link.link_type='work'
 JOIN rooms room ON room.id=link.room_id AND room.tenant_id=link.tenant_id
 JOIN task_execution_generations generation ON generation.task_id=item.id AND generation.tenant_id=item.tenant_id
  AND generation.generation=item.task_execution_generation
 WHERE owner.context_kind='meta' AND (
  generation.coordinator_context_key=owner.context_key AND generation.coordinator_actor_id=owner.agent_actor_id
  OR generation.coordinator_context_key IS NULL AND link.room_id=owner.room_id)
 UNION ALL
 SELECT 'meta:'||inbox.agent_actor_id||':'||inbox.task_id,inbox.through_seq,'meta_seq_v1',NULL,NULL,inbox.task_id,NULL
 FROM owner JOIN task_meta_inboxes inbox ON inbox.tenant_id=owner.tenant_id AND inbox.agent_actor_id=owner.agent_actor_id
  AND inbox.task_id=owner.task_id
 WHERE owner.context_kind='alter_ego'
 UNION ALL
 SELECT 'taskmeta:'||callback.task_id,callback.through_seq,'meta_seq_v1',NULL,NULL,callback.task_id,callback.coordinator_context_key
 FROM owner JOIN task_meta_callbacks callback ON callback.tenant_id=owner.tenant_id AND callback.coordinator_actor_id=owner.agent_actor_id
  AND callback.coordinator_context_key=owner.context_key
 WHERE owner.context_kind='meta';
$$;

CREATE FUNCTION public.agent_document_run_claimable(p_run_id text, p_context_key text) RETURNS boolean
    LANGUAGE sql
    AS $$
 SELECT EXISTS (
  SELECT 1 FROM agent_execution_contexts execution_context
  WHERE execution_context.context_key=p_context_key
    AND (execution_context.context_kind<>'document' OR EXISTS (
      SELECT 1 FROM agent_local_runs local_run
      JOIN agent_local_run_inputs run_input
        ON run_input.run_id=local_run.run_id AND run_input.relation='initial'
      JOIN agent_runtime_inputs input
        ON input.context_key=run_input.context_key AND input.input_id=run_input.input_id
       AND input.source_kind='inbox'
      JOIN room_document_comments comment
        ON comment.id=input.source_message_id
       AND comment.tenant_id=execution_context.tenant_id
       AND comment.document_id=execution_context.document_id
      JOIN room_document_comment_threads thread
        ON thread.id=comment.thread_id AND thread.tenant_id=comment.tenant_id
       AND thread.anchor_status='attached' AND thread.resolved_at IS NULL
      WHERE local_run.run_id=p_run_id AND local_run.context_key=p_context_key
        AND local_run.created_at>clock_timestamp()-interval '24 hours'
        AND document_comment_agent_readable(execution_context.tenant_id,
            execution_context.document_id,execution_context.agent_actor_id))));
$$;

CREATE FUNCTION public.agent_inbox_directly_mentions(segments jsonb, actor_id text) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
 SELECT CASE WHEN jsonb_typeof(segments)='array' THEN EXISTS(
  SELECT 1 FROM jsonb_array_elements(segments) segment
  WHERE segment->'type'='"reference"'::jsonb
   AND segment->'target_type'='"agent"'::jsonb
   AND segment->'target'=to_jsonb(actor_id)
 ) ELSE false END;
$$;

CREATE FUNCTION public.agent_inbox_message_disposition(p_tenant text, p_agent text, p_context text, p_inbox text, p_message text) RETURNS TABLE(disposition text, mentioned boolean)
    LANGUAGE sql STABLE
    AS $$
 SELECT CASE
   WHEN message.canceled
     OR message.message_kind<>'conversation' AND (message.message_kind<>'agent_runtime' OR NOT message.mentioned)
     OR runtime.request->>'context_key' IS DISTINCT FROM p_context AND runtime.id IS NOT NULL
     THEN 'ignore'
   WHEN runtime.request->>'kind'='native_question' THEN 'runtime_response'
   WHEN message.author_kind='agent' AND message.author_actor_id=p_agent THEN 'skip'
   WHEN message.mentioned THEN 'notify'
   -- An Agent that receives every message hears each Room and Task message
   -- except a Human's decision result; a Thread wakes only the Agents its
   -- Messages mention.
   WHEN registration.receives_all_messages AND NOT message.in_thread
     AND NOT (message.message_kind='conversation' AND message.author_kind='human'
       AND message.card_context_message_id IS NOT NULL) THEN 'notify'
   ELSE 'skip' END,
  message.mentioned
 FROM (
  SELECT message.id,message.author_actor_id,message.message_kind,message.card_context_message_id,author.kind AS author_kind,
   coalesce(p_agent=ANY(message.mentioned_actor_ids),false) AS mentioned,
   EXISTS(SELECT 1 FROM room_agent_message_cancellations cancellation WHERE cancellation.agent_actor_id=p_agent
     AND cancellation.message_id=message.id) AS canceled,
   EXISTS(SELECT 1 FROM rooms thread WHERE thread.id=message.room_id AND thread.parent_room_id IS NOT NULL) AS in_thread
  FROM messages message JOIN actors author ON author.id=message.author_actor_id AND author.tenant_id=message.tenant_id
  WHERE message.id=p_message AND message.tenant_id=p_tenant
    AND NOT starts_with(coalesce(p_inbox,''),'meta:') AND NOT starts_with(coalesce(p_inbox,''),'taskmeta:')
 ) message
 LEFT JOIN LATERAL (SELECT decision.id,decision.request->'runtime' AS request FROM decisions decision
  WHERE decision.message_id=message.card_context_message_id AND decision.request ? 'runtime'
    AND message.message_kind='agent_runtime') runtime ON true
 LEFT JOIN agent_registrations registration ON registration.actor_id=p_agent AND registration.tenant_id=p_tenant
 UNION ALL
 -- A Task's alterEgo reads the private stream its coordinating Meta writes.
 SELECT CASE WHEN EXISTS(SELECT 1 FROM agent_execution_contexts context
   WHERE context.context_key=p_context AND context.context_kind='alter_ego') THEN 'notify' ELSE 'skip' END,
  agent_inbox_directly_mentions(message.segments,p_agent)
 FROM task_meta_messages message
 WHERE starts_with(p_inbox,'meta:') AND message.id=p_message AND message.tenant_id=p_tenant
 UNION ALL
 SELECT CASE WHEN message.non_actionable THEN 'ignore' ELSE 'notify' END,
  agent_inbox_directly_mentions(message.segments,p_agent)
 FROM task_meta_callback_messages message
 WHERE starts_with(p_inbox,'taskmeta:') AND message.id=p_message AND message.tenant_id=p_tenant;
$$;

CREATE FUNCTION public.agent_inbox_notification_payload(p_input text, p_tenant text, p_agent text, p_inbox text, p_message text, p_sequence bigint, p_mentioned boolean, p_targeted boolean) RETURNS jsonb
    LANGUAGE sql STABLE
    AS $$
WITH message AS (
 SELECT message.id,message.body,message.segments,message.author_actor_id,author.display_name AS author,author.kind AS author_kind,
  to_jsonb(message.context_message_ids) AS context_message_ids,message.team_protocol,message.attachments,
  'room_event_v1' AS cursor_encoding,message.message_kind,message.fired_routine_id IS NOT NULL AS fired_routine
 FROM messages message JOIN actors author ON author.id=message.author_actor_id AND author.tenant_id=message.tenant_id
 WHERE message.id=p_message AND message.tenant_id=p_tenant
  AND NOT starts_with(p_inbox,'taskmeta:')
 UNION ALL
 SELECT message.id,message.body,message.segments,message.author_actor_id,author.display_name,author.kind,
  '[]'::jsonb,NULL,'[]'::jsonb,'meta_seq_v1',NULL,false
 FROM task_meta_callback_messages message JOIN actors author ON author.id=message.author_actor_id AND author.tenant_id=message.tenant_id
 WHERE starts_with(p_inbox,'taskmeta:') AND message.id=p_message AND message.tenant_id=p_tenant
)
SELECT jsonb_build_object(
 'messageId',p_input,
 'rawMessage','',
 'segments',jsonb_build_array(jsonb_build_object('type','text','content','')),
 'sourceInboxIds',jsonb_build_array(p_inbox),
 'invocationMessageIds',jsonb_build_array(message.id),
 'notificationRender',jsonb_build_object('agentName',agent.display_name,
  'triggeredAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
 'acceptedNotification',jsonb_build_object(
  'inboxId',p_inbox,'cursorEncoding',message.cursor_encoding,
  'after',greatest(p_sequence-1,0)::text,'through',p_sequence::text,'targeted',p_targeted,
  'messages',jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
   'id',message.id,'body',message.body,'author',message.author,
   'authorActorId',message.author_actor_id,
   'authorType',CASE WHEN message.author_kind='agent' THEN 'agent' ELSE 'user' END,
   'messageKind',message.message_kind,'firedRoutine',nullif(message.fired_routine,false),
   'mentioned',p_mentioned,'contextMessageIds',message.context_message_ids,
   'resourceReferences',agent_inbox_resource_references(message.segments,message.attachments),
   'teamProtocol',message.team_protocol)))))
FROM message JOIN actors agent ON agent.id=p_agent AND agent.tenant_id=p_tenant;
$$;

CREATE FUNCTION public.agent_inbox_recipients(p_inbox text) RETURNS TABLE(context_key text, agent_actor_id text, inbox_id text)
    LANGUAGE sql STABLE
    AS $$
WITH source_room AS MATERIALIZED (
 SELECT room.id,room.tenant_id,room.parent_room_id FROM rooms room
 WHERE left(p_inbox,5)='room:' AND room.id=substring(p_inbox FROM 6)
), threads AS MATERIALIZED (
 SELECT room.id AS room_id,room.parent_room_id,room.tenant_id FROM source_room room
 WHERE room.parent_room_id IS NOT NULL
), tasks AS MATERIALIZED (
 SELECT item.id,item.tenant_id,link.room_id,item.task_execution_generation,generation.coordinator_actor_id,generation.coordinator_context_key
 FROM source_room room JOIN work_item_room_links link ON link.room_id=room.id AND link.tenant_id=room.tenant_id AND link.link_type='work'
 JOIN work_items item ON item.id=link.work_item_id AND item.tenant_id=link.tenant_id AND item.kind='task'
 JOIN task_execution_generations generation ON generation.task_id=item.id AND generation.tenant_id=item.tenant_id AND generation.generation=item.task_execution_generation
), task_actors AS MATERIALIZED (
 SELECT task.id,task.tenant_id,task.room_id,member.actor_id FROM tasks task
 JOIN active_room_members member ON member.room_id=task.room_id AND member.tenant_id=task.tenant_id
 WHERE task.coordinator_context_key IS NULL
 UNION
 SELECT task.id,task.tenant_id,task.room_id,assignment.actor_id FROM tasks task
 JOIN work_item_assignments assignment ON assignment.work_item_id=task.id AND assignment.tenant_id=task.tenant_id
 WHERE task.coordinator_context_key IS NULL
 UNION
 SELECT task.id,task.tenant_id,task.room_id,participant.actor_id FROM tasks task
 JOIN task_execution_participants participant ON participant.task_id=task.id AND participant.tenant_id=task.tenant_id AND participant.generation=task.task_execution_generation
 WHERE task.coordinator_context_key IS NULL
 UNION
 SELECT task.id,task.tenant_id,task.room_id,task.coordinator_actor_id FROM tasks task WHERE task.coordinator_context_key IS NULL
), candidates AS (
 SELECT context.context_key,'room:'||room.id AS inbox_id FROM source_room room
 JOIN active_room_members member ON member.room_id=room.id AND member.tenant_id=room.tenant_id
 JOIN agent_execution_contexts context ON context.agent_actor_id=member.actor_id AND context.tenant_id=member.tenant_id AND context.context_kind='meta' AND context.room_id=room.id
 WHERE NOT EXISTS(SELECT 1 FROM threads) AND NOT EXISTS(SELECT 1 FROM tasks)
 UNION ALL
 SELECT context.context_key,'thread:'||thread.room_id FROM threads thread
 JOIN active_room_members member ON member.room_id=thread.parent_room_id AND member.tenant_id=thread.tenant_id
 JOIN agent_execution_contexts context ON context.agent_actor_id=member.actor_id AND context.tenant_id=member.tenant_id AND context.context_kind='meta' AND context.room_id=thread.parent_room_id
 UNION ALL
 SELECT task.coordinator_context_key,'task:'||task.id FROM tasks task WHERE task.coordinator_context_key IS NOT NULL
 UNION ALL
 SELECT context.context_key,'task:'||actor.id FROM task_actors actor
 JOIN agent_execution_contexts context ON context.agent_actor_id=actor.actor_id AND context.tenant_id=actor.tenant_id AND context.context_kind='meta' AND context.room_id=actor.room_id

 UNION ALL
 SELECT callback.coordinator_context_key,p_inbox FROM task_meta_callbacks callback
 WHERE left(p_inbox,9)='taskmeta:' AND callback.task_id=substring(p_inbox FROM 10)
)
SELECT DISTINCT context.context_key,context.agent_actor_id,candidate.inbox_id
FROM candidates candidate JOIN agent_execution_contexts context ON context.context_key=candidate.context_key
WHERE agent_context_can_receive_inbox(context.context_key,candidate.inbox_id);
$$;

CREATE FUNCTION public.agent_inbox_resource_references(p_segments jsonb, p_attachments jsonb) RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    AS $$
WITH segments AS (
 SELECT segment.value AS segment,segment.ordinality
 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_segments)='array' THEN p_segments ELSE '[]'::jsonb END) WITH ORDINALITY segment
), complete AS (
 SELECT ordinality,segment->>'document_id' AS document_id,
  jsonb_strip_nulls(jsonb_build_object('type',segment->>'type','content',coalesce(segment->>'content',''),
   'document_id',segment->>'document_id',
   'document_version_id',CASE WHEN segment->>'type'='file' THEN segment->>'document_version_id' END)) AS reference
 FROM segments
 WHERE segment->>'type' IN ('document','file') AND coalesce(segment->>'document_id','')<>''
  AND (segment->>'type'<>'file' OR coalesce(segment->>'document_version_id','')<>'')
), attached AS (
 SELECT DISTINCT document_id FROM (
  SELECT segment->>'document_id' AS document_id FROM segments
  UNION
  SELECT attachment->>'document_id'
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_attachments)='array' THEN p_attachments ELSE '[]'::jsonb END) attachment
 ) ids
 WHERE coalesce(document_id,'')<>'' AND document_id NOT IN (SELECT document_id FROM complete)
)
SELECT coalesce(jsonb_agg(reference ORDER BY rank,position),'[]'::jsonb) FROM (
 SELECT 0 AS rank,ordinality::text AS position,reference FROM complete
 UNION ALL
 SELECT 1,document_id,jsonb_build_object('type','document','content','','document_id',document_id) FROM attached
) ordered;
$$;

CREATE FUNCTION public.agent_inbox_resource_room(p_tenant text, p_inbox text) RETURNS text
    LANGUAGE sql STABLE
    AS $$
 SELECT CASE
 WHEN left(p_inbox,5)='room:' THEN substring(p_inbox FROM 6)
 WHEN left(p_inbox,7)='thread:' THEN substring(p_inbox FROM 8)
 WHEN left(p_inbox,5)='task:' THEN (SELECT room_id FROM work_item_room_links WHERE tenant_id=p_tenant AND work_item_id=substring(p_inbox FROM 6) AND link_type='work')
 END;
$$;

CREATE FUNCTION public.agent_local_run_replied(p_run_id text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
    WITH run AS (
        SELECT run.run_id, run.context_key
        FROM agent_local_runs run
        WHERE run.run_id = p_run_id AND run.status = 'running'
    ), reply AS (
        SELECT event.event_ordinal, event.created_at, event.payload
        FROM agent_runtime_status_events event
        JOIN run ON event.local_run_id = run.run_id
        WHERE event.event_type = 'presentation.output_created'
        ORDER BY event.event_ordinal DESC
        LIMIT 1
    )
    SELECT EXISTS (
        SELECT 1
        FROM run, reply
        WHERE NOT coalesce((reply.payload->>'continues')::boolean, false)
          AND NOT EXISTS (
              SELECT 1 FROM agent_runtime_status_events later
              WHERE later.local_run_id = run.run_id
                AND later.event_ordinal > reply.event_ordinal
                AND later.event_type = 'activity.started'
          )
          AND NOT EXISTS (
              SELECT 1 FROM agent_runtime_status_events started
              WHERE started.local_run_id = run.run_id
                AND started.event_type = 'activity.started'
                AND NOT EXISTS (
                    SELECT 1 FROM agent_runtime_status_events finished
                    WHERE finished.local_run_id = run.run_id
                      AND finished.activity_id = started.activity_id
                      AND finished.event_type = 'activity.finished'
                )
          )
          AND NOT EXISTS (
              SELECT 1 FROM agent_runtime_inputs input
              LEFT JOIN agent_local_run_inputs link
                ON link.context_key = input.context_key AND link.input_id = input.input_id
              WHERE input.context_key = run.context_key
                AND (link.run_id = run.run_id OR input.status = 'steering')
                AND input.created_at > reply.created_at
          )
    )
$$;

CREATE FUNCTION public.collaboration_membership_room_id(target_room_id text) RETURNS text
    LANGUAGE sql STABLE
    AS $$
    SELECT COALESCE(
        (
            SELECT thread.parent_room_id
            FROM rooms thread
            JOIN rooms parent
              ON parent.id = thread.parent_room_id
             AND parent.deleted_at IS NULL
            WHERE thread.id = target_room_id
        ),
        target_room_id
    );
$$;

CREATE FUNCTION public.create_document_permission_count() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    INSERT INTO document_permission_counts(document_id) VALUES (NEW.id);
    RETURN NEW;
END $$;

CREATE FUNCTION public.current_document_revision_id(target_document_id text) RETURNS text
    LANGUAGE sql STABLE
    AS $$
    SELECT revision.id
    FROM document_bodies body
    JOIN document_revisions revision
      ON revision.document_id=body.document_id AND revision.persisted_seq=body.seq
    WHERE body.document_id=target_document_id
$$;

CREATE FUNCTION public.default_unified_skill_access_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.access_scope IS NULL THEN
        NEW.access_scope:=CASE NEW.owner_kind WHEN 'platform' THEN 'platform' ELSE 'tenant' END;
    END IF;
    RETURN NEW;
END
$$;

CREATE FUNCTION public.distinct_text_ids(p_ids text[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $$
    SELECT array_position(p_ids,NULL) IS NULL
       AND cardinality(p_ids)=(SELECT count(DISTINCT id) FROM unnest(p_ids) id);
$$;

CREATE FUNCTION public.document_comment_agent_readable(p_tenant_id text, p_document_id text, p_agent_actor_id text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
SELECT EXISTS (
    SELECT 1 FROM agent_registrations registration
    JOIN LATERAL resolve_agent_document_access_v2(registration.agent_management_id,p_document_id) access
      ON access.tenant_id=registration.tenant_id AND access.actor_id=registration.actor_id AND access.can_read
    WHERE registration.tenant_id=p_tenant_id AND registration.actor_id=p_agent_actor_id AND registration.status='active'
)
$$;

CREATE FUNCTION public.document_text_version_id(document_id text, source_kind text, source_id text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
SELECT CASE WHEN source_kind = 'native_body'
            THEN 'text_' || left(md5(document_id || ':' || source_id), 24)
            ELSE source_id END
$$;

CREATE FUNCTION public.enforce_document_placement_tree() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    parent document_placements%ROWTYPE;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(
        NEW.tenant_id || ':' || NEW.scope_kind || ':' || NEW.owner_human_actor_id || ':' || coalesce(NEW.wiki_id,''),
        0
    ));
    IF TG_OP='UPDATE' AND (
        NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR NEW.scope_kind<>OLD.scope_kind
        OR NEW.owner_human_actor_id<>OLD.owner_human_actor_id
        OR NEW.wiki_id IS DISTINCT FROM OLD.wiki_id
        OR NEW.node_kind<>OLD.node_kind
        OR NEW.document_id IS DISTINCT FROM OLD.document_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
    ) THEN
        RAISE EXCEPTION 'Document Placement node identity is immutable';
    END IF;
    IF NEW.scope_kind='personal' AND NEW.node_kind='document' AND NOT EXISTS (
        SELECT 1 FROM documents document
        WHERE document.id=NEW.document_id AND document.tenant_id=NEW.tenant_id
          AND document.owner_actor_kind='human'
          AND document.owner_actor_id=NEW.owner_human_actor_id
    ) THEN
        RAISE EXCEPTION 'personal Document Placement requires its Human owner';
    END IF;
    IF NEW.parent_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT * INTO parent FROM document_placements placement
    WHERE placement.id=NEW.parent_id FOR SHARE;
    IF NOT FOUND OR parent.deleted_at IS NOT NULL OR parent.node_kind<>'folder'
       OR parent.tenant_id<>NEW.tenant_id OR parent.scope_kind<>NEW.scope_kind
       OR parent.owner_human_actor_id<>NEW.owner_human_actor_id
       OR parent.wiki_id IS DISTINCT FROM NEW.wiki_id THEN
        RAISE EXCEPTION 'Document Placement parent must be an active Folder in the same tree';
    END IF;
    IF EXISTS (
        WITH RECURSIVE ancestors(id,parent_id) AS (
            SELECT placement.id,placement.parent_id FROM document_placements placement
            WHERE placement.id=NEW.parent_id
            UNION ALL
            SELECT placement.id,placement.parent_id FROM document_placements placement
            JOIN ancestors ON ancestors.parent_id=placement.id
        )
        SELECT 1 FROM ancestors WHERE id=NEW.id
    ) THEN
        RAISE EXCEPTION 'Document Placement move would create a cycle';
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION public.enforce_room_document_comment_evidence_immutability() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'room document Comment evidence is immutable';
END $$;

CREATE FUNCTION public.enforce_task_effect_definition_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF ROW(NEW.id,NEW.task_id,NEW.tenant_id,NEW.generation,NEW.root_operation_id,
           NEW.effect_key,NEW.operation,NEW.owner_id,NEW.payload,
           NEW.payload_hash,NEW.root_payload_hash,NEW.dispatch_sequence,
           NEW.retry_of_effect_id,NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.id,OLD.task_id,OLD.tenant_id,OLD.generation,OLD.root_operation_id,
           OLD.effect_key,OLD.operation,OLD.owner_id,OLD.payload,
           OLD.payload_hash,OLD.root_payload_hash,OLD.dispatch_sequence,
           OLD.retry_of_effect_id,OLD.created_at) THEN
        RAISE EXCEPTION 'task effect definition is immutable';
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION public.enforce_task_effect_retry_root() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    previous task_effects%ROWTYPE;
BEGIN
    IF NEW.retry_of_effect_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT * INTO previous FROM task_effects WHERE id=NEW.retry_of_effect_id;
    IF NOT FOUND
        OR previous.task_id<>NEW.task_id
        OR previous.tenant_id<>NEW.tenant_id
        OR previous.generation<>NEW.generation
        OR previous.root_operation_id<>NEW.root_operation_id
        OR previous.root_payload_hash<>NEW.root_payload_hash
        OR previous.dispatch_sequence+1<>NEW.dispatch_sequence THEN
        RAISE EXCEPTION 'task effect retry must preserve root identity and advance one sequence';
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION public.enforce_task_execution_snapshot_revision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF OLD.task_execution_generation IS NULL AND NEW.task_execution_generation IS NOT NULL THEN
        IF NEW.task_execution_revision <> 1 THEN
            RAISE EXCEPTION 'initial task execution revision must be 1';
        END IF;
    ELSIF OLD.task_execution_generation IS NOT NULL THEN
        IF NEW.task_execution_generation <> OLD.task_execution_generation THEN
            IF NEW.task_execution_generation <> OLD.task_execution_generation + 1
                OR NEW.task_execution_revision <> 1 THEN
                RAISE EXCEPTION 'new task execution generation must increment by one and start at revision 1';
            END IF;
        ELSIF NEW.task_execution_revision <> OLD.task_execution_revision
            AND NEW.task_execution_revision <> OLD.task_execution_revision + 1 THEN
            RAISE EXCEPTION 'task execution revision must increment by exactly one';
        END IF;
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION public.enforce_task_generation_definition_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF ROW(NEW.task_id,NEW.tenant_id,NEW.generation,NEW.source_key,
           NEW.result_agent_actor_id,NEW.spec,NEW.spec_hash,NEW.created_at,
           NEW.coordinator_actor_id,NEW.coordinator_context_key)
       IS DISTINCT FROM
       ROW(OLD.task_id,OLD.tenant_id,OLD.generation,OLD.source_key,
           OLD.result_agent_actor_id,OLD.spec,OLD.spec_hash,OLD.created_at,
           OLD.coordinator_actor_id,OLD.coordinator_context_key) THEN
        RAISE EXCEPTION 'task execution generation definition is immutable';
    END IF;
    IF OLD.terminal_status IS NOT NULL
        OR NEW.terminal_status IS NULL
        OR NEW.terminal_at IS NULL THEN
        RAISE EXCEPTION 'task execution generation terminal fields may be set exactly once';
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION public.enqueue_document_text_sync(target_document_id text) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    INSERT INTO river_job(kind, queue, args, max_attempts)
    SELECT 'document_text.sync', 'indexing', jsonb_build_object('document_id', target_document_id), 6
    WHERE NOT EXISTS (
        SELECT 1 FROM river_job job
        WHERE job.kind = 'document_text.sync'
          AND job.state IN ('available', 'scheduled')
          AND job.args->>'document_id' = target_document_id);
    IF FOUND THEN
        PERFORM notify_river_queue('indexing');
    END IF;
END $$;

CREATE FUNCTION public.enqueue_task_due_on_participant_run_terminal() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_task_id text;
BEGIN
    SELECT item.id INTO v_task_id
    FROM agent_execution_contexts execution_context
    JOIN work_items item ON item.id=execution_context.task_id
    WHERE execution_context.context_key=NEW.context_key
      AND execution_context.context_kind='alter_ego'
      AND item.task_execution_status='running';
    IF v_task_id IS NULL THEN
        RETURN NULL;
    END IF;
    INSERT INTO river_job(kind, queue, args, max_attempts)
    VALUES ('task_execution.participant_run_finished', 'default', jsonb_build_object('task_id', v_task_id), 25);
    PERFORM notify_river_queue('default');
    RETURN NULL;
END $$;

CREATE FUNCTION public.initialize_agent_user_artifact_owner() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.agent_type='anotherme' THEN
        NEW.user_artifact_owner_actor_id := NEW.represented_human_actor_id;
    ELSIF TG_OP='INSERT' AND NEW.user_artifact_owner_actor_id IS NULL THEN
        SELECT actor.id INTO NEW.user_artifact_owner_actor_id
        FROM actors actor
        WHERE actor.id=NEW.created_by_actor_id
          AND actor.tenant_id=NEW.tenant_id
          AND actor.kind='human';
    END IF;
    PERFORM validate_user_artifact_human_owner(
        NEW.tenant_id,
        NEW.user_artifact_owner_actor_id
    );
    RETURN NEW;
END $$;

CREATE FUNCTION public.lock_agent_skill_binding_policy() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(
        hashtextextended('unified-agent-skill-policy',0)
    );
    RETURN NULL;
END
$$;

CREATE FUNCTION public.lock_document_event_scopes(p_document_ids text[]) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    locked_document_id text;
BEGIN
    FOR locked_document_id IN
        SELECT DISTINCT scoped.document_id
        FROM unnest(p_document_ids) AS scoped(document_id)
        WHERE scoped.document_id IS NOT NULL
        ORDER BY scoped.document_id
    LOOP
        PERFORM pg_advisory_xact_lock(hashtextextended(locked_document_id,0));
    END LOOP;
END $$;

CREATE FUNCTION public.lock_room_member_write_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    target_room_id text;
BEGIN
    IF TG_OP='DELETE' THEN
        target_room_id := OLD.room_id;
    ELSE
        target_room_id := NEW.room_id;
    END IF;
    PERFORM id FROM rooms WHERE id=target_room_id FOR NO KEY UPDATE;
    PERFORM lock_document_event_scopes(ARRAY(
        SELECT binding.document_id FROM document_context_bindings binding
        WHERE binding.room_id=target_room_id AND binding.binding_kind='room'
    ));
    IF TG_OP='DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION public.message_attachments_valid(p_attachments jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
    SELECT jsonb_typeof(p_attachments)='array' AND jsonb_array_length(p_attachments)<=16
       AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(p_attachments) item
           WHERE jsonb_typeof(item->'id') IS DISTINCT FROM 'string'
              OR jsonb_typeof(item->'document_id') IS DISTINCT FROM 'string'
              OR jsonb_typeof(item->'document_version_id') IS DISTINCT FROM 'string')
       AND distinct_text_ids(ARRAY(SELECT item->>'id' FROM jsonb_array_elements(p_attachments) item))
       AND distinct_text_ids(ARRAY(SELECT item->>'document_version_id' FROM jsonb_array_elements(p_attachments) item));
$$;

CREATE FUNCTION public.notify_river_queue(p_queue text) RETURNS void
    LANGUAGE sql
    AS $$
SELECT pg_notify(current_schema() || '.river_insert', json_build_object('queue', p_queue)::text)
$$;

CREATE FUNCTION public.notify_teamhub_agent_context_changed() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='INSERT' OR
   ROW(NEW.context_key,NEW.target_residency,NEW.terminal_reason,NEW.tenant_id,NEW.agent_actor_id,NEW.agent_management_id,NEW.context_kind,NEW.room_id,NEW.room_kind,NEW.task_id,NEW.document_id,NEW.membership_epoch_id,NEW.state_revision)
   IS DISTINCT FROM
   ROW(OLD.context_key,OLD.target_residency,OLD.terminal_reason,OLD.tenant_id,OLD.agent_actor_id,OLD.agent_management_id,OLD.context_kind,OLD.room_id,OLD.room_kind,OLD.task_id,OLD.document_id,OLD.membership_epoch_id,OLD.state_revision)
 THEN
  PERFORM publish_teamhub_realtime_wake('agent-inbox:all','context.changed',NEW.context_key,0,NEW.state_revision);
 END IF;
 RETURN NEW;
END;
$$;

CREATE FUNCTION public.notify_teamhub_document_invalidation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM publish_teamhub_realtime_wake(
        'tenant:' || NEW.tenant_id,
        CASE WHEN NEW.event_type IN (
            'document.access_invalidated',
            'document.collaborator.revoked',
            'document.collaborator.updated',
            'document.trashed'
        ) THEN 'invalidate.document-access' ELSE 'invalidate.document' END,
        NEW.document_id, 0, 0
    );
    RETURN NULL;
END;
$$;

CREATE FUNCTION public.notify_teamhub_river_due() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM publish_teamhub_realtime_wake('work:river-due','work.ready','all',0,0);
    RETURN NULL;
END $$;

CREATE FUNCTION public.notify_teamhub_room_event() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM publish_teamhub_realtime_wake(
        'room:' || NEW.room_id,
        'room.event',
        NEW.event_id,
        NEW.room_seq,
        0
    );
    RETURN NEW;
END;
$$;

CREATE FUNCTION public.notify_teamhub_task_claimable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM publish_teamhub_realtime_wake('agent-inbox:all','task.claimable','all',0,0);
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.protect_agent_runtime_status_event() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'Agent Runtime presentation events are immutable';
END $$;

CREATE FUNCTION public.protect_agent_skill_binding_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP='DELETE' THEN
        RAISE EXCEPTION 'Agent Skill bindings are disabled, not deleted';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.agent_actor_id IS DISTINCT FROM OLD.agent_actor_id
        OR NEW.skill_id IS DISTINCT FROM OLD.skill_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Agent Skill binding identity is immutable';
    END IF;
    RETURN NEW;
END
$$;

CREATE FUNCTION public.protect_agent_skill_binding_tenant() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM skills skill
        WHERE skill.skill_id=NEW.skill_id
          AND ((skill.owner_kind='platform' AND skill.tenant_id IS NULL)
            OR (skill.owner_kind='tenant' AND skill.tenant_id=NEW.tenant_id))
    ) THEN
        RAISE EXCEPTION 'Agent Skill binding Skill belongs to a different Tenant';
    END IF;
    RETURN NEW;
END
$$;

CREATE FUNCTION public.protect_document_asset_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.document_id IS DISTINCT FROM OLD.document_id
       OR NEW.created_by_actor_id IS DISTINCT FROM OLD.created_by_actor_id
       OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
       OR NEW.filename IS DISTINCT FROM OLD.filename
       OR NEW.media_type IS DISTINCT FROM OLD.media_type
       OR NEW.sha256 IS DISTINCT FROM OLD.sha256
       OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
       OR NEW.content_object_id IS DISTINCT FROM OLD.content_object_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Document Asset identity is immutable';
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION public.protect_document_context_binding_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.document_id IS DISTINCT FROM OLD.document_id
       OR NEW.binding_kind IS DISTINCT FROM OLD.binding_kind
       OR NEW.room_id IS DISTINCT FROM OLD.room_id
       OR NEW.work_item_id IS DISTINCT FROM OLD.work_item_id
       OR NEW.wiki_id IS DISTINCT FROM OLD.wiki_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Document Binding authority identity is immutable';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status OR NEW.role IS DISTINCT FROM OLD.role THEN
        IF NEW.access_epoch<>OLD.access_epoch+1 THEN
            RAISE EXCEPTION 'Document Binding authority change must advance access epoch';
        END IF;
    ELSIF NEW.access_epoch IS DISTINCT FROM OLD.access_epoch THEN
        RAISE EXCEPTION 'Document Binding unchanged authority has immutable access epoch';
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION public.protect_document_event() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP='DELETE' AND current_setting('teamhub.document_retention',true)='on' THEN
        RETURN OLD;
    END IF;
    IF TG_OP='INSERT' THEN
        PERFORM lock_document_event_scopes(ARRAY[NEW.document_id]);
        SELECT existing.sequence INTO NEW.sequence FROM document_events existing WHERE existing.id=NEW.id;
        IF FOUND THEN
            RETURN NEW;
        END IF;
        INSERT INTO document_event_sequences(document_id,last_sequence) VALUES(NEW.document_id,1)
        ON CONFLICT(document_id) DO UPDATE SET last_sequence=document_event_sequences.last_sequence+1
        RETURNING last_sequence INTO NEW.sequence;
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Document event audit evidence is immutable';
END $$;

CREATE FUNCTION public.protect_document_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP='INSERT' THEN
        IF NEW.status<>'active' OR NEW.trashed_at IS NOT NULL OR NEW.restored_at IS NOT NULL THEN
            RAISE EXCEPTION 'Document lifecycle must start active';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Document root identity is retained'; END IF;
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.owner_actor_id IS DISTINCT FROM OLD.owner_actor_id
       OR NEW.owner_actor_kind IS DISTINCT FROM OLD.owner_actor_kind
       OR NEW.creator_actor_id IS DISTINCT FROM OLD.creator_actor_id
       OR NEW.creator_actor_kind IS DISTINCT FROM OLD.creator_actor_kind
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Document identity, owner, and creator are immutable';
    END IF;
    IF NEW.updated_at<OLD.updated_at THEN RAISE EXCEPTION 'Document updated time is irreversible'; END IF;
    IF NEW.trashed_at IS DISTINCT FROM OLD.trashed_at OR NEW.restored_at IS DISTINCT FROM OLD.restored_at THEN
        IF NOT (OLD.status='active' AND NEW.status='trashed' AND NEW.trashed_at IS NOT NULL
                AND NEW.trashed_at>=OLD.updated_at AND NEW.restored_at IS NOT DISTINCT FROM OLD.restored_at)
           AND NOT (OLD.status='trashed' AND NEW.status='active' AND NEW.restored_at IS NOT NULL
                AND NEW.restored_at>=OLD.updated_at AND NEW.trashed_at IS NOT DISTINCT FROM OLD.trashed_at) THEN
            RAISE EXCEPTION 'Document lifecycle timestamps require their exact transition';
        END IF;
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION public.protect_document_revision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP='DELETE' AND current_setting('teamhub.document_retention',true)='on' THEN
        RETURN OLD;
    END IF;
    IF TG_OP='UPDATE' AND OLD.history_trigger IS NULL AND NEW.history_trigger IS NOT NULL
       AND (NEW.id,NEW.tenant_id,NEW.document_id,NEW.persisted_seq,NEW.state_vector,
            NEW.full_state_fingerprint,NEW.state_status,NEW.state_bytes,NEW.state_bytes_sha256,
            NEW.asset_manifest,NEW.thread_manifest,NEW.created_by_actor_id,NEW.created_at)
       IS NOT DISTINCT FROM
           (OLD.id,OLD.tenant_id,OLD.document_id,OLD.persisted_seq,OLD.state_vector,
            OLD.full_state_fingerprint,OLD.state_status,OLD.state_bytes,OLD.state_bytes_sha256,
            OLD.asset_manifest,OLD.thread_manifest,OLD.created_by_actor_id,OLD.created_at) THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Document Revision is immutable after insertion';
END $$;

CREATE FUNCTION public.protect_document_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    expected_version_number integer;
BEGIN
    IF TG_OP='INSERT' THEN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.document_id,0));
        SELECT coalesce(max(version_number),0)+1 INTO expected_version_number
        FROM document_versions
        WHERE document_id=NEW.document_id;
        IF NEW.version_number<>expected_version_number THEN
            RAISE EXCEPTION 'Document Version number is not contiguous';
        END IF;
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Document Version is immutable after insertion';
END $$;

CREATE FUNCTION public.protect_document_wiki_revision_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP<>'INSERT' THEN
        RAISE EXCEPTION 'Document Wiki page identity is immutable';
    END IF;
    IF NOT EXISTS(
        SELECT 1
        FROM document_context_bindings binding
        JOIN documents document
          ON document.id=binding.document_id AND document.tenant_id=binding.tenant_id
        WHERE binding.wiki_id=NEW.wiki_id AND binding.tenant_id=NEW.tenant_id
          AND binding.document_id=NEW.document_id
          AND binding.binding_kind='wiki_page' AND binding.status='active'
          AND document.status='active'
    ) THEN
        RAISE EXCEPTION 'Document Wiki page mapping lacks an active page Binding';
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION public.protect_native_document_representation_format() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.native_representation_format IS DISTINCT FROM OLD.native_representation_format
       AND NOT (
           OLD.native_representation_format IS NULL
           AND NEW.format='blocknote'
           AND OLD.format IN ('markdown','md')
           AND NEW.native_representation_format='markdown'
           AND OLD.native_import_status='pending'
       ) THEN
        RAISE EXCEPTION 'Native Document representation format is immutable';
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION public.protect_unified_skill_frontmatter_extra() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.frontmatter_extra IS DISTINCT FROM OLD.frontmatter_extra THEN
        RAISE EXCEPTION 'Skill Manifest frontmatter extension is immutable';
    END IF;
    RETURN NEW;
END
$$;

CREATE FUNCTION public.protect_unified_skill_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP='DELETE' THEN
        RAISE EXCEPTION 'Skills are not physically deleted';
    END IF;
    IF NEW.skill_id IS DISTINCT FROM OLD.skill_id
       OR NEW.owner_kind IS DISTINCT FROM OLD.owner_kind
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.name IS DISTINCT FROM OLD.name
       OR NEW.created_by_actor_id IS DISTINCT FROM OLD.created_by_actor_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR ((NEW.access_scope,NEW.owner_actor_id) IS DISTINCT FROM
           (OLD.access_scope,OLD.owner_actor_id) AND pg_trigger_depth()<=1) THEN
        RAISE EXCEPTION 'Skill identity is immutable';
    END IF;
    RETURN NEW;
END
$$;

CREATE FUNCTION public.protect_unified_skill_manifest() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE actual_file_count integer;
DECLARE actual_size_bytes bigint;
DECLARE actual_content_hash bytea;
BEGIN
    IF TG_OP='DELETE' THEN
        RAISE EXCEPTION 'sealed Skill Manifests are immutable';
    END IF;
    IF TG_OP='INSERT' THEN
        IF NEW.package_state<>'uploading' OR NEW.sealed_at IS NOT NULL THEN
            RAISE EXCEPTION 'new Skill Manifests must start uploading';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.manifest_id IS DISTINCT FROM OLD.manifest_id
       OR NEW.skill_id IS DISTINCT FROM OLD.skill_id
       OR NEW.manifest_version IS DISTINCT FROM OLD.manifest_version
       OR NEW.description IS DISTINCT FROM OLD.description
       OR NEW.config_schema IS DISTINCT FROM OLD.config_schema
       OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
       OR NEW.file_count IS DISTINCT FROM OLD.file_count
       OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
       OR NEW.created_by_actor_id IS DISTINCT FROM OLD.created_by_actor_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Skill Manifest payload is immutable';
    END IF;
    IF OLD.state='revoked' AND NEW.state<>'revoked' THEN
        RAISE EXCEPTION 'revoked Skill Manifest state is terminal';
    END IF;
    IF OLD.package_state='sealed' THEN
        IF NEW.package_state<>'sealed' OR NEW.sealed_at IS DISTINCT FROM OLD.sealed_at
           OR NEW.files IS DISTINCT FROM OLD.files THEN
            RAISE EXCEPTION 'sealed Skill Manifests are immutable';
        END IF;
        RETURN NEW;
    END IF;
    -- An uploading Manifest may complete its file list before sealing.
    IF NEW.package_state='uploading' AND NEW.sealed_at IS NULL THEN
        RETURN NEW;
    END IF;
    IF NEW.package_state<>'sealed' OR NEW.sealed_at IS NULL THEN
        RAISE EXCEPTION 'Skill Manifest only supports uploading to sealed';
    END IF;
    SELECT count(*)::integer,COALESCE(sum((file.value->>'size_bytes')::bigint),0)::bigint,
           sha256(
               convert_to('teamhub.skill-package.v1','UTF8') || decode('00','hex') ||
               COALESCE(string_agg(
                   int8send(octet_length(convert_to(file.value->>'path','UTF8'))::bigint) ||
                   convert_to(file.value->>'path','UTF8') || int8send((file.value->>'size_bytes')::bigint) ||
                   decode(file.value->>'sha256','hex'),
                   ''::bytea ORDER BY convert_to(file.value->>'path','UTF8')
               ),''::bytea)
           )
    INTO actual_file_count,actual_size_bytes,actual_content_hash
    FROM jsonb_array_elements(NEW.files) AS file(value);
    IF NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(NEW.files) AS file(value)
        WHERE file.value->>'path'='SKILL.md'
    ) OR actual_file_count<>NEW.file_count
       OR actual_size_bytes<>NEW.size_bytes
       OR actual_content_hash IS DISTINCT FROM NEW.content_hash THEN
        RAISE EXCEPTION 'Skill Package does not match its immutable Manifest';
    END IF;
    RETURN NEW;
END
$$;

CREATE FUNCTION public.publish_teamhub_realtime_wake(topic text, kind text, resource_id text, sequence bigint, revision bigint DEFAULT 0) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    wake_payload text;
BEGIN
    IF topic IS NULL OR topic = '' OR kind IS NULL OR kind = '' OR
       resource_id IS NULL OR resource_id = '' OR sequence < 0 OR revision < 0 THEN
        RAISE EXCEPTION 'invalid TeamHub realtime wake metadata';
    END IF;
    wake_payload := json_build_object(
        'topic', topic,
        'kind', kind,
        'resource_id', resource_id,
        'sequence', sequence,
        'revision', revision
    )::text;
    IF octet_length(wake_payload) > 7900 THEN
        RAISE EXCEPTION 'TeamHub realtime wake payload is too large';
    END IF;
    PERFORM pg_notify('teamhub_realtime', wake_payload);
END;
$$;

CREATE FUNCTION public.publish_voice_partial_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF (NEW.latest_partial_text,NEW.latest_partial_start_offset_ms,NEW.latest_partial_end_offset_ms)
      IS DISTINCT FROM (OLD.latest_partial_text,OLD.latest_partial_start_offset_ms,OLD.latest_partial_end_offset_ms) THEN
        PERFORM pg_notify('teamhub_realtime',json_build_object(
          'topic','voice:'||NEW.id,'kind','voice.partial','resource_id',NEW.id,
          'sequence',0,'revision',1)::text);
    END IF;
    RETURN NULL;
END $$;

CREATE FUNCTION public.publish_voice_projection_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE voice_id text; capture_id text;
BEGIN
    IF TG_TABLE_NAME='voice_sessions' THEN
        IF TG_OP='UPDATE' AND (NEW.status,NEW.credential_generation,NEW.last_failure_code,NEW.closed_at)
          IS NOT DISTINCT FROM (OLD.status,OLD.credential_generation,OLD.last_failure_code,OLD.closed_at) THEN RETURN NULL; END IF;
        voice_id := NEW.id;
    ELSIF TG_TABLE_NAME='voice_transcript_segments' THEN
        -- Captions show live rows only; recovered text and superseding reach
        -- the formal transcript, not the event feed.
        IF NEW.lane='recovery' THEN RETURN NULL; END IF;
        IF TG_OP='UPDATE' AND (NEW.text,NEW.speaker_id,NEW.seq)
          IS NOT DISTINCT FROM (OLD.text,OLD.speaker_id,OLD.seq) THEN RETURN NULL; END IF;
        voice_id := NEW.voice_session_id;
    ELSE
        IF TG_TABLE_NAME='capture_sessions' THEN
            capture_id := NEW.id;
            IF TG_OP='UPDATE' AND (NEW.status,NEW.document_version_id,NEW.transcript_document_version_id,
              NEW.source_audio_document_version_id,NEW.transcript_integrity_lost,
              NEW.transcript_recovery_status,NEW.transcript_recovery_progress_ms,
              NEW.transcript_recovery_total_ms,NEW.transcript_recovery_failure_code)
              IS NOT DISTINCT FROM (OLD.status,OLD.document_version_id,OLD.transcript_document_version_id,
              OLD.source_audio_document_version_id,OLD.transcript_integrity_lost,
              OLD.transcript_recovery_status,OLD.transcript_recovery_progress_ms,
              OLD.transcript_recovery_total_ms,OLD.transcript_recovery_failure_code) THEN RETURN NULL; END IF;
        ELSIF TG_TABLE_NAME='voice_media_epochs' THEN
            IF TG_OP='UPDATE' AND (NEW.observed_state,NEW.archived_through_ms,NEW.last_failure_code)
              IS NOT DISTINCT FROM (OLD.observed_state,OLD.archived_through_ms,OLD.last_failure_code) THEN RETURN NULL; END IF;
            capture_id := NEW.capture_session_id;
        ELSIF TG_TABLE_NAME='capture_media_ranges' THEN
            IF TG_OP='DELETE' THEN capture_id := OLD.capture_session_id; ELSE capture_id := NEW.capture_session_id; END IF;
        END IF;
        SELECT voice_session_id INTO voice_id FROM capture_sessions WHERE id=capture_id;
    END IF;
    IF voice_id IS NOT NULL THEN
        PERFORM pg_notify('teamhub_realtime', json_build_object(
          'topic', 'voice:' || voice_id, 'kind', 'voice.changed', 'resource_id', voice_id,
          'sequence', 0, 'revision', 0)::text);
    END IF;
    RETURN NULL;
END $$;

CREATE FUNCTION public.queue_agent_inbox_message(p_tenant text, p_inbox text, p_message text, p_sequence bigint) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
 v_recipient record;
 v_disposition text;
 v_mentioned boolean;
BEGIN
 FOR v_recipient IN
  SELECT recipient.context_key,recipient.agent_actor_id,recipient.inbox_id
  FROM agent_inbox_recipients(p_inbox) recipient
  ORDER BY recipient.context_key,recipient.inbox_id
 LOOP
  v_disposition := NULL;
  SELECT decision.disposition,decision.mentioned INTO v_disposition,v_mentioned
  FROM agent_inbox_message_disposition(p_tenant,v_recipient.agent_actor_id,v_recipient.context_key,v_recipient.inbox_id,p_message) decision;
  IF v_disposition='notify' THEN
   PERFORM queue_agent_inbox_notification(v_recipient.context_key,v_recipient.inbox_id,p_tenant,p_message,p_sequence,v_mentioned);
  ELSIF v_disposition='runtime_response' THEN
   PERFORM queue_agent_runtime_response(v_recipient.context_key,p_tenant,p_message);
  END IF;
 END LOOP;
END;
$$;

CREATE FUNCTION public.queue_agent_inbox_notification(p_context text, p_inbox text, p_tenant text, p_message text, p_sequence bigint, p_mentioned boolean) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
 v_context agent_execution_contexts%ROWTYPE;
 v_targeted boolean;
 v_input text := 'inbox-input-'||replace(gen_random_uuid()::text,'-','');
 v_payload jsonb;
 v_run text;
 v_candidate text;
 v_ordinal bigint := 0;
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
 IF v_targeted THEN
  SELECT run.run_id INTO v_run FROM agent_local_runs run
  WHERE run.context_key=p_context AND run.status='running' AND NOT run.cancellation_requested
   AND EXISTS (
    SELECT 1 FROM agent_local_run_inputs relation
    JOIN agent_runtime_inputs input ON input.context_key=relation.context_key AND input.input_id=relation.input_id
    WHERE relation.run_id=run.run_id AND input.payload->'sourceInboxIds' @> jsonb_build_array(p_inbox));
  IF v_run IS NOT NULL THEN
   INSERT INTO agent_runtime_inputs(context_key,input_id,payload,payload_hash,source_kind,source_message_id,source_inbox_id,
    status,selection_result,steer_group_id)
   VALUES(p_context,v_input,v_payload,sha256(convert_to(v_payload::text,'UTF8')),'inbox',p_message,p_inbox,
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
 VALUES(p_context,v_input,v_payload,sha256(convert_to(v_payload::text,'UTF8')),'inbox',p_message,p_inbox,
  'handled','{"selected":"trusted_inbox_notification","effective":"enqueue"}'::jsonb,v_run);
 INSERT INTO agent_local_run_inputs(run_id,context_key,input_id,relation,ordinal)
 VALUES(v_run,p_context,v_input,'initial',v_ordinal);
 PERFORM publish_teamhub_realtime_wake('agent-inbox:all','run.queued',p_context,0,0);
END;
$$;

CREATE FUNCTION public.queue_agent_runtime_response(p_context text, p_tenant text, p_message text) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
 v_input text := 'runtime-response-'||replace(gen_random_uuid()::text,'-','');
 v_response jsonb;
 v_payload jsonb;
BEGIN
 IF EXISTS (SELECT 1 FROM agent_runtime_inputs WHERE context_key=p_context AND source_message_id=p_message) THEN
  RETURN;
 END IF;
 SELECT jsonb_build_object(
  'operation_id',decision.request->'runtime'->>'operation_id',
  'execution_run_ref',decision.request->'runtime'->>'execution_run_ref',
  'request_id',decision.request->'runtime'->>'request_id',
  'interaction_id',decision.id,
  'payload',decision.answer)
 INTO v_response
 FROM messages message
 JOIN decisions decision ON decision.message_id=message.card_context_message_id
  AND decision.request ? 'runtime'
 WHERE message.id=p_message AND message.tenant_id=p_tenant AND message.message_kind='agent_runtime';
 IF v_response IS NULL OR NOT EXISTS (
  SELECT 1 FROM agent_local_runs run
  WHERE run.context_key=p_context AND run.run_id=v_response->>'execution_run_ref' AND run.status='running') THEN
  RETURN;
 END IF;
 v_payload := jsonb_build_object(
  'messageId',v_input,'rawMessage','','segments',jsonb_build_array(jsonb_build_object('type','text','content','')),
  'sourceInboxIds','[]'::jsonb,'invocationMessageIds','[]'::jsonb,'runtimeResponses',jsonb_build_array(v_response));
 INSERT INTO agent_runtime_inputs(context_key,input_id,payload,payload_hash,source_kind,source_message_id,
  status,selection_result,steer_group_id,local_run_id)
 VALUES(p_context,v_input,v_payload,sha256(convert_to(v_payload::text,'UTF8')),'internal',p_message,
  'steering','{"selected":"runtime_response"}'::jsonb,'steer-'||replace(gen_random_uuid()::text,'-',''),
  v_response->>'execution_run_ref');
 PERFORM publish_teamhub_realtime_wake('agent-inbox:all','run.steered',p_context,0,0);
END;
$$;

CREATE FUNCTION public.queue_document_text_for_body() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM enqueue_document_text_sync(NEW.document_id);
    RETURN NULL;
END $$;

CREATE FUNCTION public.queue_document_text_for_document() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.status = 'active'
       AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status
            OR (NEW.format <> 'blocknote' AND OLD.current_version_id IS DISTINCT FROM NEW.current_version_id))
       AND (NEW.format = 'blocknote' OR NEW.current_version_id IS NOT NULL) THEN
        PERFORM enqueue_document_text_sync(NEW.id);
    END IF;
    RETURN NULL;
END $$;

CREATE FUNCTION public.queue_room_message_agent_inputs() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 PERFORM queue_agent_inbox_message(NEW.tenant_id,'room:'||NEW.room_id,NEW.resource_id,NEW.room_seq);
 RETURN NULL;
END;
$$;

CREATE FUNCTION public.queue_task_meta_callback_agent_inputs() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 PERFORM queue_agent_inbox_message(NEW.tenant_id,'taskmeta:'||NEW.task_id,NEW.id,NEW.meta_seq);
 RETURN NULL;
END;
$$;

CREATE FUNCTION public.reconcile_document_body_comment_threads() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    changed_thread_ids text[];
    document_tenant_id text;
    change_actor_id text;
    change_actor_kind text;
    bound_room record;
    changed_thread_id text;
    event_room_seq bigint;
BEGIN
    WITH orphaned AS (
        UPDATE room_document_comment_threads thread
        SET anchor_status='orphaned',updated_at=now()
        WHERE thread.document_id=NEW.document_id
          AND thread.anchor_status='attached'
          AND thread.anchor_kind='selection'
          AND NOT (thread.id=ANY(NEW.thread_ids))
        RETURNING thread.id
    ), attached AS (
        UPDATE room_document_comment_threads thread
        SET anchor_status='attached',updated_at=now()
        WHERE thread.document_id=NEW.document_id
          AND thread.id=ANY(NEW.thread_ids)
          AND thread.anchor_status IN ('pending','orphaned')
        RETURNING thread.id
    )
    SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}'::text[]) INTO changed_thread_ids
    FROM (SELECT id FROM orphaned UNION SELECT id FROM attached) changed;
    IF cardinality(changed_thread_ids)=0 THEN
        RETURN NULL;
    END IF;

    -- The same Runs EnqueueCommentInputsForThreadsTx selects; the job's
    -- options match CommentInputArgs.InsertOpts.
    INSERT INTO river_job(kind, queue, args, max_attempts)
    SELECT DISTINCT 'document.comment_input', 'document_input',
           jsonb_build_object('run_id', local_run.run_id), 1
    FROM room_document_comments comment
    JOIN agent_runtime_inputs input
      ON input.source_message_id=comment.id AND input.source_kind='inbox'
    JOIN agent_local_runs local_run
      ON local_run.run_id=input.local_run_id AND local_run.context_key=input.context_key
     AND local_run.status='queued'
    JOIN agent_execution_contexts execution_context
      ON execution_context.context_key=local_run.context_key
     AND execution_context.context_kind='document'
     AND execution_context.document_id=comment.document_id
    WHERE comment.thread_id=ANY(changed_thread_ids);

    -- The change belongs to the editor whose save this is: the Runtime appends
    -- the saving editors last. A save without one is the owner's.
    SELECT document.tenant_id,actor.id,actor.kind
      INTO document_tenant_id,change_actor_id,change_actor_kind
    FROM documents document
    JOIN actors actor ON actor.tenant_id=document.tenant_id
     AND actor.id=CASE
         WHEN EXISTS (SELECT 1 FROM actors editor
                      WHERE editor.id=NEW.last_editor_ids[cardinality(NEW.last_editor_ids)]
                        AND editor.tenant_id=document.tenant_id)
         THEN NEW.last_editor_ids[cardinality(NEW.last_editor_ids)]
         ELSE document.owner_actor_id END
    WHERE document.id=NEW.document_id;

    -- Canonical order, as recordCommentChange takes it: the Room sequence
    -- rows in id order, then the Document. Thread rows come first here, as in
    -- every TeamHub Thread change.
    PERFORM 1 FROM rooms room
    WHERE room.tenant_id=document_tenant_id
      AND room.id IN (SELECT binding.room_id FROM document_context_bindings binding
                      WHERE binding.document_id=NEW.document_id AND binding.binding_kind='room'
                        AND binding.status='active')
    ORDER BY room.id FOR NO KEY UPDATE;
    PERFORM lock_document_event_scopes(ARRAY[NEW.document_id]);

    FOREACH changed_thread_id IN ARRAY changed_thread_ids LOOP
        INSERT INTO document_events(
            id,tenant_id,document_id,event_type,actor_id,resource_kind,resource_id,projection_version
        ) VALUES(
            'document_event_'||replace(gen_random_uuid()::text,'-',''),document_tenant_id,NEW.document_id,
            'document.comment_updated',change_actor_id,'comment_thread',changed_thread_id,1
        );
    END LOOP;

    FOR bound_room IN
        SELECT room.id FROM rooms room
        WHERE room.tenant_id=document_tenant_id
          AND room.deletion_started_at IS NULL AND room.deleted_at IS NULL
          AND room.id IN (SELECT binding.room_id FROM document_context_bindings binding
                          WHERE binding.document_id=NEW.document_id AND binding.binding_kind='room'
                            AND binding.status='active')
        ORDER BY room.id
    LOOP
        FOREACH changed_thread_id IN ARRAY changed_thread_ids LOOP
            -- AllocateRoomSeq, then CreateRoomEvent with roomevent.Append's
            -- event id and the payload recordCommentChange writes for a
            -- Thread anchor change.
            UPDATE rooms SET next_room_seq=next_room_seq+1
            WHERE id=bound_room.id AND deletion_started_at IS NULL AND deleted_at IS NULL
            RETURNING next_room_seq INTO event_room_seq;
            INSERT INTO room_events(event_id,tenant_id,room_id,room_seq,event_type,actor_id,resource_id,payload)
            VALUES(
                'event_'||replace(gen_random_uuid()::text,'-',''),document_tenant_id,bound_room.id,
                event_room_seq,'document.comment.changed',change_actor_id,changed_thread_id,
                jsonb_build_object('kind','document.comment.changed','change_kind','thread_reanchored',
                    'document_id',NEW.document_id,'thread_id',changed_thread_id)
            );
            -- A Human's own change does not count as unread for them.
            IF change_actor_kind='human' THEN
                INSERT INTO room_member_states(room_id,actor_id,read_through_room_seq)
                SELECT bound_room.id,change_actor_id,event_room_seq
                WHERE EXISTS (SELECT 1 FROM room_members member
                              WHERE member.room_id=bound_room.id AND member.actor_id=change_actor_id)
                ON CONFLICT (room_id,actor_id) DO UPDATE
                SET read_through_room_seq=greatest(room_member_states.read_through_room_seq,excluded.read_through_room_seq),
                    updated_at=CASE
                        WHEN excluded.read_through_room_seq>room_member_states.read_through_room_seq THEN now()
                        ELSE room_member_states.updated_at
                    END;
            END IF;
        END LOOP;
    END LOOP;
    RETURN NULL;
END $$;

CREATE FUNCTION public.record_document_history_point(target_document_id text, point_trigger text) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
    point_id text;
    point document_revisions%ROWTYPE;
    editors text[];
BEGIN
    point_id := snapshot_document_body(target_document_id);
    IF point_id IS NULL THEN
        RETURN NULL;
    END IF;
    SELECT * INTO point FROM document_revisions WHERE id=point_id FOR UPDATE;
    IF point.history_trigger IS NOT NULL THEN
        RETURN point_id;
    END IF;
    SELECT body.last_editor_ids INTO editors FROM document_bodies body
    WHERE body.document_id=target_document_id AND body.seq=point.persisted_seq;
    IF coalesce(cardinality(editors),0)=0 THEN
        editors := ARRAY[point.created_by_actor_id];
    END IF;
    UPDATE document_revisions SET history_trigger=point_trigger,
        history_contributor_ids=ARRAY(SELECT DISTINCT editor FROM unnest(editors) editor
                                      ORDER BY editor),
        history_recorded_at=clock_timestamp()
    WHERE id=point_id;
    UPDATE document_bodies SET last_editor_ids='{}'
    WHERE document_id=target_document_id AND seq=point.persisted_seq
      AND cardinality(last_editor_ids)>0;
    PERFORM publish_teamhub_realtime_wake('tenant:'||point.tenant_id,'invalidate.document',
        target_document_id,0,0);
    PERFORM enqueue_document_text_sync(target_document_id);
    RETURN point_id;
END $$;

CREATE FUNCTION public.reject_task_execution_fact_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION '% is immutable', TG_TABLE_NAME;
END $$;

CREATE FUNCTION public.resolve_agent_document_access_v2(p_agent_management_id text, p_document_id text) RETURNS TABLE(tenant_id text, actor_id text, content_role text, can_read boolean, can_write boolean, can_comment boolean)
    LANGUAGE sql STABLE
    AS $$
WITH principal AS (
    SELECT registration.tenant_id,registration.actor_id
    FROM agent_registrations registration
    WHERE registration.agent_management_id=p_agent_management_id AND registration.status='active'
), target AS (
    SELECT document.tenant_id,principal.actor_id,
      CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM document_context_bindings page
          WHERE page.document_id=document.id AND page.tenant_id=document.tenant_id
            AND page.binding_kind='wiki_page') THEN 'owner'
        WHEN EXISTS (
          SELECT 1 FROM document_context_bindings binding
          JOIN document_wiki_refreshes refresh ON refresh.wiki_id=binding.wiki_id
            AND refresh.tenant_id=binding.tenant_id
            AND refresh.generator_agent_actor_id=principal.actor_id
            AND refresh.status='staging'
          JOIN personal_wikis wiki ON wiki.id=binding.wiki_id AND wiki.tenant_id=binding.tenant_id
            AND wiki.deleted_at IS NULL
          WHERE binding.document_id=document.id AND binding.tenant_id=document.tenant_id
            AND binding.status='active' AND binding.binding_kind='wiki_page'
            AND binding.role<>'viewer') THEN 'editor'
        ELSE 'viewer'
      END AS role
    FROM documents document JOIN principal ON principal.tenant_id=document.tenant_id
    WHERE document.id=p_document_id AND document.status='active'
)
SELECT target.tenant_id,target.actor_id,target.role,true,target.role<>'viewer',true
FROM target
$$;

CREATE FUNCTION public.resolve_human_document_access_expiry(p_account_id text, p_document_id text, p_access_mode text) RETURNS TABLE(has_access boolean, expires_at timestamp with time zone)
    LANGUAGE sql STABLE
    AS $$
SELECT EXISTS (
    SELECT 1 FROM documents document
    JOIN actors principal ON principal.account_id=p_account_id AND principal.kind='human'
      AND principal.tenant_id=document.tenant_id
    WHERE document.id=p_document_id AND document.status='active'
      AND (p_access_mode IN ('read','comment') OR NOT EXISTS (
        SELECT 1 FROM document_context_bindings page
        WHERE page.document_id=document.id AND page.tenant_id=document.tenant_id
          AND page.binding_kind='wiki_page'))
), NULL::timestamptz
$$;

CREATE FUNCTION public.resolve_human_document_access_v2(p_account_id text, p_document_id text) RETURNS TABLE(tenant_id text, actor_id text, actor_kind text, actor_display_name text, can_read boolean, can_write boolean, can_manage boolean, can_comment boolean, content_role text, access_sources jsonb)
    LANGUAGE sql STABLE
    AS $$
SELECT principal.tenant_id,principal.id,principal.kind,principal.display_name,
       true,NOT target.read_only,NOT target.read_only,true,
       CASE WHEN target.read_only THEN 'viewer' ELSE 'owner' END,
       CASE WHEN document.owner_actor_id=principal.id THEN jsonb_build_array(jsonb_build_object(
         'schema_version',2,'source_id','owner:'||document.id,
         'source_version',1,'source_kind','owner','status','active','role','owner',
         'grantor_actor_id',document.owner_actor_id,
         'target',jsonb_build_object('kind','human','id',principal.id),
         'provenance',jsonb_build_object('schema_version',2,'kind','owner'),
         'created_at',document.created_at,'updated_at',document.updated_at))
       ELSE '[]'::jsonb END
FROM documents document
JOIN actors principal ON principal.account_id=p_account_id AND principal.kind='human'
  AND principal.tenant_id=document.tenant_id
CROSS JOIN LATERAL (SELECT EXISTS (
    SELECT 1 FROM document_context_bindings page
    WHERE page.document_id=document.id AND page.tenant_id=document.tenant_id
      AND page.binding_kind='wiki_page') AS read_only) target
WHERE document.id=p_document_id AND document.status='active'
$$;

CREATE FUNCTION public.river_job_state_in_bitmask(bitmask bit, state public.river_job_state) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $$
    SELECT CASE state
        WHEN 'available' THEN get_bit(bitmask, 7)
        WHEN 'cancelled' THEN get_bit(bitmask, 6)
        WHEN 'completed' THEN get_bit(bitmask, 5)
        WHEN 'discarded' THEN get_bit(bitmask, 4)
        WHEN 'pending'   THEN get_bit(bitmask, 3)
        WHEN 'retryable' THEN get_bit(bitmask, 2)
        WHEN 'running'   THEN get_bit(bitmask, 1)
        WHEN 'scheduled' THEN get_bit(bitmask, 0)
        ELSE 0
    END = 1;
$$;

CREATE FUNCTION public.room_actor_participating(p_room_id text, p_actor_id text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM room_member_states state
    JOIN active_room_members membership ON membership.room_id=state.room_id AND membership.actor_id=state.actor_id
      AND membership.membership_epoch_id=state.participation_epoch_id
    WHERE state.room_id=collaboration_membership_room_id(p_room_id)
      AND state.actor_id=p_actor_id AND state.left_at IS NOT NULL
  );
$$;

CREATE FUNCTION public.snapshot_document_body(target_document_id text) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
    body document_bodies%ROWTYPE;
    fingerprint text;
    snapshot_id text;
BEGIN
    SELECT * INTO body FROM document_bodies WHERE document_id=target_document_id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    SELECT revision.id INTO snapshot_id FROM document_revisions revision
    WHERE revision.document_id=body.document_id AND revision.persisted_seq=body.seq;
    IF FOUND THEN
        RETURN snapshot_id;
    END IF;
    fingerprint := encode(sha256(body.state),'hex');
    snapshot_id := 'document_revision_body_'
        || left(encode(sha256(convert_to(body.document_id||':'||body.seq,'UTF8')),'hex'),32);
    INSERT INTO document_revisions(
        id,tenant_id,document_id,persisted_seq,state_vector,full_state_fingerprint,
        state_status,state_bytes,state_bytes_sha256,asset_manifest,thread_manifest,created_by_actor_id
    )
    SELECT snapshot_id,document.tenant_id,body.document_id,body.seq,body.state_vector,fingerprint,
        'available',body.state,fingerprint,
        coalesce((SELECT jsonb_agg(jsonb_build_object(
                'asset_id',asset.id,'sha256',asset.sha256,'size_bytes',asset.size_bytes)
                ORDER BY asset.id COLLATE "C")
            FROM document_assets asset
            WHERE asset.document_id=body.document_id AND asset.id=ANY(body.asset_ids)),'[]'::jsonb),
        body.thread_ids,
        coalesce(body.last_editor_ids[cardinality(body.last_editor_ids)],document.creator_actor_id)
    FROM documents document WHERE document.id=body.document_id
    ON CONFLICT DO NOTHING;
    RETURN snapshot_id;
END $$;

CREATE FUNCTION public.source_rejection_reason(import_status text, file_name text, representation text, kind text, mime text, text_status text, is_scanned boolean, text_bytes bigint, line_bytes bigint) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
SELECT
    CASE
        WHEN import_status = 'failed' THEN 'unreadable'
        WHEN lower(coalesce(file_name, '')) LIKE '%.crdownload'
          OR lower(coalesce(representation, '')) = 'crdownload' THEN 'unsupported_type'
        WHEN kind = 'file_version'
         AND NOT wiki_reads_file_format(mime, file_name, representation)
            THEN 'unsupported_type'
        WHEN text_status = 'unsupported' THEN 'unsupported_type'
        WHEN text_status = 'too_large' THEN 'too_large'
        WHEN text_status = 'failed' THEN 'unreadable'
        WHEN is_scanned THEN 'scanned'
        WHEN text_status = 'no_text' AND kind = 'file_version'
         AND (lower(trim(split_part(mime, ';', 1))) = 'application/pdf'
              OR lower(file_name) LIKE '%.pdf'
              OR lower(representation) = 'pdf') THEN 'scanned'
        WHEN text_status = 'no_text' OR text_bytes = 0 THEN 'no_text'
        WHEN line_bytes > 144000 THEN 'too_large'
    END
$$;

CREATE FUNCTION public.unified_skill_agent_types_are_canonical(value text[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
    SELECT value IS NOT NULL
       AND array_position(value,NULL) IS NULL
       AND value = ARRAY(
           SELECT known.agent_type
           FROM unnest(ARRAY['anotherme','builder','general']::text[])
                WITH ORDINALITY AS known(agent_type,ordinality)
           WHERE known.agent_type=ANY(value)
           ORDER BY known.ordinality
       );
$$;

CREATE FUNCTION public.unified_skill_manifest_version_is_semver(value text) RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $_$
    SELECT value ~ '^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)([.](0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?([+]([0-9A-Za-z-]+)([.][0-9A-Za-z-]+)*)?$';
$_$;

CREATE FUNCTION public.valid_document_revision_thread_manifest(value text[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $_$
    SELECT value IS NOT NULL
       AND cardinality(value) <= 4096
       AND NOT EXISTS (
           SELECT 1
           FROM unnest(value) item
           WHERE item IS NULL
              OR length(item) NOT BETWEEN 1 AND 64
              OR item !~ '^[A-Za-z0-9][A-Za-z0-9_-]*$'
       )
       AND cardinality(value)=(SELECT count(DISTINCT item) FROM unnest(value) item)
       AND value=ARRAY(SELECT item FROM unnest(value) item ORDER BY item COLLATE "C");
$_$;

CREATE FUNCTION public.validate_user_artifact_human_owner(target_tenant_id text, target_owner_actor_id text) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF target_owner_actor_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM actors
        WHERE id=target_owner_actor_id
          AND tenant_id=target_tenant_id
          AND kind='human'
    ) THEN
        RAISE EXCEPTION 'User Artifact owner must be a Human Actor'
            USING ERRCODE='check_violation';
    END IF;
END $$;

CREATE FUNCTION public.voice_live_initialize() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE target text;
BEGIN
 IF NEW.purpose <> 'chat_live' THEN RETURN NEW; END IF;
 SELECT registration.actor_id INTO target FROM agent_registrations registration
 JOIN active_room_members member ON member.actor_id=registration.actor_id AND member.room_id=NEW.room_id
 WHERE registration.tenant_id=NEW.tenant_id AND registration.status='active'
 AND registration.actor_id=coalesce(
  (SELECT direct_agent_actor_id FROM rooms WHERE id=NEW.room_id AND direct_human_actor_id=NEW.created_by_actor_id),
  (SELECT actor_id FROM agent_registrations WHERE represented_human_actor_id=NEW.created_by_actor_id
   AND agent_type='anotherme' AND status='active' ORDER BY actor_id LIMIT 1));
 IF target IS NULL THEN RAISE EXCEPTION 'Live requires an active Room Agent' USING ERRCODE='23514',CONSTRAINT='voice_live_agent_required'; END IF;
 -- Context serialization is also held when Meta accepts or claims input.
 PERFORM 1 FROM agent_execution_contexts WHERE agent_actor_id=target AND room_id=NEW.room_id AND context_kind='meta' FOR UPDATE;
 NEW.live_agent_actor_id:=target;
 NEW.live_lease_until:=clock_timestamp()+interval '90 seconds';
 RETURN NEW;
END $$;

CREATE FUNCTION public.voice_live_owns_context(p_context text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
 SELECT EXISTS(SELECT 1 FROM agent_execution_contexts context
 JOIN voice_sessions voice ON voice.tenant_id=context.tenant_id AND voice.live_agent_actor_id=context.agent_actor_id
 WHERE context.context_key=p_context AND context.context_kind='meta'
 AND voice.purpose='chat_live' AND voice.status IN ('provisioning','connected','reconnecting')
 AND voice.live_lease_until>now()
 AND (voice.room_id=context.room_id OR EXISTS(SELECT 1 FROM voice_live_tasks task
  WHERE task.room_id=voice.room_id AND task.owner_actor_id=voice.created_by_actor_id AND task.home_room_id=context.room_id)));
$$;

CREATE FUNCTION public.voice_live_task_foreground() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM voice_sessions voice WHERE voice.id=NEW.voice_session_id AND voice.status IN ('provisioning','connected','reconnecting') AND voice.live_lease_until>now()) THEN
  PERFORM 1 FROM agent_execution_contexts context JOIN voice_sessions voice ON voice.live_agent_actor_id=context.agent_actor_id AND voice.tenant_id=context.tenant_id WHERE voice.id=NEW.voice_session_id AND context.context_kind='meta' AND context.room_id=NEW.home_room_id FOR UPDATE OF context;
  UPDATE agent_local_runs run SET cancellation_requested=true,updated_at=clock_timestamp() FROM agent_execution_contexts context JOIN voice_sessions voice ON voice.live_agent_actor_id=context.agent_actor_id AND voice.tenant_id=context.tenant_id WHERE run.context_key=context.context_key AND voice.id=NEW.voice_session_id AND context.context_kind='meta' AND context.room_id=NEW.home_room_id AND run.status='running';
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION public.voice_live_task_state_changed() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE origin_room text;
BEGIN
 SELECT room_id INTO origin_room FROM voice_live_tasks WHERE work_item_id=NEW.id;
 IF origin_room IS NOT NULL THEN
  PERFORM pg_notify('teamhub_realtime',json_build_object('topic','voicetasks:'||origin_room,'kind','voice.tasks.changed','resource_id',NEW.id,'sequence',0,'revision',0)::text);
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION public.voice_live_transition() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE item record;
BEGIN
 IF NEW.purpose <> 'chat_live' THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' THEN
  -- Interrupt the foreground Meta only. Delegated AlterEgos keep their identity,
  -- workspace and accepted work throughout the switch.
  UPDATE agent_local_runs run SET cancellation_requested=true,updated_at=clock_timestamp()
  FROM agent_execution_contexts context WHERE context.context_key=run.context_key
   AND context.context_kind='meta' AND context.agent_actor_id=NEW.live_agent_actor_id
   AND context.room_id=NEW.room_id AND run.status='running';
 ELSIF OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('closing','closed') THEN
  FOR item IN SELECT context.context_key FROM agent_execution_contexts context
   WHERE context.tenant_id=NEW.tenant_id AND context.agent_actor_id=NEW.live_agent_actor_id
    AND context.context_kind='meta'
    AND (context.room_id=NEW.room_id OR context.room_id IN (
     SELECT task.home_room_id FROM voice_live_tasks task
     WHERE task.room_id=NEW.room_id AND task.owner_actor_id=NEW.created_by_actor_id))
    AND EXISTS (SELECT 1 FROM agent_local_runs run WHERE run.context_key=context.context_key AND run.status='queued')
  LOOP
   PERFORM publish_teamhub_realtime_wake('agent-inbox:all','run.queued',item.context_key,0,0);
  END LOOP;
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION public.wiki_reads_file_format(media_type text, filename text, representation_format text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $_$
SELECT CASE
    WHEN format.extension = ANY (ARRAY['md', 'markdown', 'txt', 'htm', 'html', 'xhtml', 'mht', 'mhtml', 'eml',
                                       'pdf', 'doc', 'docx', 'dotx', 'pptx', 'potx', 'ppsx', 'odt', 'odp', 'epub'])
        THEN true
    WHEN format.extension = ANY (ARRAY['avif', 'bmp', 'gif', 'heic', 'heif', 'ico', 'jpeg', 'jpg', 'png', 'svg',
                                       'tif', 'tiff', 'webp', 'aac', 'flac', 'm4a', 'mp3', 'ogg', 'wav', 'avi', 'mkv',
                                       'mov', 'mp4', 'webm', '7z', 'gz', 'gzip', 'rar', 'tar', 'tgz', 'zip', 'ppt',
                                       'csv', 'ods', 'tsv', 'xls', 'xlsx', 'xltx', 'json', 'log', 'sql', 'toml', 'xml',
                                       'yaml', 'yml', 'c', 'cpp', 'css', 'go', 'h', 'hpp', 'java', 'js', 'jsx', 'less',
                                       'mmd', 'py', 'rs', 'scss', 'sh', 'ts', 'tsx'])
        THEN false
    WHEN format.media_type = ANY (ARRAY[
            'text/markdown', 'text/x-markdown', 'text/plain', 'text/html', 'application/xhtml+xml',
            'message/rfc822', 'multipart/related', 'application/x-mimearchive', 'application/pdf',
            'application/msword', 'application/vnd.ms-word', 'application/x-msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'application/vnd.openxmlformats-officedocument.presentationml.template',
            'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
            'application/vnd.oasis.opendocument.text', 'application/vnd.oasis.opendocument.presentation',
            'application/epub+zip'])
        THEN true
    ELSE format.representation = ANY (ARRAY['markdown', 'plain_text', 'html', 'pdf', 'doc', 'docx', 'dotx', 'pptx',
                                             'potx', 'ppsx', 'odt', 'odp', 'epub', 'eml', 'mht', 'mhtml'])
END
FROM (SELECT lower(trim(split_part(coalesce(media_type, ''), ';', 1))) AS media_type,
             lower(substring(coalesce(filename, '') FROM '\.([^./]+)$')) AS extension,
             lower(coalesce(representation_format, '')) AS representation) format
$_$;

CREATE TABLE memory_index.chunks (
    id text NOT NULL,
    tenant_id text NOT NULL,
    owner_id text NOT NULL,
    agent_id text NOT NULL,
    source_id text NOT NULL,
    source_sha256 text NOT NULL,
    chunk_no integer NOT NULL,
    content text NOT NULL,
    heading_path text[] DEFAULT ARRAY[]::text[] NOT NULL,
    line_start integer NOT NULL,
    line_end integer NOT NULL,
    content_sha256 text NOT NULL,
    search_tsv tsvector NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chunks_check CHECK ((line_end >= line_start)),
    CONSTRAINT chunks_chunk_no_check CHECK ((chunk_no >= 0)),
    CONSTRAINT chunks_content_check CHECK ((length(content) > 0)),
    CONSTRAINT chunks_content_sha256_check CHECK ((content_sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT chunks_heading_path_check CHECK ((array_position(heading_path, NULL::text) IS NULL)),
    CONSTRAINT chunks_id_check CHECK ((id ~ '^chunk-[a-f0-9]{16}-[0-9]+$'::text)),
    CONSTRAINT chunks_line_start_check CHECK ((line_start >= 1)),
    CONSTRAINT chunks_source_sha256_check CHECK ((source_sha256 ~ '^[a-f0-9]{64}$'::text))
);

CREATE TABLE memory_index.scheduler_state (
    singleton boolean DEFAULT true NOT NULL,
    calendar_time_zone text,
    calendar_hour bigint,
    calendar_completed text[] DEFAULT '{}'::text[] NOT NULL,
    calendar_pending jsonb DEFAULT '[]'::jsonb NOT NULL,
    calendar_failed jsonb DEFAULT '[]'::jsonb NOT NULL,
    triggers_activated_at timestamp with time zone,
    triggers_scanned_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT scheduler_state_check CHECK (((calendar_time_zone IS NULL) = (calendar_hour IS NULL))),
    CONSTRAINT scheduler_state_singleton_check CHECK (singleton)
);

CREATE TABLE memory_index.session_fact_windows (
    tenant_id text NOT NULL,
    owner_id text NOT NULL,
    agent_id text NOT NULL,
    source_id text NOT NULL,
    window_sha256 text NOT NULL,
    fact_count integer NOT NULL,
    extracted_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT session_fact_windows_fact_count_check CHECK ((fact_count >= 0)),
    CONSTRAINT session_fact_windows_window_sha256_check CHECK ((window_sha256 ~ '^[a-f0-9]{64}$'::text))
);

CREATE TABLE memory_index.session_facts (
    id text NOT NULL,
    tenant_id text NOT NULL,
    owner_id text NOT NULL,
    agent_id text NOT NULL,
    source_id text NOT NULL,
    source_sha256 text NOT NULL,
    window_sha256 text NOT NULL,
    chunk_id text NOT NULL,
    chunk_sha256 text NOT NULL,
    ordinal integer NOT NULL,
    text text NOT NULL,
    speaker text,
    fact_type text NOT NULL,
    occurred_start date,
    occurred_end date,
    mentioned_at timestamp with time zone NOT NULL,
    entities text[] DEFAULT ARRAY[]::text[] NOT NULL,
    search_tsv tsvector NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT session_facts_check CHECK (((occurred_end IS NULL) OR (occurred_start IS NULL) OR (occurred_end >= occurred_start))),
    CONSTRAINT session_facts_chunk_sha256_check CHECK ((chunk_sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT session_facts_fact_type_check CHECK ((fact_type = ANY (ARRAY['world'::text, 'assistant'::text]))),
    CONSTRAINT session_facts_id_check CHECK ((id ~ '^msf_[a-f0-9]{32}$'::text)),
    CONSTRAINT session_facts_ordinal_check CHECK ((ordinal >= 0)),
    CONSTRAINT session_facts_source_sha256_check CHECK ((source_sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT session_facts_text_check CHECK (((length(text) >= 1) AND (length(text) <= 1000))),
    CONSTRAINT session_facts_window_sha256_check CHECK ((window_sha256 ~ '^[a-f0-9]{64}$'::text))
);

CREATE TABLE memory_index.session_trigger_targets (
    target_key text NOT NULL,
    target jsonb NOT NULL,
    attempts integer NOT NULL,
    next_attempt_at timestamp with time zone NOT NULL,
    started boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT session_trigger_targets_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT session_trigger_targets_target_key_check CHECK ((target_key ~ '^[a-f0-9]{64}$'::text))
);

CREATE TABLE memory_index.source_versions (
    source_id text NOT NULL,
    sha256 text NOT NULL,
    manifest jsonb NOT NULL,
    content text NOT NULL,
    size_bytes bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT source_versions_check CHECK (((size_bytes = octet_length(content)) AND ((size_bytes >= 1) AND (size_bytes <= 33554432)))),
    CONSTRAINT source_versions_content_check CHECK ((length(content) > 0)),
    CONSTRAINT source_versions_manifest_check CHECK ((jsonb_typeof(manifest) = 'object'::text)),
    CONSTRAINT source_versions_sha256_check CHECK ((sha256 ~ '^[a-f0-9]{64}$'::text))
);

CREATE TABLE memory_index.sources (
    id text NOT NULL,
    tenant_id text NOT NULL,
    owner_id text NOT NULL,
    agent_id text NOT NULL,
    document_id text NOT NULL,
    source_path text NOT NULL,
    title text NOT NULL,
    mime_type text DEFAULT 'text/markdown'::text NOT NULL,
    active_sha256 text,
    index_profile text NOT NULL,
    indexed_at timestamp with time zone,
    last_index_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    source_kind text DEFAULT 'room_message'::text NOT NULL,
    origin_kind text DEFAULT 'room'::text NOT NULL,
    source_uri text DEFAULT ''::text NOT NULL,
    source_version text DEFAULT ''::text NOT NULL,
    representation_format text DEFAULT 'markdown'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    state text DEFAULT 'active'::text NOT NULL,
    room_id text,
    CONSTRAINT sources_active_sha256_check CHECK (((active_sha256 IS NULL) OR (active_sha256 ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT sources_document_id_check CHECK ((document_id ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT sources_id_check CHECK ((id ~ '^mis_[a-f0-9]{24}$'::text)),
    CONSTRAINT sources_index_profile_check CHECK (((length(index_profile) >= 1) AND (length(index_profile) <= 128))),
    CONSTRAINT sources_last_index_error_check CHECK (((last_index_error IS NULL) OR (length(last_index_error) <= 2048))),
    CONSTRAINT sources_metadata_check CHECK ((jsonb_typeof(metadata) = 'object'::text)),
    CONSTRAINT sources_mime_type_check CHECK (((length(mime_type) >= 1) AND (length(mime_type) <= 128))),
    CONSTRAINT sources_origin_kind_check CHECK ((origin_kind = ANY (ARRAY['room'::text, 'recording'::text, 'my_pages'::text, 'connected_app'::text, 'mail'::text, 'period_summary'::text, 'pocket_note'::text, 'profile'::text, 'wiki'::text]))),
    CONSTRAINT sources_representation_format_check CHECK ((representation_format = 'markdown'::text)),
    CONSTRAINT sources_source_kind_check CHECK ((source_kind = ANY (ARRAY['room_message'::text, 'recording_transcript'::text, 'document'::text, 'connected_app_item'::text, 'pocket_note'::text, 'profile'::text, 'wiki_page'::text, 'period_report'::text]))),
    CONSTRAINT sources_source_path_check CHECK (((length(source_path) >= 1) AND (length(source_path) <= 2048))),
    CONSTRAINT sources_source_uri_check CHECK ((length(source_uri) <= 2048)),
    CONSTRAINT sources_source_version_check CHECK ((length(source_version) <= 255)),
    CONSTRAINT sources_state_check CHECK ((state = ANY (ARRAY['active'::text, 'failed'::text]))),
    CONSTRAINT sources_title_check CHECK (((length(title) >= 1) AND (length(title) <= 512)))
);

CREATE TABLE memory_index.tracking_items (
    id text NOT NULL,
    tenant_id text NOT NULL,
    owner_actor_id text NOT NULL,
    kind text NOT NULL,
    content text NOT NULL,
    due_at timestamp with time zone,
    source_ref text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    due_text text,
    source_date date DEFAULT CURRENT_DATE NOT NULL,
    source_timezone text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    CONSTRAINT tracking_items_content_check CHECK (((length(content) >= 1) AND (length(content) <= 200))),
    CONSTRAINT tracking_items_due_text_check CHECK (((length(due_text) >= 1) AND (length(due_text) <= 500))),
    CONSTRAINT tracking_items_id_check CHECK ((id ~ '^ti_[a-f0-9]{32}$'::text)),
    CONSTRAINT tracking_items_kind_check CHECK ((kind = ANY (ARRAY['todo'::text, 'question'::text, 'meeting'::text]))),
    CONSTRAINT tracking_items_revision_check CHECK ((revision > 0)),
    CONSTRAINT tracking_items_source_ref_check CHECK (((length(source_ref) >= 1) AND (length(source_ref) <= 2048))),
    CONSTRAINT tracking_items_status_check CHECK ((status = ANY (ARRAY['open'::text, 'done'::text])))
);

CREATE TABLE public.actors (
    id text NOT NULL,
    tenant_id text NOT NULL,
    kind text NOT NULL,
    display_name text NOT NULL,
    account_id text,
    handle text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT actors_display_name_check CHECK (((length(display_name) >= 1) AND (length(display_name) <= 120))),
    CONSTRAINT actors_identity_shape CHECK ((((kind = 'human'::text) AND (handle IS NULL)) OR ((kind = 'agent'::text) AND (account_id IS NULL) AND (handle IS NOT NULL)))),
    CONSTRAINT actors_kind_check CHECK ((kind = ANY (ARRAY['human'::text, 'agent'::text])))
);

CREATE TABLE public.agent_registrations (
    actor_id text NOT NULL,
    tenant_id text NOT NULL,
    agent_management_id text,
    status text NOT NULL,
    instructions text NOT NULL,
    runtime_model text NOT NULL,
    created_by_actor_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    computer_id text,
    local_runtime_type text,
    workspace_grant_id text,
    visibility_scope text DEFAULT 'workspace'::text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    configuration_revision bigint DEFAULT 1 NOT NULL,
    agent_type text DEFAULT 'general'::text NOT NULL,
    represented_human_actor_id text,
    user_artifact_owner_actor_id text,
    runtime_reasoning_effort text,
    avatar_key text,
    runtime_configuration_revision bigint DEFAULT 1 NOT NULL,
    avatar_image text,
    avatar_updated_at timestamp with time zone,
    template_id text,
    template_routines jsonb,
    template_installed_at timestamp with time zone,
    assignment_revision bigint DEFAULT 1 NOT NULL,
    receives_all_messages boolean DEFAULT false NOT NULL,
    CONSTRAINT agent_registrations_agent_type_check CHECK ((agent_type = ANY (ARRAY['general'::text, 'anotherme'::text]))),
    CONSTRAINT agent_registrations_assignment_revision_check CHECK ((assignment_revision >= 1)),
    CONSTRAINT agent_registrations_avatar_image_check CHECK (((length(avatar_image) >= 1) AND (length(avatar_image) <= 131072))),
    CONSTRAINT agent_registrations_avatar_key_check CHECK (((avatar_key IS NULL) OR ((length(avatar_key) >= 1) AND (length(avatar_key) <= 64)))),
    CONSTRAINT agent_registrations_avatar_shape CHECK (((avatar_image IS NULL) = (avatar_updated_at IS NULL))),
    CONSTRAINT agent_registrations_configuration_revision_check CHECK ((configuration_revision >= 1)),
    CONSTRAINT agent_registrations_description_check CHECK ((length(description) <= 1000)),
    CONSTRAINT agent_registrations_identity_check CHECK ((agent_management_id IS NOT NULL)),
    CONSTRAINT agent_registrations_instructions_check CHECK (((length(instructions) >= 1) AND (length(instructions) <= 50000))),
    CONSTRAINT agent_registrations_placement_check CHECK (((status = 'revoked'::text) OR ((computer_id IS NOT NULL) AND (computer_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'::text) AND (local_runtime_type IS NOT NULL) AND (local_runtime_type = ANY (ARRAY['codex'::text, 'claude'::text, 'pi'::text])) AND (workspace_grant_id IS NOT NULL) AND (workspace_grant_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'::text)))),
    CONSTRAINT agent_registrations_represented_human_shape_check CHECK ((((agent_type = 'anotherme'::text) AND (represented_human_actor_id IS NOT NULL)) OR ((agent_type <> 'anotherme'::text) AND (represented_human_actor_id IS NULL)))),
    CONSTRAINT agent_registrations_runtime_model_check CHECK (((length(runtime_model) >= 1) AND (length(runtime_model) <= 120))),
    CONSTRAINT agent_registrations_runtime_reasoning_effort_check CHECK (((runtime_reasoning_effort IS NULL) OR ((runtime_reasoning_effort = btrim(runtime_reasoning_effort)) AND ((length(runtime_reasoning_effort) >= 1) AND (length(runtime_reasoning_effort) <= 20))))),
    CONSTRAINT agent_registrations_runtime_revision_check CHECK (((runtime_configuration_revision >= 1) AND (runtime_configuration_revision <= configuration_revision))),
    CONSTRAINT agent_registrations_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text]))),
    CONSTRAINT agent_registrations_template_routines_check CHECK (((jsonb_typeof(template_routines) = 'array'::text) AND (jsonb_array_length(template_routines) <= 50))),
    CONSTRAINT agent_registrations_template_shape CHECK ((((template_id IS NULL) = (template_routines IS NULL)) AND ((template_installed_at IS NULL) OR (template_id IS NOT NULL)))),
    CONSTRAINT agent_registrations_user_artifact_owner_shape_check CHECK ((((agent_type = 'anotherme'::text) AND (user_artifact_owner_actor_id = represented_human_actor_id)) OR (agent_type = 'general'::text))),
    CONSTRAINT agent_registrations_visibility_scope_check CHECK ((visibility_scope = ANY (ARRAY['sponsor'::text, 'workspace'::text])))
);

CREATE TABLE public.personal_profile_currents (
    tenant_id text NOT NULL,
    owner_actor_id text NOT NULL,
    revision_id text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.personal_profile_revisions (
    id text NOT NULL,
    tenant_id text NOT NULL,
    owner_actor_id text NOT NULL,
    prompt_version text NOT NULL,
    markdown text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    source_profile_generation_id text,
    source_apps text[],
    profile jsonb NOT NULL
);

CREATE VIEW memory_source.another_me_subjects AS
 SELECT registration.tenant_id,
    registration.actor_id AS agent_actor_id,
    registration.agent_management_id,
    agent_actor.display_name AS agent_display_name,
    registration.represented_human_actor_id,
    human_actor.display_name AS represented_human_display_name,
    human_actor.account_id AS represented_human_account_id,
    profile_current.revision_id AS user_profile_revision_id,
    profile_revision.markdown AS user_profile_markdown,
    ((human_actor.account_id IS NOT NULL))::boolean AS human_is_tenant_member
   FROM ((((public.agent_registrations registration
     JOIN public.actors agent_actor ON (((agent_actor.id = registration.actor_id) AND (agent_actor.tenant_id = registration.tenant_id))))
     JOIN public.actors human_actor ON (((human_actor.id = registration.represented_human_actor_id) AND (human_actor.tenant_id = registration.tenant_id) AND (human_actor.kind = 'human'::text))))
     LEFT JOIN public.personal_profile_currents profile_current ON (((profile_current.tenant_id = registration.tenant_id) AND (profile_current.owner_actor_id = registration.represented_human_actor_id))))
     LEFT JOIN public.personal_profile_revisions profile_revision ON ((profile_revision.id = profile_current.revision_id)))
  WHERE ((registration.agent_type = 'anotherme'::text) AND (registration.status = 'active'::text));

CREATE TABLE public.messages (
    id text NOT NULL,
    tenant_id text NOT NULL,
    room_id text NOT NULL,
    author_actor_id text NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    segments jsonb NOT NULL,
    card_context_message_id text,
    message_kind text DEFAULT 'conversation'::text NOT NULL,
    team_protocol text,
    local_run_id text,
    notice jsonb,
    card_title text,
    room_seq bigint,
    mentioned_actor_ids text[] DEFAULT '{}'::text[] NOT NULL,
    reply_to_message_id text,
    context_message_ids text[] DEFAULT '{}'::text[] NOT NULL,
    attachments jsonb DEFAULT '[]'::jsonb NOT NULL,
    fired_routine_id text,
    fired_routine_instruction text,
    card_kind text,
    CONSTRAINT messages_attachments_check CHECK (public.message_attachments_valid(attachments)),
    CONSTRAINT messages_body_check CHECK (((length(body) >= 1) AND (length(body) <= 50000))),
    CONSTRAINT messages_card_context_not_self_check CHECK (((card_context_message_id IS NULL) OR (card_context_message_id <> id))),
    CONSTRAINT messages_card_kind_check CHECK (((card_kind IS NULL) OR ((card_kind = 'profile'::text) AND (card_title IS NOT NULL)))),
    CONSTRAINT messages_card_title_check CHECK (((card_title IS NULL) OR ((message_kind = 'conversation'::text) AND (card_title = btrim(card_title)) AND ((char_length(card_title) >= 1) AND (char_length(card_title) <= 120)) AND (strpos(card_title, '
'::text) = 0)))),
    CONSTRAINT messages_context_message_ids_check CHECK (((cardinality(context_message_ids) <= 10) AND public.distinct_text_ids(context_message_ids) AND (NOT (id = ANY (context_message_ids))))),
    CONSTRAINT messages_fired_routine_check CHECK ((((fired_routine_id IS NULL) = (fired_routine_instruction IS NULL)) AND ((fired_routine_id IS NULL) OR (message_kind = 'agent_runtime'::text)))),
    CONSTRAINT messages_mentioned_actor_ids_check CHECK (public.distinct_text_ids(mentioned_actor_ids)),
    CONSTRAINT messages_mentions_published_check CHECK (((cardinality(mentioned_actor_ids) = 0) OR (room_seq IS NOT NULL))),
    CONSTRAINT messages_message_kind_check CHECK ((message_kind = ANY (ARRAY['conversation'::text, 'agent_runtime'::text, 'task_terminal_notice'::text, 'room_notice'::text]))),
    CONSTRAINT messages_reply_to_not_self_check CHECK (((reply_to_message_id IS NULL) OR (reply_to_message_id <> id))),
    CONSTRAINT messages_room_notice_shape CHECK ((((message_kind = 'room_notice'::text) = (notice IS NOT NULL)) AND ((notice IS NULL) OR ((notice ->> 'type'::text) = ANY (ARRAY['agent_created'::text, 'member_added'::text, 'agent_profile_changed'::text]))))),
    CONSTRAINT messages_room_seq_check CHECK (((room_seq IS NULL) OR (room_seq >= 1))),
    CONSTRAINT messages_segments_shape_check CHECK (
CASE
    WHEN (jsonb_typeof(segments) = 'array'::text) THEN ((jsonb_array_length(segments) >= 1) AND (jsonb_array_length(segments) <= 1000))
    ELSE false
END),
    CONSTRAINT messages_team_protocol_check CHECK (((team_protocol IS NULL) OR (team_protocol = ANY (ARRAY['classify-and-act'::text, 'fan-out-and-synthesize'::text, 'adversarial-verification'::text, 'tournament'::text, 'loop-until-done'::text]))))
);

CREATE VIEW memory_source.conversation_messages AS
 SELECT message.id,
    message.tenant_id,
    message.room_id,
    message.author_actor_id,
    author.display_name AS author_display_name,
    author.kind AS author_kind,
    message.message_kind,
    message.body,
    message.created_at
   FROM (public.messages message
     JOIN public.actors author ON (((author.id = message.author_actor_id) AND (author.tenant_id = message.tenant_id))))
  WHERE (message.message_kind = 'conversation'::text);

CREATE TABLE public.rooms (
    id text NOT NULL,
    tenant_id text NOT NULL,
    name text NOT NULL,
    description text,
    created_by_actor_id text NOT NULL,
    next_room_seq bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deletion_started_at timestamp with time zone,
    deletion_started_by_actor_id text,
    deleted_at timestamp with time zone,
    deleted_by_actor_id text,
    direct_human_actor_id text,
    direct_agent_actor_id text,
    parent_room_id text,
    root_message_id text,
    team_md_raw_markdown text,
    team_md_collaborate_pattern text,
    team_md_document jsonb,
    team_md_revision bigint,
    team_md_updated_at timestamp with time zone,
    team_md_updated_by_actor_id text,
    CONSTRAINT rooms_deletion_shape CHECK ((((deletion_started_at IS NULL) AND (deletion_started_by_actor_id IS NULL) AND (deleted_at IS NULL) AND (deleted_by_actor_id IS NULL)) OR ((deletion_started_at IS NOT NULL) AND (deletion_started_by_actor_id IS NOT NULL) AND (deleted_at IS NULL) AND (deleted_by_actor_id IS NULL)) OR ((deletion_started_at IS NOT NULL) AND (deletion_started_by_actor_id IS NOT NULL) AND (deleted_at IS NOT NULL) AND (deleted_at >= deletion_started_at) AND (deleted_by_actor_id = deletion_started_by_actor_id)))),
    CONSTRAINT rooms_direct_pair_distinct CHECK ((direct_human_actor_id <> direct_agent_actor_id)),
    CONSTRAINT rooms_direct_pair_shape CHECK (((direct_human_actor_id IS NULL) = (direct_agent_actor_id IS NULL))),
    CONSTRAINT rooms_name_check CHECK (((length(name) >= 1) AND (length(name) <= 120))),
    CONSTRAINT rooms_next_room_seq_check CHECK ((next_room_seq >= 0)),
    CONSTRAINT rooms_team_md_pattern_check CHECK ((team_md_collaborate_pattern = ANY (ARRAY['classify-and-act'::text, 'fan-out-and-synthesize'::text, 'adversarial-verification'::text, 'tournament'::text, 'loop-until-done'::text]))),
    CONSTRAINT rooms_team_md_raw_markdown_check CHECK (((length(team_md_raw_markdown) >= 1) AND (length(team_md_raw_markdown) <= 65536))),
    CONSTRAINT rooms_team_md_revision_check CHECK ((team_md_revision >= 1)),
    CONSTRAINT rooms_team_md_shape CHECK ((((team_md_raw_markdown IS NULL) AND (team_md_collaborate_pattern IS NULL) AND (team_md_document IS NULL) AND (team_md_revision IS NULL) AND (team_md_updated_at IS NULL) AND (team_md_updated_by_actor_id IS NULL)) OR ((team_md_raw_markdown IS NOT NULL) AND (team_md_collaborate_pattern IS NOT NULL) AND (team_md_document IS NOT NULL) AND (team_md_revision IS NOT NULL) AND (team_md_updated_at IS NOT NULL) AND (team_md_updated_by_actor_id IS NOT NULL)))),
    CONSTRAINT rooms_thread_not_self CHECK ((parent_room_id <> id)),
    CONSTRAINT rooms_thread_shape CHECK (((parent_room_id IS NULL) = (root_message_id IS NULL)))
);

CREATE VIEW memory_source.deleted_rooms AS
 SELECT tenant_id,
    id AS room_id
   FROM public.rooms
  WHERE (deleted_at IS NOT NULL);

CREATE TABLE public.capture_sessions (
    id text NOT NULL,
    tenant_id text NOT NULL,
    room_id text NOT NULL,
    created_by_actor_id text NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    transcript_start_offset_ms bigint,
    transcript_end_offset_ms bigint,
    document_id text,
    document_version_id text,
    transcript_document_id text,
    transcript_document_version_id text,
    voice_session_id text,
    transcript_integrity_lost boolean DEFAULT false NOT NULL,
    source_audio_document_id text,
    source_audio_document_version_id text,
    transcript_recovered_at timestamp with time zone,
    requested_transcript_start_offset_ms bigint NOT NULL,
    voice_completion_attempts integer DEFAULT 0 NOT NULL,
    voice_completion_failed_at timestamp with time zone,
    voice_completion_failure_code text,
    staging_deleted_at timestamp with time zone,
    stop_requested_at timestamp with time zone,
    materialize_requested_at timestamp with time zone,
    materialize_attempts integer DEFAULT 0 NOT NULL,
    materialize_retry_at timestamp with time zone,
    transcript_recovery_status text,
    transcript_recovery_progress_ms bigint DEFAULT 0 NOT NULL,
    transcript_recovery_total_ms bigint,
    transcript_recovery_failures integer DEFAULT 0 NOT NULL,
    transcript_recovery_failure_code text,
    transcript_recovery_retry_at timestamp with time zone,
    hidden_at timestamp with time zone,
    CONSTRAINT capture_sessions_check2 CHECK (((transcript_end_offset_ms IS NULL) OR ((transcript_start_offset_ms IS NOT NULL) AND (transcript_end_offset_ms >= transcript_start_offset_ms)))),
    CONSTRAINT capture_sessions_document_state_check CHECK ((((status <> 'finalized'::text) AND (document_id IS NULL) AND (document_version_id IS NULL)) OR ((status = 'finalized'::text) AND (document_id IS NOT NULL) AND (document_version_id IS NOT NULL)))),
    CONSTRAINT capture_sessions_livekit_voice_check CHECK ((voice_session_id IS NOT NULL)),
    CONSTRAINT capture_sessions_materialize_attempts_check CHECK ((materialize_attempts >= 0)),
    CONSTRAINT capture_sessions_status_check CHECK ((status = ANY (ARRAY['starting'::text, 'recording'::text, 'finalizing'::text, 'recovering'::text, 'finalized'::text, 'failed'::text]))),
    CONSTRAINT capture_sessions_transcript_document_pair_check CHECK (((transcript_document_id IS NULL) = (transcript_document_version_id IS NULL))),
    CONSTRAINT capture_sessions_transcript_recovery_check CHECK ((((transcript_recovery_status IS NULL) = (transcript_recovery_total_ms IS NULL)) AND (transcript_recovery_progress_ms <= COALESCE(transcript_recovery_total_ms, (0)::bigint)))),
    CONSTRAINT capture_sessions_transcript_recovery_failures_check CHECK ((transcript_recovery_failures >= 0)),
    CONSTRAINT capture_sessions_transcript_recovery_progress_ms_check CHECK ((transcript_recovery_progress_ms >= 0)),
    CONSTRAINT capture_sessions_transcript_recovery_status_check CHECK ((transcript_recovery_status = ANY (ARRAY['pending'::text, 'running'::text, 'succeeded'::text, 'failed'::text]))),
    CONSTRAINT capture_sessions_transcript_recovery_total_ms_check CHECK ((transcript_recovery_total_ms > 0)),
    CONSTRAINT capture_sessions_transcript_start_offset_ms_check CHECK ((transcript_start_offset_ms >= 0)),
    CONSTRAINT capture_sessions_voice_completion_attempts_check CHECK ((voice_completion_attempts >= 0)),
    CONSTRAINT capture_sessions_voice_completion_failure_check CHECK (((voice_completion_failed_at IS NULL) = (voice_completion_failure_code IS NULL)))
);

CREATE TABLE public.document_versions (
    id text NOT NULL,
    tenant_id text NOT NULL,
    document_id text NOT NULL,
    version_number integer NOT NULL,
    filename text NOT NULL,
    representation_format text NOT NULL,
    media_type text NOT NULL,
    size_bytes bigint NOT NULL,
    sha256 text NOT NULL,
    content_object_id text NOT NULL,
    source text NOT NULL,
    created_by_actor_id text NOT NULL,
    source_revision_id text,
    base_version_id text,
    source_invocation_id text,
    exporter_schema_version integer,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT document_versions_check CHECK (((source_revision_id IS NULL) = (exporter_schema_version IS NULL))),
    CONSTRAINT document_versions_check1 CHECK (((source = 'agent_publication'::text) OR (source_revision_id IS NULL))),
    CONSTRAINT document_versions_content_object_id_check CHECK (((length(content_object_id) >= 1) AND (length(content_object_id) <= 255))),
    CONSTRAINT document_versions_exporter_schema_version_check CHECK ((exporter_schema_version >= 1)),
    CONSTRAINT document_versions_filename_check CHECK (((length(filename) >= 1) AND (length(filename) <= 255))),
    CONSTRAINT document_versions_media_type_check CHECK (((length(media_type) >= 1) AND (length(media_type) <= 255))),
    CONSTRAINT document_versions_representation_format_check CHECK (((length(representation_format) >= 1) AND (length(representation_format) <= 120))),
    CONSTRAINT document_versions_sha256_check CHECK ((sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT document_versions_size_bytes_check CHECK ((size_bytes >= 0)),
    CONSTRAINT document_versions_source_check CHECK ((source = ANY (ARRAY['ordinary_upload'::text, 'replacement_upload'::text, 'agent_publication'::text, 'wiki_page'::text]))),
    CONSTRAINT document_versions_version_number_check CHECK ((version_number >= 1))
);

CREATE TABLE public.documents (
    id text NOT NULL,
    tenant_id text NOT NULL,
    title text NOT NULL,
    format text NOT NULL,
    owner_actor_id text NOT NULL,
    owner_actor_kind text NOT NULL,
    creator_actor_id text NOT NULL,
    creator_actor_kind text NOT NULL,
    status text NOT NULL,
    trashed_at timestamp with time zone,
    restored_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    current_version_id text,
    native_representation_format text,
    native_import_status text,
    native_import_source_version_id text,
    link_share_id text,
    link_share_token_sha256 bytea,
    link_share_role text,
    link_share_status text,
    link_share_version bigint,
    CONSTRAINT documents_creator_actor_kind_check CHECK ((creator_actor_kind = ANY (ARRAY['human'::text, 'agent'::text]))),
    CONSTRAINT documents_format_check CHECK (((length(format) >= 1) AND (length(format) <= 120))),
    CONSTRAINT documents_link_share_role_check CHECK ((link_share_role = ANY (ARRAY['viewer'::text, 'editor'::text]))),
    CONSTRAINT documents_link_share_shape CHECK ((((link_share_id IS NULL) AND (link_share_token_sha256 IS NULL) AND (link_share_role IS NULL) AND (link_share_status IS NULL) AND (link_share_version IS NULL)) OR ((link_share_id IS NOT NULL) AND (link_share_token_sha256 IS NOT NULL) AND (link_share_role IS NOT NULL) AND (link_share_status IS NOT NULL) AND (link_share_version IS NOT NULL)))),
    CONSTRAINT documents_link_share_status_check CHECK ((link_share_status = ANY (ARRAY['active'::text, 'revoked'::text]))),
    CONSTRAINT documents_link_share_token_sha256_check CHECK ((octet_length(link_share_token_sha256) = 32)),
    CONSTRAINT documents_link_share_version_check CHECK ((link_share_version >= 1)),
    CONSTRAINT documents_native_import_shape CHECK (((native_import_status IS NULL) = (native_import_source_version_id IS NULL))),
    CONSTRAINT documents_native_import_status_check CHECK ((native_import_status = ANY (ARRAY['pending'::text, 'completed'::text, 'failed'::text]))),
    CONSTRAINT documents_native_representation_format_check CHECK ((((format = 'blocknote'::text) AND ((native_representation_format IS NULL) OR (native_representation_format = ANY (ARRAY['markdown'::text, 'html'::text])))) OR ((format <> 'blocknote'::text) AND (native_representation_format IS NULL)))),
    CONSTRAINT documents_owner_actor_kind_check CHECK ((owner_actor_kind = ANY (ARRAY['human'::text, 'agent'::text]))),
    CONSTRAINT documents_status_check CHECK ((status = ANY (ARRAY['active'::text, 'trashed'::text]))),
    CONSTRAINT documents_title_check CHECK (((length(title) >= 1) AND (length(title) <= 255)))
);

CREATE VIEW memory_source.finalized_meetings AS
 SELECT capture.id,
    capture.tenant_id,
    capture.room_id,
    capture.created_at AS started_at,
    capture.updated_at,
    audio.document_id AS recording_document_id,
    audio.id AS recording_version_id,
    audio.filename AS recording_filename,
    transcript.document_id AS transcript_document_id,
    transcript.id AS transcript_version_id,
    transcript.sha256 AS transcript_sha256,
    transcript_document.created_at AS transcript_created_at
   FROM (((((public.capture_sessions capture
     JOIN public.rooms room ON (((room.id = capture.room_id) AND (room.tenant_id = capture.tenant_id) AND (room.deleted_at IS NULL))))
     JOIN public.document_versions audio ON (((audio.id = capture.document_version_id) AND (audio.document_id = capture.document_id) AND (audio.tenant_id = capture.tenant_id))))
     JOIN public.documents audio_document ON (((audio_document.id = audio.document_id) AND (audio_document.status = 'active'::text))))
     JOIN public.document_versions transcript ON (((transcript.id = capture.transcript_document_version_id) AND (transcript.document_id = capture.transcript_document_id) AND (transcript.tenant_id = capture.tenant_id))))
     JOIN public.documents transcript_document ON (((transcript_document.id = transcript.document_id) AND (transcript_document.status = 'active'::text))))
  WHERE (capture.status = 'finalized'::text);

CREATE VIEW memory_source.hidden_meetings AS
 SELECT tenant_id,
    id AS capture_session_id
   FROM public.capture_sessions
  WHERE (hidden_at IS NOT NULL);

CREATE VIEW memory_source.message_attachments AS
 SELECT message.id AS message_id,
    ((item.ordinality - 1))::integer AS "position",
    message.tenant_id,
    ((item.value ->> 'document_id'::text))::text AS document_id,
    ((item.value ->> 'document_version_id'::text))::text AS document_version_id,
    version.filename,
    version.representation_format,
    version.media_type,
    version.size_bytes,
    version.sha256,
    (EXISTS ( SELECT 1
           FROM public.capture_sessions capture
          WHERE ((capture.tenant_id = message.tenant_id) AND (capture.transcript_document_id = (item.value ->> 'document_id'::text))))) AS is_recording_transcript
   FROM ((public.messages message
     CROSS JOIN LATERAL jsonb_array_elements(message.attachments) WITH ORDINALITY item(value, ordinality))
     JOIN public.document_versions version ON (((version.id = (item.value ->> 'document_version_id'::text)) AND (version.tenant_id = message.tenant_id) AND (version.document_id = (item.value ->> 'document_id'::text)))));

CREATE TABLE public.pocket_notes (
    tenant_id text NOT NULL,
    owner_actor_id text NOT NULL,
    note_date date NOT NULL,
    body text NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    hidden_at timestamp with time zone,
    CONSTRAINT pocket_notes_body_check CHECK (((char_length(body) >= 1) AND (char_length(body) <= 20000)))
);

CREATE VIEW memory_source.pocket_notes AS
 SELECT tenant_id,
    owner_actor_id,
    note_date,
    body
   FROM public.pocket_notes
  WHERE (hidden_at IS NULL);

CREATE TABLE public.proactive_guidelines (
    tenant_id text NOT NULL,
    owner_actor_id text NOT NULL,
    version integer NOT NULL,
    specific jsonb NOT NULL,
    clues jsonb NOT NULL,
    change_note text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT proactive_guidelines_change_note_check CHECK ((length(change_note) <= 4000)),
    CONSTRAINT proactive_guidelines_clues_check CHECK (((jsonb_typeof(clues) = 'array'::text) AND (jsonb_array_length(clues) <= 20))),
    CONSTRAINT proactive_guidelines_specific_check CHECK (((jsonb_typeof(specific) = 'array'::text) AND (jsonb_array_length(specific) <= 20))),
    CONSTRAINT proactive_guidelines_version_check CHECK ((version >= 1))
);

CREATE VIEW memory_source.proactive_guidelines AS
 SELECT tenant_id,
    owner_actor_id,
    version,
    specific,
    clues
   FROM public.proactive_guidelines;

CREATE VIEW memory_source.profile_revision_dates AS
 SELECT id,
    created_at
   FROM public.personal_profile_revisions;

CREATE VIEW memory_source.revoked_another_me_agents AS
 SELECT tenant_id,
    represented_human_actor_id,
    agent_management_id
   FROM public.agent_registrations
  WHERE ((agent_type = 'anotherme'::text) AND (status = 'revoked'::text) AND (agent_management_id IS NOT NULL));

CREATE TABLE public.room_members (
    room_id text NOT NULL,
    tenant_id text NOT NULL,
    actor_id text NOT NULL,
    role text NOT NULL,
    added_by_actor_id text NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    membership_epoch_id text NOT NULL,
    CONSTRAINT room_members_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'member'::text])))
);

CREATE VIEW public.active_room_members AS
 SELECT room_id,
    tenant_id,
    actor_id,
    role,
    added_by_actor_id,
    joined_at,
    updated_at,
    membership_epoch_id
   FROM public.room_members;

CREATE TABLE public.voice_capture_questions (
    id text NOT NULL,
    capture_session_id text NOT NULL,
    question text NOT NULL,
    answer text NOT NULL,
    answered boolean NOT NULL,
    cutoff_offset_ms bigint NOT NULL,
    sources jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    kind text NOT NULL,
    task_title text DEFAULT ''::text NOT NULL,
    sent_message_id text,
    CONSTRAINT voice_capture_questions_cutoff_offset_ms_check CHECK ((cutoff_offset_ms >= 0)),
    CONSTRAINT voice_capture_questions_kind_check CHECK ((kind = ANY (ARRAY['answer'::text, 'task'::text]))),
    CONSTRAINT voice_capture_questions_sources_check CHECK ((jsonb_typeof(sources) = 'array'::text)),
    CONSTRAINT voice_capture_questions_task_check CHECK ((((kind = 'task'::text) AND (task_title <> ''::text)) OR ((kind = 'answer'::text) AND (task_title = ''::text) AND (sent_message_id IS NULL))))
);

CREATE VIEW memory_source.subject_recordings AS
 SELECT subject.agent_management_id,
    capture.id AS capture_id,
    capture.tenant_id,
    capture.room_id,
    room.name AS room_name,
    version.document_id,
    version.id AS version_id,
    version.sha256,
    version.size_bytes,
    capture.created_at AS started_at,
    GREATEST(capture.updated_at, version.created_at) AS ready_at,
    document.created_at AS source_date_at,
    (capture.transcript_end_offset_ms - capture.transcript_start_offset_ms) AS duration_ms,
    creator.id AS creator_id,
    creator.display_name AS creator_name,
    (EXISTS ( SELECT 1
           FROM public.active_room_members member
          WHERE ((member.tenant_id = capture.tenant_id) AND (member.room_id = capture.room_id) AND (member.actor_id = subject.agent_actor_id)))) AS agent_is_member,
    (EXISTS ( SELECT 1
           FROM public.active_room_members member
          WHERE ((member.tenant_id = capture.tenant_id) AND (member.room_id = capture.room_id) AND (member.actor_id = subject.represented_human_actor_id)))) AS human_is_member,
    capture.requested_transcript_start_offset_ms AS recording_start_offset_ms,
        CASE
            WHEN (capture.created_by_actor_id = subject.represented_human_actor_id) THEN ( SELECT json_agg(json_build_object('kind', question.kind, 'task_sent', (question.sent_message_id IS NOT NULL), 'question', question.question, 'answer', question.answer, 'answered', question.answered, 'cutoff_offset_ms', question.cutoff_offset_ms) ORDER BY question.created_at, question.id) AS json_agg
               FROM public.voice_capture_questions question
              WHERE (question.capture_session_id = capture.id))
            ELSE NULL::json
        END AS private_questions,
        CASE
            WHEN (capture.created_by_actor_id = subject.represented_human_actor_id) THEN ( SELECT max(question.created_at) AS max
               FROM public.voice_capture_questions question
              WHERE (question.capture_session_id = capture.id))
            ELSE NULL::timestamp with time zone
        END AS private_changed_at
   FROM (((((memory_source.another_me_subjects subject
     JOIN public.capture_sessions capture ON (((capture.tenant_id = subject.tenant_id) AND (capture.status = 'finalized'::text) AND (capture.transcript_start_offset_ms IS NOT NULL) AND (capture.transcript_end_offset_ms IS NOT NULL))))
     JOIN public.rooms room ON (((room.id = capture.room_id) AND (room.tenant_id = capture.tenant_id) AND (room.deleted_at IS NULL))))
     JOIN public.actors creator ON (((creator.id = capture.created_by_actor_id) AND (creator.tenant_id = capture.tenant_id))))
     JOIN public.document_versions version ON (((version.id = capture.transcript_document_version_id) AND (version.document_id = capture.transcript_document_id) AND (version.tenant_id = capture.tenant_id) AND (version.representation_format = ANY (ARRAY['markdown'::text, 'plain_text'::text])))))
     JOIN public.documents document ON (((document.id = version.document_id) AND (document.tenant_id = version.tenant_id))))
  WHERE (EXISTS ( SELECT 1
           FROM public.active_room_members member
          WHERE ((member.tenant_id = capture.tenant_id) AND (member.room_id = capture.room_id) AND (member.actor_id = ANY (ARRAY[subject.agent_actor_id, subject.represented_human_actor_id])))));

CREATE VIEW memory_source.subject_rooms AS
 SELECT subject.agent_management_id,
    subject.agent_actor_id,
    subject.represented_human_actor_id,
    room.tenant_id,
    room.id AS room_id,
    room.name AS room_name,
    room.created_by_actor_id AS room_created_by_actor_id,
    (EXISTS ( SELECT 1
           FROM public.active_room_members member
          WHERE ((member.tenant_id = room.tenant_id) AND (member.room_id = room.id) AND (member.actor_id = subject.agent_actor_id)))) AS agent_is_member,
    (EXISTS ( SELECT 1
           FROM public.active_room_members member
          WHERE ((member.tenant_id = room.tenant_id) AND (member.room_id = room.id) AND (member.actor_id = subject.represented_human_actor_id)))) AS represented_human_is_member
   FROM (memory_source.another_me_subjects subject
     JOIN public.rooms room ON (((room.tenant_id = subject.tenant_id) AND (room.deleted_at IS NULL))))
  WHERE (EXISTS ( SELECT 1
           FROM public.active_room_members member
          WHERE ((member.tenant_id = room.tenant_id) AND (member.room_id = room.id) AND (member.actor_id = ANY (ARRAY[subject.agent_actor_id, subject.represented_human_actor_id])))));

CREATE TABLE public.user_memory_revisions (
    tenant_id text NOT NULL,
    owner_actor_id text NOT NULL,
    version integer NOT NULL,
    sections jsonb NOT NULL,
    markdown text NOT NULL,
    base_profile_revision_id text,
    source text NOT NULL,
    change_note text DEFAULT ''::text NOT NULL,
    evidence jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_memory_revisions_change_note_check CHECK ((length(change_note) <= 1000)),
    CONSTRAINT user_memory_revisions_evidence_check CHECK ((jsonb_typeof(evidence) = 'array'::text)),
    CONSTRAINT user_memory_revisions_markdown_check CHECK ((octet_length(markdown) <= 16384)),
    CONSTRAINT user_memory_revisions_sections_check CHECK ((jsonb_typeof(sections) = 'object'::text)),
    CONSTRAINT user_memory_revisions_source_check CHECK ((source = ANY (ARRAY['profile'::text, 'daily'::text, 'weekly'::text, 'rollback'::text]))),
    CONSTRAINT user_memory_revisions_version_check CHECK ((version >= 1))
);

CREATE VIEW memory_source.user_memory_revisions AS
 SELECT tenant_id,
    owner_actor_id,
    version,
    sections,
    base_profile_revision_id,
    source
   FROM public.user_memory_revisions;

CREATE TABLE public.accounts (
    id text NOT NULL,
    password_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    email text NOT NULL,
    password_change_window_started_at timestamp with time zone,
    password_change_attempts integer,
    profile_bio text DEFAULT ''::text NOT NULL,
    profile_organization text DEFAULT ''::text NOT NULL,
    profile_avatar_image text DEFAULT ''::text NOT NULL,
    profile_background_image text DEFAULT ''::text NOT NULL,
    profile_name_user_managed boolean DEFAULT false NOT NULL,
    profile_bio_user_managed boolean DEFAULT false NOT NULL,
    profile_organization_user_managed boolean DEFAULT false NOT NULL,
    profile_updated_at timestamp with time zone,
    work_item_last_number bigint DEFAULT 0 NOT NULL,
    CONSTRAINT accounts_password_change_attempts_check CHECK (((password_change_attempts >= 1) AND (password_change_attempts <= 5))),
    CONSTRAINT accounts_password_change_limit_check CHECK (((password_change_window_started_at IS NULL) = (password_change_attempts IS NULL))),
    CONSTRAINT accounts_profile_avatar_image_check CHECK ((octet_length(profile_avatar_image) <= 524288)),
    CONSTRAINT accounts_profile_background_image_check CHECK ((octet_length(profile_background_image) <= 524288)),
    CONSTRAINT accounts_profile_bio_check CHECK ((length(profile_bio) <= 2000)),
    CONSTRAINT accounts_profile_organization_check CHECK ((length(profile_organization) <= 200)),
    CONSTRAINT accounts_work_item_last_number_check CHECK ((work_item_last_number >= 0))
);

CREATE TABLE public.agent_access_credentials (
    id text NOT NULL,
    token_hash bytea NOT NULL,
    tenant_id text NOT NULL,
    agent_actor_id text NOT NULL,
    agent_management_id text NOT NULL,
    label text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone,
    assignment_revision bigint,
    CONSTRAINT agent_access_credentials_assignment_revision_check CHECK ((assignment_revision >= 1)),
    CONSTRAINT agent_access_credentials_label_check CHECK (((length(label) >= 1) AND (length(label) <= 128))),
    CONSTRAINT agent_access_credentials_token_hash_check CHECK ((octet_length(token_hash) = 32)),
    CONSTRAINT agent_access_credentials_unbound_expires_check CHECK (((assignment_revision IS NOT NULL) OR (expires_at IS NOT NULL)))
);

CREATE TABLE public.agent_context_inbox_cursors (
    context_key text NOT NULL,
    inbox_id text NOT NULL,
    committed_through_seq bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    cursor_encoding text NOT NULL,
    CONSTRAINT agent_context_inbox_cursors_committed_through_seq_check CHECK ((committed_through_seq >= 0)),
    CONSTRAINT agent_context_inbox_cursors_cursor_encoding_check CHECK ((cursor_encoding = ANY (ARRAY['room_event_v1'::text, 'meta_seq_v1'::text]))),
    CONSTRAINT agent_context_inbox_cursors_inbox_id_check CHECK (((length(inbox_id) >= 1) AND (length(inbox_id) <= 1000)))
);

CREATE TABLE public.agent_execution_contexts (
    context_key text NOT NULL,
    tenant_id text NOT NULL,
    agent_actor_id text NOT NULL,
    agent_management_id text NOT NULL,
    context_kind text NOT NULL,
    task_id text,
    target_residency text NOT NULL,
    next_input_sequence bigint DEFAULT 0 NOT NULL,
    state_revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    room_id text,
    membership_epoch_id text,
    terminal_reason text,
    terminated_at timestamp with time zone,
    document_id text,
    room_kind text,
    task_archive_suspended boolean DEFAULT false NOT NULL,
    session jsonb,
    session_provider_kind text,
    session_schema_version bigint,
    session_thread_id text,
    session_configuration_revision bigint,
    session_profile_revision bigint,
    session_revision bigint DEFAULT 0 NOT NULL,
    session_updated_at timestamp with time zone,
    CONSTRAINT agent_execution_context_room_kind_shape CHECK ((((context_kind = 'meta'::text) AND (room_kind = ANY (ARRAY['direct'::text, 'collaboration'::text]))) OR ((context_kind <> 'meta'::text) AND (room_kind IS NULL)))),
    CONSTRAINT agent_execution_contexts_context_key_check CHECK (((length(context_key) >= 1) AND (length(context_key) <= 1000))),
    CONSTRAINT agent_execution_contexts_context_kind_check CHECK ((context_kind = ANY (ARRAY['meta'::text, 'alter_ego'::text, 'document'::text]))),
    CONSTRAINT agent_execution_contexts_identity_check CHECK ((((context_kind = 'meta'::text) AND (room_id IS NOT NULL) AND (task_id IS NULL) AND (document_id IS NULL)) OR ((context_kind = 'alter_ego'::text) AND (task_id IS NOT NULL) AND (room_id IS NULL) AND (membership_epoch_id IS NULL) AND (document_id IS NULL)) OR ((context_kind = 'document'::text) AND (task_id IS NULL) AND (room_id IS NULL) AND (membership_epoch_id IS NULL) AND (document_id IS NOT NULL)))),
    CONSTRAINT agent_execution_contexts_next_input_sequence_check CHECK ((next_input_sequence >= 0)),
    CONSTRAINT agent_execution_contexts_room_authority_check CHECK ((((room_id IS NULL) AND (membership_epoch_id IS NULL)) OR ((context_kind = 'meta'::text) AND (room_id IS NOT NULL) AND (membership_epoch_id IS NOT NULL)))),
    CONSTRAINT agent_execution_contexts_session_check CHECK ((((session IS NULL) AND (session_provider_kind IS NULL) AND (session_schema_version IS NULL) AND (session_thread_id IS NULL) AND (session_configuration_revision IS NULL) AND (session_profile_revision IS NULL) AND (session_updated_at IS NULL) AND (session_revision = 0)) OR ((jsonb_typeof(session) = 'object'::text) AND ((length(session_provider_kind) >= 1) AND (length(session_provider_kind) <= 64)) AND (session_schema_version >= 1) AND ((session_thread_id IS NULL) OR ((length(session_thread_id) >= 1) AND (length(session_thread_id) <= 1000))) AND (session_configuration_revision >= 1) AND (session_profile_revision >= 1) AND (session_updated_at IS NOT NULL) AND (session_revision >= 1)))),
    CONSTRAINT agent_execution_contexts_state_revision_check CHECK ((state_revision >= 1)),
    CONSTRAINT agent_execution_contexts_target_residency_check CHECK ((target_residency = ANY (ARRAY['active'::text, 'suspended'::text]))),
    CONSTRAINT agent_execution_contexts_terminal_check CHECK ((((terminal_reason IS NULL) AND (terminated_at IS NULL)) OR ((terminal_reason = ANY (ARRAY['room_deleted'::text, 'context_deleted'::text])) AND (terminated_at IS NOT NULL))))
);

CREATE TABLE public.room_events (
    event_id text NOT NULL,
    tenant_id text NOT NULL,
    room_id text NOT NULL,
    room_seq bigint NOT NULL,
    event_type text NOT NULL,
    actor_id text NOT NULL,
    resource_id text NOT NULL,
    payload jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT room_events_event_type_check CHECK ((event_type = ANY (ARRAY['room.participation.changed'::text, 'room.created'::text, 'room.updated'::text, 'room.deleted'::text, 'room.history.compacted'::text, 'message.created'::text, 'message.thread_summary.updated'::text, 'message.reactions.changed'::text, 'card.changed'::text, 'room.member.added'::text, 'room.member.role_changed'::text, 'room.member.removed'::text, 'work_item.changed'::text, 'document.comment.changed'::text, 'document.created'::text, 'routine.changed'::text, 'capture.session.changed'::text, 'agent_run.status_changed'::text, 'team_md.published'::text]))),
    CONSTRAINT room_events_room_seq_check CHECK ((room_seq >= 1))
);

CREATE TABLE public.task_meta_callback_messages (
    id text NOT NULL,
    task_id text NOT NULL,
    tenant_id text NOT NULL,
    generation bigint NOT NULL,
    meta_seq bigint NOT NULL,
    author_actor_id text NOT NULL,
    body text NOT NULL,
    segments jsonb NOT NULL,
    non_actionable boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT task_meta_callback_messages_body_check CHECK (((length(body) >= 1) AND (length(body) <= 50000))),
    CONSTRAINT task_meta_callback_messages_meta_seq_check CHECK ((meta_seq >= 1)),
    CONSTRAINT task_meta_callback_messages_segments_check CHECK ((jsonb_typeof(segments) = 'array'::text))
);

CREATE TABLE public.task_meta_callbacks (
    task_id text NOT NULL,
    tenant_id text NOT NULL,
    generation bigint NOT NULL,
    coordinator_actor_id text NOT NULL,
    coordinator_context_key text NOT NULL,
    through_seq bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT task_meta_callbacks_through_seq_check CHECK ((through_seq >= 0))
);

CREATE TABLE public.task_meta_messages (
    id text NOT NULL,
    tenant_id text NOT NULL,
    task_id text NOT NULL,
    agent_actor_id text NOT NULL,
    meta_seq bigint NOT NULL,
    author_actor_id text NOT NULL,
    body text NOT NULL,
    segments jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT task_meta_messages_body_check CHECK (((length(body) >= 1) AND (length(body) <= 50000))),
    CONSTRAINT task_meta_messages_meta_seq_check CHECK ((meta_seq >= 1)),
    CONSTRAINT task_meta_messages_segments_check CHECK ((jsonb_typeof(segments) = 'array'::text))
);

CREATE TABLE public.work_item_room_links (
    work_item_id text NOT NULL,
    tenant_id text NOT NULL,
    link_type text NOT NULL,
    room_id text NOT NULL,
    origin_message_id text,
    linked_by_actor_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT work_item_room_links_check CHECK (((link_type = 'origin'::text) OR (origin_message_id IS NULL))),
    CONSTRAINT work_item_room_links_link_type_check CHECK ((link_type = ANY (ARRAY['origin'::text, 'work'::text])))
);

CREATE TABLE public.work_items (
    id text NOT NULL,
    tenant_id text NOT NULL,
    number bigint NOT NULL,
    kind text NOT NULL,
    title text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    priority text DEFAULT 'medium'::text NOT NULL,
    state text DEFAULT 'open'::text NOT NULL,
    resolution text,
    version bigint DEFAULT 1 NOT NULL,
    created_by_actor_id text NOT NULL,
    updated_by_actor_id text NOT NULL,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    task_source_key text,
    task_execution_generation bigint,
    task_execution_status text,
    task_execution_revision bigint,
    task_execution_reason_code text,
    task_desired_control text,
    task_control_revision bigint,
    task_control_settled_revision bigint,
    task_control_outcome text,
    task_control_source_kind text,
    task_control_source_id text,
    task_control_requested_by_actor_id text,
    task_control_requested_at timestamp with time zone,
    task_control_payload jsonb,
    task_execution_updated_at timestamp with time zone,
    task_next_reconcile_at timestamp with time zone,
    task_worker_id text,
    task_lease_token_hash bytea,
    task_lease_generation bigint,
    task_lease_expires_at timestamp with time zone,
    CONSTRAINT work_items_check CHECK (((state = 'resolved'::text) OR (resolution IS NULL))),
    CONSTRAINT work_items_description_check CHECK ((length(description) <= 50000)),
    CONSTRAINT work_items_kind_check CHECK ((kind = ANY (ARRAY['issue'::text, 'task'::text]))),
    CONSTRAINT work_items_number_check CHECK ((number >= 1)),
    CONSTRAINT work_items_priority_check CHECK ((priority = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'urgent'::text]))),
    CONSTRAINT work_items_resolution_check CHECK ((resolution = ANY (ARRAY['completed'::text, 'failed'::text, 'not_planned'::text, 'duplicate'::text]))),
    CONSTRAINT work_items_state_check CHECK ((state = ANY (ARRAY['open'::text, 'in_progress'::text, 'resolved'::text]))),
    CONSTRAINT work_items_task_control_request_shape CHECK ((((task_control_revision = 0) AND (task_control_source_kind IS NULL) AND (task_control_source_id IS NULL) AND (task_control_requested_by_actor_id IS NULL) AND (task_control_requested_at IS NULL) AND (task_control_payload IS NULL)) OR ((task_control_revision > 0) AND (task_control_source_kind = ANY (ARRAY['human'::text, 'system'::text])) AND (task_control_source_id IS NOT NULL) AND (task_control_requested_at IS NOT NULL) AND (task_control_payload IS NOT NULL) AND (jsonb_typeof(task_control_payload) = 'object'::text)) OR (task_control_revision IS NULL))),
    CONSTRAINT work_items_task_execution_lease_shape CHECK ((((task_worker_id IS NULL) AND (task_lease_token_hash IS NULL) AND (task_lease_expires_at IS NULL)) OR ((task_worker_id IS NOT NULL) AND (task_lease_token_hash IS NOT NULL) AND (octet_length(task_lease_token_hash) = 32) AND (task_lease_expires_at IS NOT NULL)))),
    CONSTRAINT work_items_task_execution_projection_shape CHECK (((task_execution_status IS NULL) OR ((task_execution_status = ANY (ARRAY['running'::text, 'waiting_for_approval'::text, 'idle'::text, 'failed'::text, 'canceled'::text])) AND (state = 'in_progress'::text) AND (resolution IS NULL)))),
    CONSTRAINT work_items_task_execution_shape CHECK ((((task_execution_generation IS NULL) AND (task_source_key IS NULL) AND (task_execution_status IS NULL) AND (task_execution_revision IS NULL) AND (task_execution_reason_code IS NULL) AND (task_desired_control IS NULL) AND (task_control_revision IS NULL) AND (task_control_settled_revision IS NULL) AND (task_control_outcome IS NULL) AND (task_control_source_kind IS NULL) AND (task_control_source_id IS NULL) AND (task_control_requested_by_actor_id IS NULL) AND (task_control_requested_at IS NULL) AND (task_control_payload IS NULL) AND (task_execution_updated_at IS NULL) AND (task_next_reconcile_at IS NULL) AND (task_worker_id IS NULL) AND (task_lease_token_hash IS NULL) AND (task_lease_generation IS NULL) AND (task_lease_expires_at IS NULL)) OR ((kind = 'task'::text) AND (task_execution_generation >= 1) AND (task_execution_status = ANY (ARRAY['running'::text, 'waiting_for_approval'::text, 'idle'::text, 'failed'::text, 'canceled'::text])) AND (task_execution_revision >= 1) AND (task_desired_control = 'run'::text) AND (task_control_revision >= 0) AND (task_control_settled_revision = task_control_revision) AND ((task_control_outcome IS NULL) OR (task_control_outcome = ANY (ARRAY['applied'::text, 'superseded'::text, 'rejected'::text]))) AND (task_execution_updated_at IS NOT NULL) AND (task_next_reconcile_at IS NOT NULL) AND (task_lease_generation >= 0)))),
    CONSTRAINT work_items_title_check CHECK (((length(btrim(title)) >= 1) AND (length(btrim(title)) <= 240))),
    CONSTRAINT work_items_version_check CHECK ((version >= 1))
);

CREATE VIEW public.agent_history_messages AS
 SELECT message.tenant_id,
    message.id AS message_id,
        CASE
            WHEN (thread.parent_room_id IS NOT NULL) THEN ('thread:'::text || message.room_id)
            WHEN (work_link.work_item_id IS NOT NULL) THEN ('task:'::text || work_link.work_item_id)
            ELSE ('room:'::text || message.room_id)
        END AS inbox_id,
    message.room_id AS source_room_id,
    event.room_seq AS source_sequence,
    message.author_actor_id,
    author.display_name AS author,
    author.kind AS author_kind,
    message.body,
    message.segments,
    message.message_kind,
    message.created_at,
    to_jsonb(message.context_message_ids) AS context_message_ids,
    (COALESCE(( SELECT jsonb_agg(jsonb_build_object('document_id', refs.document_id)) AS jsonb_agg
           FROM ( SELECT (value.value ->> 'document_id'::text) AS document_id
                   FROM jsonb_array_elements(message.segments) value(value)
                  WHERE ((value.value ->> 'document_id'::text) IS NOT NULL)
                UNION
                 SELECT (attachment.value ->> 'document_id'::text) AS document_id
                   FROM jsonb_array_elements(message.attachments) attachment(value)
                  WHERE ((attachment.value ->> 'document_id'::text) IS NOT NULL)) refs), '[]'::jsonb))::jsonb AS resource_references
   FROM ((((public.messages message
     JOIN public.room_events event ON (((event.tenant_id = message.tenant_id) AND (event.room_id = message.room_id) AND (event.resource_id = message.id) AND (event.event_type = 'message.created'::text))))
     JOIN public.actors author ON (((author.id = message.author_actor_id) AND (author.tenant_id = message.tenant_id))))
     LEFT JOIN public.rooms thread ON (((thread.id = message.room_id) AND (thread.tenant_id = message.tenant_id))))
     LEFT JOIN public.work_item_room_links work_link ON (((work_link.room_id = message.room_id) AND (work_link.tenant_id = message.tenant_id) AND (work_link.link_type = 'work'::text) AND (EXISTS ( SELECT 1
           FROM public.work_items item
          WHERE ((item.id = work_link.work_item_id) AND (item.tenant_id = work_link.tenant_id) AND (item.kind = 'task'::text)))))))
  WHERE (message.message_kind = ANY (ARRAY['conversation'::text, 'agent_runtime'::text, 'task_terminal_notice'::text]))
UNION ALL
 SELECT message.tenant_id,
    message.id AS message_id,
    ((('meta:'::text || message.agent_actor_id) || ':'::text) || message.task_id) AS inbox_id,
    NULL::text AS source_room_id,
    message.meta_seq AS source_sequence,
    message.author_actor_id,
    author.display_name AS author,
    author.kind AS author_kind,
    message.body,
    message.segments,
    'conversation'::text AS message_kind,
    message.created_at,
    '[]'::jsonb AS context_message_ids,
    COALESCE(( SELECT jsonb_agg(jsonb_build_object('document_id', (value.value ->> 'document_id'::text))) AS jsonb_agg
           FROM jsonb_array_elements(message.segments) value(value)
          WHERE ((value.value ->> 'document_id'::text) IS NOT NULL)), '[]'::jsonb) AS resource_references
   FROM (public.task_meta_messages message
     JOIN public.actors author ON (((author.id = message.author_actor_id) AND (author.tenant_id = message.tenant_id))))
UNION ALL
 SELECT message.tenant_id,
    message.id AS message_id,
    ('taskmeta:'::text || message.task_id) AS inbox_id,
    NULL::text AS source_room_id,
    message.meta_seq AS source_sequence,
    message.author_actor_id,
    author.display_name AS author,
    author.kind AS author_kind,
    message.body,
    message.segments,
    'conversation'::text AS message_kind,
    message.created_at,
    '[]'::jsonb AS context_message_ids,
    COALESCE(( SELECT jsonb_agg(jsonb_build_object('document_id', (value.value ->> 'document_id'::text))) AS jsonb_agg
           FROM jsonb_array_elements(message.segments) value(value)
          WHERE ((value.value ->> 'document_id'::text) IS NOT NULL)), '[]'::jsonb) AS resource_references
   FROM ((public.task_meta_callback_messages message
     JOIN public.task_meta_callbacks callback ON (((callback.task_id = message.task_id) AND (callback.tenant_id = message.tenant_id) AND (callback.generation = message.generation))))
     JOIN public.actors author ON (((author.id = message.author_actor_id) AND (author.tenant_id = message.tenant_id))));

CREATE TABLE public.agent_live_handover_receipts (
    context_key text NOT NULL,
    voice_session_id text NOT NULL,
    input_id text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE public.agent_local_run_inputs (
    run_id text NOT NULL,
    context_key text NOT NULL,
    input_id text NOT NULL,
    relation text NOT NULL,
    ordinal bigint NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT agent_local_run_inputs_ordinal_check CHECK ((ordinal >= 0)),
    CONSTRAINT agent_local_run_inputs_relation_check CHECK ((relation = ANY (ARRAY['initial'::text, 'steer'::text])))
);

CREATE TABLE public.agent_local_runs (
    run_id text NOT NULL,
    context_key text NOT NULL,
    status text NOT NULL,
    terminal jsonb,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    attempt_count integer DEFAULT 0 NOT NULL,
    cancellation_requested boolean DEFAULT false NOT NULL,
    epoch text,
    claim_id text,
    claim_configuration_revision bigint,
    usage jsonb,
    status_room_id text,
    claim_profile_revision bigint,
    CONSTRAINT agent_local_runs_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT agent_local_runs_check CHECK ((((status = 'queued'::text) AND (terminal IS NULL) AND (started_at IS NULL) AND (finished_at IS NULL)) OR ((status = 'running'::text) AND (terminal IS NULL) AND (started_at IS NOT NULL) AND (finished_at IS NULL)) OR ((status = ANY (ARRAY['succeeded'::text, 'failed'::text, 'canceled'::text])) AND (terminal IS NOT NULL) AND (finished_at IS NOT NULL)))),
    CONSTRAINT agent_local_runs_claim_id_check CHECK (((claim_id IS NULL) OR ((length(claim_id) >= 1) AND (length(claim_id) <= 256)))),
    CONSTRAINT agent_local_runs_claim_profile_revision_check CHECK (((claim_profile_revision IS NULL) OR (claim_profile_revision >= 1))),
    CONSTRAINT agent_local_runs_run_id_check CHECK (((length(run_id) >= 1) AND (length(run_id) <= 256))),
    CONSTRAINT agent_local_runs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'canceled'::text]))),
    CONSTRAINT agent_local_runs_status_room_id_check CHECK (((status_room_id IS NULL) OR ((length(status_room_id) >= 1) AND (length(status_room_id) <= 256)))),
    CONSTRAINT agent_local_runs_usage_check CHECK (((usage IS NULL) OR (jsonb_typeof(usage) = 'object'::text)))
);

CREATE TABLE public.agent_memories (
    agent_id text NOT NULL,
    revision bigint NOT NULL,
    document jsonb NOT NULL,
    CONSTRAINT agent_memories_document_check CHECK ((jsonb_typeof(document) = 'object'::text)),
    CONSTRAINT agent_memories_revision_check CHECK ((revision > 0))
);

CREATE TABLE public.agent_presentation_sequence_items (
    sequence_id text NOT NULL,
    "position" integer NOT NULL,
    content text NOT NULL,
    pause_before text NOT NULL,
    not_before timestamp with time zone NOT NULL,
    delivered_message_id text,
    delivered_at timestamp with time zone,
    CONSTRAINT agent_presentation_sequence_items_check CHECK (((delivered_message_id IS NULL) = (delivered_at IS NULL))),
    CONSTRAINT agent_presentation_sequence_items_content_check CHECK (((length(content) >= 1) AND (length(content) <= 50000))),
    CONSTRAINT agent_presentation_sequence_items_pause_before_check CHECK ((pause_before = ANY (ARRAY['none'::text, 'brief'::text, 'natural'::text]))),
    CONSTRAINT agent_presentation_sequence_items_position_check CHECK (("position" > 0))
);

CREATE TABLE public.agent_presentation_sequences (
    id text NOT NULL,
    tenant_id text NOT NULL,
    room_id text NOT NULL,
    agent_actor_id text NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    local_run_id text,
    reply_to_message_id text,
    CONSTRAINT agent_presentation_sequences_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'delivering'::text, 'completed'::text, 'canceled'::text])))
);

CREATE TABLE public.agent_runtime_inputs (
    context_key text NOT NULL,
    input_id text NOT NULL,
    input_sequence bigint NOT NULL,
    payload jsonb NOT NULL,
    payload_hash bytea NOT NULL,
    source_kind text NOT NULL,
    source_message_id text,
    source_inbox_id text,
    status text NOT NULL,
    selection_result jsonb,
    steer_group_id text,
    local_run_id text,
    steer_outcome text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT agent_runtime_inputs_input_id_check CHECK (((length(input_id) >= 1) AND (length(input_id) <= 1000))),
    CONSTRAINT agent_runtime_inputs_input_sequence_check CHECK ((input_sequence >= 1)),
    CONSTRAINT agent_runtime_inputs_payload_hash_check CHECK ((octet_length(payload_hash) = 32)),
    CONSTRAINT agent_runtime_inputs_source_kind_check CHECK ((source_kind = ANY (ARRAY['inbox'::text, 'trusted_turn'::text, 'internal'::text]))),
    CONSTRAINT agent_runtime_inputs_status_check CHECK ((status = ANY (ARRAY['steering'::text, 'handled'::text]))),
    CONSTRAINT agent_runtime_inputs_steer_outcome_check CHECK (((steer_outcome IS NULL) OR (steer_outcome = ANY (ARRAY['applied'::text, 'uncertain'::text]))))
);

CREATE SEQUENCE public.agent_runtime_input_sequence
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.agent_runtime_input_sequence OWNED BY public.agent_runtime_inputs.input_sequence;

CREATE TABLE public.agent_runtime_status_events (
    local_run_id text NOT NULL,
    event_ordinal bigint NOT NULL,
    command_id text NOT NULL,
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    invocation_id text,
    outcome text,
    message_id text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    activity_id text,
    segment_id text NOT NULL,
    CONSTRAINT agent_runtime_status_events_command_id_check CHECK (((length(command_id) >= 8) AND (length(command_id) <= 256) AND (command_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'::text))),
    CONSTRAINT agent_runtime_status_events_message_check CHECK (((message_id IS NULL) OR (event_type = 'presentation.output_created'::text))),
    CONSTRAINT agent_runtime_status_events_metadata_check CHECK ((((event_type = ANY (ARRAY['activity.started'::text, 'activity.updated'::text])) AND (activity_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text) AND (invocation_id IS NULL) AND (outcome IS NULL) AND (message_id IS NULL)) OR ((event_type = 'activity.finished'::text) AND (activity_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text) AND (outcome = ANY (ARRAY['succeeded'::text, 'failed'::text, 'canceled'::text, 'declined'::text])) AND (invocation_id IS NULL) AND (message_id IS NULL)) OR ((event_type = ANY (ARRAY['status.changed'::text, 'plan.updated'::text])) AND (activity_id IS NULL) AND (invocation_id IS NULL) AND (outcome IS NULL) AND (message_id IS NULL)) OR ((event_type = 'presentation.output_created'::text) AND (activity_id IS NULL) AND (outcome IS NULL) AND ((invocation_id IS NULL) OR (invocation_id ~ '^agent-invocation-sha256:[a-f0-9]{64}$'::text)) AND (jsonb_typeof((payload -> 'output_id'::text)) = 'string'::text) AND ((length((payload ->> 'output_id'::text)) >= 1) AND (length((payload ->> 'output_id'::text)) <= 256)) AND ((payload ->> 'output_kind'::text) = ANY (ARRAY['message'::text, 'card'::text])) AND ((payload ->> 'surface'::text) = ANY (ARRAY['room_timeline'::text, 'workspace'::text])) AND (((payload ->> 'output_kind'::text) <> 'message'::text) OR (message_id IS NOT NULL))))),
    CONSTRAINT agent_runtime_status_events_ordinal_check CHECK ((event_ordinal >= 1)),
    CONSTRAINT agent_runtime_status_events_payload_check CHECK (((jsonb_typeof(payload) = 'object'::text) AND ((payload ->> 'type'::text) = event_type) AND (octet_length((payload)::text) <= 200000))),
    CONSTRAINT agent_runtime_status_events_type_check CHECK ((event_type = ANY (ARRAY['status.changed'::text, 'plan.updated'::text, 'activity.started'::text, 'activity.updated'::text, 'activity.finished'::text, 'presentation.output_created'::text])))
);

CREATE TABLE public.agent_service_epochs (
    epoch text NOT NULL,
    started_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT agent_service_epochs_epoch_check CHECK (((length(epoch) >= 1) AND (length(epoch) <= 256)))
);

CREATE TABLE public.agent_skill_bindings (
    id text NOT NULL,
    tenant_id text NOT NULL,
    agent_actor_id text NOT NULL,
    skill_id text NOT NULL,
    manifest_version text NOT NULL,
    enabled boolean NOT NULL,
    config jsonb NOT NULL,
    binding_version bigint NOT NULL,
    updated_by_actor_id text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT agent_skill_bindings_binding_version_check CHECK ((binding_version >= 1)),
    CONSTRAINT agent_skill_bindings_config_check CHECK ((jsonb_typeof(config) = 'object'::text))
);

CREATE TABLE public.agent_templates (
    template_id text NOT NULL,
    origin text NOT NULL,
    tenant_id text,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    instructions text NOT NULL,
    avatar_key text,
    skill_bindings jsonb DEFAULT '[]'::jsonb NOT NULL,
    published_by_actor_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    connector_bindings jsonb DEFAULT '[]'::jsonb NOT NULL,
    routines jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT agent_templates_avatar_key_check CHECK (((avatar_key IS NULL) OR ((length(avatar_key) >= 1) AND (length(avatar_key) <= 64)))),
    CONSTRAINT agent_templates_check CHECK ((((origin = 'builtin'::text) AND (tenant_id IS NULL) AND (published_by_actor_id IS NULL)) OR ((origin = 'published'::text) AND (tenant_id IS NOT NULL) AND (published_by_actor_id IS NOT NULL)))),
    CONSTRAINT agent_templates_connector_bindings_check CHECK (((jsonb_typeof(connector_bindings) = 'array'::text) AND (jsonb_array_length(connector_bindings) <= 20))),
    CONSTRAINT agent_templates_description_check CHECK ((length(description) <= 1000)),
    CONSTRAINT agent_templates_instructions_check CHECK (((length(instructions) >= 1) AND (length(instructions) <= 50000))),
    CONSTRAINT agent_templates_name_check CHECK (((length(name) >= 1) AND (length(name) <= 120))),
    CONSTRAINT agent_templates_origin_check CHECK ((origin = ANY (ARRAY['builtin'::text, 'published'::text]))),
    CONSTRAINT agent_templates_routines_check CHECK (((jsonb_typeof(routines) = 'array'::text) AND (jsonb_array_length(routines) <= 50))),
    CONSTRAINT agent_templates_skill_bindings_check CHECK ((jsonb_typeof(skill_bindings) = 'array'::text)),
    CONSTRAINT agent_templates_template_id_check CHECK (((length(template_id) >= 1) AND (length(template_id) <= 64) AND (template_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]*$'::text)))
);

CREATE TABLE public.agent_usage_totals (
    provider text NOT NULL,
    model text NOT NULL,
    input_tokens bigint NOT NULL,
    cache_read_tokens bigint NOT NULL,
    cache_write_tokens bigint NOT NULL,
    output_tokens bigint NOT NULL,
    reasoning_tokens bigint NOT NULL,
    compaction_count bigint NOT NULL,
    CONSTRAINT agent_usage_totals_cache_read_tokens_check CHECK ((cache_read_tokens >= 0)),
    CONSTRAINT agent_usage_totals_cache_write_tokens_check CHECK ((cache_write_tokens >= 0)),
    CONSTRAINT agent_usage_totals_compaction_count_check CHECK ((compaction_count >= 0)),
    CONSTRAINT agent_usage_totals_input_tokens_check CHECK ((input_tokens >= 0)),
    CONSTRAINT agent_usage_totals_output_tokens_check CHECK ((output_tokens >= 0)),
    CONSTRAINT agent_usage_totals_reasoning_tokens_check CHECK ((reasoning_tokens >= 0))
);

CREATE TABLE public.auth_sessions (
    id text NOT NULL,
    account_id text NOT NULL,
    token_hash bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    revoked_reason text,
    CONSTRAINT auth_sessions_check CHECK ((expires_at > created_at)),
    CONSTRAINT auth_sessions_revocation_reason_check CHECK ((((revoked_at IS NULL) AND (revoked_reason IS NULL)) OR ((revoked_at IS NOT NULL) AND (revoked_reason = ANY (ARRAY['logout'::text, 'password_reset'::text]))))),
    CONSTRAINT auth_sessions_token_hash_check CHECK ((octet_length(token_hash) = 32))
);

CREATE TABLE public.capture_media_outputs (
    id text NOT NULL,
    capture_session_id text NOT NULL,
    purpose text NOT NULL,
    range_digest text NOT NULL,
    object_key text NOT NULL,
    filename text NOT NULL,
    media_type text NOT NULL,
    duration_ms bigint NOT NULL,
    size_bytes bigint NOT NULL,
    sha256 text NOT NULL,
    document_id text,
    document_version_id text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT capture_media_outputs_duration_ms_check CHECK ((duration_ms > 0)),
    CONSTRAINT capture_media_outputs_media_type_check CHECK ((media_type = 'audio/mp4'::text)),
    CONSTRAINT capture_media_outputs_purpose_check CHECK ((purpose = ANY (ARRAY['source'::text, 'final'::text]))),
    CONSTRAINT capture_media_outputs_range_digest_check CHECK ((range_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT capture_media_outputs_sha256_check CHECK ((sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT capture_media_outputs_size_bytes_check CHECK ((size_bytes > 0))
);

CREATE TABLE public.capture_media_ranges (
    id text NOT NULL,
    capture_session_id text NOT NULL,
    epoch_id text,
    kind text NOT NULL,
    start_offset_ms bigint NOT NULL,
    end_offset_ms bigint NOT NULL,
    reason text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT capture_media_ranges_check CHECK ((end_offset_ms > start_offset_ms)),
    CONSTRAINT capture_media_ranges_kind_check CHECK ((kind = ANY (ARRAY['media'::text, 'gap'::text, 'excluded_command'::text]))),
    CONSTRAINT capture_media_ranges_start_offset_ms_check CHECK ((start_offset_ms >= 0))
);

CREATE TABLE public.capture_transcript_coverage (
    session_id text NOT NULL,
    stream_id text NOT NULL,
    lane text NOT NULL,
    start_offset_ms bigint NOT NULL,
    end_offset_ms bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT capture_transcript_coverage_check CHECK ((end_offset_ms >= start_offset_ms)),
    CONSTRAINT capture_transcript_coverage_lane_check CHECK ((lane = ANY (ARRAY['live'::text, 'recovery'::text]))),
    CONSTRAINT capture_transcript_coverage_start_offset_ms_check CHECK ((start_offset_ms >= 0))
);

CREATE TABLE public.command_replays (
    scope text NOT NULL,
    operation text NOT NULL,
    key text NOT NULL,
    request_hash bytea NOT NULL,
    resource_id text,
    response_status integer,
    response_body bytea,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    state text NOT NULL,
    invocation_id text,
    credential_id text,
    CONSTRAINT command_replays_request_hash_check CHECK ((octet_length(request_hash) = 32)),
    CONSTRAINT command_replays_scope_check CHECK ((scope ~ '^(account|actor|agent|principal):.+$'::text)),
    CONSTRAINT command_replays_state_check CHECK ((state = ANY (ARRAY['reserved'::text, 'completed'::text])))
);

CREATE TABLE public.composio_settings (
    singleton boolean DEFAULT true NOT NULL,
    api_key_ciphertext bytea NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT composio_settings_singleton_check CHECK (singleton)
);

CREATE TABLE public.decisions (
    id text NOT NULL,
    tenant_id text NOT NULL,
    room_id text NOT NULL,
    message_id text NOT NULL,
    kind text NOT NULL,
    requested_by_actor_id text NOT NULL,
    decider_actor_id text NOT NULL,
    alter_ego_task_id text,
    status text DEFAULT 'pending'::text NOT NULL,
    request jsonb NOT NULL,
    view jsonb NOT NULL,
    answer jsonb,
    result jsonb,
    expires_at timestamp with time zone,
    decided_at timestamp with time zone,
    finished_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    screenshot bytea,
    screenshot_media_type text,
    decided_by_actor_id text,
    CONSTRAINT decisions_answer_check CHECK (((answer IS NULL) OR (jsonb_typeof(answer) = 'object'::text))),
    CONSTRAINT decisions_decided_check CHECK ((((decided_at IS NULL) = (answer IS NULL)) AND ((decided_at IS NULL) = (decided_by_actor_id IS NULL)) AND ((status <> 'pending'::text) OR (decided_at IS NULL)) AND ((status = ANY (ARRAY['pending'::text, 'expired'::text])) OR (decided_at IS NOT NULL)))),
    CONSTRAINT decisions_finished_check CHECK (((status = ANY (ARRAY['succeeded'::text, 'failed'::text, 'unknown'::text, 'denied'::text, 'expired'::text, 'answered'::text, 'consumed'::text])) = (finished_at IS NOT NULL))),
    CONSTRAINT decisions_kind_check CHECK ((kind = ANY (ARRAY['connector_write'::text, 'agent_change'::text, 'question'::text, 'runtime_permission'::text, 'profile_setup_apps'::text, 'profile_setup_sources'::text, 'connection_auth'::text, 'browser_connection'::text, 'room_creation'::text, 'computer_permission'::text]))),
    CONSTRAINT decisions_request_check CHECK ((jsonb_typeof(request) = 'object'::text)),
    CONSTRAINT decisions_result_check CHECK (((result IS NULL) OR (jsonb_typeof(result) = 'object'::text))),
    CONSTRAINT decisions_screenshot_check CHECK ((((screenshot IS NULL) = (screenshot_media_type IS NULL)) AND ((screenshot IS NULL) OR ((kind = 'runtime_permission'::text) AND (screenshot_media_type = ANY (ARRAY['image/jpeg'::text, 'image/png'::text])))))),
    CONSTRAINT decisions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'executing'::text, 'succeeded'::text, 'failed'::text, 'unknown'::text, 'denied'::text, 'expired'::text, 'answered'::text, 'consumed'::text, 'authorizing'::text]))),
    CONSTRAINT decisions_view_check CHECK ((jsonb_typeof(view) = 'object'::text))
);

CREATE TABLE public.document_assets (
    id text NOT NULL,
    tenant_id text NOT NULL,
    document_id text NOT NULL,
    created_by_actor_id text,
    request_hash bytea,
    filename text NOT NULL,
    media_type text NOT NULL,
    sha256 text NOT NULL,
    size_bytes bigint NOT NULL,
    content_object_id text NOT NULL,
    status text NOT NULL,
    observed_size_bytes bigint,
    observed_sha256 text,
    observed_at timestamp with time zone,
    upload_attempt_count integer DEFAULT 0 NOT NULL,
    upload_attempt_id text,
    upload_lease_token_hash bytea,
    upload_lease_expires_at timestamp with time zone,
    upload_started_at timestamp with time zone,
    upload_completed_at timestamp with time zone,
    gc_after timestamp with time zone,
    deletion_identity text,
    deletion_result text,
    failure_code text,
    failure_evidence_hash text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    stored_at timestamp with time zone,
    available_at timestamp with time zone,
    deleting_at timestamp with time zone,
    deleted_at timestamp with time zone,
    quarantined_at timestamp with time zone,
    CONSTRAINT document_assets_check CHECK ((((upload_attempt_id IS NULL) AND (upload_lease_token_hash IS NULL) AND (upload_lease_expires_at IS NULL) AND (upload_started_at IS NULL)) OR ((upload_attempt_id IS NOT NULL) AND (upload_lease_token_hash IS NOT NULL) AND (upload_lease_expires_at IS NOT NULL) AND (upload_started_at IS NOT NULL)))),
    CONSTRAINT document_assets_check1 CHECK (((status = 'deleted'::text) = (deleted_at IS NOT NULL))),
    CONSTRAINT document_assets_content_object_id_check CHECK (((length(content_object_id) >= 1) AND (length(content_object_id) <= 255))),
    CONSTRAINT document_assets_deletion_result_check CHECK (((deletion_result IS NULL) OR (deletion_result = ANY (ARRAY['pending'::text, 'confirmed_absent'::text, 'hash_conflict'::text])))),
    CONSTRAINT document_assets_failure_code_check CHECK (((failure_code IS NULL) OR ((length(failure_code) >= 1) AND (length(failure_code) <= 128)))),
    CONSTRAINT document_assets_failure_evidence_hash_check CHECK (((failure_evidence_hash IS NULL) OR (failure_evidence_hash ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT document_assets_filename_check CHECK (((length(filename) >= 1) AND (length(filename) <= 255))),
    CONSTRAINT document_assets_media_type_check CHECK (((length(media_type) >= 1) AND (length(media_type) <= 255))),
    CONSTRAINT document_assets_observed_sha256_check CHECK (((observed_sha256 IS NULL) OR (observed_sha256 ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT document_assets_observed_size_bytes_check CHECK (((observed_size_bytes IS NULL) OR (observed_size_bytes >= 0))),
    CONSTRAINT document_assets_request_hash_check CHECK (((request_hash IS NULL) OR (octet_length(request_hash) = 32))),
    CONSTRAINT document_assets_sha256_check CHECK ((sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT document_assets_size_bytes_check CHECK ((size_bytes >= 0)),
    CONSTRAINT document_assets_status_check CHECK ((status = ANY (ARRAY['planned'::text, 'stored'::text, 'available'::text, 'gc_pending'::text, 'deleting'::text, 'deleted'::text, 'quarantined'::text]))),
    CONSTRAINT document_assets_upload_attempt_count_check CHECK ((upload_attempt_count >= 0)),
    CONSTRAINT document_assets_upload_lease_token_hash_check CHECK (((upload_lease_token_hash IS NULL) OR (octet_length(upload_lease_token_hash) = 32)))
);

CREATE TABLE public.document_bodies (
    document_id text NOT NULL,
    seq bigint NOT NULL,
    state bytea NOT NULL,
    state_vector bytea NOT NULL,
    asset_ids text[] DEFAULT '{}'::text[] NOT NULL,
    thread_ids text[] DEFAULT '{}'::text[] NOT NULL,
    last_editor_ids text[] DEFAULT '{}'::text[] NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    server_operations jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT document_bodies_asset_ids_check CHECK ((cardinality(asset_ids) <= 4096)),
    CONSTRAINT document_bodies_last_editor_ids_check CHECK ((cardinality(last_editor_ids) <= 4096)),
    CONSTRAINT document_bodies_seq_check CHECK ((seq >= 0)),
    CONSTRAINT document_bodies_server_operations_check CHECK (((jsonb_typeof(server_operations) = 'array'::text) AND (jsonb_array_length(server_operations) <= 32))),
    CONSTRAINT document_bodies_server_operations_objects CHECK ((NOT jsonb_path_exists(server_operations, '$[*]?(@.type() != "object")'::jsonpath))),
    CONSTRAINT document_bodies_state_check CHECK (((octet_length(state) >= 1) AND (octet_length(state) <= 33554432))),
    CONSTRAINT document_bodies_state_vector_check CHECK ((octet_length(state_vector) <= 1048576)),
    CONSTRAINT document_bodies_thread_ids_check CHECK (public.valid_document_revision_thread_manifest(thread_ids))
);

CREATE TABLE public.document_context_bindings (
    id text NOT NULL,
    tenant_id text NOT NULL,
    document_id text NOT NULL,
    binding_kind text NOT NULL,
    room_id text,
    work_item_id text,
    wiki_id text,
    status text NOT NULL,
    access_epoch bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    role text DEFAULT 'editor'::text NOT NULL,
    CONSTRAINT document_context_bindings_access_epoch_check CHECK ((access_epoch >= 1)),
    CONSTRAINT document_context_bindings_binding_kind_check CHECK ((binding_kind = ANY (ARRAY['room'::text, 'task'::text, 'wiki_source'::text, 'wiki_page'::text]))),
    CONSTRAINT document_context_bindings_check CHECK ((((binding_kind = 'room'::text) AND (room_id IS NOT NULL) AND (work_item_id IS NULL) AND (wiki_id IS NULL)) OR ((binding_kind = 'task'::text) AND (room_id IS NULL) AND (work_item_id IS NOT NULL) AND (wiki_id IS NULL)) OR ((binding_kind = ANY (ARRAY['wiki_source'::text, 'wiki_page'::text])) AND (room_id IS NULL) AND (work_item_id IS NULL) AND (wiki_id IS NOT NULL)))),
    CONSTRAINT document_context_bindings_role_check CHECK ((role = ANY (ARRAY['viewer'::text, 'editor'::text, 'manager'::text]))),
    CONSTRAINT document_context_bindings_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text])))
);

CREATE TABLE public.document_direct_collaborators (
    id text NOT NULL,
    tenant_id text NOT NULL,
    document_id text NOT NULL,
    target_actor_id text NOT NULL,
    role text NOT NULL,
    status text NOT NULL,
    grantor_actor_id text NOT NULL,
    version bigint NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT document_direct_collaborators_check CHECK ((((status = 'active'::text) AND (revoked_at IS NULL)) OR ((status = 'revoked'::text) AND (revoked_at IS NOT NULL)))),
    CONSTRAINT document_direct_collaborators_role_check CHECK ((role = ANY (ARRAY['viewer'::text, 'editor'::text, 'manager'::text]))),
    CONSTRAINT document_direct_collaborators_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text]))),
    CONSTRAINT document_direct_collaborators_version_check CHECK ((version >= 1))
);

CREATE TABLE public.document_event_sequences (
    document_id text NOT NULL,
    last_sequence bigint NOT NULL,
    CONSTRAINT document_event_sequences_last_sequence_check CHECK ((last_sequence >= 1))
);

CREATE TABLE public.document_events (
    id text NOT NULL,
    tenant_id text NOT NULL,
    document_id text NOT NULL,
    sequence bigint NOT NULL,
    event_type text NOT NULL,
    actor_id text NOT NULL,
    resource_kind text NOT NULL,
    resource_id text NOT NULL,
    projection_version bigint NOT NULL,
    occurred_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT document_events_check CHECK ((((event_type = 'document.created'::text) AND (resource_kind = ANY (ARRAY['document'::text, 'document_version'::text, 'agent_create_command'::text, 'publication_item'::text, 'duplicate_provenance'::text]))) OR ((event_type = 'document.metadata_updated'::text) AND (resource_kind = 'metadata_command'::text)) OR ((event_type = 'document.draft_updated'::text) AND (resource_kind = ANY (ARRAY['autosave_batch'::text, 'semantic_mutation'::text, 'wiki_page_result'::text, 'native_import'::text]))) OR ((event_type = 'document.title_updated'::text) AND (resource_kind = 'title_command'::text)) OR ((event_type = 'document.history_checkpointed'::text) AND (resource_kind = 'history_entry'::text)) OR ((event_type = 'document.version_created'::text) AND (resource_kind = ANY (ARRAY['document_version'::text, 'publication_item'::text]))) OR ((event_type = 'document.placement_updated'::text) AND (resource_kind = 'placement'::text)) OR ((event_type = 'document.binding_updated'::text) AND (resource_kind = 'binding_context'::text)) OR ((event_type = 'document.access_invalidated'::text) AND (resource_kind = ANY (ARRAY['access_epoch'::text, 'lifecycle_operation'::text]))) OR ((event_type = ANY (ARRAY['document.trashed'::text, 'document.restored'::text])) AND (resource_kind = 'lifecycle_operation'::text)) OR ((event_type = 'document.comment_updated'::text) AND (resource_kind = 'comment_thread'::text)) OR ((event_type = ANY (ARRAY['document.collaborator.created'::text, 'document.collaborator.updated'::text, 'document.collaborator.revoked'::text])) AND (resource_kind = 'collaborator_source'::text)) OR ((event_type = 'document.collaborator.policy_updated'::text) AND (resource_kind = 'collaborator_policy'::text)) OR ((event_type = ANY (ARRAY['document.access_request.created'::text, 'document.access_request.decided'::text])) AND (resource_kind = 'access_request'::text)) OR ((event_type = ANY (ARRAY['document.delegation.created'::text, 'document.delegation.updated'::text, 'document.delegation.revoked'::text, 'document.delegation.expired'::text])) AND (resource_kind = 'collaborator_source'::text)) OR ((event_type = 'document.link_share.updated'::text) AND (resource_kind = 'link_share'::text)))),
    CONSTRAINT document_events_event_type_check CHECK ((event_type = ANY (ARRAY['document.created'::text, 'document.metadata_updated'::text, 'document.draft_updated'::text, 'document.title_updated'::text, 'document.history_checkpointed'::text, 'document.version_created'::text, 'document.placement_updated'::text, 'document.binding_updated'::text, 'document.access_invalidated'::text, 'document.trashed'::text, 'document.restored'::text, 'document.comment_updated'::text, 'document.collaborator.created'::text, 'document.collaborator.updated'::text, 'document.collaborator.revoked'::text, 'document.collaborator.policy_updated'::text, 'document.access_request.created'::text, 'document.access_request.decided'::text, 'document.delegation.created'::text, 'document.delegation.updated'::text, 'document.delegation.revoked'::text, 'document.delegation.expired'::text, 'document.link_share.updated'::text]))),
    CONSTRAINT document_events_projection_version_check CHECK ((projection_version >= 1)),
    CONSTRAINT document_events_resource_kind_check CHECK ((resource_kind = ANY (ARRAY['document'::text, 'document_version'::text, 'agent_create_command'::text, 'publication_item'::text, 'duplicate_provenance'::text, 'metadata_command'::text, 'autosave_batch'::text, 'semantic_mutation'::text, 'wiki_page_result'::text, 'native_import'::text, 'title_command'::text, 'history_entry'::text, 'placement'::text, 'binding_context'::text, 'access_epoch'::text, 'lifecycle_operation'::text, 'comment_thread'::text, 'collaborator_source'::text, 'collaborator_policy'::text, 'access_request'::text, 'link_share'::text]))),
    CONSTRAINT document_events_sequence_check CHECK ((sequence >= 1))
);

CREATE TABLE public.document_latest_projections (
    tenant_id text NOT NULL,
    document_id text NOT NULL,
    revision_id text NOT NULL,
    persisted_seq bigint NOT NULL,
    full_state_fingerprint text NOT NULL,
    filename text NOT NULL,
    media_type text NOT NULL,
    content_object_id text NOT NULL,
    size_bytes bigint NOT NULL,
    sha256 text NOT NULL,
    input_schema_version integer NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    representation_format text NOT NULL,
    CONSTRAINT document_latest_projections_content_object_id_check CHECK (((length(content_object_id) >= 1) AND (length(content_object_id) <= 255))),
    CONSTRAINT document_latest_projections_filename_check CHECK (((length(filename) >= 1) AND (length(filename) <= 255))),
    CONSTRAINT document_latest_projections_full_state_fingerprint_check CHECK ((full_state_fingerprint ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT document_latest_projections_input_schema_version_check CHECK ((input_schema_version = 1)),
    CONSTRAINT document_latest_projections_media_type_check CHECK ((((representation_format = 'markdown'::text) AND (media_type = 'text/markdown'::text)) OR ((representation_format = 'plain_text'::text) AND (media_type = 'text/plain'::text)) OR ((representation_format = 'html'::text) AND (media_type = 'text/html'::text)) OR ((representation_format = 'blocks'::text) AND (media_type = 'application/json'::text)))),
    CONSTRAINT document_latest_projections_persisted_seq_check CHECK ((persisted_seq >= 0)),
    CONSTRAINT document_latest_projections_representation_format_check CHECK ((representation_format = ANY (ARRAY['markdown'::text, 'plain_text'::text, 'html'::text, 'blocks'::text]))),
    CONSTRAINT document_latest_projections_sha256_check CHECK ((sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT document_latest_projections_size_bytes_check CHECK (((size_bytes >= 0) AND (size_bytes <=
CASE representation_format
    WHEN 'markdown'::text THEN 33554432
    ELSE 104857600
END)))
);

CREATE TABLE public.document_permission_counts (
    document_id text NOT NULL,
    permission_count bigint DEFAULT 0 NOT NULL,
    CONSTRAINT document_permission_counts_permission_count_check CHECK ((permission_count >= 0))
);

CREATE TABLE public.document_placements (
    id text NOT NULL,
    tenant_id text NOT NULL,
    scope_kind text NOT NULL,
    owner_human_actor_id text NOT NULL,
    owner_actor_kind text DEFAULT 'human'::text NOT NULL,
    wiki_id text,
    parent_id text,
    node_kind text NOT NULL,
    name text,
    document_id text,
    sort_key text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT document_placements_check CHECK ((((scope_kind = ANY (ARRAY['personal'::text, 'shared'::text])) AND (wiki_id IS NULL)) OR ((scope_kind = 'wiki'::text) AND (wiki_id IS NOT NULL)))),
    CONSTRAINT document_placements_check1 CHECK ((((node_kind = 'folder'::text) AND (name IS NOT NULL) AND ((length(name) >= 1) AND (length(name) <= 255)) AND (document_id IS NULL)) OR ((node_kind = 'document'::text) AND (name IS NULL) AND (document_id IS NOT NULL)))),
    CONSTRAINT document_placements_check2 CHECK (((parent_id IS NULL) OR (parent_id <> id))),
    CONSTRAINT document_placements_node_kind_check CHECK ((node_kind = ANY (ARRAY['folder'::text, 'document'::text]))),
    CONSTRAINT document_placements_owner_actor_kind_check CHECK ((owner_actor_kind = 'human'::text)),
    CONSTRAINT document_placements_scope_kind_check CHECK ((scope_kind = ANY (ARRAY['personal'::text, 'wiki'::text, 'shared'::text]))),
    CONSTRAINT document_placements_sort_key_check CHECK (((length(sort_key) >= 1) AND (length(sort_key) <= 255)))
);

CREATE TABLE public.document_recent_opens (
    tenant_id text NOT NULL,
    document_id text NOT NULL,
    last_opened_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE public.document_revisions (
    id text NOT NULL,
    tenant_id text NOT NULL,
    document_id text NOT NULL,
    persisted_seq bigint NOT NULL,
    state_vector bytea NOT NULL,
    full_state_fingerprint text NOT NULL,
    state_status text DEFAULT 'available'::text NOT NULL,
    state_bytes bytea,
    state_bytes_sha256 text,
    asset_manifest jsonb NOT NULL,
    thread_manifest text[] DEFAULT '{}'::text[] NOT NULL,
    created_by_actor_id text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    history_trigger text,
    history_contributor_ids text[] DEFAULT '{}'::text[] NOT NULL,
    history_recorded_at timestamp with time zone,
    CONSTRAINT document_revisions_asset_manifest_check CHECK ((jsonb_typeof(asset_manifest) = 'array'::text)),
    CONSTRAINT document_revisions_check CHECK ((((state_status = 'available'::text) AND (state_bytes IS NOT NULL) AND (state_bytes_sha256 IS NOT NULL)) OR ((state_status = 'missing'::text) AND (state_bytes IS NULL) AND (state_bytes_sha256 IS NULL)))),
    CONSTRAINT document_revisions_full_state_fingerprint_check CHECK ((full_state_fingerprint ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT document_revisions_history_contributors_check CHECK ((cardinality(history_contributor_ids) <= 4096)),
    CONSTRAINT document_revisions_history_point_check CHECK ((((history_trigger IS NULL) = (history_recorded_at IS NULL)) AND ((history_trigger IS NOT NULL) OR (cardinality(history_contributor_ids) = 0)))),
    CONSTRAINT document_revisions_history_trigger_check CHECK ((history_trigger = ANY (ARRAY['idle'::text, 'manual'::text, 'agent_edit'::text, 'restore'::text]))),
    CONSTRAINT document_revisions_persisted_seq_check CHECK ((persisted_seq >= 0)),
    CONSTRAINT document_revisions_state_bytes_check CHECK (((state_bytes IS NULL) OR (octet_length(state_bytes) <= 33554432))),
    CONSTRAINT document_revisions_state_bytes_sha256_check CHECK (((state_bytes_sha256 IS NULL) OR (state_bytes_sha256 ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT document_revisions_state_status_check CHECK ((state_status = ANY (ARRAY['available'::text, 'missing'::text]))),
    CONSTRAINT document_revisions_state_vector_check CHECK ((octet_length(state_vector) <= 1048576)),
    CONSTRAINT document_revisions_thread_manifest_check CHECK (public.valid_document_revision_thread_manifest(thread_manifest))
);

CREATE TABLE public.document_texts (
    document_id text NOT NULL,
    tenant_id text NOT NULL,
    source_kind text NOT NULL,
    source_id text NOT NULL,
    status text NOT NULL,
    search_text text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    markdown text DEFAULT ''::text NOT NULL,
    markdown_sha256 text,
    scanned boolean DEFAULT false NOT NULL,
    longest_line_bytes bigint DEFAULT 0 NOT NULL,
    CONSTRAINT document_texts_longest_line_bytes_check CHECK ((longest_line_bytes >= 0)),
    CONSTRAINT document_texts_markdown_check CHECK ((((status = 'ready'::text) = (markdown_sha256 IS NOT NULL)) AND ((markdown_sha256 IS NULL) OR (markdown_sha256 ~ '^[a-f0-9]{64}$'::text)) AND ((status = 'ready'::text) OR (markdown = ''::text)))),
    CONSTRAINT document_texts_source_kind_check CHECK ((source_kind = ANY (ARRAY['native_body'::text, 'file_version'::text]))),
    CONSTRAINT document_texts_status_check CHECK ((status = ANY (ARRAY['ready'::text, 'too_large'::text, 'no_text'::text, 'unsupported'::text, 'failed'::text])))
);

CREATE VIEW public.document_text_heads AS
 SELECT document.id,
    document.tenant_id,
    document.status,
    document.format,
    public.document_text_version_id(document.id, text.source_kind, text.source_id) AS current_version_id,
    COALESCE(version.filename, document.title) AS filename,
    'markdown'::text AS representation_format,
    'text/markdown'::text AS media_type,
    (octet_length(text.markdown))::bigint AS size_bytes,
    text.markdown_sha256 AS sha256,
    text.updated_at AS created_at
   FROM (((public.documents document
     JOIN public.document_texts text ON (((text.document_id = document.id) AND (text.status = 'ready'::text))))
     LEFT JOIN public.document_versions version ON (((text.source_kind = 'file_version'::text) AND (version.id = text.source_id) AND (version.document_id = document.id))))
     CROSS JOIN LATERAL ( SELECT lower(TRIM(BOTH FROM split_part(COALESCE(version.media_type, 'text/markdown'::text), ';'::text, 1))) AS media_type,
            lower(regexp_replace(COALESCE(version.filename, 'document.md'::text), '^.*\.'::text, ''::text)) AS extension,
            lower(COALESCE(version.representation_format, 'markdown'::text)) AS representation) format)
  WHERE ((document.status = 'active'::text) AND (octet_length(text.markdown) > 0) AND (NOT (EXISTS ( SELECT 1
           FROM public.document_context_bindings page
          WHERE ((page.document_id = document.id) AND (page.tenant_id = document.tenant_id) AND (page.binding_kind = 'wiki_page'::text))))) AND ((text.source_kind = 'native_body'::text) OR ((lower(version.filename) !~ '\.(zip|gz|gzip|tar)\.(gz|gzip)$'::text) AND
        CASE
            WHEN ((format.media_type ~~ 'audio/%'::text) OR (format.media_type ~~ 'video/%'::text) OR (format.media_type = ANY (ARRAY['application/vnd.ms-excel'::text, 'application/vnd.ms-powerpoint'::text, 'application/vnd.rar'::text, 'application/x-7z-compressed'::text, 'application/x-rar-compressed'::text, 'application/x-tar'::text]))) THEN false
            WHEN (format.media_type = ANY (ARRAY['application/x-zip'::text, 'application/x-zip-compressed'::text, 'application/zip'::text])) THEN ((format.extension = ANY (ARRAY['docx'::text, 'pptx'::text, 'xlsx'::text, 'odt'::text, 'ods'::text, 'odp'::text, 'epub'::text, 'dotx'::text, 'potx'::text, 'ppsx'::text, 'xltx'::text])) OR (format.representation = ANY (ARRAY['docx'::text, 'pptx'::text, 'xlsx'::text, 'odt'::text, 'ods'::text, 'odp'::text, 'epub'::text, 'dotx'::text, 'potx'::text, 'ppsx'::text, 'xltx'::text])))
            WHEN ((format.media_type = ANY (ARRAY['application/vnd.oasis.opendocument.presentation'::text, 'application/vnd.oasis.opendocument.spreadsheet'::text, 'application/vnd.oasis.opendocument.text'::text, 'application/epub+zip'::text, 'message/rfc822'::text, 'multipart/related'::text, 'application/x-mimearchive'::text, 'application/vnd.openxmlformats-officedocument.wordprocessingml.template'::text, 'application/vnd.openxmlformats-officedocument.presentationml.template'::text, 'application/vnd.openxmlformats-officedocument.presentationml.slideshow'::text, 'application/vnd.openxmlformats-officedocument.spreadsheetml.template'::text, 'application/csv'::text, 'application/ecmascript'::text, 'application/javascript'::text, 'application/json'::text, 'application/ld+json'::text, 'application/msword'::text, 'application/pdf'::text, 'application/sql'::text, 'application/toml'::text, 'application/vnd.ms-word'::text, 'application/vnd.openxmlformats-officedocument.presentationml.presentation'::text, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'::text, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'::text, 'application/gzip'::text, 'application/x-gzip'::text, 'application/x-javascript'::text, 'application/x-msword'::text, 'application/x-yaml'::text, 'application/xhtml+xml'::text, 'application/xml'::text, 'application/yaml'::text, 'image/svg+xml'::text, 'text/comma-separated-values'::text, 'text/css'::text, 'text/csv'::text, 'text/html'::text, 'text/javascript'::text, 'text/json'::text, 'text/markdown'::text, 'text/plain'::text, 'text/tab-separated-values'::text, 'text/tsv'::text, 'text/x-markdown'::text, 'text/x-python'::text, 'text/x-sh'::text, 'text/x-sql'::text, 'text/x-yaml'::text, 'text/xml'::text, 'text/yaml'::text])) OR (format.media_type ~~ 'image/%'::text)) THEN true
            ELSE ((format.extension = ANY (ARRAY['odt'::text, 'ods'::text, 'odp'::text, 'epub'::text, 'eml'::text, 'mht'::text, 'mhtml'::text, 'dotx'::text, 'potx'::text, 'ppsx'::text, 'xltx'::text, 'c'::text, 'cpp'::text, 'css'::text, 'avif'::text, 'bmp'::text, 'csv'::text, 'doc'::text, 'docx'::text, 'gif'::text, 'go'::text, 'gz'::text, 'gzip'::text, 'h'::text, 'heic'::text, 'heif'::text, 'hpp'::text, 'htm'::text, 'html'::text, 'ico'::text, 'java'::text, 'jpeg'::text, 'jpg'::text, 'js'::text, 'json'::text, 'jsx'::text, 'less'::text, 'log'::text, 'markdown'::text, 'md'::text, 'mmd'::text, 'pdf'::text, 'png'::text, 'pptx'::text, 'py'::text, 'rs'::text, 'scss'::text, 'sh'::text, 'sql'::text, 'svg'::text, 'tif'::text, 'tiff'::text, 'toml'::text, 'ts'::text, 'tsv'::text, 'tsx'::text, 'txt'::text, 'webp'::text, 'xlsx'::text, 'xml'::text, 'yaml'::text, 'yml'::text])) OR (format.representation = ANY (ARRAY['odt'::text, 'ods'::text, 'odp'::text, 'epub'::text, 'eml'::text, 'mht'::text, 'mhtml'::text, 'dotx'::text, 'potx'::text, 'ppsx'::text, 'xltx'::text, 'c'::text, 'cpp'::text, 'css'::text, 'avif'::text, 'bmp'::text, 'csv'::text, 'doc'::text, 'docx'::text, 'gif'::text, 'go'::text, 'gz'::text, 'gzip'::text, 'h'::text, 'heic'::text, 'heif'::text, 'hpp'::text, 'htm'::text, 'html'::text, 'ico'::text, 'java'::text, 'jpeg'::text, 'jpg'::text, 'js'::text, 'json'::text, 'jsx'::text, 'less'::text, 'log'::text, 'markdown'::text, 'md'::text, 'mmd'::text, 'pdf'::text, 'png'::text, 'pptx'::text, 'py'::text, 'rs'::text, 'scss'::text, 'sh'::text, 'sql'::text, 'svg'::text, 'tif'::text, 'tiff'::text, 'toml'::text, 'ts'::text, 'tsv'::text, 'tsx'::text, 'txt'::text, 'webp'::text, 'xlsx'::text, 'xml'::text, 'yaml'::text, 'yml'::text, 'csv'::text, 'doc'::text, 'docx'::text, 'gzip'::text, 'html'::text, 'json'::text, 'markdown'::text, 'pdf'::text, 'plain_text'::text, 'png'::text, 'pptx'::text, 'svg'::text, 'tsv'::text, 'xlsx'::text, 'xml'::text, 'yaml'::text])) OR (format.media_type ~~ 'text/%'::text))
        END)));

CREATE TABLE public.document_wiki_pages (
    wiki_id text NOT NULL,
    tenant_id text NOT NULL,
    page_key text NOT NULL,
    document_id text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT document_wiki_pages_page_key_check CHECK (((page_key = lower(page_key)) AND (page_key ~ '^[a-z0-9][a-z0-9._/-]*\.md$'::text) AND (page_key !~ '(^|/)\.\.?(/|$)'::text) AND (page_key !~~ '%//%'::text) AND (length(page_key) <= 512)))
);

CREATE TABLE public.document_wiki_published_sources (
    wiki_id text NOT NULL,
    tenant_id text NOT NULL,
    document_id text NOT NULL,
    document_version_id text NOT NULL
);

CREATE TABLE public.document_wiki_refresh_sources (
    refresh_id text NOT NULL,
    tenant_id text NOT NULL,
    document_id text NOT NULL,
    frozen_document_version_id text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    source_kind text DEFAULT 'document'::text NOT NULL,
    CONSTRAINT document_wiki_refresh_sources_source_kind_check CHECK ((source_kind = ANY (ARRAY['document'::text, 'session'::text])))
);

CREATE TABLE public.document_wiki_refreshes (
    id text NOT NULL,
    tenant_id text NOT NULL,
    wiki_id text NOT NULL,
    generator_agent_actor_id text NOT NULL,
    generator_actor_kind text DEFAULT 'agent'::text NOT NULL,
    base_wiki_revision_id text,
    status text NOT NULL,
    candidate_set_hash text,
    result_wiki_revision_id text,
    outcome text,
    dispatch_last_error_code text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    followup_requested boolean DEFAULT false NOT NULL,
    capture_id text,
    sources_deferred boolean DEFAULT false NOT NULL,
    preview_pages jsonb,
    preview_revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT document_wiki_refreshes_candidate_set_hash_check CHECK (((candidate_set_hash IS NULL) OR (candidate_set_hash ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT document_wiki_refreshes_capture_id_check CHECK (((capture_id IS NULL) OR ((char_length(capture_id) >= 1) AND (char_length(capture_id) <= 128)))),
    CONSTRAINT document_wiki_refreshes_check CHECK ((((status = 'settled'::text) AND (result_wiki_revision_id IS NOT NULL) AND (outcome = 'applied'::text)) OR ((status <> 'settled'::text) AND (result_wiki_revision_id IS NULL)))),
    CONSTRAINT document_wiki_refreshes_dispatch_last_error_code_check CHECK (((dispatch_last_error_code IS NULL) OR (dispatch_last_error_code = ANY (ARRAY['object_unavailable'::text, 'object_mismatch'::text, 'candidate_unavailable'::text, 'candidate_invalid'::text, 'settlement_unavailable'::text])))),
    CONSTRAINT document_wiki_refreshes_generator_actor_kind_check CHECK ((generator_actor_kind = 'agent'::text)),
    CONSTRAINT document_wiki_refreshes_outcome_check CHECK (((outcome IS NULL) OR (outcome = ANY (ARRAY['applied'::text, 'conflicted'::text, 'failed'::text])))),
    CONSTRAINT document_wiki_refreshes_sources_deferred_check CHECK ((NOT (sources_deferred AND (capture_id IS NOT NULL)))),
    CONSTRAINT document_wiki_refreshes_status_check CHECK ((status = ANY (ARRAY['staging'::text, 'settled'::text, 'conflicted'::text, 'failed'::text])))
);

CREATE TABLE public.external_connection_agent_grants (
    id text NOT NULL,
    connection_id text NOT NULL,
    tenant_id text NOT NULL,
    agent_actor_id text NOT NULL,
    represented_human_actor_id text NOT NULL,
    status text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT external_connection_agent_grants_check CHECK (((status = 'active'::text) = (revoked_at IS NULL))),
    CONSTRAINT external_connection_agent_grants_revision_check CHECK ((revision >= 1)),
    CONSTRAINT external_connection_agent_grants_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text])))
);

CREATE TABLE public.external_connection_upstreams (
    upstream_id text NOT NULL,
    account_id text NOT NULL,
    user_id text NOT NULL,
    toolkit_slug text NOT NULL,
    auth_config_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoke_requested_at timestamp with time zone
);

CREATE TABLE public.external_connections (
    id text NOT NULL,
    account_id text NOT NULL,
    provider text NOT NULL,
    upstream_connection_id text NOT NULL,
    status text NOT NULL,
    connect_expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    remote_team_id text,
    remote_team_name text,
    remote_user_id text,
    revision bigint DEFAULT 1 NOT NULL,
    connect_url text,
    identity_label text,
    remote_principal_key text,
    status_checked_at timestamp with time zone,
    next_status_check_at timestamp with time zone DEFAULT now() NOT NULL,
    status_error_code text,
    active_since timestamp with time zone,
    toolkit_slug text,
    auth_config_id text,
    auto_reminders boolean DEFAULT true NOT NULL,
    status_check_requested_at timestamp with time zone,
    reauthorization_upstream_id text,
    reauthorization_connect_url text,
    reauthorization_connect_expires_at timestamp with time zone,
    reauthorization_error_code text,
    mail_import_status text,
    mail_import_revision bigint,
    mail_import_tenant_id text,
    mail_import_error_code text,
    mail_import_cursor text,
    mail_import_read integer,
    mail_import_provider_calls integer,
    mail_synced_until timestamp with time zone,
    CONSTRAINT external_connections_mail_import_check CHECK ((((mail_import_status IS NULL) = (mail_import_revision IS NULL)) AND ((mail_import_revision IS NULL) = (mail_import_tenant_id IS NULL)) AND ((mail_import_revision IS NULL) = (mail_import_cursor IS NULL)) AND ((mail_import_revision IS NULL) = (mail_import_read IS NULL)) AND ((mail_import_revision IS NULL) = (mail_import_provider_calls IS NULL)) AND (mail_import_read >= 0) AND (mail_import_provider_calls >= 0))),
    CONSTRAINT external_connections_mail_import_status_check CHECK ((mail_import_status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text]))),
    CONSTRAINT external_connections_mail_synced_until_check CHECK (((mail_synced_until IS NULL) OR (mail_import_status = 'completed'::text))),
    CONSTRAINT external_connections_provider_check CHECK ((provider ~ '^[a-z0-9][a-z0-9_-]{0,119}$'::text)),
    CONSTRAINT external_connections_reauthorization_check CHECK ((((reauthorization_upstream_id IS NULL) = (reauthorization_connect_expires_at IS NULL)) AND ((reauthorization_connect_url IS NULL) OR (reauthorization_upstream_id IS NOT NULL)))),
    CONSTRAINT external_connections_revision_check CHECK ((revision > 0)),
    CONSTRAINT external_connections_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'expired'::text, 'failed'::text, 'disconnecting'::text, 'revoke_pending'::text, 'revoked'::text])))
);

CREATE TABLE public.external_mail_import_documents (
    remote_id text NOT NULL,
    ordinal integer NOT NULL,
    document jsonb NOT NULL,
    connection_id text NOT NULL,
    CONSTRAINT external_mail_import_documents_document_check CHECK ((jsonb_typeof(document) = 'object'::text)),
    CONSTRAINT external_mail_import_documents_ordinal_check CHECK ((ordinal >= 0))
);

CREATE TABLE public.local_computer_enrollments (
    enrollment_id text NOT NULL,
    tenant_id text NOT NULL,
    owner_actor_id text NOT NULL,
    requested_computer_id text,
    renews_existing_computer boolean DEFAULT false NOT NULL,
    display_name text NOT NULL,
    redirect_uri text NOT NULL,
    code_challenge text NOT NULL,
    authorization_code_hash bytea NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    exchanged_at timestamp with time zone,
    exchanged_generation bigint,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT local_computer_enrollments_authorization_code_hash_check CHECK ((octet_length(authorization_code_hash) = 32)),
    CONSTRAINT local_computer_enrollments_check CHECK (((exchanged_at IS NULL) = (exchanged_generation IS NULL))),
    CONSTRAINT local_computer_enrollments_code_challenge_check CHECK (((length(code_challenge) >= 43) AND (length(code_challenge) <= 128))),
    CONSTRAINT local_computer_enrollments_display_name_check CHECK (((length(btrim(display_name)) >= 1) AND (length(btrim(display_name)) <= 120))),
    CONSTRAINT local_computer_enrollments_enrollment_id_check CHECK (((length(enrollment_id) >= 8) AND (length(enrollment_id) <= 128))),
    CONSTRAINT local_computer_enrollments_exchanged_generation_check CHECK (((exchanged_generation IS NULL) OR (exchanged_generation >= 0))),
    CONSTRAINT local_computer_enrollments_redirect_uri_check CHECK (((length(redirect_uri) >= 1) AND (length(redirect_uri) <= 2000))),
    CONSTRAINT local_computer_enrollments_requested_computer_id_check CHECK (((requested_computer_id IS NULL) OR (requested_computer_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'::text)))
);

CREATE TABLE public.local_computers (
    computer_id text NOT NULL,
    display_name text NOT NULL,
    status text DEFAULT 'offline'::text NOT NULL,
    credential_generation bigint DEFAULT 0 NOT NULL,
    capacity integer,
    active_operations integer DEFAULT 0 NOT NULL,
    runtime_inventory jsonb DEFAULT '[]'::jsonb NOT NULL,
    workspace_grants jsonb DEFAULT '[]'::jsonb NOT NULL,
    runtime_diagnostics jsonb DEFAULT '[]'::jsonb NOT NULL,
    last_seen_at timestamp with time zone,
    removed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    daemon_id text,
    daemon_public_key bytea,
    daemon_identity_version bigint DEFAULT 1 NOT NULL,
    platform text,
    daemon_version text,
    recommended_version text,
    owner_tenant_id text NOT NULL,
    owner_actor_id text NOT NULL,
    CONSTRAINT local_computers_active_operations_check CHECK ((active_operations >= 0)),
    CONSTRAINT local_computers_capacity_check CHECK (((capacity IS NULL) OR (capacity >= 0))),
    CONSTRAINT local_computers_check CHECK (((status = 'removed'::text) = (removed_at IS NOT NULL))),
    CONSTRAINT local_computers_computer_id_check CHECK ((computer_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'::text)),
    CONSTRAINT local_computers_credential_generation_check CHECK ((credential_generation >= 0)),
    CONSTRAINT local_computers_daemon_id_check CHECK (((daemon_id IS NULL) OR (daemon_id ~ '^[A-Za-z0-9_-]{43}$'::text))),
    CONSTRAINT local_computers_daemon_identity_shape_check CHECK (((daemon_id IS NULL) = (daemon_public_key IS NULL))),
    CONSTRAINT local_computers_daemon_public_key_check CHECK (((daemon_public_key IS NULL) OR (octet_length(daemon_public_key) = 32))),
    CONSTRAINT local_computers_daemon_version_check CHECK (((daemon_version IS NULL) OR ((length(daemon_version) >= 1) AND (length(daemon_version) <= 64)))),
    CONSTRAINT local_computers_display_name_check CHECK (((length(btrim(display_name)) >= 1) AND (length(btrim(display_name)) <= 120))),
    CONSTRAINT local_computers_platform_check CHECK ((platform = ANY (ARRAY['darwin'::text, 'linux'::text, 'win32'::text]))),
    CONSTRAINT local_computers_recommended_version_check CHECK (((recommended_version IS NULL) OR ((length(recommended_version) >= 1) AND (length(recommended_version) <= 64)))),
    CONSTRAINT local_computers_runtime_diagnostics_check CHECK ((jsonb_typeof(runtime_diagnostics) = 'array'::text)),
    CONSTRAINT local_computers_runtime_inventory_check CHECK ((jsonb_typeof(runtime_inventory) = 'array'::text)),
    CONSTRAINT local_computers_status_check CHECK ((status = ANY (ARRAY['online'::text, 'offline'::text, 'upgrade_required'::text, 'removed'::text]))),
    CONSTRAINT local_computers_workspace_grants_check CHECK ((jsonb_typeof(workspace_grants) = 'array'::text))
);

CREATE TABLE public.message_cards (
    message_id text NOT NULL,
    tenant_id text NOT NULL,
    room_id text NOT NULL,
    work_item_id text,
    decision_owner_actor_id text NOT NULL,
    card_type text NOT NULL,
    intent text NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT message_cards_card_type_check CHECK ((card_type = ANY (ARRAY['personal_notice'::text, 'room_invitation'::text]))),
    CONSTRAINT message_cards_card_type_intent_check CHECK (((card_type = 'personal_notice'::text) AND (intent = 'decision_requested'::text))),
    CONSTRAINT message_cards_source_check CHECK ((work_item_id IS NULL)),
    CONSTRAINT message_cards_version_check CHECK ((version >= 1))
);

CREATE TABLE public.message_reactions (
    message_id text NOT NULL,
    tenant_id text NOT NULL,
    room_id text NOT NULL,
    actor_id text NOT NULL,
    reaction_id text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT message_reactions_reaction_id_check CHECK ((reaction_id ~ '^[a-z0-9_+-]{1,64}$'::text))
);

CREATE TABLE public.personal_insights (
    id text NOT NULL,
    tenant_id text NOT NULL,
    owner_actor_id text NOT NULL,
    source_generation_id text NOT NULL,
    prompt_version text NOT NULL,
    model text NOT NULL,
    dimension text NOT NULL,
    basis text NOT NULL,
    statement text NOT NULL,
    content_fingerprint text NOT NULL,
    evidence jsonb NOT NULL,
    dismissed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT personal_insights_basis_check CHECK ((basis = ANY (ARRAY['explicit'::text, 'reported'::text, 'inferred'::text]))),
    CONSTRAINT personal_insights_check CHECK (((jsonb_typeof(evidence) = 'array'::text) AND ((jsonb_array_length(evidence) > 0) OR (dismissed_at IS NOT NULL)))),
    CONSTRAINT personal_insights_content_fingerprint_check CHECK ((content_fingerprint ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT personal_insights_dimension_check CHECK (((length(dimension) >= 1) AND (length(dimension) <= 120))),
    CONSTRAINT personal_insights_statement_check CHECK (((length(statement) >= 1) AND (length(statement) <= 2000)))
);

CREATE TABLE public.personal_profile_generations (
    id text NOT NULL,
    tenant_id text NOT NULL,
    owner_actor_id text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    decision_status text DEFAULT 'pending'::text NOT NULL,
    prompt_version text NOT NULL,
    base_profile_revision_id text,
    candidate_revision_id text,
    last_error_code text,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    sources jsonb DEFAULT '[]'::jsonb NOT NULL,
    insight_status text,
    insight_error_code text,
    insight_documents jsonb,
    CONSTRAINT personal_profile_generations_decision_status_check CHECK ((decision_status = ANY (ARRAY['pending'::text, 'confirmed'::text]))),
    CONSTRAINT personal_profile_generations_insight_documents_check CHECK ((jsonb_typeof(insight_documents) = 'array'::text)),
    CONSTRAINT personal_profile_generations_insight_shape CHECK ((((insight_documents IS NULL) OR (insight_status = ANY (ARRAY['queued'::text, 'running'::text]))) AND ((insight_error_code IS NULL) OR (insight_status IS NOT NULL)))),
    CONSTRAINT personal_profile_generations_insight_status_check CHECK ((insight_status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text]))),
    CONSTRAINT personal_profile_generations_sources_check CHECK ((jsonb_typeof(sources) = 'array'::text)),
    CONSTRAINT personal_profile_generations_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text])))
);

CREATE TABLE public.personal_wikis (
    id text NOT NULL,
    tenant_id text NOT NULL,
    owner_actor_id text NOT NULL,
    published_generation bigint DEFAULT 0 NOT NULL,
    current_revision_id text,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    CONSTRAINT personal_wikis_published_check CHECK (((current_revision_id IS NULL) = (published_at IS NULL))),
    CONSTRAINT personal_wikis_published_generation_check CHECK ((published_generation >= 0))
);

CREATE TABLE public.proactive_conversation_windows (
    room_id text NOT NULL,
    tenant_id text NOT NULL,
    judged_count bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT proactive_conversation_windows_judged_count_check CHECK ((judged_count >= 0))
);

CREATE TABLE public.proactive_outputs (
    message_id text NOT NULL,
    tenant_id text NOT NULL,
    owner_actor_id text NOT NULL,
    room_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    source text NOT NULL,
    local_run_id text NOT NULL,
    CONSTRAINT proactive_outputs_source_check CHECK ((source = ANY (ARRAY['review'::text, 'routine'::text, 'event'::text, 'plan'::text])))
);

CREATE TABLE public.proactive_pending_wakes (
    id text NOT NULL,
    tenant_id text NOT NULL,
    room_id text NOT NULL,
    author_actor_id text NOT NULL,
    agent_actor_id text NOT NULL,
    body text NOT NULL,
    tracking_item_id text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    delivered_at timestamp with time zone,
    source text NOT NULL,
    message_id text,
    connection_grant jsonb DEFAULT 'null'::jsonb NOT NULL,
    fired_routine_id text,
    fired_routine_instruction text,
    CONSTRAINT proactive_pending_wakes_body_check CHECK (((length(body) >= 1) AND (length(body) <= 20000))),
    CONSTRAINT proactive_pending_wakes_fired_routine_check CHECK (((fired_routine_id IS NULL) = (fired_routine_instruction IS NULL))),
    CONSTRAINT proactive_pending_wakes_source_check CHECK ((source = ANY (ARRAY['review'::text, 'routine'::text, 'event'::text, 'plan'::text, 'scheduled'::text])))
);

CREATE TABLE public.proactive_potential_items (
    id text NOT NULL,
    tenant_id text NOT NULL,
    owner_actor_id text NOT NULL,
    content text NOT NULL,
    source text NOT NULL,
    source_key text NOT NULL,
    reminded boolean NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT proactive_potential_items_content_check CHECK (((length(content) >= 1) AND (length(content) <= 2000))),
    CONSTRAINT proactive_potential_items_id_check CHECK ((id ~ '^ppi_[a-f0-9]{32}$'::text)),
    CONSTRAINT proactive_potential_items_source_check CHECK ((source = ANY (ARRAY['tracking_item'::text, 'pocket_note'::text, 'event'::text]))),
    CONSTRAINT proactive_potential_items_source_key_check CHECK (((length(source_key) >= 1) AND (length(source_key) <= 200)))
);

CREATE TABLE public.river_job (
    id bigint NOT NULL,
    state public.river_job_state DEFAULT 'available'::public.river_job_state NOT NULL,
    attempt smallint DEFAULT 0 NOT NULL,
    max_attempts smallint DEFAULT 25 NOT NULL,
    attempted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    finalized_at timestamp with time zone,
    scheduled_at timestamp with time zone DEFAULT now() NOT NULL,
    priority smallint DEFAULT 1 NOT NULL,
    args jsonb NOT NULL,
    attempted_by text[],
    errors jsonb[],
    kind text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    queue text DEFAULT 'default'::text NOT NULL,
    tags character varying(255)[] DEFAULT '{}'::character varying[] NOT NULL,
    unique_key bytea,
    unique_states bit(8),
    CONSTRAINT finalized_or_finalized_at_null CHECK ((((finalized_at IS NULL) AND (state <> ALL (ARRAY['cancelled'::public.river_job_state, 'completed'::public.river_job_state, 'discarded'::public.river_job_state]))) OR ((finalized_at IS NOT NULL) AND (state = ANY (ARRAY['cancelled'::public.river_job_state, 'completed'::public.river_job_state, 'discarded'::public.river_job_state]))))),
    CONSTRAINT kind_length CHECK (((char_length(kind) > 0) AND (char_length(kind) < 128))),
    CONSTRAINT max_attempts_is_positive CHECK ((max_attempts > 0)),
    CONSTRAINT priority_in_range CHECK (((priority >= 1) AND (priority <= 4))),
    CONSTRAINT queue_length CHECK (((char_length(queue) > 0) AND (char_length(queue) < 128)))
);

CREATE SEQUENCE public.river_job_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.river_job_id_seq OWNED BY public.river_job.id;

CREATE UNLOGGED TABLE public.river_leader (
    elected_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    leader_id text NOT NULL,
    name text DEFAULT 'default'::text NOT NULL,
    CONSTRAINT leader_id_length CHECK (((char_length(leader_id) > 0) AND (char_length(leader_id) < 128))),
    CONSTRAINT name_length CHECK ((name = 'default'::text))
);

CREATE TABLE public.river_notification (
    id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    payload text NOT NULL,
    topic text NOT NULL,
    CONSTRAINT topic_length CHECK (((length(topic) > 0) AND (length(topic) < 128)))
);

CREATE SEQUENCE public.river_notification_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.river_notification_id_seq OWNED BY public.river_notification.id;

CREATE TABLE public.river_queue (
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    paused_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.room_agent_message_cancellations (
    tenant_id text NOT NULL,
    room_id text NOT NULL,
    agent_actor_id text NOT NULL,
    message_id text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE VIEW public.room_agent_runs AS
 SELECT run.run_id,
    run.status,
    run.created_at,
    run.context_key,
    context.tenant_id,
    COALESCE(run.status_room_id, context.room_id) AS room_id,
    context.room_id AS context_room_id,
    context.agent_management_id,
    context.agent_actor_id
   FROM ((public.agent_local_runs run
     JOIN public.agent_execution_contexts context ON ((context.context_key = run.context_key)))
     JOIN public.active_room_members membership ON (((membership.room_id = context.room_id) AND (membership.actor_id = context.agent_actor_id) AND (membership.membership_epoch_id = context.membership_epoch_id))))
  WHERE (context.context_kind = 'meta'::text);

CREATE TABLE public.room_document_comment_reactions (
    tenant_id text NOT NULL,
    room_id text,
    document_id text NOT NULL,
    thread_id text NOT NULL,
    comment_id text NOT NULL,
    actor_id text NOT NULL,
    emoji text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT room_document_comment_reactions_emoji_check CHECK (((char_length(emoji) >= 1) AND (char_length(emoji) <= 64)))
);

CREATE TABLE public.room_document_comment_threads (
    id text NOT NULL,
    tenant_id text NOT NULL,
    room_id text,
    document_id text NOT NULL,
    current_anchor_id text NOT NULL,
    anchor_status text DEFAULT 'pending'::text NOT NULL,
    created_by_actor_id text NOT NULL,
    resolved_by_actor_id text,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    anchor_kind text NOT NULL,
    anchor_document_version_id text,
    anchor_quoted_text text NOT NULL,
    anchor_block_id text NOT NULL,
    anchor_context_before text NOT NULL,
    anchor_context_after text NOT NULL,
    anchor_version_number bigint NOT NULL,
    anchor_created_by_actor_id text NOT NULL,
    anchor_created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT room_document_comment_threads_anchor_context_check CHECK (((char_length(anchor_context_before) <= 2000) AND (char_length(anchor_context_after) <= 2000))),
    CONSTRAINT room_document_comment_threads_anchor_shape_check CHECK ((((anchor_kind = 'selection'::text) AND (anchor_document_version_id IS NULL) AND ((char_length(anchor_quoted_text) >= 1) AND (char_length(anchor_quoted_text) <= 10000)) AND ((char_length(anchor_block_id) >= 1) AND (char_length(anchor_block_id) <= 255))) OR ((anchor_kind = 'document_version'::text) AND (anchor_document_version_id IS NOT NULL) AND ((char_length(anchor_quoted_text) >= 1) AND (char_length(anchor_quoted_text) <= 10000)) AND (anchor_block_id = ''::text) AND (anchor_context_before = ''::text) AND (anchor_context_after = ''::text)))),
    CONSTRAINT room_document_comment_threads_anchor_status_check CHECK ((anchor_status = ANY (ARRAY['pending'::text, 'attached'::text, 'orphaned'::text]))),
    CONSTRAINT room_document_comment_threads_anchor_version_check CHECK ((anchor_version_number > 0)),
    CONSTRAINT room_document_comment_threads_check CHECK (((resolved_at IS NULL) = (resolved_by_actor_id IS NULL)))
);

CREATE TABLE public.room_document_comments (
    id text NOT NULL,
    tenant_id text NOT NULL,
    room_id text,
    document_id text NOT NULL,
    thread_id text NOT NULL,
    parent_comment_id text,
    author_actor_id text NOT NULL,
    version_number bigint DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    body text NOT NULL,
    segments jsonb NOT NULL,
    CONSTRAINT room_document_comments_body_check CHECK (((char_length(body) >= 1) AND (char_length(body) <= 50000))),
    CONSTRAINT room_document_comments_segments_check CHECK ((jsonb_typeof(segments) = 'array'::text)),
    CONSTRAINT room_document_comments_version_number_check CHECK ((version_number > 0))
);

CREATE SEQUENCE public.room_document_write_permit_identity_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE public.room_history_share_assets (
    share_id text NOT NULL,
    id text NOT NULL,
    media_type text NOT NULL,
    content bytea NOT NULL
);

CREATE TABLE public.room_history_share_messages (
    share_id text NOT NULL,
    "position" bigint NOT NULL,
    message_id text NOT NULL,
    presentation jsonb NOT NULL
);

CREATE TABLE public.room_history_shares (
    id text NOT NULL,
    room_id text NOT NULL,
    creator_actor_id text NOT NULL,
    creator_membership_epoch_id text NOT NULL,
    token_hash bytea NOT NULL,
    room_name text NOT NULL,
    snapshot_room_seq bigint NOT NULL,
    message_count integer DEFAULT 0 NOT NULL,
    web_version text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone
);

CREATE TABLE public.room_member_states (
    room_id text NOT NULL,
    actor_id text NOT NULL,
    read_through_room_seq bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    left_at timestamp with time zone,
    participation_epoch_id text,
    left_room_seq bigint DEFAULT 0 NOT NULL,
    pinned_at timestamp with time zone,
    thread_opened_at timestamp with time zone,
    CONSTRAINT room_member_states_read_through_room_seq_check CHECK ((read_through_room_seq >= 0))
);

CREATE SEQUENCE public.room_membership_epoch_identity_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.room_membership_epoch_identity_seq OWNED BY public.room_members.membership_epoch_id;

CREATE TABLE public.room_reminders (
    id text NOT NULL,
    tenant_id text NOT NULL,
    room_id text NOT NULL,
    created_by_actor_id text NOT NULL,
    instruction text NOT NULL,
    mention_actor_id text,
    cadence_kind text,
    timezone text NOT NULL,
    hour integer,
    minute integer,
    interval_hours integer,
    enabled boolean DEFAULT true NOT NULL,
    next_run_at timestamp with time zone,
    revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    name text NOT NULL,
    weekdays text[],
    template_agent_actor_id text,
    template_routine_key text,
    trigger jsonb,
    run_at timestamp with time zone,
    tracking_item_id text,
    tracking_purpose text,
    CONSTRAINT room_reminders_cadence_kind_check CHECK ((cadence_kind = ANY (ARRAY['daily'::text, 'weekly'::text, 'every_n_hours'::text, 'once'::text]))),
    CONSTRAINT room_reminders_cadence_shape CHECK ((((cadence_kind IS NULL) AND (run_at IS NULL)) OR (((cadence_kind = 'daily'::text) AND (hour IS NOT NULL) AND (minute IS NOT NULL) AND (weekdays IS NULL) AND (interval_hours IS NULL) AND (run_at IS NULL)) OR ((cadence_kind = 'weekly'::text) AND (hour IS NOT NULL) AND (minute IS NOT NULL) AND (interval_hours IS NULL) AND (run_at IS NULL) AND ((weekdays IS NOT NULL) AND (cardinality(weekdays) >= 1) AND (cardinality(weekdays) <= 7) AND (array_ndims(weekdays) = 1) AND (array_position(weekdays, NULL::text) IS NULL) AND (weekdays <@ ARRAY['monday'::text, 'tuesday'::text, 'wednesday'::text, 'thursday'::text, 'friday'::text, 'saturday'::text, 'sunday'::text]))) OR ((cadence_kind = 'every_n_hours'::text) AND (interval_hours IS NOT NULL) AND (hour IS NULL) AND (minute IS NULL) AND (weekdays IS NULL) AND (run_at IS NULL)) OR ((cadence_kind = 'once'::text) AND (run_at IS NOT NULL) AND (hour IS NULL) AND (minute IS NULL) AND (weekdays IS NULL) AND (interval_hours IS NULL))))),
    CONSTRAINT room_reminders_enabled_shape CHECK (((next_run_at IS NOT NULL) = (enabled AND (cadence_kind IS NOT NULL)))),
    CONSTRAINT room_reminders_hour_check CHECK (((hour IS NULL) OR ((hour >= 0) AND (hour <= 23)))),
    CONSTRAINT room_reminders_interval_hours_check CHECK (((interval_hours IS NULL) OR ((interval_hours >= 1) AND (interval_hours <= 168)))),
    CONSTRAINT room_reminders_minute_check CHECK (((minute IS NULL) OR ((minute >= 0) AND (minute <= 59)))),
    CONSTRAINT room_reminders_name_len CHECK (((char_length(name) >= 1) AND (char_length(name) <= 120))),
    CONSTRAINT room_reminders_prompt_check CHECK (((char_length(instruction) >= 1) AND (char_length(instruction) <= 50000))),
    CONSTRAINT room_reminders_revision_check CHECK ((revision >= 1)),
    CONSTRAINT room_reminders_template_origin_check CHECK (((template_agent_actor_id IS NULL) = (template_routine_key IS NULL))),
    CONSTRAINT room_reminders_timezone_check CHECK (((char_length(timezone) >= 1) AND (char_length(timezone) <= 255))),
    CONSTRAINT room_reminders_tracking_purpose_check CHECK ((((tracking_item_id IS NULL) AND (tracking_purpose IS NULL)) OR ((tracking_item_id IS NOT NULL) AND ((length(tracking_purpose) >= 1) AND (length(tracking_purpose) <= 500))))),
    CONSTRAINT room_reminders_trigger_shape CHECK (((trigger IS NULL) OR ((jsonb_typeof(trigger) = 'array'::text) AND ((jsonb_array_length(trigger) >= 1) AND (jsonb_array_length(trigger) <= 8)) AND (mention_actor_id IS NOT NULL)))),
    CONSTRAINT room_reminders_trigger_xor_cadence CHECK ((NOT ((cadence_kind IS NOT NULL) AND (trigger IS NOT NULL))))
);

CREATE TABLE public.room_routine_listeners (
    id text NOT NULL,
    tenant_id text NOT NULL,
    room_id text NOT NULL,
    routine_id text NOT NULL,
    ordinal integer NOT NULL,
    kind text NOT NULL,
    connection_id text NOT NULL,
    poll_cursor text,
    poll_next_at timestamp with time zone,
    poll_interval_seconds integer DEFAULT 300 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT room_routine_listeners_id_check CHECK ((id ~ '^lstr_[a-f0-9]{32}$'::text)),
    CONSTRAINT room_routine_listeners_kind_check CHECK ((kind = ANY (ARRAY['slack'::text, 'gmail'::text, 'outlook'::text, 'gcal'::text]))),
    CONSTRAINT room_routine_listeners_ordinal_check CHECK (((ordinal >= 0) AND (ordinal <= 7))),
    CONSTRAINT room_routine_listeners_poll_interval_seconds_check CHECK ((poll_interval_seconds >= 60))
);

CREATE TABLE public.routine_event_deliveries (
    routine_id text NOT NULL,
    source text NOT NULL,
    upstream_event_id text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE public.skill_manifests (
    manifest_id text NOT NULL,
    skill_id text NOT NULL,
    manifest_version text NOT NULL,
    description text NOT NULL,
    config_schema jsonb NOT NULL,
    content_hash bytea NOT NULL,
    file_count integer NOT NULL,
    size_bytes bigint NOT NULL,
    package_state text DEFAULT 'uploading'::text NOT NULL,
    created_by_actor_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sealed_at timestamp with time zone,
    frontmatter_extra jsonb DEFAULT '{}'::jsonb NOT NULL,
    files jsonb DEFAULT '[]'::jsonb NOT NULL,
    state text DEFAULT 'active'::text NOT NULL,
    CONSTRAINT skill_manifests_check CHECK ((((package_state = 'uploading'::text) AND (sealed_at IS NULL)) OR ((package_state = 'sealed'::text) AND (sealed_at IS NOT NULL)))),
    CONSTRAINT skill_manifests_config_schema_check CHECK ((jsonb_typeof(config_schema) = 'object'::text)),
    CONSTRAINT skill_manifests_content_hash_check CHECK ((octet_length(content_hash) = 32)),
    CONSTRAINT skill_manifests_description_check CHECK (((length(description) >= 1) AND (length(description) <= 1024))),
    CONSTRAINT skill_manifests_file_count_check CHECK ((file_count > 0)),
    CONSTRAINT skill_manifests_files_check CHECK ((jsonb_typeof(files) = 'array'::text)),
    CONSTRAINT skill_manifests_frontmatter_extra_check CHECK (((jsonb_typeof(frontmatter_extra) = 'object'::text) AND (octet_length((frontmatter_extra)::text) <= 65536))),
    CONSTRAINT skill_manifests_manifest_id_check CHECK (((length(manifest_id) >= 1) AND (length(manifest_id) <= 512) AND (manifest_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]*$'::text))),
    CONSTRAINT skill_manifests_manifest_version_check CHECK (((length(manifest_version) >= 1) AND (length(manifest_version) <= 64) AND public.unified_skill_manifest_version_is_semver(manifest_version))),
    CONSTRAINT skill_manifests_package_state_check CHECK ((package_state = ANY (ARRAY['uploading'::text, 'sealed'::text]))),
    CONSTRAINT skill_manifests_size_bytes_check CHECK ((size_bytes > 0)),
    CONSTRAINT skill_manifests_state_check CHECK ((state = ANY (ARRAY['active'::text, 'disabled'::text, 'revoked'::text])))
);

CREATE TABLE public.skills (
    skill_id text NOT NULL,
    owner_kind text NOT NULL,
    tenant_id text,
    name text NOT NULL,
    default_agent_types text[] DEFAULT ARRAY[]::text[] NOT NULL,
    created_by_actor_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    access_scope text NOT NULL,
    owner_actor_id text,
    latest_manifest_id text,
    CONSTRAINT skills_access_owner_consistent CHECK ((((access_scope = 'platform'::text) AND (owner_kind = 'platform'::text) AND (tenant_id IS NULL) AND (owner_actor_id IS NULL)) OR ((access_scope = 'tenant'::text) AND (owner_kind = 'tenant'::text) AND (tenant_id IS NOT NULL) AND (owner_actor_id IS NULL)) OR ((access_scope = 'owner'::text) AND (owner_kind = 'tenant'::text) AND (tenant_id IS NOT NULL) AND (owner_actor_id IS NOT NULL)))),
    CONSTRAINT skills_access_scope_check CHECK ((access_scope = ANY (ARRAY['platform'::text, 'tenant'::text, 'owner'::text]))),
    CONSTRAINT skills_check CHECK ((((owner_kind = 'platform'::text) AND (tenant_id IS NULL)) OR ((owner_kind = 'tenant'::text) AND (tenant_id IS NOT NULL)))),
    CONSTRAINT skills_check1 CHECK (((owner_kind = 'platform'::text) OR (cardinality(default_agent_types) = 0))),
    CONSTRAINT skills_default_agent_types_check CHECK (public.unified_skill_agent_types_are_canonical(default_agent_types)),
    CONSTRAINT skills_latest_manifest_platform_check CHECK (((latest_manifest_id IS NULL) OR (owner_kind = 'platform'::text))),
    CONSTRAINT skills_name_check CHECK (((length(name) >= 1) AND (length(name) <= 64) AND (name ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text))),
    CONSTRAINT skills_owner_kind_check CHECK ((owner_kind = ANY (ARRAY['platform'::text, 'tenant'::text]))),
    CONSTRAINT skills_skill_id_check CHECK (((length(skill_id) >= 1) AND (length(skill_id) <= 512) AND (skill_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]*$'::text)))
);

CREATE TABLE public.task_attempts (
    id text NOT NULL,
    task_id text NOT NULL,
    tenant_id text NOT NULL,
    generation bigint NOT NULL,
    attempt_number bigint NOT NULL,
    runtime_generation_key text NOT NULL,
    status text NOT NULL,
    current_input_revision bigint NOT NULL,
    deadline_at timestamp with time zone,
    stop_reason_code text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT task_attempts_attempt_number_check CHECK ((attempt_number >= 1)),
    CONSTRAINT task_attempts_check CHECK ((((status = ANY (ARRAY['passed'::text, 'stopped'::text])) AND (finished_at IS NOT NULL)) OR ((status <> ALL (ARRAY['passed'::text, 'stopped'::text])) AND (finished_at IS NULL)))),
    CONSTRAINT task_attempts_current_input_revision_check CHECK ((current_input_revision >= 1)),
    CONSTRAINT task_attempts_runtime_generation_key_check CHECK (((length(runtime_generation_key) >= 1) AND (length(runtime_generation_key) <= 255))),
    CONSTRAINT task_attempts_status_check CHECK ((status = ANY (ARRAY['running'::text, 'passed'::text, 'stopped'::text])))
);

CREATE TABLE public.task_effects (
    id text NOT NULL,
    task_id text NOT NULL,
    tenant_id text NOT NULL,
    generation bigint NOT NULL,
    root_operation_id text NOT NULL,
    effect_key text NOT NULL,
    operation text NOT NULL,
    owner_id text NOT NULL,
    payload jsonb NOT NULL,
    payload_hash bytea NOT NULL,
    root_payload_hash bytea NOT NULL,
    dispatch_sequence bigint NOT NULL,
    retry_of_effect_id text,
    status text NOT NULL,
    worker_id text,
    lease_token_hash bytea,
    lease_generation bigint DEFAULT 0 NOT NULL,
    lease_expires_at timestamp with time zone,
    observation jsonb,
    observation_hash bytea,
    error text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    dispatch_started_at timestamp with time zone,
    completed_at timestamp with time zone,
    CONSTRAINT task_effects_check CHECK ((((dispatch_sequence = 1) AND (retry_of_effect_id IS NULL)) OR ((dispatch_sequence > 1) AND (retry_of_effect_id IS NOT NULL)))),
    CONSTRAINT task_effects_check1 CHECK ((((worker_id IS NULL) AND (lease_token_hash IS NULL) AND (lease_expires_at IS NULL)) OR ((worker_id IS NOT NULL) AND (lease_token_hash IS NOT NULL) AND (lease_expires_at IS NOT NULL)))),
    CONSTRAINT task_effects_check2 CHECK ((((status = 'pending'::text) AND (dispatch_started_at IS NULL) AND (completed_at IS NULL)) OR ((status = 'dispatching'::text) AND (dispatch_started_at IS NOT NULL) AND (completed_at IS NULL)) OR ((status = ANY (ARRAY['succeeded'::text, 'failed'::text, 'uncertain'::text])) AND (dispatch_started_at IS NOT NULL) AND (completed_at IS NOT NULL)) OR ((status = 'canceled'::text) AND (completed_at IS NOT NULL)))),
    CONSTRAINT task_effects_check3 CHECK (((status <> 'succeeded'::text) OR ((observation IS NOT NULL) AND (observation_hash IS NOT NULL)))),
    CONSTRAINT task_effects_check4 CHECK (((status <> ALL (ARRAY['failed'::text, 'uncertain'::text])) OR (error IS NOT NULL))),
    CONSTRAINT task_effects_dispatch_sequence_check CHECK ((dispatch_sequence >= 1)),
    CONSTRAINT task_effects_effect_key_check CHECK (((length(effect_key) >= 1) AND (length(effect_key) <= 255))),
    CONSTRAINT task_effects_lease_generation_check CHECK ((lease_generation >= 0)),
    CONSTRAINT task_effects_lease_token_hash_check CHECK (((lease_token_hash IS NULL) OR (octet_length(lease_token_hash) = 32))),
    CONSTRAINT task_effects_observation_check CHECK (((observation IS NULL) OR (jsonb_typeof(observation) = 'object'::text))),
    CONSTRAINT task_effects_observation_hash_check CHECK (((observation_hash IS NULL) OR (octet_length(observation_hash) = 32))),
    CONSTRAINT task_effects_operation_check CHECK ((operation = ANY (ARRAY['submit_agent_turn'::text, 'cleanup_runtime'::text]))),
    CONSTRAINT task_effects_owner_id_check CHECK (((length(owner_id) >= 1) AND (length(owner_id) <= 255))),
    CONSTRAINT task_effects_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT task_effects_payload_hash_check CHECK ((octet_length(payload_hash) = 32)),
    CONSTRAINT task_effects_root_operation_id_check CHECK (((length(root_operation_id) >= 1) AND (length(root_operation_id) <= 255))),
    CONSTRAINT task_effects_root_payload_hash_check CHECK ((octet_length(root_payload_hash) = 32)),
    CONSTRAINT task_effects_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'dispatching'::text, 'succeeded'::text, 'failed'::text, 'uncertain'::text, 'canceled'::text])))
);

CREATE TABLE public.task_execution_facts (
    id text NOT NULL,
    task_id text NOT NULL,
    tenant_id text NOT NULL,
    generation bigint NOT NULL,
    execution_revision bigint NOT NULL,
    fact_kind text NOT NULL,
    execution_status text NOT NULL,
    control_settled_revision bigint NOT NULL,
    control_revision bigint,
    source_operation_id text,
    reason_code text,
    payload jsonb NOT NULL,
    payload_hash bytea NOT NULL,
    caused_by_actor_id text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT task_execution_facts_control_revision_check CHECK (((control_revision IS NULL) OR (control_revision >= 1))),
    CONSTRAINT task_execution_facts_control_settled_revision_check CHECK ((control_settled_revision >= 0)),
    CONSTRAINT task_execution_facts_execution_revision_check CHECK ((execution_revision >= 1)),
    CONSTRAINT task_execution_facts_execution_status_check CHECK ((execution_status = ANY (ARRAY['running'::text, 'waiting_for_approval'::text, 'idle'::text, 'failed'::text, 'canceled'::text]))),
    CONSTRAINT task_execution_facts_fact_kind_check CHECK ((fact_kind = 'TASK_EXECUTION_CHANGED'::text)),
    CONSTRAINT task_execution_facts_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT task_execution_facts_payload_hash_check CHECK ((octet_length(payload_hash) = 32))
);

CREATE TABLE public.task_execution_generations (
    task_id text NOT NULL,
    tenant_id text NOT NULL,
    generation bigint NOT NULL,
    source_key text,
    result_agent_actor_id text NOT NULL,
    spec jsonb NOT NULL,
    spec_hash bytea NOT NULL,
    terminal_status text,
    terminal_reason_code text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    terminal_at timestamp with time zone,
    coordinator_actor_id text,
    coordinator_context_key text,
    CONSTRAINT task_execution_generations_coordinator_pair_check CHECK (((coordinator_actor_id IS NULL) = (coordinator_context_key IS NULL))),
    CONSTRAINT task_execution_generations_generation_check CHECK ((generation >= 1)),
    CONSTRAINT task_execution_generations_open_check CHECK (((terminal_status IS NULL) AND (terminal_reason_code IS NULL) AND (terminal_at IS NULL))),
    CONSTRAINT task_execution_generations_spec_check CHECK ((jsonb_typeof(spec) = 'object'::text)),
    CONSTRAINT task_execution_generations_spec_hash_check CHECK ((octet_length(spec_hash) = 32))
);

CREATE TABLE public.task_execution_participants (
    task_id text NOT NULL,
    tenant_id text NOT NULL,
    generation bigint NOT NULL,
    actor_id text NOT NULL,
    agent_management_id text NOT NULL,
    execution_context_ref jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT task_execution_participants_agent_management_id_check CHECK (((length(agent_management_id) >= 1) AND (length(agent_management_id) <= 255))),
    CONSTRAINT task_execution_participants_execution_context_ref_check CHECK ((jsonb_typeof(execution_context_ref) = 'object'::text))
);

CREATE TABLE public.task_input_revisions (
    task_id text NOT NULL,
    tenant_id text NOT NULL,
    generation bigint NOT NULL,
    attempt_id text NOT NULL,
    input_revision bigint NOT NULL,
    cause text NOT NULL,
    recipient_actor_ids jsonb NOT NULL,
    input_manifest jsonb NOT NULL,
    message_effect_ids jsonb NOT NULL,
    capability_hash bytea NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    source_message_id text,
    CONSTRAINT task_input_revisions_capability_hash_check CHECK ((octet_length(capability_hash) = 32)),
    CONSTRAINT task_input_revisions_cause_check CHECK ((cause = ANY (ARRAY['creation'::text, 'human_message'::text, 'meta_message'::text, 'system'::text]))),
    CONSTRAINT task_input_revisions_input_manifest_check CHECK ((jsonb_typeof(input_manifest) = 'object'::text)),
    CONSTRAINT task_input_revisions_input_revision_check CHECK ((input_revision >= 1)),
    CONSTRAINT task_input_revisions_message_effect_ids_check CHECK ((jsonb_typeof(message_effect_ids) = 'array'::text)),
    CONSTRAINT task_input_revisions_recipient_actor_ids_check CHECK ((jsonb_typeof(recipient_actor_ids) = 'array'::text)),
    CONSTRAINT task_input_revisions_source_message_shape CHECK ((((cause = 'human_message'::text) AND (source_message_id IS NOT NULL)) OR ((cause <> 'human_message'::text) AND (source_message_id IS NULL))))
);

CREATE TABLE public.task_meta_inboxes (
    task_id text NOT NULL,
    tenant_id text NOT NULL,
    agent_actor_id text NOT NULL,
    through_seq bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT task_meta_inboxes_through_seq_check CHECK ((through_seq >= 0))
);

CREATE VIEW public.thread_room_list_actors AS
 SELECT message.room_id AS thread_room_id,
    message.author_actor_id AS actor_id,
    message.tenant_id
   FROM public.messages message
  WHERE ((message.message_kind = 'conversation'::text) AND (message.room_seq IS NOT NULL))
UNION
 SELECT message.room_id AS thread_room_id,
    mentioned.actor_id,
    message.tenant_id
   FROM (public.messages message
     CROSS JOIN LATERAL unnest(message.mentioned_actor_ids) mentioned(actor_id))
  WHERE ((message.mentioned_actor_ids <> '{}'::text[]) AND (message.message_kind = 'conversation'::text) AND (message.room_seq IS NOT NULL))
UNION
 SELECT state.room_id AS thread_room_id,
    state.actor_id,
    room.tenant_id
   FROM (public.room_member_states state
     JOIN public.rooms room ON ((room.id = state.room_id)))
  WHERE (state.thread_opened_at IS NOT NULL);

CREATE TABLE public.voice_live_confirmations (
    id text NOT NULL,
    voice_session_id text NOT NULL,
    turn_id text NOT NULL,
    tool text NOT NULL,
    arguments_hash text NOT NULL,
    goal text DEFAULT ''::text NOT NULL,
    surface text DEFAULT ''::text NOT NULL,
    used_at timestamp with time zone,
    used_turn_id text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE public.voice_live_replies (
    voice_session_id text NOT NULL,
    event_id text NOT NULL,
    turn_id text NOT NULL,
    message_id text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE public.voice_live_report_deliveries (
    report_id text NOT NULL,
    voice_session_id text NOT NULL,
    message_id text NOT NULL,
    delivered_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE public.voice_live_tasks (
    work_item_id text NOT NULL,
    room_id text NOT NULL,
    owner_actor_id text NOT NULL,
    home_room_id text NOT NULL,
    ordinal integer NOT NULL,
    voice_session_id text,
    goal text NOT NULL,
    surface text NOT NULL,
    canceled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT voice_live_tasks_goal_check CHECK (((char_length(goal) >= 1) AND (char_length(goal) <= 4000))),
    CONSTRAINT voice_live_tasks_ordinal_check CHECK ((ordinal > 0)),
    CONSTRAINT voice_live_tasks_surface_check CHECK ((surface = ANY (ARRAY['workspace'::text, 'web'::text, 'desktop'::text, 'apps'::text])))
);

CREATE TABLE public.voice_live_tool_calls (
    voice_session_id text NOT NULL,
    call_id text NOT NULL,
    turn_id text NOT NULL,
    name text NOT NULL,
    arguments text NOT NULL,
    request_hash text NOT NULL,
    state text DEFAULT 'running'::text NOT NULL,
    output text DEFAULT '{ "status": "outcome_unknown", "detail": "This operation was already accepted. Check its effect before trying again." }'::text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT voice_live_tool_calls_state_check CHECK ((state = ANY (ARRAY['running'::text, 'completed'::text, 'unknown'::text])))
);

CREATE TABLE public.voice_live_turns (
    voice_session_id text NOT NULL,
    turn_id text NOT NULL,
    human_message_id text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE public.voice_media_epochs (
    id text NOT NULL,
    voice_session_id text NOT NULL,
    capture_session_id text NOT NULL,
    epoch_index integer NOT NULL,
    desired_state text NOT NULL,
    observed_state text NOT NULL,
    provider_egress_id text,
    staging_prefix text NOT NULL,
    playlist_object_key text,
    first_archived_ms bigint,
    archived_through_ms bigint,
    segment_count bigint DEFAULT 0 NOT NULL,
    last_segment_at timestamp with time zone,
    final_end_ms bigint,
    last_failure_code text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    sealed_at timestamp with time zone,
    recorder_state text,
    recorder_started_at timestamp with time zone,
    recorder_archived_through_ms bigint,
    recorder_failure_code text,
    recorder_reported_at timestamp with time zone,
    restart_retry_at timestamp with time zone,
    CONSTRAINT voice_media_epochs_archived_through_ms_check CHECK ((archived_through_ms >= 0)),
    CONSTRAINT voice_media_epochs_check CHECK (((archived_through_ms IS NULL) OR (first_archived_ms IS NULL) OR (archived_through_ms >= first_archived_ms))),
    CONSTRAINT voice_media_epochs_check1 CHECK (((segment_count = 0) = (last_segment_at IS NULL))),
    CONSTRAINT voice_media_epochs_check2 CHECK (((final_end_ms IS NULL) OR (archived_through_ms IS NULL) OR (final_end_ms <= archived_through_ms))),
    CONSTRAINT voice_media_epochs_desired_state_check CHECK ((desired_state = ANY (ARRAY['active'::text, 'sealed'::text]))),
    CONSTRAINT voice_media_epochs_epoch_index_check CHECK ((epoch_index >= 0)),
    CONSTRAINT voice_media_epochs_final_end_ms_check CHECK ((final_end_ms >= 0)),
    CONSTRAINT voice_media_epochs_first_archived_ms_check CHECK ((first_archived_ms >= 0)),
    CONSTRAINT voice_media_epochs_observed_state_check CHECK ((observed_state = ANY (ARRAY['requested'::text, 'active'::text, 'sealing'::text, 'available'::text, 'failed'::text, 'unknown'::text]))),
    CONSTRAINT voice_media_epochs_recorder_archived_through_ms_check CHECK ((recorder_archived_through_ms >= 0)),
    CONSTRAINT voice_media_epochs_recorder_started_check CHECK (((recorder_state IS NULL) OR (recorder_state = 'failed'::text) OR (recorder_started_at IS NOT NULL))),
    CONSTRAINT voice_media_epochs_recorder_state_check CHECK ((recorder_state = ANY (ARRAY['active'::text, 'available'::text, 'failed'::text]))),
    CONSTRAINT voice_media_epochs_segment_count_check CHECK ((segment_count >= 0))
);

CREATE TABLE public.voice_sessions (
    id text NOT NULL,
    tenant_id text NOT NULL,
    room_id text NOT NULL,
    created_by_actor_id text NOT NULL,
    status text NOT NULL,
    provider_room_name text NOT NULL,
    participant_identity text NOT NULL,
    credential_generation bigint DEFAULT 0 NOT NULL,
    last_failure_code text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    closed_at timestamp with time zone,
    latest_partial_text text,
    latest_partial_start_offset_ms bigint,
    latest_partial_end_offset_ms bigint,
    latest_partial_updated_at timestamp with time zone,
    last_input_started_ms bigint,
    last_input_ended_ms bigint,
    purpose text NOT NULL,
    auth_session_id text,
    live_agent_actor_id text,
    live_lease_until timestamp with time zone,
    CONSTRAINT voice_sessions_check CHECK (((status = 'closed'::text) = (closed_at IS NOT NULL))),
    CONSTRAINT voice_sessions_credential_generation_check CHECK ((credential_generation >= 0)),
    CONSTRAINT voice_sessions_partial_state_check CHECK ((((latest_partial_text IS NULL) AND (latest_partial_start_offset_ms IS NULL) AND (latest_partial_end_offset_ms IS NULL) AND (latest_partial_updated_at IS NULL)) OR ((latest_partial_text IS NOT NULL) AND (length(TRIM(BOTH FROM latest_partial_text)) > 0) AND (latest_partial_start_offset_ms IS NOT NULL) AND (latest_partial_start_offset_ms >= 0) AND (latest_partial_end_offset_ms IS NOT NULL) AND (latest_partial_end_offset_ms > latest_partial_start_offset_ms) AND (latest_partial_updated_at IS NOT NULL)))),
    CONSTRAINT voice_sessions_purpose_check CHECK ((purpose = ANY (ARRAY['hardware_control'::text, 'chat_dictation'::text, 'chat_live'::text]))),
    CONSTRAINT voice_sessions_status_check CHECK ((status = ANY (ARRAY['provisioning'::text, 'connected'::text, 'reconnecting'::text, 'closing'::text, 'closed'::text])))
);

CREATE TABLE public.voice_transcript_segments (
    id text NOT NULL,
    event_id text NOT NULL,
    voice_session_id text NOT NULL,
    capture_session_id text,
    media_epoch integer NOT NULL,
    lane text NOT NULL,
    start_offset_ms bigint NOT NULL,
    end_offset_ms bigint NOT NULL,
    text text NOT NULL,
    normalized_text text NOT NULL,
    kind text NOT NULL,
    accepted_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    speaker_id text,
    seq bigint NOT NULL,
    superseded_at timestamp with time zone,
    CONSTRAINT voice_dictation_turn_fields_check CHECK (((kind <> 'dictation_turn'::text) OR (capture_session_id IS NULL))),
    CONSTRAINT voice_transcript_segments_end_offset_ms_check CHECK ((end_offset_ms > start_offset_ms)),
    CONSTRAINT voice_transcript_segments_kind_check CHECK ((kind = ANY (ARRAY['speech'::text, 'dictation_turn'::text]))),
    CONSTRAINT voice_transcript_segments_lane_check CHECK ((lane = ANY (ARRAY['live'::text, 'recovery'::text]))),
    CONSTRAINT voice_transcript_segments_media_epoch_check CHECK ((media_epoch >= 0)),
    CONSTRAINT voice_transcript_segments_normalized_text_check CHECK ((length(TRIM(BOTH FROM normalized_text)) > 0)),
    CONSTRAINT voice_transcript_segments_recovery_capture_check CHECK (((lane <> 'recovery'::text) OR (capture_session_id IS NOT NULL))),
    CONSTRAINT voice_transcript_segments_speaker_id_check CHECK (((speaker_id IS NULL) OR (speaker_id ~ '^spk_[1-9][0-9]*$'::text))),
    CONSTRAINT voice_transcript_segments_start_offset_ms_check CHECK ((start_offset_ms >= 0)),
    CONSTRAINT voice_transcript_segments_superseded_check CHECK (((superseded_at IS NULL) OR (lane = 'live'::text))),
    CONSTRAINT voice_transcript_segments_text_check CHECK ((length(TRIM(BOTH FROM text)) > 0))
);

CREATE SEQUENCE public.voice_transcript_segment_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.voice_transcript_segment_seq OWNED BY public.voice_transcript_segments.seq;

CREATE TABLE public.voice_transcript_uncertainties (
    capture_session_id text NOT NULL,
    event_id text NOT NULL,
    start_offset_ms bigint NOT NULL,
    end_offset_ms bigint NOT NULL,
    reason text NOT NULL,
    recovered_at timestamp with time zone,
    CONSTRAINT voice_transcript_uncertainties_check CHECK ((end_offset_ms > start_offset_ms)),
    CONSTRAINT voice_transcript_uncertainties_reason_check CHECK ((reason = ANY (ARRAY['input_gap'::text, 'track_interruption'::text, 'input_ended'::text]))),
    CONSTRAINT voice_transcript_uncertainties_start_offset_ms_check CHECK ((start_offset_ms >= 0))
);

CREATE TABLE public.wiki_source_items (
    tenant_id text NOT NULL,
    owner_actor_id text NOT NULL,
    source_key text NOT NULL,
    content_sha256 text NOT NULL,
    document_id text NOT NULL,
    document_version_id text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT wiki_source_items_content_sha256_check CHECK ((content_sha256 ~ '^[a-f0-9]{64}$'::text))
);

CREATE VIEW public.wiki_document_verdicts AS
 SELECT binding.wiki_id,
    binding.tenant_id,
    document.id AS document_id,
    COALESCE(version.filename, document.title) AS filename,
        CASE
            WHEN (item.document_id IS NULL) THEN 'my_pages'::text
            ELSE COALESCE(connection.provider, 'mail'::text)
        END AS source,
    public.document_text_version_id(document.id, text.source_kind, text.source_id) AS version_id,
    (octet_length(text.markdown))::bigint AS size_bytes,
    text.updated_at AS decided_at,
    public.source_rejection_reason(document.native_import_status, version.filename, version.representation_format, text.source_kind, version.media_type, text.status, text.scanned, (octet_length(text.markdown))::bigint, text.longest_line_bytes) AS reason
   FROM (((((public.document_context_bindings binding
     JOIN public.documents document ON (((document.id = binding.document_id) AND (document.tenant_id = binding.tenant_id) AND (document.status = 'active'::text))))
     JOIN public.document_texts text ON ((text.document_id = document.id)))
     LEFT JOIN public.document_versions version ON (((text.source_kind = 'file_version'::text) AND (version.id = text.source_id) AND (version.document_id = document.id))))
     LEFT JOIN public.wiki_source_items item ON (((item.tenant_id = document.tenant_id) AND (item.document_id = document.id))))
     LEFT JOIN public.external_connections connection ON ((connection.id = split_part(item.source_key, ':'::text, 2))))
  WHERE ((binding.binding_kind = 'wiki_source'::text) AND (binding.status = 'active'::text) AND (COALESCE(document.native_import_status, 'completed'::text) = ANY (ARRAY['completed'::text, 'failed'::text])) AND (NOT (EXISTS ( SELECT 1
           FROM public.document_context_bindings page
          WHERE ((page.document_id = document.id) AND (page.tenant_id = document.tenant_id) AND (page.binding_kind = 'wiki_page'::text))))));

CREATE VIEW public.wiki_session_sources AS
 SELECT wiki.id AS wiki_id,
    wiki.tenant_id,
    source.id AS source_id,
    source.active_sha256 AS version_id,
    version.size_bytes
   FROM (((public.personal_wikis wiki
     JOIN memory_source.another_me_subjects subject ON (((subject.tenant_id = wiki.tenant_id) AND (subject.represented_human_actor_id = wiki.owner_actor_id))))
     JOIN memory_index.sources source ON (((source.tenant_id = wiki.tenant_id) AND (source.owner_id = wiki.owner_actor_id) AND (source.agent_id = subject.agent_management_id))))
     JOIN memory_index.source_versions version ON (((version.source_id = source.id) AND (version.sha256 = source.active_sha256))))
  WHERE ((wiki.deleted_at IS NULL) AND (source.state = 'active'::text) AND (source.source_kind = ANY (ARRAY['room_message'::text, 'recording_transcript'::text])));

CREATE VIEW public.wiki_current_sources AS
 SELECT verdict.wiki_id,
    verdict.tenant_id,
    'document'::text AS source_kind,
    verdict.document_id AS source_id,
    verdict.version_id,
    verdict.size_bytes
   FROM public.wiki_document_verdicts verdict
  WHERE (verdict.reason IS NULL)
UNION ALL
 SELECT wiki_session_sources.wiki_id,
    wiki_session_sources.tenant_id,
    'session'::text AS source_kind,
    wiki_session_sources.source_id,
    wiki_session_sources.version_id,
    wiki_session_sources.size_bytes
   FROM public.wiki_session_sources;

CREATE TABLE public.wiki_source_skips (
    tenant_id text NOT NULL,
    owner_actor_id text NOT NULL,
    source_key text NOT NULL,
    source text NOT NULL,
    name text NOT NULL,
    reason text NOT NULL,
    skipped_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT wiki_source_skips_name_check CHECK ((char_length(name) <= 255)),
    CONSTRAINT wiki_source_skips_reason_check CHECK ((reason = 'filtered'::text)),
    CONSTRAINT wiki_source_skips_source_check CHECK ((source = ANY (ARRAY['gmail'::text, 'outlook'::text])))
);

CREATE TABLE public.work_item_access_grants (
    work_item_id text NOT NULL,
    tenant_id text NOT NULL,
    actor_id text NOT NULL,
    granted_by_actor_id text NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.work_item_activities (
    id text NOT NULL,
    work_item_id text NOT NULL,
    tenant_id text NOT NULL,
    kind text NOT NULL,
    actor_id text NOT NULL,
    from_state text,
    to_state text,
    target_actor_id text,
    comment_id text,
    room_id text,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT work_item_activities_details_shape CHECK (((jsonb_typeof(details) = 'object'::text) AND (((kind <> ALL (ARRAY['execution_control_requested'::text, 'task_recovery_decision'::text])) AND (details = '{}'::jsonb)) OR ((kind = 'execution_control_requested'::text) AND ((details ->> 'action'::text) = ANY (ARRAY['pause'::text, 'resume'::text, 'terminate'::text])) AND (jsonb_typeof((details -> 'generation'::text)) = 'number'::text) AND (((details ->> 'generation'::text))::bigint >= 1) AND (jsonb_typeof((details -> 'control_revision'::text)) = 'number'::text) AND (((details ->> 'control_revision'::text))::bigint >= 1) AND ((details ->> 'source_kind'::text) = 'human'::text) AND ((length((details ->> 'source_id'::text)) >= 1) AND (length((details ->> 'source_id'::text)) <= 255)) AND ((NOT (details ? 'reason'::text)) OR ((jsonb_typeof((details -> 'reason'::text)) = 'string'::text) AND (length((details ->> 'reason'::text)) <= 1000))) AND ((details - ARRAY['action'::text, 'generation'::text, 'control_revision'::text, 'source_kind'::text, 'source_id'::text, 'reason'::text]) = '{}'::jsonb)) OR ((kind = 'task_recovery_decision'::text) AND ((details ->> 'action'::text) = ANY (ARRAY['retry'::text, 'terminate'::text])) AND (jsonb_typeof((details -> 'generation'::text)) = 'number'::text) AND (((details ->> 'generation'::text))::bigint >= 1) AND ((length((details ->> 'intervention_id'::text)) >= 1) AND (length((details ->> 'intervention_id'::text)) <= 255)) AND (jsonb_typeof((details -> 'intervention_version'::text)) = 'number'::text) AND (((details ->> 'intervention_version'::text))::bigint >= 2) AND ((details ->> 'source_kind'::text) = 'human'::text) AND ((details - ARRAY['action'::text, 'generation'::text, 'intervention_id'::text, 'intervention_version'::text, 'source_kind'::text]) = '{}'::jsonb))))),
    CONSTRAINT work_item_activities_from_state_check CHECK ((from_state = ANY (ARRAY['open'::text, 'in_progress'::text, 'resolved'::text]))),
    CONSTRAINT work_item_activities_kind_check CHECK ((kind = ANY (ARRAY['created'::text, 'metadata_updated'::text, 'state_transitioned'::text, 'archived'::text, 'unarchived'::text, 'assignment_added'::text, 'assignment_removed'::text, 'access_grant_added'::text, 'access_grant_removed'::text, 'comment_edited'::text, 'comment_deleted'::text, 'work_room_created'::text, 'execution_control_requested'::text, 'task_recovery_decision'::text]))),
    CONSTRAINT work_item_activities_to_state_check CHECK ((to_state = ANY (ARRAY['open'::text, 'in_progress'::text, 'resolved'::text])))
);

CREATE TABLE public.work_item_assignments (
    work_item_id text NOT NULL,
    tenant_id text NOT NULL,
    actor_id text NOT NULL,
    assigned_by_actor_id text NOT NULL,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.work_item_comment_references (
    comment_id text NOT NULL,
    work_item_id text NOT NULL,
    tenant_id text NOT NULL,
    actor_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.work_item_comments (
    id text NOT NULL,
    work_item_id text NOT NULL,
    tenant_id text NOT NULL,
    author_actor_id text NOT NULL,
    body text NOT NULL,
    segments jsonb NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT work_item_comments_body_check CHECK ((length(body) <= 50000)),
    CONSTRAINT work_item_comments_check CHECK (((deleted_at IS NULL) OR ((body = ''::text) AND (segments = '[]'::jsonb)))),
    CONSTRAINT work_item_comments_segments_check CHECK ((jsonb_typeof(segments) = 'array'::text)),
    CONSTRAINT work_item_comments_version_check CHECK ((version >= 1))
);

CREATE TABLE public.work_item_description_references (
    work_item_id text NOT NULL,
    tenant_id text NOT NULL,
    actor_id text NOT NULL,
    ordinal integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT work_item_description_references_ordinal_check CHECK ((ordinal >= 0))
);

ALTER TABLE ONLY public.agent_runtime_inputs ALTER COLUMN input_sequence SET DEFAULT nextval('public.agent_runtime_input_sequence'::regclass);

ALTER TABLE ONLY public.river_job ALTER COLUMN id SET DEFAULT nextval('public.river_job_id_seq'::regclass);

ALTER TABLE ONLY public.river_notification ALTER COLUMN id SET DEFAULT nextval('public.river_notification_id_seq'::regclass);

ALTER TABLE ONLY public.room_members ALTER COLUMN membership_epoch_id SET DEFAULT ('membership_epoch_'::text || lpad((nextval('public.room_membership_epoch_identity_seq'::regclass))::text, 20, '0'::text));

ALTER TABLE ONLY public.voice_transcript_segments ALTER COLUMN seq SET DEFAULT nextval('public.voice_transcript_segment_seq'::regclass);

ALTER TABLE ONLY memory_index.chunks
    ADD CONSTRAINT chunks_pkey PRIMARY KEY (source_id, id);

ALTER TABLE ONLY memory_index.chunks
    ADD CONSTRAINT chunks_source_id_chunk_no_key UNIQUE (source_id, chunk_no);

ALTER TABLE ONLY memory_index.scheduler_state
    ADD CONSTRAINT scheduler_state_pkey PRIMARY KEY (singleton);

ALTER TABLE ONLY memory_index.session_fact_windows
    ADD CONSTRAINT session_fact_windows_pkey PRIMARY KEY (source_id, window_sha256);

ALTER TABLE ONLY memory_index.session_facts
    ADD CONSTRAINT session_facts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY memory_index.session_facts
    ADD CONSTRAINT session_facts_source_id_window_sha256_ordinal_key UNIQUE (source_id, window_sha256, ordinal);

ALTER TABLE ONLY memory_index.session_trigger_targets
    ADD CONSTRAINT session_trigger_targets_pkey PRIMARY KEY (target_key);

ALTER TABLE ONLY memory_index.source_versions
    ADD CONSTRAINT source_versions_pkey PRIMARY KEY (source_id, sha256);

ALTER TABLE ONLY memory_index.sources
    ADD CONSTRAINT sources_pkey PRIMARY KEY (id);

ALTER TABLE ONLY memory_index.sources
    ADD CONSTRAINT sources_tenant_id_owner_id_agent_id_document_id_key UNIQUE (tenant_id, owner_id, agent_id, document_id);

ALTER TABLE ONLY memory_index.sources
    ADD CONSTRAINT sources_tenant_id_owner_id_agent_id_id_key UNIQUE (tenant_id, owner_id, agent_id, id);

ALTER TABLE ONLY memory_index.tracking_items
    ADD CONSTRAINT tracking_items_owner_identity UNIQUE (tenant_id, owner_actor_id, id);

ALTER TABLE ONLY memory_index.tracking_items
    ADD CONSTRAINT tracking_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.actors
    ADD CONSTRAINT actors_id_tenant_id_key UNIQUE (id, tenant_id);

ALTER TABLE ONLY public.actors
    ADD CONSTRAINT actors_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.actors
    ADD CONSTRAINT actors_scoped_kind_key UNIQUE (id, tenant_id, kind);

ALTER TABLE ONLY public.actors
    ADD CONSTRAINT actors_tenant_id_account_id_key UNIQUE (tenant_id, account_id);

ALTER TABLE ONLY public.actors
    ADD CONSTRAINT actors_tenant_id_handle_key UNIQUE (tenant_id, handle);

ALTER TABLE ONLY public.agent_access_credentials
    ADD CONSTRAINT agent_access_credentials_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.agent_access_credentials
    ADD CONSTRAINT agent_access_credentials_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY public.agent_context_inbox_cursors
    ADD CONSTRAINT agent_context_inbox_cursors_pkey PRIMARY KEY (context_key, inbox_id);

ALTER TABLE ONLY public.agent_execution_contexts
    ADD CONSTRAINT agent_execution_contexts_pkey PRIMARY KEY (context_key);

ALTER TABLE ONLY public.agent_live_handover_receipts
    ADD CONSTRAINT agent_live_handover_receipts_pkey PRIMARY KEY (context_key, voice_session_id);

ALTER TABLE ONLY public.agent_local_run_inputs
    ADD CONSTRAINT agent_local_run_inputs_pkey PRIMARY KEY (run_id, relation, ordinal);

ALTER TABLE ONLY public.agent_local_run_inputs
    ADD CONSTRAINT agent_local_run_inputs_run_id_input_id_key UNIQUE (run_id, input_id);

ALTER TABLE ONLY public.agent_local_runs
    ADD CONSTRAINT agent_local_runs_context_key_run_id_key UNIQUE (context_key, run_id);

ALTER TABLE ONLY public.agent_local_runs
    ADD CONSTRAINT agent_local_runs_pkey PRIMARY KEY (run_id);

ALTER TABLE ONLY public.agent_memories
    ADD CONSTRAINT agent_memories_pkey PRIMARY KEY (agent_id);

ALTER TABLE ONLY public.agent_presentation_sequence_items
    ADD CONSTRAINT agent_presentation_sequence_items_pkey PRIMARY KEY (sequence_id, "position");

ALTER TABLE ONLY public.agent_presentation_sequences
    ADD CONSTRAINT agent_presentation_sequences_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.agent_registrations
    ADD CONSTRAINT agent_registrations_actor_tenant_key UNIQUE (actor_id, tenant_id);

ALTER TABLE ONLY public.agent_registrations
    ADD CONSTRAINT agent_registrations_agent_management_id_key UNIQUE (agent_management_id);

ALTER TABLE ONLY public.agent_registrations
    ADD CONSTRAINT agent_registrations_owner_key UNIQUE (actor_id, tenant_id, agent_management_id);

ALTER TABLE ONLY public.agent_registrations
    ADD CONSTRAINT agent_registrations_pkey PRIMARY KEY (actor_id);

ALTER TABLE ONLY public.agent_runtime_inputs
    ADD CONSTRAINT agent_runtime_inputs_context_key_input_sequence_key UNIQUE (context_key, input_sequence);

ALTER TABLE ONLY public.agent_runtime_inputs
    ADD CONSTRAINT agent_runtime_inputs_pkey PRIMARY KEY (context_key, input_id);

ALTER TABLE ONLY public.agent_runtime_status_events
    ADD CONSTRAINT agent_runtime_status_events_command_id_key UNIQUE (command_id);

ALTER TABLE ONLY public.agent_runtime_status_events
    ADD CONSTRAINT agent_runtime_status_events_pkey PRIMARY KEY (local_run_id, event_ordinal);

ALTER TABLE ONLY public.agent_service_epochs
    ADD CONSTRAINT agent_service_epochs_pkey PRIMARY KEY (epoch);

ALTER TABLE ONLY public.agent_skill_bindings
    ADD CONSTRAINT agent_skill_bindings_agent_actor_id_skill_id_key UNIQUE (agent_actor_id, skill_id);

ALTER TABLE ONLY public.agent_skill_bindings
    ADD CONSTRAINT agent_skill_bindings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.agent_templates
    ADD CONSTRAINT agent_templates_pkey PRIMARY KEY (template_id);

ALTER TABLE ONLY public.agent_usage_totals
    ADD CONSTRAINT agent_usage_totals_pkey PRIMARY KEY (provider, model);

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY public.capture_media_outputs
    ADD CONSTRAINT capture_media_outputs_capture_session_id_purpose_range_dige_key UNIQUE (capture_session_id, purpose, range_digest);

ALTER TABLE ONLY public.capture_media_outputs
    ADD CONSTRAINT capture_media_outputs_object_key_key UNIQUE (object_key);

ALTER TABLE ONLY public.capture_media_outputs
    ADD CONSTRAINT capture_media_outputs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.capture_media_ranges
    ADD CONSTRAINT capture_media_ranges_capture_session_id_kind_start_offset_m_key UNIQUE (capture_session_id, kind, start_offset_ms, end_offset_ms);

ALTER TABLE ONLY public.capture_media_ranges
    ADD CONSTRAINT capture_media_ranges_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.capture_sessions
    ADD CONSTRAINT capture_sessions_id_tenant_id_room_id_key UNIQUE (id, tenant_id, room_id);

ALTER TABLE ONLY public.capture_sessions
    ADD CONSTRAINT capture_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.capture_transcript_coverage
    ADD CONSTRAINT capture_transcript_coverage_pkey PRIMARY KEY (session_id, stream_id);

ALTER TABLE ONLY public.command_replays
    ADD CONSTRAINT command_replays_pkey PRIMARY KEY (scope, operation, key);

ALTER TABLE ONLY public.composio_settings
    ADD CONSTRAINT composio_settings_pkey PRIMARY KEY (singleton);

ALTER TABLE ONLY public.decisions
    ADD CONSTRAINT decisions_message_id_key UNIQUE (message_id);

ALTER TABLE ONLY public.decisions
    ADD CONSTRAINT decisions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.document_assets
    ADD CONSTRAINT document_assets_content_object_id_key UNIQUE (content_object_id);

ALTER TABLE ONLY public.document_assets
    ADD CONSTRAINT document_assets_deletion_identity_key UNIQUE (deletion_identity);

ALTER TABLE ONLY public.document_assets
    ADD CONSTRAINT document_assets_id_document_id_key UNIQUE (id, document_id);

ALTER TABLE ONLY public.document_assets
    ADD CONSTRAINT document_assets_id_tenant_id_document_id_key UNIQUE (id, tenant_id, document_id);

ALTER TABLE ONLY public.document_assets
    ADD CONSTRAINT document_assets_id_tenant_id_document_id_sha256_size_bytes_key UNIQUE (id, tenant_id, document_id, sha256, size_bytes);

ALTER TABLE ONLY public.document_assets
    ADD CONSTRAINT document_assets_id_tenant_id_key UNIQUE (id, tenant_id);

ALTER TABLE ONLY public.document_assets
    ADD CONSTRAINT document_assets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.document_bodies
    ADD CONSTRAINT document_bodies_pkey PRIMARY KEY (document_id);

ALTER TABLE ONLY public.document_context_bindings
    ADD CONSTRAINT document_context_bindings_id_tenant_id_key UNIQUE (id, tenant_id);

ALTER TABLE ONLY public.document_context_bindings
    ADD CONSTRAINT document_context_bindings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.document_direct_collaborators
    ADD CONSTRAINT document_direct_collaborators_id_tenant_id_key UNIQUE (id, tenant_id);

ALTER TABLE ONLY public.document_direct_collaborators
    ADD CONSTRAINT document_direct_collaborators_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.document_event_sequences
    ADD CONSTRAINT document_event_sequences_pkey PRIMARY KEY (document_id);

ALTER TABLE ONLY public.document_events
    ADD CONSTRAINT document_events_document_id_sequence_key UNIQUE (document_id, sequence);

ALTER TABLE ONLY public.document_events
    ADD CONSTRAINT document_events_id_tenant_id_key UNIQUE (id, tenant_id);

ALTER TABLE ONLY public.document_events
    ADD CONSTRAINT document_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.document_latest_projections
    ADD CONSTRAINT document_latest_projections_pkey PRIMARY KEY (tenant_id, document_id, representation_format);

ALTER TABLE ONLY public.document_permission_counts
    ADD CONSTRAINT document_permission_counts_pkey PRIMARY KEY (document_id);

ALTER TABLE ONLY public.document_placements
    ADD CONSTRAINT document_placements_id_tenant_id_key UNIQUE (id, tenant_id);

ALTER TABLE ONLY public.document_placements
    ADD CONSTRAINT document_placements_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.document_recent_opens
    ADD CONSTRAINT document_recent_opens_pkey PRIMARY KEY (document_id);

ALTER TABLE ONLY public.document_revisions
    ADD CONSTRAINT document_revisions_document_id_persisted_seq_full_state_fin_key UNIQUE (document_id, persisted_seq, full_state_fingerprint);

ALTER TABLE ONLY public.document_revisions
    ADD CONSTRAINT document_revisions_document_tenant_seq_fingerprint_key UNIQUE (document_id, tenant_id, persisted_seq, full_state_fingerprint);

ALTER TABLE ONLY public.document_revisions
    ADD CONSTRAINT document_revisions_id_tenant_id_document_id_key UNIQUE (id, tenant_id, document_id);

ALTER TABLE ONLY public.document_revisions
    ADD CONSTRAINT document_revisions_id_tenant_id_document_id_persisted_seq_f_key UNIQUE (id, tenant_id, document_id, persisted_seq, full_state_fingerprint);

ALTER TABLE ONLY public.document_revisions
    ADD CONSTRAINT document_revisions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.document_texts
    ADD CONSTRAINT document_texts_pkey PRIMARY KEY (document_id);

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_document_id_version_number_key UNIQUE (document_id, version_number);

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_id_document_id_key UNIQUE (id, document_id);

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_id_tenant_id_document_id_key UNIQUE (id, tenant_id, document_id);

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_id_tenant_id_document_id_sha256_key UNIQUE (id, tenant_id, document_id, sha256);

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_id_tenant_id_key UNIQUE (id, tenant_id);

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.document_wiki_pages
    ADD CONSTRAINT document_wiki_pages_pkey PRIMARY KEY (wiki_id, page_key);

ALTER TABLE ONLY public.document_wiki_pages
    ADD CONSTRAINT document_wiki_pages_wiki_id_document_id_key UNIQUE (wiki_id, document_id);

ALTER TABLE ONLY public.document_wiki_pages
    ADD CONSTRAINT document_wiki_pages_wiki_id_tenant_id_page_key_document_id_key UNIQUE (wiki_id, tenant_id, page_key, document_id);

ALTER TABLE ONLY public.document_wiki_published_sources
    ADD CONSTRAINT document_wiki_published_sources_pkey PRIMARY KEY (wiki_id, document_id);

ALTER TABLE ONLY public.document_wiki_refresh_sources
    ADD CONSTRAINT document_wiki_refresh_sources_pkey PRIMARY KEY (refresh_id, document_id);

ALTER TABLE ONLY public.document_wiki_refreshes
    ADD CONSTRAINT document_wiki_refreshes_id_tenant_id_key UNIQUE (id, tenant_id);

ALTER TABLE ONLY public.document_wiki_refreshes
    ADD CONSTRAINT document_wiki_refreshes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_id_tenant_id_key UNIQUE (id, tenant_id);

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.external_connection_agent_grants
    ADD CONSTRAINT external_connection_agent_gran_connection_id_agent_actor_id_key UNIQUE (connection_id, agent_actor_id);

ALTER TABLE ONLY public.external_connection_agent_grants
    ADD CONSTRAINT external_connection_agent_grants_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.external_connection_upstreams
    ADD CONSTRAINT external_connection_upstreams_pkey PRIMARY KEY (upstream_id);

ALTER TABLE ONLY public.external_connections
    ADD CONSTRAINT external_connections_id_account_id_key UNIQUE (id, account_id);

ALTER TABLE ONLY public.external_connections
    ADD CONSTRAINT external_connections_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.external_connections
    ADD CONSTRAINT external_connections_upstream_connection_id_key UNIQUE (upstream_connection_id);

ALTER TABLE ONLY public.external_mail_import_documents
    ADD CONSTRAINT external_mail_import_documents_pkey PRIMARY KEY (connection_id, remote_id);

ALTER TABLE ONLY public.local_computer_enrollments
    ADD CONSTRAINT local_computer_enrollments_pkey PRIMARY KEY (enrollment_id);

ALTER TABLE ONLY public.local_computers
    ADD CONSTRAINT local_computers_computer_daemon_unique UNIQUE (computer_id, daemon_id);

ALTER TABLE ONLY public.local_computers
    ADD CONSTRAINT local_computers_pkey PRIMARY KEY (computer_id);

ALTER TABLE ONLY public.message_cards
    ADD CONSTRAINT message_cards_message_id_intent_key UNIQUE (message_id, intent);

ALTER TABLE ONLY public.message_cards
    ADD CONSTRAINT message_cards_pkey PRIMARY KEY (message_id);

ALTER TABLE ONLY public.message_reactions
    ADD CONSTRAINT message_reactions_pkey PRIMARY KEY (message_id, actor_id, reaction_id);

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_id_tenant_room_unique UNIQUE (id, tenant_id, room_id);

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_source_identity_unique UNIQUE (id, tenant_id);

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_work_item_origin_key UNIQUE (id, room_id, tenant_id);

ALTER TABLE ONLY public.personal_insights
    ADD CONSTRAINT personal_insights_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.personal_insights
    ADD CONSTRAINT personal_insights_tenant_id_owner_actor_id_content_fingerpr_key UNIQUE (tenant_id, owner_actor_id, content_fingerprint);

ALTER TABLE ONLY public.personal_profile_currents
    ADD CONSTRAINT personal_profile_currents_pkey PRIMARY KEY (tenant_id, owner_actor_id);

ALTER TABLE ONLY public.personal_profile_generations
    ADD CONSTRAINT personal_profile_generations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.personal_profile_revisions
    ADD CONSTRAINT personal_profile_revisions_id_tenant_id_owner_actor_id_key UNIQUE (id, tenant_id, owner_actor_id);

ALTER TABLE ONLY public.personal_profile_revisions
    ADD CONSTRAINT personal_profile_revisions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.personal_profile_revisions
    ADD CONSTRAINT personal_profile_revisions_source_profile_generation_id_key UNIQUE (source_profile_generation_id);

ALTER TABLE ONLY public.personal_wikis
    ADD CONSTRAINT personal_wikis_id_owner_actor_id_key UNIQUE (id, owner_actor_id);

ALTER TABLE ONLY public.personal_wikis
    ADD CONSTRAINT personal_wikis_id_tenant_id_key UNIQUE (id, tenant_id);

ALTER TABLE ONLY public.personal_wikis
    ADD CONSTRAINT personal_wikis_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pocket_notes
    ADD CONSTRAINT pocket_notes_pkey PRIMARY KEY (tenant_id, owner_actor_id, note_date);

ALTER TABLE ONLY public.proactive_conversation_windows
    ADD CONSTRAINT proactive_conversation_windows_pkey PRIMARY KEY (room_id);

ALTER TABLE ONLY public.proactive_guidelines
    ADD CONSTRAINT proactive_guidelines_pkey PRIMARY KEY (tenant_id, owner_actor_id, version);

ALTER TABLE ONLY public.proactive_outputs
    ADD CONSTRAINT proactive_outputs_local_run_id_key UNIQUE (local_run_id);

ALTER TABLE ONLY public.proactive_outputs
    ADD CONSTRAINT proactive_outputs_pkey PRIMARY KEY (message_id);

ALTER TABLE ONLY public.proactive_pending_wakes
    ADD CONSTRAINT proactive_pending_wakes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.proactive_potential_items
    ADD CONSTRAINT proactive_potential_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.proactive_potential_items
    ADD CONSTRAINT proactive_potential_items_tenant_id_owner_actor_id_source_s_key UNIQUE (tenant_id, owner_actor_id, source, source_key);

ALTER TABLE ONLY public.river_job
    ADD CONSTRAINT river_job_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.river_leader
    ADD CONSTRAINT river_leader_pkey PRIMARY KEY (name);

ALTER TABLE ONLY public.river_notification
    ADD CONSTRAINT river_notification_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.river_queue
    ADD CONSTRAINT river_queue_pkey PRIMARY KEY (name);

ALTER TABLE ONLY public.room_agent_message_cancellations
    ADD CONSTRAINT room_agent_message_cancellations_pkey PRIMARY KEY (agent_actor_id, message_id);

ALTER TABLE ONLY public.room_document_comment_reactions
    ADD CONSTRAINT room_document_comment_reactions_pkey PRIMARY KEY (comment_id, actor_id, emoji);

ALTER TABLE ONLY public.room_document_comment_threads
    ADD CONSTRAINT room_document_comment_threads_id_document_id_key UNIQUE (id, document_id);

ALTER TABLE ONLY public.room_document_comment_threads
    ADD CONSTRAINT room_document_comment_threads_id_tenant_id_room_id_document_key UNIQUE (id, tenant_id, room_id, document_id);

ALTER TABLE ONLY public.room_document_comment_threads
    ADD CONSTRAINT room_document_comment_threads_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.room_document_comments
    ADD CONSTRAINT room_document_comments_id_tenant_id_room_id_document_id_thr_key UNIQUE (id, tenant_id, room_id, document_id, thread_id);

ALTER TABLE ONLY public.room_document_comments
    ADD CONSTRAINT room_document_comments_id_thread_id_key UNIQUE (id, thread_id);

ALTER TABLE ONLY public.room_document_comments
    ADD CONSTRAINT room_document_comments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.room_events
    ADD CONSTRAINT room_events_pkey PRIMARY KEY (event_id);

ALTER TABLE ONLY public.room_events
    ADD CONSTRAINT room_events_room_id_room_seq_key UNIQUE (room_id, room_seq);

ALTER TABLE ONLY public.room_history_share_assets
    ADD CONSTRAINT room_history_share_assets_pkey PRIMARY KEY (share_id, id);

ALTER TABLE ONLY public.room_history_share_messages
    ADD CONSTRAINT room_history_share_messages_pkey PRIMARY KEY (share_id, "position");

ALTER TABLE ONLY public.room_history_shares
    ADD CONSTRAINT room_history_shares_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.room_history_shares
    ADD CONSTRAINT room_history_shares_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY public.room_member_states
    ADD CONSTRAINT room_member_states_pkey PRIMARY KEY (room_id, actor_id);

ALTER TABLE ONLY public.room_members
    ADD CONSTRAINT room_members_pkey PRIMARY KEY (room_id, actor_id);

ALTER TABLE ONLY public.room_reminders
    ADD CONSTRAINT room_reminders_id_room_id_key UNIQUE (id, room_id);

ALTER TABLE ONLY public.room_reminders
    ADD CONSTRAINT room_reminders_id_tenant_id_key UNIQUE (id, tenant_id);

ALTER TABLE ONLY public.room_reminders
    ADD CONSTRAINT room_reminders_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.room_reminders
    ADD CONSTRAINT room_reminders_template_origin_unique UNIQUE (template_agent_actor_id, template_routine_key);

ALTER TABLE ONLY public.room_routine_listeners
    ADD CONSTRAINT room_routine_listeners_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.room_routine_listeners
    ADD CONSTRAINT room_routine_listeners_routine_id_ordinal_key UNIQUE (routine_id, ordinal);

ALTER TABLE ONLY public.rooms
    ADD CONSTRAINT rooms_id_tenant_id_key UNIQUE (id, tenant_id);

ALTER TABLE ONLY public.rooms
    ADD CONSTRAINT rooms_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.routine_event_deliveries
    ADD CONSTRAINT routine_event_deliveries_pkey PRIMARY KEY (routine_id, source, upstream_event_id);

ALTER TABLE ONLY public.skill_manifests
    ADD CONSTRAINT skill_manifests_manifest_id_skill_id_key UNIQUE (manifest_id, skill_id);

ALTER TABLE ONLY public.skill_manifests
    ADD CONSTRAINT skill_manifests_pkey PRIMARY KEY (manifest_id);

ALTER TABLE ONLY public.skill_manifests
    ADD CONSTRAINT skill_manifests_skill_id_manifest_version_key UNIQUE (skill_id, manifest_version);

ALTER TABLE ONLY public.skills
    ADD CONSTRAINT skills_pkey PRIMARY KEY (skill_id);

ALTER TABLE ONLY public.task_attempts
    ADD CONSTRAINT task_attempts_id_task_id_tenant_id_generation_key UNIQUE (id, task_id, tenant_id, generation);

ALTER TABLE ONLY public.task_attempts
    ADD CONSTRAINT task_attempts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.task_attempts
    ADD CONSTRAINT task_attempts_task_id_generation_attempt_number_key UNIQUE (task_id, generation, attempt_number);

ALTER TABLE ONLY public.task_effects
    ADD CONSTRAINT task_effects_id_task_id_tenant_id_generation_key UNIQUE (id, task_id, tenant_id, generation);

ALTER TABLE ONLY public.task_effects
    ADD CONSTRAINT task_effects_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.task_effects
    ADD CONSTRAINT task_effects_retry_of_effect_id_key UNIQUE (retry_of_effect_id);

ALTER TABLE ONLY public.task_effects
    ADD CONSTRAINT task_effects_task_id_generation_effect_key_key UNIQUE (task_id, generation, effect_key);

ALTER TABLE ONLY public.task_effects
    ADD CONSTRAINT task_effects_task_id_generation_root_operation_id_dispatch__key UNIQUE (task_id, generation, root_operation_id, dispatch_sequence);

ALTER TABLE ONLY public.task_execution_facts
    ADD CONSTRAINT task_execution_facts_id_task_id_tenant_id_generation_key UNIQUE (id, task_id, tenant_id, generation);

ALTER TABLE ONLY public.task_execution_facts
    ADD CONSTRAINT task_execution_facts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.task_execution_facts
    ADD CONSTRAINT task_execution_facts_task_id_generation_execution_revision_key UNIQUE (task_id, generation, execution_revision);

ALTER TABLE ONLY public.task_execution_generations
    ADD CONSTRAINT task_execution_generations_pkey PRIMARY KEY (task_id, generation);

ALTER TABLE ONLY public.task_execution_generations
    ADD CONSTRAINT task_execution_generations_task_id_tenant_id_generation_key UNIQUE (task_id, tenant_id, generation);

ALTER TABLE ONLY public.task_execution_participants
    ADD CONSTRAINT task_execution_participants_pkey PRIMARY KEY (task_id, generation, actor_id);

ALTER TABLE ONLY public.task_execution_participants
    ADD CONSTRAINT task_execution_participants_task_id_tenant_id_generation_ac_key UNIQUE (task_id, tenant_id, generation, actor_id);

ALTER TABLE ONLY public.task_input_revisions
    ADD CONSTRAINT task_input_revisions_pkey PRIMARY KEY (attempt_id, input_revision);

ALTER TABLE ONLY public.task_input_revisions
    ADD CONSTRAINT task_input_revisions_task_id_tenant_id_generation_attempt_i_key UNIQUE (task_id, tenant_id, generation, attempt_id, input_revision);

ALTER TABLE ONLY public.task_meta_callback_messages
    ADD CONSTRAINT task_meta_callback_messages_id_tenant_id_task_id_key UNIQUE (id, tenant_id, task_id);

ALTER TABLE ONLY public.task_meta_callback_messages
    ADD CONSTRAINT task_meta_callback_messages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.task_meta_callback_messages
    ADD CONSTRAINT task_meta_callback_messages_task_id_tenant_id_meta_seq_key UNIQUE (task_id, tenant_id, meta_seq);

ALTER TABLE ONLY public.task_meta_callbacks
    ADD CONSTRAINT task_meta_callbacks_pkey PRIMARY KEY (task_id, tenant_id);

ALTER TABLE ONLY public.task_meta_callbacks
    ADD CONSTRAINT task_meta_callbacks_task_id_tenant_id_generation_key UNIQUE (task_id, tenant_id, generation);

ALTER TABLE ONLY public.task_meta_inboxes
    ADD CONSTRAINT task_meta_inboxes_pkey PRIMARY KEY (task_id, agent_actor_id);

ALTER TABLE ONLY public.task_meta_inboxes
    ADD CONSTRAINT task_meta_inboxes_task_id_tenant_id_agent_actor_id_key UNIQUE (task_id, tenant_id, agent_actor_id);

ALTER TABLE ONLY public.task_meta_messages
    ADD CONSTRAINT task_meta_messages_id_target_key UNIQUE (id, tenant_id, task_id, agent_actor_id);

ALTER TABLE ONLY public.task_meta_messages
    ADD CONSTRAINT task_meta_messages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.task_meta_messages
    ADD CONSTRAINT task_meta_messages_task_id_agent_actor_id_meta_seq_key UNIQUE (task_id, agent_actor_id, meta_seq);

ALTER TABLE ONLY public.room_document_comment_threads
    ADD CONSTRAINT unified_document_comment_threads_scope_key UNIQUE (id, tenant_id, document_id);

ALTER TABLE ONLY public.room_document_comments
    ADD CONSTRAINT unified_document_comments_scope_key UNIQUE (id, tenant_id, document_id, thread_id);

ALTER TABLE ONLY public.user_memory_revisions
    ADD CONSTRAINT user_memory_revisions_pkey PRIMARY KEY (tenant_id, owner_actor_id, version);

ALTER TABLE ONLY public.voice_capture_questions
    ADD CONSTRAINT voice_capture_questions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.voice_live_confirmations
    ADD CONSTRAINT voice_live_confirmations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.voice_live_replies
    ADD CONSTRAINT voice_live_replies_message_id_key UNIQUE (message_id);

ALTER TABLE ONLY public.voice_live_replies
    ADD CONSTRAINT voice_live_replies_pkey PRIMARY KEY (voice_session_id, event_id);

ALTER TABLE ONLY public.voice_live_report_deliveries
    ADD CONSTRAINT voice_live_report_deliveries_pkey PRIMARY KEY (report_id);

ALTER TABLE ONLY public.voice_live_tasks
    ADD CONSTRAINT voice_live_tasks_pkey PRIMARY KEY (work_item_id);

ALTER TABLE ONLY public.voice_live_tasks
    ADD CONSTRAINT voice_live_tasks_room_id_owner_actor_id_ordinal_key UNIQUE (room_id, owner_actor_id, ordinal);

ALTER TABLE ONLY public.voice_live_tool_calls
    ADD CONSTRAINT voice_live_tool_calls_pkey PRIMARY KEY (voice_session_id, call_id);

ALTER TABLE ONLY public.voice_live_turns
    ADD CONSTRAINT voice_live_turns_human_message_id_key UNIQUE (human_message_id);

ALTER TABLE ONLY public.voice_live_turns
    ADD CONSTRAINT voice_live_turns_pkey PRIMARY KEY (voice_session_id, turn_id);

ALTER TABLE ONLY public.voice_media_epochs
    ADD CONSTRAINT voice_media_epochs_capture_session_id_epoch_index_key UNIQUE (capture_session_id, epoch_index);

ALTER TABLE ONLY public.voice_media_epochs
    ADD CONSTRAINT voice_media_epochs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.voice_media_epochs
    ADD CONSTRAINT voice_media_epochs_provider_egress_id_key UNIQUE (provider_egress_id);

ALTER TABLE ONLY public.voice_media_epochs
    ADD CONSTRAINT voice_media_epochs_staging_prefix_key UNIQUE (staging_prefix);

ALTER TABLE ONLY public.voice_sessions
    ADD CONSTRAINT voice_sessions_id_tenant_id_room_id_key UNIQUE (id, tenant_id, room_id);

ALTER TABLE ONLY public.voice_sessions
    ADD CONSTRAINT voice_sessions_participant_identity_key UNIQUE (participant_identity);

ALTER TABLE ONLY public.voice_sessions
    ADD CONSTRAINT voice_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.voice_sessions
    ADD CONSTRAINT voice_sessions_provider_room_name_key UNIQUE (provider_room_name);

ALTER TABLE ONLY public.voice_transcript_segments
    ADD CONSTRAINT voice_transcript_segments_event_id_key UNIQUE (event_id);

ALTER TABLE ONLY public.voice_transcript_segments
    ADD CONSTRAINT voice_transcript_segments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.voice_transcript_uncertainties
    ADD CONSTRAINT voice_transcript_uncertainties_pkey PRIMARY KEY (capture_session_id, event_id);

ALTER TABLE ONLY public.wiki_source_items
    ADD CONSTRAINT wiki_source_items_pkey PRIMARY KEY (tenant_id, owner_actor_id, source_key);

ALTER TABLE ONLY public.wiki_source_skips
    ADD CONSTRAINT wiki_source_skips_pkey PRIMARY KEY (tenant_id, owner_actor_id, source_key);

ALTER TABLE ONLY public.work_item_access_grants
    ADD CONSTRAINT work_item_access_grants_pkey PRIMARY KEY (work_item_id, actor_id);

ALTER TABLE ONLY public.work_item_activities
    ADD CONSTRAINT work_item_activities_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.work_item_assignments
    ADD CONSTRAINT work_item_assignments_pkey PRIMARY KEY (work_item_id, actor_id);

ALTER TABLE ONLY public.work_item_comment_references
    ADD CONSTRAINT work_item_comment_references_pkey PRIMARY KEY (comment_id, actor_id);

ALTER TABLE ONLY public.work_item_comments
    ADD CONSTRAINT work_item_comments_id_work_item_id_tenant_id_key UNIQUE (id, work_item_id, tenant_id);

ALTER TABLE ONLY public.work_item_comments
    ADD CONSTRAINT work_item_comments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.work_item_description_references
    ADD CONSTRAINT work_item_description_references_pkey PRIMARY KEY (work_item_id, actor_id);

ALTER TABLE ONLY public.work_item_description_references
    ADD CONSTRAINT work_item_description_references_work_item_id_ordinal_key UNIQUE (work_item_id, ordinal);

ALTER TABLE ONLY public.work_item_room_links
    ADD CONSTRAINT work_item_room_links_pkey PRIMARY KEY (work_item_id, link_type);

ALTER TABLE ONLY public.work_items
    ADD CONSTRAINT work_items_id_tenant_id_key UNIQUE (id, tenant_id);

ALTER TABLE ONLY public.work_items
    ADD CONSTRAINT work_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.work_items
    ADD CONSTRAINT work_items_tenant_id_number_key UNIQUE (tenant_id, number);

CREATE INDEX memory_index_chunks_fts_idx ON memory_index.chunks USING gin (search_tsv);

CREATE INDEX memory_index_chunks_scope_idx ON memory_index.chunks USING btree (tenant_id, owner_id, agent_id, source_id, chunk_no);

CREATE INDEX memory_index_session_facts_fts_idx ON memory_index.session_facts USING gin (search_tsv);

CREATE INDEX memory_index_session_facts_scope_idx ON memory_index.session_facts USING btree (tenant_id, owner_id, agent_id, source_id);

CREATE INDEX memory_index_session_facts_time_idx ON memory_index.session_facts USING btree (tenant_id, owner_id, agent_id, occurred_start, occurred_end);

CREATE INDEX memory_index_source_versions_scope_idx ON memory_index.source_versions USING btree (source_id, created_at DESC);

CREATE INDEX memory_index_sources_kind_idx ON memory_index.sources USING btree (tenant_id, owner_id, agent_id, origin_kind, source_kind) WHERE (state = 'active'::text);

CREATE INDEX memory_index_sources_room_idx ON memory_index.sources USING btree (tenant_id, room_id) WHERE (room_id IS NOT NULL);

CREATE INDEX memory_index_sources_scope_idx ON memory_index.sources USING btree (tenant_id, owner_id, agent_id, id);

CREATE INDEX tracking_items_owner_idx ON memory_index.tracking_items USING btree (tenant_id, owner_actor_id, due_at);

CREATE UNIQUE INDEX accounts_email_lower_key ON public.accounts USING btree (lower(email));

CREATE UNIQUE INDEX actors_one_human_per_account ON public.actors USING btree (account_id) WHERE (kind = 'human'::text);

CREATE INDEX agent_access_credentials_agent_idx ON public.agent_access_credentials USING btree (agent_actor_id, created_at);

CREATE INDEX agent_access_credentials_management_idx ON public.agent_access_credentials USING btree (agent_management_id) WHERE ((assignment_revision IS NOT NULL) AND (expires_at IS NULL));

CREATE INDEX agent_execution_contexts_agent_idx ON public.agent_execution_contexts USING btree (agent_management_id, context_key);

CREATE INDEX agent_execution_contexts_claim_idx ON public.agent_execution_contexts USING btree (created_at, context_key) WHERE (terminal_reason IS NULL);

CREATE UNIQUE INDEX agent_execution_contexts_one_document_idx ON public.agent_execution_contexts USING btree (agent_actor_id, document_id) WHERE (context_kind = 'document'::text);

CREATE UNIQUE INDEX agent_execution_contexts_one_per_room_meta_idx ON public.agent_execution_contexts USING btree (agent_actor_id, room_id) WHERE ((context_kind = 'meta'::text) AND (room_id IS NOT NULL));

CREATE UNIQUE INDEX agent_execution_contexts_one_task_idx ON public.agent_execution_contexts USING btree (agent_actor_id, task_id) WHERE (context_kind = 'alter_ego'::text);

CREATE INDEX agent_local_run_inputs_response_watch_idx ON public.agent_local_run_inputs USING btree (context_key, input_id);

CREATE UNIQUE INDEX agent_local_runs_one_running_idx ON public.agent_local_runs USING btree (context_key) WHERE (status = 'running'::text);

CREATE INDEX agent_local_runs_queue_idx ON public.agent_local_runs USING btree (context_key, created_at, run_id) WHERE (status = 'queued'::text);

CREATE INDEX agent_local_runs_recent_context_idx ON public.agent_local_runs USING btree (context_key, created_at DESC, run_id DESC);

CREATE INDEX agent_local_runs_status_room_idx ON public.agent_local_runs USING btree (status_room_id, created_at, run_id) WHERE (status_room_id IS NOT NULL);

CREATE INDEX agent_presentation_sequence_due_idx ON public.agent_presentation_sequence_items USING btree (not_before, sequence_id, "position") WHERE (delivered_at IS NULL);

CREATE INDEX agent_presentation_sequence_items_delivered_message_idx ON public.agent_presentation_sequence_items USING btree (delivered_message_id) WHERE (delivered_message_id IS NOT NULL);

CREATE INDEX agent_presentation_sequences_local_run_idx ON public.agent_presentation_sequences USING btree (local_run_id) WHERE (local_run_id IS NOT NULL);

CREATE UNIQUE INDEX agent_registrations_one_another_me_per_human ON public.agent_registrations USING btree (tenant_id, represented_human_actor_id) WHERE ((agent_type = 'anotherme'::text) AND (status <> 'revoked'::text));

CREATE INDEX agent_registrations_tenant_created_idx ON public.agent_registrations USING btree (tenant_id, created_at, actor_id);

CREATE INDEX agent_runtime_inputs_direct_run_idx ON public.agent_runtime_inputs USING btree (context_key, local_run_id) WHERE (local_run_id IS NOT NULL);

CREATE UNIQUE INDEX agent_runtime_inputs_document_comment_key ON public.agent_runtime_inputs USING btree (context_key, source_message_id) WHERE ((source_kind = 'inbox'::text) AND (source_inbox_id ~~ 'document:%'::text));

CREATE INDEX agent_runtime_inputs_inbox_source_idx ON public.agent_runtime_inputs USING btree (source_message_id) WHERE (source_kind = 'inbox'::text);

CREATE INDEX agent_runtime_inputs_response_watch_idx ON public.agent_runtime_inputs USING btree (context_key, created_at);

CREATE INDEX agent_runtime_inputs_steer_idx ON public.agent_runtime_inputs USING btree (context_key, steer_group_id, input_sequence) WHERE (status = 'steering'::text);

CREATE INDEX agent_runtime_inputs_waiting_idx ON public.agent_runtime_inputs USING btree (context_key, input_sequence) WHERE (status = 'waiting'::text);

CREATE INDEX agent_runtime_status_events_activity_idx ON public.agent_runtime_status_events USING btree (local_run_id, activity_id, event_ordinal) WHERE (activity_id IS NOT NULL);

CREATE INDEX agent_runtime_status_events_message_idx ON public.agent_runtime_status_events USING btree (message_id, local_run_id, event_ordinal) WHERE (message_id IS NOT NULL);

CREATE UNIQUE INDEX agent_runtime_status_events_output_idx ON public.agent_runtime_status_events USING btree (local_run_id, ((payload ->> 'output_id'::text))) WHERE (event_type = 'presentation.output_created'::text);

CREATE UNIQUE INDEX agent_service_epochs_single ON public.agent_service_epochs USING btree ((true));

CREATE INDEX agent_skill_bindings_agent_idx ON public.agent_skill_bindings USING btree (agent_actor_id, skill_id);

CREATE INDEX agent_templates_listing_idx ON public.agent_templates USING btree (origin, created_at DESC);

CREATE INDEX agent_templates_publisher_idx ON public.agent_templates USING btree (published_by_actor_id);

CREATE INDEX auth_sessions_account_id_idx ON public.auth_sessions USING btree (account_id);

CREATE UNIQUE INDEX capture_media_outputs_final_idx ON public.capture_media_outputs USING btree (capture_session_id) WHERE (purpose = 'final'::text);

CREATE INDEX capture_media_ranges_timeline_idx ON public.capture_media_ranges USING btree (capture_session_id, start_offset_ms, end_offset_ms, id);

CREATE UNIQUE INDEX capture_sessions_active_voice_idx ON public.capture_sessions USING btree (voice_session_id) WHERE (status = ANY (ARRAY['starting'::text, 'recording'::text, 'finalizing'::text]));

CREATE INDEX capture_sessions_room_created_idx ON public.capture_sessions USING btree (room_id, created_at DESC, id);

CREATE INDEX capture_sessions_voice_session_idx ON public.capture_sessions USING btree (voice_session_id);

CREATE INDEX capture_transcript_coverage_session_range_idx ON public.capture_transcript_coverage USING btree (session_id, start_offset_ms, end_offset_ms);

CREATE INDEX command_replays_credential_idx ON public.command_replays USING btree (credential_id) WHERE (credential_id IS NOT NULL);

CREATE UNIQUE INDEX command_replays_invocation_idx ON public.command_replays USING btree (scope, invocation_id) WHERE (invocation_id IS NOT NULL);

CREATE INDEX command_replays_operation_resource_id_idx ON public.command_replays USING btree (operation, resource_id);

CREATE INDEX decisions_alter_ego_task_idx ON public.decisions USING btree (alter_ego_task_id) WHERE (alter_ego_task_id IS NOT NULL);

CREATE UNIQUE INDEX decisions_document_access_room_idx ON public.decisions USING btree (((request ->> 'access_request_id'::text)), room_id) WHERE (kind = 'document_access'::text);

CREATE INDEX decisions_open_connection_auth_idx ON public.decisions USING btree (decided_at, id) WHERE ((kind = 'connection_auth'::text) AND (status = ANY (ARRAY['pending'::text, 'authorizing'::text])));

CREATE INDEX decisions_pending_requester_idx ON public.decisions USING btree (requested_by_actor_id) WHERE (status = 'pending'::text);

CREATE INDEX decisions_pending_runtime_run_idx ON public.decisions USING btree ((((request -> 'runtime'::text) ->> 'execution_run_ref'::text))) WHERE ((status = 'pending'::text) AND (request ? 'runtime'::text));

CREATE UNIQUE INDEX decisions_room_creation_submission_idx ON public.decisions USING btree (requested_by_actor_id, ((request ->> 'submission_id'::text))) WHERE (kind = 'room_creation'::text);

CREATE INDEX decisions_runtime_permission_action_idx ON public.decisions USING btree (((request ->> 'context_key'::text)), ((request ->> 'action_digest'::text))) WHERE (kind = 'runtime_permission'::text);

CREATE INDEX document_assets_document_status_idx ON public.document_assets USING btree (document_id, status, id);

CREATE INDEX document_assets_tenant_status_idx ON public.document_assets USING btree (tenant_id, status, document_id, id);

CREATE INDEX document_bindings_room_list_idx ON public.document_context_bindings USING btree (room_id, document_id) WHERE ((status = 'active'::text) AND (binding_kind = 'room'::text));

CREATE INDEX document_bindings_task_list_idx ON public.document_context_bindings USING btree (work_item_id, document_id) WHERE ((status = 'active'::text) AND (binding_kind = 'task'::text));

CREATE INDEX document_bindings_tenant_task_list_idx ON public.document_context_bindings USING btree (tenant_id, document_id) WHERE ((status = 'active'::text) AND (binding_kind = 'task'::text));

CREATE INDEX document_bindings_wiki_list_idx ON public.document_context_bindings USING btree (wiki_id, document_id) WHERE ((status = 'active'::text) AND (binding_kind = ANY (ARRAY['wiki_source'::text, 'wiki_page'::text])));

CREATE INDEX document_bodies_updated_at_idx ON public.document_bodies USING btree (updated_at);

CREATE UNIQUE INDEX document_context_bindings_active_room_key ON public.document_context_bindings USING btree (document_id, room_id) WHERE ((binding_kind = 'room'::text) AND (status = 'active'::text));

CREATE UNIQUE INDEX document_context_bindings_active_task_key ON public.document_context_bindings USING btree (document_id, work_item_id) WHERE ((binding_kind = 'task'::text) AND (status = 'active'::text));

CREATE UNIQUE INDEX document_context_bindings_active_wiki_key ON public.document_context_bindings USING btree (document_id, binding_kind, wiki_id) WHERE ((binding_kind = ANY (ARRAY['wiki_source'::text, 'wiki_page'::text])) AND (status = 'active'::text));

CREATE UNIQUE INDEX document_direct_collaborators_active_target_idx ON public.document_direct_collaborators USING btree (document_id, target_actor_id) WHERE (status = 'active'::text);

CREATE INDEX document_direct_collaborators_target_idx ON public.document_direct_collaborators USING btree (target_actor_id, document_id) WHERE (status = 'active'::text);

CREATE INDEX document_events_occurred_at_idx ON public.document_events USING btree (occurred_at);

CREATE INDEX document_events_tenant_cursor_idx ON public.document_events USING btree (tenant_id, occurred_at, id);

CREATE UNIQUE INDEX document_events_typed_resource_once_idx ON public.document_events USING btree (tenant_id, event_type, resource_kind, resource_id) WHERE (resource_kind = ANY (ARRAY['document'::text, 'document_version'::text, 'agent_create_command'::text, 'publication_item'::text, 'duplicate_provenance'::text, 'metadata_command'::text, 'autosave_batch'::text, 'semantic_mutation'::text, 'wiki_page_result'::text, 'title_command'::text, 'access_epoch'::text]));

CREATE UNIQUE INDEX document_lifecycle_terminal_event_once ON public.document_events USING btree (tenant_id, event_type, resource_id) WHERE (event_type = ANY (ARRAY['document.trashed'::text, 'document.restored'::text]));

CREATE UNIQUE INDEX document_placements_active_folder_name_key ON public.document_placements USING btree (tenant_id, scope_kind, owner_human_actor_id, COALESCE(wiki_id, ''::text), COALESCE(parent_id, ''::text), lower(name)) WHERE ((node_kind = 'folder'::text) AND (deleted_at IS NULL) AND (scope_kind <> 'shared'::text));

CREATE UNIQUE INDEX document_placements_active_personal_document_key ON public.document_placements USING btree (owner_human_actor_id, document_id) WHERE ((scope_kind = 'personal'::text) AND (node_kind = 'document'::text) AND (deleted_at IS NULL));

CREATE UNIQUE INDEX document_placements_active_wiki_document_key ON public.document_placements USING btree (wiki_id, document_id) WHERE ((scope_kind = 'wiki'::text) AND (node_kind = 'document'::text) AND (deleted_at IS NULL));

CREATE INDEX document_placements_personal_list_idx ON public.document_placements USING btree (owner_human_actor_id, document_id) WHERE ((scope_kind = 'personal'::text) AND (node_kind = 'document'::text) AND (deleted_at IS NULL));

CREATE UNIQUE INDEX document_placements_shared_document_key ON public.document_placements USING btree (owner_human_actor_id, document_id) WHERE ((scope_kind = 'shared'::text) AND (node_kind = 'document'::text));

CREATE INDEX document_placements_tree_idx ON public.document_placements USING btree (tenant_id, scope_kind, owner_human_actor_id, wiki_id, parent_id, sort_key, id) WHERE (deleted_at IS NULL);

CREATE INDEX document_recent_opens_recent_idx ON public.document_recent_opens USING btree (tenant_id, last_opened_at DESC, document_id);

CREATE INDEX document_revisions_head_idx ON public.document_revisions USING btree (document_id, persisted_seq DESC, id);

CREATE INDEX document_revisions_history_idx ON public.document_revisions USING btree (document_id, persisted_seq DESC, history_recorded_at DESC, id DESC) WHERE (history_trigger IS NOT NULL);

CREATE UNIQUE INDEX document_versions_revision_export_key ON public.document_versions USING btree (document_id, source_revision_id, representation_format, exporter_schema_version, sha256) WHERE (source_revision_id IS NOT NULL);

CREATE INDEX document_wiki_refreshes_latest_for_wiki ON public.document_wiki_refreshes USING btree (wiki_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX document_wiki_refreshes_one_active ON public.document_wiki_refreshes USING btree (wiki_id) WHERE (status = 'staging'::text);

CREATE INDEX documents_agent_list_owner_idx ON public.documents USING btree (tenant_id, owner_actor_id, id) WHERE (status = 'active'::text);

CREATE UNIQUE INDEX documents_link_share_id_key ON public.documents USING btree (link_share_id) WHERE (link_share_id IS NOT NULL);

CREATE UNIQUE INDEX documents_link_share_token_sha256_key ON public.documents USING btree (link_share_token_sha256) WHERE (link_share_token_sha256 IS NOT NULL);

CREATE INDEX documents_owner_idx ON public.documents USING btree (tenant_id, owner_actor_id, updated_at DESC, id) WHERE (status = 'active'::text);

CREATE INDEX documents_tenant_updated_idx ON public.documents USING btree (tenant_id, updated_at DESC, id);

CREATE INDEX external_connection_agent_grants_agent_active_idx ON public.external_connection_agent_grants USING btree (agent_actor_id, connection_id) WHERE (status = 'active'::text);

CREATE UNIQUE INDEX external_connections_account_app_principal_idx ON public.external_connections USING btree (account_id, provider, remote_principal_key) WHERE ((remote_principal_key IS NOT NULL) AND (status <> 'revoked'::text));

CREATE INDEX external_connections_account_provider_idx ON public.external_connections USING btree (account_id, provider, created_at DESC);

CREATE UNIQUE INDEX external_connections_reauthorization_upstream_idx ON public.external_connections USING btree (reauthorization_upstream_id) WHERE (reauthorization_upstream_id IS NOT NULL);

CREATE INDEX external_mail_import_documents_order ON public.external_mail_import_documents USING btree (connection_id, ordinal);

CREATE INDEX local_computer_enrollments_expiry_idx ON public.local_computer_enrollments USING btree (expires_at) WHERE (exchanged_at IS NULL);

CREATE UNIQUE INDEX local_computers_daemon_id_idx ON public.local_computers USING btree (daemon_id) WHERE (daemon_id IS NOT NULL);

CREATE INDEX local_computers_owner_idx ON public.local_computers USING btree (owner_tenant_id, owner_actor_id, computer_id);

CREATE INDEX message_cards_work_item_idx ON public.message_cards USING btree (work_item_id, message_id);

CREATE INDEX message_reactions_message_order_idx ON public.message_reactions USING btree (message_id, created_at, reaction_id, actor_id);

CREATE INDEX messages_card_context_idx ON public.messages USING btree (card_context_message_id) WHERE (card_context_message_id IS NOT NULL);

CREATE INDEX messages_local_run_idx ON public.messages USING btree (local_run_id) WHERE (local_run_id IS NOT NULL);

CREATE INDEX messages_reply_to_idx ON public.messages USING btree (reply_to_message_id) WHERE (reply_to_message_id IS NOT NULL);

CREATE INDEX messages_room_conversation_author_idx ON public.messages USING btree (room_id, author_actor_id) WHERE ((message_kind = 'conversation'::text) AND (room_seq IS NOT NULL));

CREATE INDEX messages_room_created_idx ON public.messages USING btree (room_id, created_at, id);

CREATE INDEX messages_room_mention_seq_idx ON public.messages USING btree (room_id, room_seq) INCLUDE (mentioned_actor_ids) WHERE (mentioned_actor_ids <> '{}'::text[]);

CREATE INDEX personal_insights_current_owner_idx ON public.personal_insights USING btree (tenant_id, owner_actor_id, created_at, id) WHERE (dismissed_at IS NULL);

CREATE INDEX personal_profile_generations_owner_idx ON public.personal_profile_generations USING btree (tenant_id, owner_actor_id, created_at DESC, id);

CREATE UNIQUE INDEX personal_wikis_active_owner_key ON public.personal_wikis USING btree (tenant_id, owner_actor_id) WHERE (deleted_at IS NULL);

CREATE INDEX proactive_outputs_owner_idx ON public.proactive_outputs USING btree (tenant_id, owner_actor_id, created_at);

CREATE INDEX proactive_pending_wakes_room_idx ON public.proactive_pending_wakes USING btree (room_id, created_at, id);

CREATE INDEX proactive_potential_items_owner_idx ON public.proactive_potential_items USING btree (tenant_id, owner_actor_id, created_at);

CREATE INDEX river_job_args_index ON public.river_job USING gin (args);

CREATE INDEX river_job_kind ON public.river_job USING btree (kind);

CREATE INDEX river_job_metadata_index ON public.river_job USING gin (metadata);

CREATE INDEX river_job_prioritized_fetching_index ON public.river_job USING btree (state, queue, priority, scheduled_at, id);

CREATE INDEX river_job_state_and_finalized_at_index ON public.river_job USING btree (state, finalized_at) WHERE (finalized_at IS NOT NULL);

CREATE UNIQUE INDEX river_job_unique_idx ON public.river_job USING btree (unique_key) WHERE ((unique_key IS NOT NULL) AND (unique_states IS NOT NULL) AND public.river_job_state_in_bitmask(unique_states, state));

CREATE INDEX river_notification_created_at_idx ON public.river_notification USING btree (created_at);

CREATE INDEX river_notification_topic_id_idx ON public.river_notification USING btree (topic, id);

CREATE INDEX room_document_comment_reactions_thread_idx ON public.room_document_comment_reactions USING btree (thread_id, comment_id, emoji, actor_id);

CREATE INDEX room_document_comment_threads_document_idx ON public.room_document_comment_threads USING btree (document_id, created_at, id);

CREATE INDEX room_document_comments_thread_idx ON public.room_document_comments USING btree (thread_id, created_at, id);

CREATE INDEX room_events_document_comment_idx ON public.room_events USING btree (((payload ->> 'comment_id'::text))) WHERE (event_type = 'document.comment.changed'::text);

CREATE INDEX room_events_history_message_source_idx ON public.room_events USING btree (tenant_id, room_id, resource_id) INCLUDE (room_seq) WHERE (event_type = 'message.created'::text);

CREATE INDEX room_events_resource_type_idx ON public.room_events USING btree (resource_id, occurred_at DESC, room_seq DESC) WHERE (event_type = 'work_item.changed'::text);

CREATE INDEX room_events_room_seq_idx ON public.room_events USING btree (room_id, room_seq);

CREATE INDEX room_events_tenant_projection_membership_seq_idx ON public.room_events USING btree (room_id, room_seq DESC) WHERE (event_type = ANY (ARRAY['room.member.added'::text, 'room.member.role_changed'::text, 'room.member.removed'::text]));

CREATE INDEX room_events_tenant_projection_message_seq_idx ON public.room_events USING btree (room_id, room_seq DESC) INCLUDE (resource_id) WHERE (event_type = 'message.created'::text);

CREATE INDEX room_history_shares_room_idx ON public.room_history_shares USING btree (room_id, created_at DESC);

CREATE INDEX room_members_actor_room_idx ON public.room_members USING btree (actor_id, room_id);

CREATE UNIQUE INDEX room_members_membership_epoch_id_key ON public.room_members USING btree (membership_epoch_id);

CREATE INDEX room_members_room_joined_idx ON public.room_members USING btree (room_id, joined_at, actor_id);

CREATE INDEX room_reminders_due_idx ON public.room_reminders USING btree (next_run_at, id) WHERE (enabled AND (next_run_at IS NOT NULL));

CREATE INDEX room_reminders_room_created_idx ON public.room_reminders USING btree (room_id, created_at DESC, id DESC);

CREATE INDEX room_reminders_tracking_item_idx ON public.room_reminders USING btree (tracking_item_id) WHERE (tracking_item_id IS NOT NULL);

CREATE INDEX room_routine_listeners_poll_due_idx ON public.room_routine_listeners USING btree (poll_next_at) WHERE (poll_next_at IS NOT NULL);

CREATE INDEX room_routine_listeners_routine_idx ON public.room_routine_listeners USING btree (routine_id);

CREATE INDEX rooms_active_tenant_created_idx ON public.rooms USING btree (tenant_id, created_at, id) WHERE (deletion_started_at IS NULL);

CREATE INDEX rooms_direct_agent_idx ON public.rooms USING btree (direct_agent_actor_id) WHERE (direct_agent_actor_id IS NOT NULL);

CREATE UNIQUE INDEX rooms_direct_pair_key ON public.rooms USING btree (tenant_id, direct_human_actor_id, direct_agent_actor_id) WHERE (direct_agent_actor_id IS NOT NULL);

CREATE INDEX rooms_tenant_created_idx ON public.rooms USING btree (tenant_id, created_at, id);

CREATE UNIQUE INDEX rooms_thread_root_key ON public.rooms USING btree (parent_room_id, root_message_id) WHERE (parent_room_id IS NOT NULL);

CREATE INDEX routine_event_deliveries_created_idx ON public.routine_event_deliveries USING btree (created_at);

CREATE INDEX skills_owner_catalog_idx ON public.skills USING btree (tenant_id, owner_actor_id, skill_id) WHERE (access_scope = 'owner'::text);

CREATE INDEX skills_tenant_catalog_idx ON public.skills USING btree (tenant_id, skill_id) WHERE (owner_kind = 'tenant'::text);

CREATE UNIQUE INDEX task_attempts_single_active_idx ON public.task_attempts USING btree (task_id, generation) WHERE (status = ANY (ARRAY['materializing'::text, 'ready'::text, 'running'::text, 'checking'::text]));

CREATE INDEX task_effects_dispatch_idx ON public.task_effects USING btree (status, created_at, id) WHERE (status = ANY (ARRAY['pending'::text, 'dispatching'::text]));

CREATE UNIQUE INDEX task_effects_single_live_root_idx ON public.task_effects USING btree (task_id, generation, root_operation_id) WHERE (status = ANY (ARRAY['pending'::text, 'dispatching'::text]));

CREATE INDEX task_effects_task_idx ON public.task_effects USING btree (task_id, generation, created_at, id);

CREATE UNIQUE INDEX task_execution_facts_control_witness_idx ON public.task_execution_facts USING btree (task_id, generation, control_revision) WHERE (control_revision IS NOT NULL);

CREATE UNIQUE INDEX task_execution_facts_source_operation_witness_idx ON public.task_execution_facts USING btree (task_id, generation, source_operation_id) WHERE (source_operation_id IS NOT NULL);

CREATE INDEX task_execution_facts_task_idx ON public.task_execution_facts USING btree (task_id, generation, execution_revision);

CREATE UNIQUE INDEX task_input_revisions_source_message_idx ON public.task_input_revisions USING btree (task_id, generation, source_message_id) WHERE (source_message_id IS NOT NULL);

CREATE INDEX task_meta_callback_messages_tenant_task_seq_idx ON public.task_meta_callback_messages USING btree (tenant_id, task_id, meta_seq);

CREATE INDEX task_meta_callbacks_tenant_idx ON public.task_meta_callbacks USING btree (tenant_id, task_id);

CREATE INDEX task_meta_inboxes_tenant_idx ON public.task_meta_inboxes USING btree (tenant_id, task_id, agent_actor_id);

CREATE INDEX task_meta_messages_tenant_task_agent_seq_idx ON public.task_meta_messages USING btree (tenant_id, task_id, agent_actor_id, meta_seq);

CREATE INDEX voice_capture_questions_capture_created_idx ON public.voice_capture_questions USING btree (capture_session_id, created_at, id);

CREATE INDEX voice_live_confirmations_lookup_idx ON public.voice_live_confirmations USING btree (voice_session_id, tool, arguments_hash);

CREATE INDEX voice_live_tasks_session_idx ON public.voice_live_tasks USING btree (voice_session_id);

CREATE INDEX voice_media_epochs_reconcile_idx ON public.voice_media_epochs USING btree (updated_at, id) WHERE (observed_state = ANY (ARRAY['requested'::text, 'active'::text, 'sealing'::text, 'unknown'::text]));

CREATE UNIQUE INDEX voice_media_epochs_staging_prefix_idx ON public.voice_media_epochs USING btree (staging_prefix);

CREATE INDEX voice_media_epochs_voice_session_idx ON public.voice_media_epochs USING btree (voice_session_id);

CREATE UNIQUE INDEX voice_sessions_active_auth_session_idx ON public.voice_sessions USING btree (auth_session_id) WHERE (status = ANY (ARRAY['provisioning'::text, 'connected'::text, 'reconnecting'::text, 'closing'::text]));

CREATE UNIQUE INDEX voice_sessions_live_foreground_idx ON public.voice_sessions USING btree (tenant_id, live_agent_actor_id, room_id) WHERE ((purpose = 'chat_live'::text) AND (status = ANY (ARRAY['provisioning'::text, 'connected'::text, 'reconnecting'::text])));

CREATE INDEX voice_sessions_room_created_idx ON public.voice_sessions USING btree (room_id, created_at DESC, id);

CREATE INDEX voice_transcript_segments_capture_offset_idx ON public.voice_transcript_segments USING btree (capture_session_id, start_offset_ms, end_offset_ms, id) WHERE (capture_session_id IS NOT NULL);

CREATE UNIQUE INDEX voice_transcript_segments_dictation_window_idx ON public.voice_transcript_segments USING btree (voice_session_id, media_epoch, start_offset_ms, end_offset_ms) WHERE (kind = 'dictation_turn'::text);

CREATE UNIQUE INDEX voice_transcript_segments_session_seq_idx ON public.voice_transcript_segments USING btree (voice_session_id, seq);

CREATE INDEX voice_transcript_segments_session_timeline_idx ON public.voice_transcript_segments USING btree (voice_session_id, media_epoch, start_offset_ms, end_offset_ms, id);

CREATE UNIQUE INDEX voice_transcript_segments_speech_window_idx ON public.voice_transcript_segments USING btree (voice_session_id, media_epoch, start_offset_ms, end_offset_ms) WHERE ((lane = 'live'::text) AND (kind <> 'dictation_turn'::text));

CREATE INDEX wiki_source_items_document ON public.wiki_source_items USING btree (tenant_id, document_id);

CREATE INDEX wiki_source_skips_recent ON public.wiki_source_skips USING btree (tenant_id, owner_actor_id, skipped_at DESC);

CREATE INDEX work_item_access_grants_actor_idx ON public.work_item_access_grants USING btree (actor_id, work_item_id);

CREATE INDEX work_item_activities_item_order_idx ON public.work_item_activities USING btree (work_item_id, occurred_at, id);

CREATE INDEX work_item_assignments_actor_idx ON public.work_item_assignments USING btree (actor_id, work_item_id);

CREATE INDEX work_item_comment_references_actor_idx ON public.work_item_comment_references USING btree (actor_id, work_item_id);

CREATE INDEX work_item_comments_item_order_idx ON public.work_item_comments USING btree (work_item_id, created_at, id);

CREATE INDEX work_item_description_references_actor_idx ON public.work_item_description_references USING btree (actor_id, work_item_id);

CREATE INDEX work_item_room_links_room_idx ON public.work_item_room_links USING btree (room_id, link_type, work_item_id);

CREATE UNIQUE INDEX work_item_room_links_unique_work_room_idx ON public.work_item_room_links USING btree (room_id) WHERE (link_type = 'work'::text);

CREATE INDEX work_items_task_cleanup_claim_idx ON public.work_items USING btree (task_next_reconcile_at, task_lease_expires_at, id) WHERE ((task_execution_generation IS NOT NULL) AND (task_execution_status <> 'running'::text));

CREATE INDEX work_items_task_execution_claim_idx ON public.work_items USING btree (task_next_reconcile_at, task_lease_expires_at, id) WHERE ((task_execution_generation IS NOT NULL) AND (task_execution_status = 'running'::text));

CREATE UNIQUE INDEX work_items_task_source_key_idx ON public.work_items USING btree (tenant_id, task_source_key) WHERE (task_source_key IS NOT NULL);

CREATE INDEX work_items_tenant_active_updated_idx ON public.work_items USING btree (tenant_id, updated_at DESC, id DESC) WHERE (archived_at IS NULL);

CREATE INDEX work_items_tenant_updated_idx ON public.work_items USING btree (tenant_id, updated_at DESC, id DESC);

CREATE TRIGGER agent_execution_contexts_notify_teamhub_changed AFTER INSERT OR UPDATE ON public.agent_execution_contexts FOR EACH ROW EXECUTE FUNCTION public.notify_teamhub_agent_context_changed();

CREATE TRIGGER agent_local_runs_task_due_on_terminal AFTER UPDATE OF status ON public.agent_local_runs FOR EACH ROW WHEN (((old.status = ANY (ARRAY['queued'::text, 'running'::text])) AND (new.status = ANY (ARRAY['succeeded'::text, 'failed'::text, 'canceled'::text])))) EXECUTE FUNCTION public.enqueue_task_due_on_participant_run_terminal();

CREATE TRIGGER agent_registration_user_artifact_owner_initialize BEFORE INSERT OR UPDATE OF agent_type, represented_human_actor_id, user_artifact_owner_actor_id ON public.agent_registrations FOR EACH ROW EXECUTE FUNCTION public.initialize_agent_user_artifact_owner();

CREATE TRIGGER agent_runtime_status_event_guard BEFORE DELETE OR UPDATE ON public.agent_runtime_status_events FOR EACH ROW EXECUTE FUNCTION public.protect_agent_runtime_status_event();

CREATE TRIGGER agent_skill_binding_identity_guard BEFORE DELETE OR UPDATE ON public.agent_skill_bindings FOR EACH ROW EXECUTE FUNCTION public.protect_agent_skill_binding_identity();

CREATE TRIGGER agent_skill_binding_policy_lock BEFORE INSERT OR DELETE OR UPDATE ON public.agent_skill_bindings FOR EACH STATEMENT EXECUTE FUNCTION public.lock_agent_skill_binding_policy();

CREATE TRIGGER agent_skill_binding_tenant_guard BEFORE INSERT OR UPDATE ON public.agent_skill_bindings FOR EACH ROW EXECUTE FUNCTION public.protect_agent_skill_binding_tenant();

CREATE TRIGGER document_asset_identity_guard BEFORE UPDATE ON public.document_assets FOR EACH ROW EXECUTE FUNCTION public.protect_document_asset_identity();

CREATE TRIGGER document_body_comment_threads AFTER UPDATE OF thread_ids ON public.document_bodies FOR EACH ROW WHEN ((old.thread_ids IS DISTINCT FROM new.thread_ids)) EXECUTE FUNCTION public.reconcile_document_body_comment_threads();

CREATE TRIGGER document_context_binding_identity_guard BEFORE UPDATE ON public.document_context_bindings FOR EACH ROW EXECUTE FUNCTION public.protect_document_context_binding_identity();

CREATE TRIGGER document_event_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.document_events FOR EACH ROW EXECUTE FUNCTION public.protect_document_event();

CREATE TRIGGER document_events_notify_teamhub_invalidation AFTER INSERT ON public.document_events FOR EACH ROW EXECUTE FUNCTION public.notify_teamhub_document_invalidation();

CREATE TRIGGER document_identity_guard BEFORE INSERT OR DELETE OR UPDATE ON public.documents FOR EACH ROW EXECUTE FUNCTION public.protect_document_identity();

CREATE TRIGGER document_native_representation_format_guard BEFORE UPDATE OF native_representation_format ON public.documents FOR EACH ROW EXECUTE FUNCTION public.protect_native_document_representation_format();

CREATE TRIGGER document_placement_tree_guard BEFORE INSERT OR UPDATE ON public.document_placements FOR EACH ROW EXECUTE FUNCTION public.enforce_document_placement_tree();

CREATE TRIGGER document_revision_immutable BEFORE DELETE OR UPDATE ON public.document_revisions FOR EACH ROW EXECUTE FUNCTION public.protect_document_revision();

CREATE TRIGGER document_text_queue AFTER INSERT ON public.document_bodies FOR EACH ROW EXECUTE FUNCTION public.queue_document_text_for_body();

CREATE TRIGGER document_text_queue AFTER INSERT OR UPDATE OF status, current_version_id ON public.documents FOR EACH ROW EXECUTE FUNCTION public.queue_document_text_for_document();

CREATE TRIGGER document_version_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.document_versions FOR EACH ROW EXECUTE FUNCTION public.protect_document_version();

CREATE TRIGGER document_wiki_page_identity_guard BEFORE INSERT OR DELETE OR UPDATE ON public.document_wiki_pages FOR EACH ROW EXECUTE FUNCTION public.protect_document_wiki_revision_identity();

CREATE TRIGGER documents_create_permission_count AFTER INSERT ON public.documents FOR EACH ROW EXECUTE FUNCTION public.create_document_permission_count();

CREATE TRIGGER river_job_due_insert_wake AFTER INSERT ON public.river_job FOR EACH ROW WHEN (((new.state = ANY (ARRAY['available'::public.river_job_state, 'scheduled'::public.river_job_state])) AND ((new.scheduled_at > (now() + '00:00:01'::interval)) OR (new.queue <> 'maintenance'::text)))) EXECUTE FUNCTION public.notify_teamhub_river_due();

CREATE TRIGGER river_job_due_update_wake AFTER UPDATE OF state, scheduled_at ON public.river_job FOR EACH ROW WHEN (((new.state = ANY (ARRAY['available'::public.river_job_state, 'scheduled'::public.river_job_state, 'retryable'::public.river_job_state])) AND ((old.state IS DISTINCT FROM new.state) OR (old.scheduled_at IS DISTINCT FROM new.scheduled_at)))) EXECUTE FUNCTION public.notify_teamhub_river_due();

CREATE TRIGGER river_job_finish_wake AFTER UPDATE OF state ON public.river_job FOR EACH ROW WHEN (((old.state = 'running'::public.river_job_state) AND (new.state = ANY (ARRAY['completed'::public.river_job_state, 'cancelled'::public.river_job_state, 'discarded'::public.river_job_state])) AND (new.queue <> 'maintenance'::text))) EXECUTE FUNCTION public.notify_teamhub_river_due();

CREATE TRIGGER room_events_notify_teamhub_realtime AFTER INSERT ON public.room_events FOR EACH ROW EXECUTE FUNCTION public.notify_teamhub_room_event();

CREATE CONSTRAINT TRIGGER room_events_queue_agent_inputs AFTER INSERT ON public.room_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.event_type = 'message.created'::text)) EXECUTE FUNCTION public.queue_room_message_agent_inputs();

CREATE TRIGGER room_member_write_lock_order BEFORE INSERT OR DELETE ON public.room_members FOR EACH ROW EXECUTE FUNCTION public.lock_room_member_write_scope();

CREATE TRIGGER task_effect_definition_guard BEFORE UPDATE ON public.task_effects FOR EACH ROW EXECUTE FUNCTION public.enforce_task_effect_definition_immutable();

CREATE TRIGGER task_effect_retry_root_guard BEFORE INSERT ON public.task_effects FOR EACH ROW EXECUTE FUNCTION public.enforce_task_effect_retry_root();

CREATE TRIGGER task_effects_cleanup_claimable_insert_wake AFTER INSERT ON public.task_effects FOR EACH ROW WHEN (((new.operation = 'cleanup_runtime'::text) AND (new.status = ANY (ARRAY['pending'::text, 'dispatching'::text])))) EXECUTE FUNCTION public.notify_teamhub_task_claimable();

CREATE TRIGGER task_effects_cleanup_claimable_update_wake AFTER UPDATE ON public.task_effects FOR EACH ROW WHEN (((new.operation = 'cleanup_runtime'::text) AND (((new.status = 'pending'::text) AND (old.status IS DISTINCT FROM 'pending'::text)) OR ((new.status = 'dispatching'::text) AND (old.lease_expires_at IS NOT NULL) AND ((new.lease_expires_at IS NULL) OR (new.lease_expires_at < old.lease_expires_at)))))) EXECUTE FUNCTION public.notify_teamhub_task_claimable();

CREATE TRIGGER task_execution_facts_immutable BEFORE DELETE OR UPDATE ON public.task_execution_facts FOR EACH ROW EXECUTE FUNCTION public.reject_task_execution_fact_mutation();

CREATE TRIGGER task_execution_generation_definition_guard BEFORE UPDATE ON public.task_execution_generations FOR EACH ROW EXECUTE FUNCTION public.enforce_task_generation_definition_immutable();

CREATE TRIGGER task_execution_participants_immutable BEFORE DELETE OR UPDATE ON public.task_execution_participants FOR EACH ROW EXECUTE FUNCTION public.reject_task_execution_fact_mutation();

CREATE TRIGGER task_input_revisions_immutable BEFORE DELETE OR UPDATE ON public.task_input_revisions FOR EACH ROW EXECUTE FUNCTION public.reject_task_execution_fact_mutation();

CREATE CONSTRAINT TRIGGER task_meta_callback_messages_queue_agent_inputs AFTER INSERT ON public.task_meta_callback_messages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.queue_task_meta_callback_agent_inputs();

CREATE TRIGGER unified_skill_access_scope_default BEFORE INSERT ON public.skills FOR EACH ROW EXECUTE FUNCTION public.default_unified_skill_access_scope();

CREATE TRIGGER unified_skill_identity_guard BEFORE DELETE OR UPDATE ON public.skills FOR EACH ROW EXECUTE FUNCTION public.protect_unified_skill_identity();

CREATE TRIGGER unified_skill_manifest_frontmatter_extra_guard BEFORE UPDATE ON public.skill_manifests FOR EACH ROW EXECUTE FUNCTION public.protect_unified_skill_frontmatter_extra();

CREATE TRIGGER unified_skill_manifest_guard BEFORE INSERT OR DELETE OR UPDATE ON public.skill_manifests FOR EACH ROW EXECUTE FUNCTION public.protect_unified_skill_manifest();

CREATE CONSTRAINT TRIGGER voice_capture_projection_event AFTER INSERT OR UPDATE ON public.capture_sessions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.publish_voice_projection_change();

CREATE CONSTRAINT TRIGGER voice_epoch_projection_event AFTER INSERT OR UPDATE ON public.voice_media_epochs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.publish_voice_projection_change();

CREATE TRIGGER voice_live_initialize BEFORE INSERT ON public.voice_sessions FOR EACH ROW EXECUTE FUNCTION public.voice_live_initialize();

CREATE TRIGGER voice_live_task_foreground AFTER INSERT ON public.voice_live_tasks FOR EACH ROW EXECUTE FUNCTION public.voice_live_task_foreground();

CREATE TRIGGER voice_live_task_state_changed AFTER UPDATE OF task_execution_status, task_execution_updated_at ON public.work_items FOR EACH ROW EXECUTE FUNCTION public.voice_live_task_state_changed();

CREATE TRIGGER voice_live_transition AFTER INSERT OR UPDATE OF status ON public.voice_sessions FOR EACH ROW EXECUTE FUNCTION public.voice_live_transition();

CREATE TRIGGER voice_partial_projection AFTER UPDATE ON public.voice_sessions FOR EACH ROW EXECUTE FUNCTION public.publish_voice_partial_change();

CREATE CONSTRAINT TRIGGER voice_range_projection_event AFTER INSERT OR DELETE OR UPDATE ON public.capture_media_ranges DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.publish_voice_projection_change();

CREATE CONSTRAINT TRIGGER voice_session_projection_event AFTER INSERT OR UPDATE ON public.voice_sessions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.publish_voice_projection_change();

CREATE CONSTRAINT TRIGGER voice_transcript_projection_event AFTER INSERT OR UPDATE ON public.voice_transcript_segments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.publish_voice_projection_change();

CREATE TRIGGER work_items_task_claimable_insert_wake AFTER INSERT ON public.work_items FOR EACH ROW WHEN ((new.task_execution_generation IS NOT NULL)) EXECUTE FUNCTION public.notify_teamhub_task_claimable();

CREATE TRIGGER work_items_task_claimable_update_wake AFTER UPDATE ON public.work_items FOR EACH ROW WHEN (((new.task_execution_generation IS NOT NULL) AND ((new.task_execution_generation IS DISTINCT FROM old.task_execution_generation) OR (new.task_execution_status IS DISTINCT FROM old.task_execution_status) OR (old.task_next_reconcile_at IS NULL) OR (GREATEST(new.task_next_reconcile_at, COALESCE(new.task_lease_expires_at, '-infinity'::timestamp with time zone)) < GREATEST(old.task_next_reconcile_at, COALESCE(old.task_lease_expires_at, '-infinity'::timestamp with time zone)))))) EXECUTE FUNCTION public.notify_teamhub_task_claimable();

CREATE TRIGGER work_items_task_execution_revision_guard BEFORE UPDATE OF task_execution_generation, task_execution_revision ON public.work_items FOR EACH ROW EXECUTE FUNCTION public.enforce_task_execution_snapshot_revision();

ALTER TABLE ONLY memory_index.chunks
    ADD CONSTRAINT chunks_tenant_id_owner_id_agent_id_source_id_fkey FOREIGN KEY (tenant_id, owner_id, agent_id, source_id) REFERENCES memory_index.sources(tenant_id, owner_id, agent_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY memory_index.sources
    ADD CONSTRAINT memory_index_sources_active_version_fkey FOREIGN KEY (id, active_sha256) REFERENCES memory_index.source_versions(source_id, sha256) DEFERRABLE INITIALLY DEFERRED NOT VALID;

ALTER TABLE ONLY memory_index.session_fact_windows
    ADD CONSTRAINT session_fact_windows_tenant_id_owner_id_agent_id_source_id_fkey FOREIGN KEY (tenant_id, owner_id, agent_id, source_id) REFERENCES memory_index.sources(tenant_id, owner_id, agent_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY memory_index.session_facts
    ADD CONSTRAINT session_facts_tenant_id_owner_id_agent_id_source_id_fkey FOREIGN KEY (tenant_id, owner_id, agent_id, source_id) REFERENCES memory_index.sources(tenant_id, owner_id, agent_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY memory_index.source_versions
    ADD CONSTRAINT source_versions_source_id_fkey FOREIGN KEY (source_id) REFERENCES memory_index.sources(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.actors
    ADD CONSTRAINT actors_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);

ALTER TABLE ONLY public.agent_access_credentials
    ADD CONSTRAINT agent_access_credentials_agent_actor_id_tenant_id_agent_ma_fkey FOREIGN KEY (agent_actor_id, tenant_id, agent_management_id) REFERENCES public.agent_registrations(actor_id, tenant_id, agent_management_id);

ALTER TABLE ONLY public.agent_context_inbox_cursors
    ADD CONSTRAINT agent_context_inbox_cursors_context_key_fkey FOREIGN KEY (context_key) REFERENCES public.agent_execution_contexts(context_key) ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_execution_contexts
    ADD CONSTRAINT agent_execution_contexts_agent_actor_id_tenant_id_agent_ma_fkey FOREIGN KEY (agent_actor_id, tenant_id, agent_management_id) REFERENCES public.agent_registrations(actor_id, tenant_id, agent_management_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_execution_contexts
    ADD CONSTRAINT agent_execution_contexts_document_fk FOREIGN KEY (document_id, tenant_id) REFERENCES public.documents(id, tenant_id);

ALTER TABLE ONLY public.agent_execution_contexts
    ADD CONSTRAINT agent_execution_contexts_room_fk FOREIGN KEY (room_id, tenant_id) REFERENCES public.rooms(id, tenant_id);

ALTER TABLE ONLY public.agent_execution_contexts
    ADD CONSTRAINT agent_execution_contexts_task_id_tenant_id_fkey FOREIGN KEY (task_id, tenant_id) REFERENCES public.work_items(id, tenant_id);

ALTER TABLE ONLY public.agent_live_handover_receipts
    ADD CONSTRAINT agent_live_handover_receipts_context_key_fkey FOREIGN KEY (context_key) REFERENCES public.agent_execution_contexts(context_key) ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_live_handover_receipts
    ADD CONSTRAINT agent_live_handover_receipts_voice_session_id_fkey FOREIGN KEY (voice_session_id) REFERENCES public.voice_sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_local_run_inputs
    ADD CONSTRAINT agent_local_run_inputs_context_key_input_id_fkey FOREIGN KEY (context_key, input_id) REFERENCES public.agent_runtime_inputs(context_key, input_id);

ALTER TABLE ONLY public.agent_local_run_inputs
    ADD CONSTRAINT agent_local_run_inputs_context_key_run_id_fkey FOREIGN KEY (context_key, run_id) REFERENCES public.agent_local_runs(context_key, run_id);

ALTER TABLE ONLY public.agent_local_run_inputs
    ADD CONSTRAINT agent_local_run_inputs_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.agent_local_runs(run_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_local_runs
    ADD CONSTRAINT agent_local_runs_context_key_fkey FOREIGN KEY (context_key) REFERENCES public.agent_execution_contexts(context_key) ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_memories
    ADD CONSTRAINT agent_memories_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agent_registrations(agent_management_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_presentation_sequence_items
    ADD CONSTRAINT agent_presentation_sequence_items_delivered_message_id_fkey FOREIGN KEY (delivered_message_id) REFERENCES public.messages(id);

ALTER TABLE ONLY public.agent_presentation_sequence_items
    ADD CONSTRAINT agent_presentation_sequence_items_sequence_id_fkey FOREIGN KEY (sequence_id) REFERENCES public.agent_presentation_sequences(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_presentation_sequences
    ADD CONSTRAINT agent_presentation_sequence_reply_target_fk FOREIGN KEY (reply_to_message_id, tenant_id, room_id) REFERENCES public.messages(id, tenant_id, room_id);

ALTER TABLE ONLY public.agent_presentation_sequences
    ADD CONSTRAINT agent_presentation_sequences_agent_actor_id_tenant_id_fkey FOREIGN KEY (agent_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_presentation_sequences
    ADD CONSTRAINT agent_presentation_sequences_local_run_id_fkey FOREIGN KEY (local_run_id) REFERENCES public.agent_local_runs(run_id);

ALTER TABLE ONLY public.agent_presentation_sequences
    ADD CONSTRAINT agent_presentation_sequences_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_registrations
    ADD CONSTRAINT agent_registrations_actor_id_tenant_id_fkey FOREIGN KEY (actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.agent_registrations
    ADD CONSTRAINT agent_registrations_created_by_actor_id_tenant_id_fkey FOREIGN KEY (created_by_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.agent_registrations
    ADD CONSTRAINT agent_registrations_represented_human_fk FOREIGN KEY (represented_human_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.agent_registrations
    ADD CONSTRAINT agent_registrations_user_artifact_owner_fk FOREIGN KEY (user_artifact_owner_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.agent_runtime_inputs
    ADD CONSTRAINT agent_runtime_inputs_context_key_fkey FOREIGN KEY (context_key) REFERENCES public.agent_execution_contexts(context_key) ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_runtime_inputs
    ADD CONSTRAINT agent_runtime_inputs_local_run_fkey FOREIGN KEY (context_key, local_run_id) REFERENCES public.agent_local_runs(context_key, run_id);

ALTER TABLE ONLY public.agent_runtime_status_events
    ADD CONSTRAINT agent_runtime_status_events_local_run_id_fkey FOREIGN KEY (local_run_id) REFERENCES public.agent_local_runs(run_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_runtime_status_events
    ADD CONSTRAINT agent_runtime_status_events_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.messages(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.agent_skill_bindings
    ADD CONSTRAINT agent_skill_bindings_agent_actor_id_tenant_id_fkey FOREIGN KEY (agent_actor_id, tenant_id) REFERENCES public.agent_registrations(actor_id, tenant_id);

ALTER TABLE ONLY public.agent_skill_bindings
    ADD CONSTRAINT agent_skill_bindings_manifest_fkey FOREIGN KEY (skill_id, manifest_version) REFERENCES public.skill_manifests(skill_id, manifest_version);

ALTER TABLE ONLY public.agent_skill_bindings
    ADD CONSTRAINT agent_skill_bindings_updated_by_actor_id_tenant_id_fkey FOREIGN KEY (updated_by_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.agent_templates
    ADD CONSTRAINT agent_templates_published_by_actor_id_fkey FOREIGN KEY (published_by_actor_id) REFERENCES public.actors(id);

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);

ALTER TABLE ONLY public.capture_media_outputs
    ADD CONSTRAINT capture_media_outputs_capture_session_id_fkey FOREIGN KEY (capture_session_id) REFERENCES public.capture_sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.capture_media_outputs
    ADD CONSTRAINT capture_media_outputs_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id);

ALTER TABLE ONLY public.capture_media_outputs
    ADD CONSTRAINT capture_media_outputs_document_version_id_fkey FOREIGN KEY (document_version_id) REFERENCES public.document_versions(id);

ALTER TABLE ONLY public.capture_media_ranges
    ADD CONSTRAINT capture_media_ranges_capture_session_id_fkey FOREIGN KEY (capture_session_id) REFERENCES public.capture_sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.capture_media_ranges
    ADD CONSTRAINT capture_media_ranges_epoch_id_fkey FOREIGN KEY (epoch_id) REFERENCES public.voice_media_epochs(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.capture_sessions
    ADD CONSTRAINT capture_sessions_created_by_actor_id_tenant_id_fkey FOREIGN KEY (created_by_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.capture_sessions
    ADD CONSTRAINT capture_sessions_document_fk FOREIGN KEY (document_id, tenant_id) REFERENCES public.documents(id, tenant_id);

ALTER TABLE ONLY public.capture_sessions
    ADD CONSTRAINT capture_sessions_document_version_fk FOREIGN KEY (document_version_id, tenant_id, document_id) REFERENCES public.document_versions(id, tenant_id, document_id);

ALTER TABLE ONLY public.capture_sessions
    ADD CONSTRAINT capture_sessions_room_id_tenant_id_fkey FOREIGN KEY (room_id, tenant_id) REFERENCES public.rooms(id, tenant_id);

ALTER TABLE ONLY public.capture_sessions
    ADD CONSTRAINT capture_sessions_source_audio_document_id_fkey FOREIGN KEY (source_audio_document_id) REFERENCES public.documents(id);

ALTER TABLE ONLY public.capture_sessions
    ADD CONSTRAINT capture_sessions_source_audio_document_version_id_fkey FOREIGN KEY (source_audio_document_version_id) REFERENCES public.document_versions(id);

ALTER TABLE ONLY public.capture_sessions
    ADD CONSTRAINT capture_sessions_transcript_document_version_fk FOREIGN KEY (transcript_document_version_id, tenant_id, transcript_document_id) REFERENCES public.document_versions(id, tenant_id, document_id);

ALTER TABLE ONLY public.capture_sessions
    ADD CONSTRAINT capture_sessions_voice_session_id_fkey FOREIGN KEY (voice_session_id) REFERENCES public.voice_sessions(id);

ALTER TABLE ONLY public.capture_transcript_coverage
    ADD CONSTRAINT capture_transcript_coverage_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.capture_sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.decisions
    ADD CONSTRAINT decisions_decided_by_actor_id_tenant_id_fkey FOREIGN KEY (decided_by_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.decisions
    ADD CONSTRAINT decisions_decider_actor_id_tenant_id_fkey FOREIGN KEY (decider_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.decisions
    ADD CONSTRAINT decisions_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.message_cards(message_id);

ALTER TABLE ONLY public.decisions
    ADD CONSTRAINT decisions_requested_by_actor_id_tenant_id_fkey FOREIGN KEY (requested_by_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.decisions
    ADD CONSTRAINT decisions_room_id_tenant_id_fkey FOREIGN KEY (room_id, tenant_id) REFERENCES public.rooms(id, tenant_id);

ALTER TABLE ONLY public.document_assets
    ADD CONSTRAINT document_assets_created_by_actor_id_tenant_id_fkey FOREIGN KEY (created_by_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.document_assets
    ADD CONSTRAINT document_assets_document_id_tenant_id_fkey FOREIGN KEY (document_id, tenant_id) REFERENCES public.documents(id, tenant_id);

ALTER TABLE ONLY public.document_bodies
    ADD CONSTRAINT document_bodies_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id);

ALTER TABLE ONLY public.document_context_bindings
    ADD CONSTRAINT document_context_bindings_document_id_tenant_id_fkey FOREIGN KEY (document_id, tenant_id) REFERENCES public.documents(id, tenant_id);

ALTER TABLE ONLY public.document_context_bindings
    ADD CONSTRAINT document_context_bindings_room_id_tenant_id_fkey FOREIGN KEY (room_id, tenant_id) REFERENCES public.rooms(id, tenant_id);

ALTER TABLE ONLY public.document_context_bindings
    ADD CONSTRAINT document_context_bindings_wiki_id_tenant_id_fkey FOREIGN KEY (wiki_id, tenant_id) REFERENCES public.personal_wikis(id, tenant_id);

ALTER TABLE ONLY public.document_context_bindings
    ADD CONSTRAINT document_context_bindings_work_item_id_tenant_id_fkey FOREIGN KEY (work_item_id, tenant_id) REFERENCES public.work_items(id, tenant_id);

ALTER TABLE ONLY public.document_direct_collaborators
    ADD CONSTRAINT document_direct_collaborators_document_id_tenant_id_fkey FOREIGN KEY (document_id, tenant_id) REFERENCES public.documents(id, tenant_id);

ALTER TABLE ONLY public.document_direct_collaborators
    ADD CONSTRAINT document_direct_collaborators_grantor_actor_id_tenant_id_fkey FOREIGN KEY (grantor_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.document_direct_collaborators
    ADD CONSTRAINT document_direct_collaborators_target_actor_id_tenant_id_fkey FOREIGN KEY (target_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.document_event_sequences
    ADD CONSTRAINT document_event_sequences_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id);

ALTER TABLE ONLY public.document_events
    ADD CONSTRAINT document_events_actor_id_tenant_id_fkey FOREIGN KEY (actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.document_events
    ADD CONSTRAINT document_events_document_id_tenant_id_fkey FOREIGN KEY (document_id, tenant_id) REFERENCES public.documents(id, tenant_id);

ALTER TABLE ONLY public.document_latest_projections
    ADD CONSTRAINT document_latest_projections_revision_id_tenant_id_document_fkey FOREIGN KEY (revision_id, tenant_id, document_id, persisted_seq, full_state_fingerprint) REFERENCES public.document_revisions(id, tenant_id, document_id, persisted_seq, full_state_fingerprint);

ALTER TABLE ONLY public.document_permission_counts
    ADD CONSTRAINT document_permission_counts_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.document_placements
    ADD CONSTRAINT document_placements_document_id_tenant_id_fkey FOREIGN KEY (document_id, tenant_id) REFERENCES public.documents(id, tenant_id);

ALTER TABLE ONLY public.document_placements
    ADD CONSTRAINT document_placements_owner_human_actor_id_tenant_id_owner_a_fkey FOREIGN KEY (owner_human_actor_id, tenant_id, owner_actor_kind) REFERENCES public.actors(id, tenant_id, kind);

ALTER TABLE ONLY public.document_placements
    ADD CONSTRAINT document_placements_parent_id_tenant_id_fkey FOREIGN KEY (parent_id, tenant_id) REFERENCES public.document_placements(id, tenant_id);

ALTER TABLE ONLY public.document_placements
    ADD CONSTRAINT document_placements_wiki_id_tenant_id_fkey FOREIGN KEY (wiki_id, tenant_id) REFERENCES public.personal_wikis(id, tenant_id);

ALTER TABLE ONLY public.document_recent_opens
    ADD CONSTRAINT document_recent_opens_document_id_tenant_id_fkey FOREIGN KEY (document_id, tenant_id) REFERENCES public.documents(id, tenant_id);

ALTER TABLE ONLY public.document_revisions
    ADD CONSTRAINT document_revisions_created_by_actor_id_tenant_id_fkey FOREIGN KEY (created_by_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.document_revisions
    ADD CONSTRAINT document_revisions_document_id_tenant_id_fkey FOREIGN KEY (document_id, tenant_id) REFERENCES public.documents(id, tenant_id);

ALTER TABLE ONLY public.document_texts
    ADD CONSTRAINT document_texts_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_base_version_id_tenant_id_fkey FOREIGN KEY (base_version_id, tenant_id) REFERENCES public.document_versions(id, tenant_id);

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_created_by_actor_id_tenant_id_fkey FOREIGN KEY (created_by_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_document_id_tenant_id_fkey FOREIGN KEY (document_id, tenant_id) REFERENCES public.documents(id, tenant_id);

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_source_revision_id_tenant_id_document_id_fkey FOREIGN KEY (source_revision_id, tenant_id, document_id) REFERENCES public.document_revisions(id, tenant_id, document_id);

ALTER TABLE ONLY public.document_wiki_pages
    ADD CONSTRAINT document_wiki_pages_document_id_tenant_id_fkey FOREIGN KEY (document_id, tenant_id) REFERENCES public.documents(id, tenant_id);

ALTER TABLE ONLY public.document_wiki_pages
    ADD CONSTRAINT document_wiki_pages_wiki_id_tenant_id_fkey FOREIGN KEY (wiki_id, tenant_id) REFERENCES public.personal_wikis(id, tenant_id);

ALTER TABLE ONLY public.document_wiki_published_sources
    ADD CONSTRAINT document_wiki_published_sources_wiki_id_tenant_id_fkey FOREIGN KEY (wiki_id, tenant_id) REFERENCES public.personal_wikis(id, tenant_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.document_wiki_refresh_sources
    ADD CONSTRAINT document_wiki_refresh_sources_refresh_id_tenant_id_fkey FOREIGN KEY (refresh_id, tenant_id) REFERENCES public.document_wiki_refreshes(id, tenant_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.document_wiki_refreshes
    ADD CONSTRAINT document_wiki_refreshes_generator_agent_actor_id_tenant_id_fkey FOREIGN KEY (generator_agent_actor_id, tenant_id, generator_actor_kind) REFERENCES public.actors(id, tenant_id, kind);

ALTER TABLE ONLY public.document_wiki_refreshes
    ADD CONSTRAINT document_wiki_refreshes_wiki_id_tenant_id_fkey FOREIGN KEY (wiki_id, tenant_id) REFERENCES public.personal_wikis(id, tenant_id);

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_creator_actor_id_tenant_id_creator_actor_kind_fkey FOREIGN KEY (creator_actor_id, tenant_id, creator_actor_kind) REFERENCES public.actors(id, tenant_id, kind);

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_current_version_fk FOREIGN KEY (current_version_id, tenant_id, id) REFERENCES public.document_versions(id, tenant_id, document_id);

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_native_import_source_version_fk FOREIGN KEY (native_import_source_version_id, tenant_id, id) REFERENCES public.document_versions(id, tenant_id, document_id);

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_owner_actor_id_tenant_id_owner_actor_kind_fkey FOREIGN KEY (owner_actor_id, tenant_id, owner_actor_kind) REFERENCES public.actors(id, tenant_id, kind);

ALTER TABLE ONLY public.external_connection_agent_grants
    ADD CONSTRAINT external_connection_agent_gra_represented_human_actor_id_t_fkey FOREIGN KEY (represented_human_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.external_connection_agent_grants
    ADD CONSTRAINT external_connection_agent_grants_agent_actor_id_tenant_id_fkey FOREIGN KEY (agent_actor_id, tenant_id) REFERENCES public.agent_registrations(actor_id, tenant_id);

ALTER TABLE ONLY public.external_connection_agent_grants
    ADD CONSTRAINT external_connection_agent_grants_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES public.external_connections(id);

ALTER TABLE ONLY public.external_connection_upstreams
    ADD CONSTRAINT external_connection_upstreams_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);

ALTER TABLE ONLY public.external_connections
    ADD CONSTRAINT external_connections_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.external_mail_import_documents
    ADD CONSTRAINT external_mail_import_documents_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES public.external_connections(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.local_computer_enrollments
    ADD CONSTRAINT local_computer_enrollments_owner_actor_id_tenant_id_fkey FOREIGN KEY (owner_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.local_computers
    ADD CONSTRAINT local_computers_owner_fkey FOREIGN KEY (owner_actor_id, owner_tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.message_cards
    ADD CONSTRAINT message_cards_decision_owner_actor_id_tenant_id_fkey FOREIGN KEY (decision_owner_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.message_cards
    ADD CONSTRAINT message_cards_message_id_room_id_tenant_id_fkey FOREIGN KEY (message_id, room_id, tenant_id) REFERENCES public.messages(id, room_id, tenant_id);

ALTER TABLE ONLY public.message_cards
    ADD CONSTRAINT message_cards_work_item_id_tenant_id_fkey FOREIGN KEY (work_item_id, tenant_id) REFERENCES public.work_items(id, tenant_id);

ALTER TABLE ONLY public.message_reactions
    ADD CONSTRAINT message_reactions_actor_id_tenant_id_fkey FOREIGN KEY (actor_id, tenant_id) REFERENCES public.actors(id, tenant_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.message_reactions
    ADD CONSTRAINT message_reactions_message_id_tenant_id_room_id_fkey FOREIGN KEY (message_id, tenant_id, room_id) REFERENCES public.messages(id, tenant_id, room_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_author_actor_id_tenant_id_fkey FOREIGN KEY (author_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_card_context_fk FOREIGN KEY (card_context_message_id, room_id, tenant_id) REFERENCES public.messages(id, room_id, tenant_id);

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_local_run_id_fkey FOREIGN KEY (local_run_id) REFERENCES public.agent_local_runs(run_id) ON DELETE SET NULL;

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_reply_to_fk FOREIGN KEY (reply_to_message_id, tenant_id, room_id) REFERENCES public.messages(id, tenant_id, room_id);

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_room_id_tenant_id_fkey FOREIGN KEY (room_id, tenant_id) REFERENCES public.rooms(id, tenant_id);

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_room_seq_event_fkey FOREIGN KEY (room_id, room_seq) REFERENCES public.room_events(room_id, room_seq);

ALTER TABLE ONLY public.personal_insights
    ADD CONSTRAINT personal_insights_owner_actor_id_tenant_id_fkey FOREIGN KEY (owner_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.personal_insights
    ADD CONSTRAINT personal_insights_source_generation_id_fkey FOREIGN KEY (source_generation_id) REFERENCES public.personal_profile_generations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.personal_profile_currents
    ADD CONSTRAINT personal_profile_currents_owner_actor_id_tenant_id_fkey FOREIGN KEY (owner_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.personal_profile_currents
    ADD CONSTRAINT personal_profile_currents_revision_id_tenant_id_owner_acto_fkey FOREIGN KEY (revision_id, tenant_id, owner_actor_id) REFERENCES public.personal_profile_revisions(id, tenant_id, owner_actor_id);

ALTER TABLE ONLY public.personal_profile_generations
    ADD CONSTRAINT personal_profile_generations_base_profile_revision_id_tena_fkey FOREIGN KEY (base_profile_revision_id, tenant_id, owner_actor_id) REFERENCES public.personal_profile_revisions(id, tenant_id, owner_actor_id);

ALTER TABLE ONLY public.personal_profile_generations
    ADD CONSTRAINT personal_profile_generations_candidate_revision_fk FOREIGN KEY (candidate_revision_id) REFERENCES public.personal_profile_revisions(id);

ALTER TABLE ONLY public.personal_profile_generations
    ADD CONSTRAINT personal_profile_generations_owner_actor_id_tenant_id_fkey FOREIGN KEY (owner_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.personal_profile_revisions
    ADD CONSTRAINT personal_profile_revisions_owner_actor_id_tenant_id_fkey FOREIGN KEY (owner_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.personal_profile_revisions
    ADD CONSTRAINT personal_profile_revisions_source_profile_generation_id_fkey FOREIGN KEY (source_profile_generation_id) REFERENCES public.personal_profile_generations(id);

ALTER TABLE ONLY public.personal_wikis
    ADD CONSTRAINT personal_wikis_owner_actor_id_tenant_id_fkey FOREIGN KEY (owner_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.pocket_notes
    ADD CONSTRAINT pocket_notes_owner_actor_id_tenant_id_fkey FOREIGN KEY (owner_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.proactive_conversation_windows
    ADD CONSTRAINT proactive_conversation_windows_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.proactive_outputs
    ADD CONSTRAINT proactive_outputs_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.messages(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.proactive_pending_wakes
    ADD CONSTRAINT proactive_pending_wakes_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.proactive_pending_wakes
    ADD CONSTRAINT proactive_pending_wakes_tracking_item_id_fkey FOREIGN KEY (tracking_item_id) REFERENCES memory_index.tracking_items(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.room_agent_message_cancellations
    ADD CONSTRAINT room_agent_message_cancellations_agent_actor_id_tenant_id_fkey FOREIGN KEY (agent_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.room_agent_message_cancellations
    ADD CONSTRAINT room_agent_message_cancellations_message_id_tenant_id_fkey FOREIGN KEY (message_id, tenant_id) REFERENCES public.messages(id, tenant_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.room_agent_message_cancellations
    ADD CONSTRAINT room_agent_message_cancellations_room_id_tenant_id_fkey FOREIGN KEY (room_id, tenant_id) REFERENCES public.rooms(id, tenant_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.room_document_comment_reactions
    ADD CONSTRAINT room_document_comment_reactions_actor_id_tenant_id_fkey FOREIGN KEY (actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.room_document_comment_threads
    ADD CONSTRAINT room_document_comment_threads_anchor_creator_fk FOREIGN KEY (anchor_created_by_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.room_document_comment_threads
    ADD CONSTRAINT room_document_comment_threads_anchor_version_fk FOREIGN KEY (anchor_document_version_id, tenant_id, document_id) REFERENCES public.document_versions(id, tenant_id, document_id);

ALTER TABLE ONLY public.room_document_comment_threads
    ADD CONSTRAINT room_document_comment_threads_created_by_actor_id_tenant_i_fkey FOREIGN KEY (created_by_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.room_document_comment_threads
    ADD CONSTRAINT room_document_comment_threads_current_document_fk FOREIGN KEY (document_id, tenant_id) REFERENCES public.documents(id, tenant_id);

ALTER TABLE ONLY public.room_document_comment_threads
    ADD CONSTRAINT room_document_comment_threads_resolved_by_actor_id_tenant__fkey FOREIGN KEY (resolved_by_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.room_document_comments
    ADD CONSTRAINT room_document_comments_author_actor_id_tenant_id_fkey FOREIGN KEY (author_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.room_document_comments
    ADD CONSTRAINT room_document_comments_parent_comment_id_thread_id_fkey FOREIGN KEY (parent_comment_id, thread_id) REFERENCES public.room_document_comments(id, thread_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.room_events
    ADD CONSTRAINT room_events_actor_id_tenant_id_fkey FOREIGN KEY (actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.room_events
    ADD CONSTRAINT room_events_room_id_tenant_id_fkey FOREIGN KEY (room_id, tenant_id) REFERENCES public.rooms(id, tenant_id);

ALTER TABLE ONLY public.room_history_share_assets
    ADD CONSTRAINT room_history_share_assets_share_id_fkey FOREIGN KEY (share_id) REFERENCES public.room_history_shares(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.room_history_share_messages
    ADD CONSTRAINT room_history_share_messages_share_id_fkey FOREIGN KEY (share_id) REFERENCES public.room_history_shares(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.room_history_shares
    ADD CONSTRAINT room_history_shares_creator_actor_id_fkey FOREIGN KEY (creator_actor_id) REFERENCES public.actors(id);

ALTER TABLE ONLY public.room_history_shares
    ADD CONSTRAINT room_history_shares_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id);

ALTER TABLE ONLY public.room_member_states
    ADD CONSTRAINT room_member_states_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.actors(id);

ALTER TABLE ONLY public.room_member_states
    ADD CONSTRAINT room_member_states_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.room_members
    ADD CONSTRAINT room_members_actor_id_tenant_id_fkey FOREIGN KEY (actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.room_members
    ADD CONSTRAINT room_members_added_by_actor_id_tenant_id_fkey FOREIGN KEY (added_by_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.room_members
    ADD CONSTRAINT room_members_room_id_tenant_id_fkey FOREIGN KEY (room_id, tenant_id) REFERENCES public.rooms(id, tenant_id);

ALTER TABLE ONLY public.room_reminders
    ADD CONSTRAINT room_reminders_created_by_actor_id_tenant_id_fkey FOREIGN KEY (created_by_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.room_reminders
    ADD CONSTRAINT room_reminders_mention_actor_id_tenant_id_fkey FOREIGN KEY (mention_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.room_reminders
    ADD CONSTRAINT room_reminders_room_id_tenant_id_fkey FOREIGN KEY (room_id, tenant_id) REFERENCES public.rooms(id, tenant_id);

ALTER TABLE ONLY public.room_reminders
    ADD CONSTRAINT room_reminders_template_agent_actor_id_fkey FOREIGN KEY (template_agent_actor_id) REFERENCES public.actors(id);

ALTER TABLE ONLY public.room_reminders
    ADD CONSTRAINT room_reminders_tracking_item_id_fkey FOREIGN KEY (tracking_item_id) REFERENCES memory_index.tracking_items(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.room_routine_listeners
    ADD CONSTRAINT room_routine_listeners_routine_id_fkey FOREIGN KEY (routine_id) REFERENCES public.room_reminders(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.rooms
    ADD CONSTRAINT rooms_created_by_actor_id_tenant_id_fkey FOREIGN KEY (created_by_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.rooms
    ADD CONSTRAINT rooms_deleted_by_actor_fk FOREIGN KEY (deleted_by_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.rooms
    ADD CONSTRAINT rooms_deletion_started_by_actor_fk FOREIGN KEY (deletion_started_by_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.rooms
    ADD CONSTRAINT rooms_direct_agent_actor_fkey FOREIGN KEY (direct_agent_actor_id, tenant_id) REFERENCES public.agent_registrations(actor_id, tenant_id);

ALTER TABLE ONLY public.rooms
    ADD CONSTRAINT rooms_direct_human_actor_fkey FOREIGN KEY (direct_human_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.rooms
    ADD CONSTRAINT rooms_parent_room_fkey FOREIGN KEY (parent_room_id, tenant_id) REFERENCES public.rooms(id, tenant_id);

ALTER TABLE ONLY public.rooms
    ADD CONSTRAINT rooms_root_message_fkey FOREIGN KEY (root_message_id) REFERENCES public.messages(id);

ALTER TABLE ONLY public.rooms
    ADD CONSTRAINT rooms_team_md_updated_by_actor_id_fkey FOREIGN KEY (team_md_updated_by_actor_id) REFERENCES public.actors(id);

ALTER TABLE ONLY public.routine_event_deliveries
    ADD CONSTRAINT routine_event_deliveries_routine_id_fkey FOREIGN KEY (routine_id) REFERENCES public.room_reminders(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.skill_manifests
    ADD CONSTRAINT skill_manifests_created_by_actor_id_fkey FOREIGN KEY (created_by_actor_id) REFERENCES public.actors(id);

ALTER TABLE ONLY public.skill_manifests
    ADD CONSTRAINT skill_manifests_skill_id_fkey FOREIGN KEY (skill_id) REFERENCES public.skills(skill_id);

ALTER TABLE ONLY public.skills
    ADD CONSTRAINT skills_created_by_actor_id_fkey FOREIGN KEY (created_by_actor_id) REFERENCES public.actors(id);

ALTER TABLE ONLY public.skills
    ADD CONSTRAINT skills_latest_manifest_fkey FOREIGN KEY (latest_manifest_id, skill_id) REFERENCES public.skill_manifests(manifest_id, skill_id);

ALTER TABLE ONLY public.skills
    ADD CONSTRAINT skills_owner_actor_id_fkey FOREIGN KEY (owner_actor_id) REFERENCES public.actors(id);

ALTER TABLE ONLY public.task_attempts
    ADD CONSTRAINT task_attempts_current_input_revision_fk FOREIGN KEY (task_id, tenant_id, generation, id, current_input_revision) REFERENCES public.task_input_revisions(task_id, tenant_id, generation, attempt_id, input_revision) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.task_attempts
    ADD CONSTRAINT task_attempts_task_id_tenant_id_generation_fkey FOREIGN KEY (task_id, tenant_id, generation) REFERENCES public.task_execution_generations(task_id, tenant_id, generation) ON DELETE RESTRICT;

ALTER TABLE ONLY public.task_effects
    ADD CONSTRAINT task_effects_retry_of_effect_id_fkey FOREIGN KEY (retry_of_effect_id) REFERENCES public.task_effects(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.task_effects
    ADD CONSTRAINT task_effects_task_id_tenant_id_generation_fkey FOREIGN KEY (task_id, tenant_id, generation) REFERENCES public.task_execution_generations(task_id, tenant_id, generation) ON DELETE RESTRICT;

ALTER TABLE ONLY public.task_execution_facts
    ADD CONSTRAINT task_execution_facts_caused_by_actor_id_tenant_id_fkey FOREIGN KEY (caused_by_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.task_execution_facts
    ADD CONSTRAINT task_execution_facts_task_id_tenant_id_generation_fkey FOREIGN KEY (task_id, tenant_id, generation) REFERENCES public.task_execution_generations(task_id, tenant_id, generation) ON DELETE RESTRICT;

ALTER TABLE ONLY public.task_execution_generations
    ADD CONSTRAINT task_execution_generations_coordinator_actor_fk FOREIGN KEY (coordinator_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.task_execution_generations
    ADD CONSTRAINT task_execution_generations_result_agent_actor_id_tenant_id_fkey FOREIGN KEY (result_agent_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.task_execution_generations
    ADD CONSTRAINT task_execution_generations_result_participant_fk FOREIGN KEY (task_id, tenant_id, generation, result_agent_actor_id) REFERENCES public.task_execution_participants(task_id, tenant_id, generation, actor_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.task_execution_generations
    ADD CONSTRAINT task_execution_generations_task_id_tenant_id_fkey FOREIGN KEY (task_id, tenant_id) REFERENCES public.work_items(id, tenant_id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.task_execution_participants
    ADD CONSTRAINT task_execution_participants_actor_id_tenant_id_fkey FOREIGN KEY (actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.task_execution_participants
    ADD CONSTRAINT task_execution_participants_task_id_tenant_id_generation_fkey FOREIGN KEY (task_id, tenant_id, generation) REFERENCES public.task_execution_generations(task_id, tenant_id, generation) ON DELETE RESTRICT;

ALTER TABLE ONLY public.task_input_revisions
    ADD CONSTRAINT task_input_revisions_attempt_id_task_id_tenant_id_generati_fkey FOREIGN KEY (attempt_id, task_id, tenant_id, generation) REFERENCES public.task_attempts(id, task_id, tenant_id, generation) ON DELETE RESTRICT;

ALTER TABLE ONLY public.task_input_revisions
    ADD CONSTRAINT task_input_revisions_source_message_fk FOREIGN KEY (source_message_id, tenant_id) REFERENCES public.messages(id, tenant_id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.task_meta_callback_messages
    ADD CONSTRAINT task_meta_callback_messages_author_actor_id_tenant_id_fkey FOREIGN KEY (author_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.task_meta_callback_messages
    ADD CONSTRAINT task_meta_callback_messages_task_id_tenant_id_generation_fkey FOREIGN KEY (task_id, tenant_id, generation) REFERENCES public.task_meta_callbacks(task_id, tenant_id, generation) ON DELETE CASCADE;

ALTER TABLE ONLY public.task_meta_callbacks
    ADD CONSTRAINT task_meta_callbacks_coordinator_actor_id_tenant_id_fkey FOREIGN KEY (coordinator_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.task_meta_callbacks
    ADD CONSTRAINT task_meta_callbacks_task_id_tenant_id_generation_fkey FOREIGN KEY (task_id, tenant_id, generation) REFERENCES public.task_execution_generations(task_id, tenant_id, generation) ON DELETE CASCADE;

ALTER TABLE ONLY public.task_meta_inboxes
    ADD CONSTRAINT task_meta_inboxes_agent_actor_id_tenant_id_fkey FOREIGN KEY (agent_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.task_meta_inboxes
    ADD CONSTRAINT task_meta_inboxes_task_id_tenant_id_fkey FOREIGN KEY (task_id, tenant_id) REFERENCES public.work_items(id, tenant_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.task_meta_messages
    ADD CONSTRAINT task_meta_messages_author_actor_id_tenant_id_fkey FOREIGN KEY (author_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.task_meta_messages
    ADD CONSTRAINT task_meta_messages_task_id_tenant_id_agent_actor_id_fkey FOREIGN KEY (task_id, tenant_id, agent_actor_id) REFERENCES public.task_meta_inboxes(task_id, tenant_id, agent_actor_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.room_document_comment_reactions
    ADD CONSTRAINT unified_document_comment_reactions_comment_fk FOREIGN KEY (comment_id, tenant_id, document_id, thread_id) REFERENCES public.room_document_comments(id, tenant_id, document_id, thread_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.room_document_comment_threads
    ADD CONSTRAINT unified_document_comment_threads_room_fk FOREIGN KEY (room_id, tenant_id) REFERENCES public.rooms(id, tenant_id);

ALTER TABLE ONLY public.room_document_comments
    ADD CONSTRAINT unified_document_comments_thread_fk FOREIGN KEY (thread_id, tenant_id, document_id) REFERENCES public.room_document_comment_threads(id, tenant_id, document_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.voice_capture_questions
    ADD CONSTRAINT voice_capture_questions_capture_session_id_fkey FOREIGN KEY (capture_session_id) REFERENCES public.capture_sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.voice_live_confirmations
    ADD CONSTRAINT voice_live_confirmations_voice_session_id_fkey FOREIGN KEY (voice_session_id) REFERENCES public.voice_sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.voice_live_replies
    ADD CONSTRAINT voice_live_replies_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.messages(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.voice_live_replies
    ADD CONSTRAINT voice_live_replies_voice_session_id_turn_id_fkey FOREIGN KEY (voice_session_id, turn_id) REFERENCES public.voice_live_turns(voice_session_id, turn_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.voice_live_report_deliveries
    ADD CONSTRAINT voice_live_report_deliveries_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.messages(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.voice_live_report_deliveries
    ADD CONSTRAINT voice_live_report_deliveries_report_id_fkey FOREIGN KEY (report_id) REFERENCES public.task_meta_callback_messages(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.voice_live_report_deliveries
    ADD CONSTRAINT voice_live_report_deliveries_voice_session_id_fkey FOREIGN KEY (voice_session_id) REFERENCES public.voice_sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.voice_live_tasks
    ADD CONSTRAINT voice_live_tasks_home_room_id_fkey FOREIGN KEY (home_room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.voice_live_tasks
    ADD CONSTRAINT voice_live_tasks_owner_actor_id_fkey FOREIGN KEY (owner_actor_id) REFERENCES public.actors(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.voice_live_tasks
    ADD CONSTRAINT voice_live_tasks_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.voice_live_tasks
    ADD CONSTRAINT voice_live_tasks_voice_session_id_fkey FOREIGN KEY (voice_session_id) REFERENCES public.voice_sessions(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.voice_live_tasks
    ADD CONSTRAINT voice_live_tasks_work_item_id_fkey FOREIGN KEY (work_item_id) REFERENCES public.work_items(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.voice_live_tool_calls
    ADD CONSTRAINT voice_live_tool_calls_voice_session_id_fkey FOREIGN KEY (voice_session_id) REFERENCES public.voice_sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.voice_live_turns
    ADD CONSTRAINT voice_live_turns_human_message_id_fkey FOREIGN KEY (human_message_id) REFERENCES public.messages(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.voice_live_turns
    ADD CONSTRAINT voice_live_turns_voice_session_id_fkey FOREIGN KEY (voice_session_id) REFERENCES public.voice_sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.voice_media_epochs
    ADD CONSTRAINT voice_media_epochs_capture_session_id_fkey FOREIGN KEY (capture_session_id) REFERENCES public.capture_sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.voice_media_epochs
    ADD CONSTRAINT voice_media_epochs_voice_session_id_fkey FOREIGN KEY (voice_session_id) REFERENCES public.voice_sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.voice_sessions
    ADD CONSTRAINT voice_sessions_auth_session_id_fkey FOREIGN KEY (auth_session_id) REFERENCES public.auth_sessions(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.voice_sessions
    ADD CONSTRAINT voice_sessions_created_by_actor_id_tenant_id_fkey FOREIGN KEY (created_by_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.voice_sessions
    ADD CONSTRAINT voice_sessions_live_agent_actor_id_fkey FOREIGN KEY (live_agent_actor_id) REFERENCES public.actors(id);

ALTER TABLE ONLY public.voice_sessions
    ADD CONSTRAINT voice_sessions_room_id_tenant_id_fkey FOREIGN KEY (room_id, tenant_id) REFERENCES public.rooms(id, tenant_id);

ALTER TABLE ONLY public.voice_transcript_segments
    ADD CONSTRAINT voice_transcript_segments_capture_session_id_fkey FOREIGN KEY (capture_session_id) REFERENCES public.capture_sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.voice_transcript_segments
    ADD CONSTRAINT voice_transcript_segments_voice_session_id_fkey FOREIGN KEY (voice_session_id) REFERENCES public.voice_sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.voice_transcript_uncertainties
    ADD CONSTRAINT voice_transcript_uncertainties_capture_session_id_fkey FOREIGN KEY (capture_session_id) REFERENCES public.capture_sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.wiki_source_items
    ADD CONSTRAINT wiki_source_items_document_id_tenant_id_fkey FOREIGN KEY (document_id, tenant_id) REFERENCES public.documents(id, tenant_id);

ALTER TABLE ONLY public.wiki_source_items
    ADD CONSTRAINT wiki_source_items_document_version_id_tenant_id_fkey FOREIGN KEY (document_version_id, tenant_id, document_id) REFERENCES public.document_versions(id, tenant_id, document_id);

ALTER TABLE ONLY public.wiki_source_items
    ADD CONSTRAINT wiki_source_items_owner_actor_id_tenant_id_fkey FOREIGN KEY (owner_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.wiki_source_skips
    ADD CONSTRAINT wiki_source_skips_owner_actor_id_tenant_id_fkey FOREIGN KEY (owner_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.work_item_access_grants
    ADD CONSTRAINT work_item_access_grants_actor_id_tenant_id_fkey FOREIGN KEY (actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.work_item_access_grants
    ADD CONSTRAINT work_item_access_grants_granted_by_actor_id_tenant_id_fkey FOREIGN KEY (granted_by_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.work_item_access_grants
    ADD CONSTRAINT work_item_access_grants_work_item_id_tenant_id_fkey FOREIGN KEY (work_item_id, tenant_id) REFERENCES public.work_items(id, tenant_id);

ALTER TABLE ONLY public.work_item_activities
    ADD CONSTRAINT work_item_activities_actor_id_tenant_id_fkey FOREIGN KEY (actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.work_item_activities
    ADD CONSTRAINT work_item_activities_comment_fk FOREIGN KEY (comment_id) REFERENCES public.work_item_comments(id);

ALTER TABLE ONLY public.work_item_activities
    ADD CONSTRAINT work_item_activities_room_id_tenant_id_fkey FOREIGN KEY (room_id, tenant_id) REFERENCES public.rooms(id, tenant_id);

ALTER TABLE ONLY public.work_item_activities
    ADD CONSTRAINT work_item_activities_target_actor_id_tenant_id_fkey FOREIGN KEY (target_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.work_item_activities
    ADD CONSTRAINT work_item_activities_work_item_id_tenant_id_fkey FOREIGN KEY (work_item_id, tenant_id) REFERENCES public.work_items(id, tenant_id);

ALTER TABLE ONLY public.work_item_assignments
    ADD CONSTRAINT work_item_assignments_actor_id_tenant_id_fkey FOREIGN KEY (actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.work_item_assignments
    ADD CONSTRAINT work_item_assignments_assigned_by_actor_id_tenant_id_fkey FOREIGN KEY (assigned_by_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.work_item_assignments
    ADD CONSTRAINT work_item_assignments_work_item_id_tenant_id_fkey FOREIGN KEY (work_item_id, tenant_id) REFERENCES public.work_items(id, tenant_id);

ALTER TABLE ONLY public.work_item_comment_references
    ADD CONSTRAINT work_item_comment_references_actor_id_tenant_id_fkey FOREIGN KEY (actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.work_item_comment_references
    ADD CONSTRAINT work_item_comment_references_comment_id_work_item_id_tenan_fkey FOREIGN KEY (comment_id, work_item_id, tenant_id) REFERENCES public.work_item_comments(id, work_item_id, tenant_id);

ALTER TABLE ONLY public.work_item_comment_references
    ADD CONSTRAINT work_item_comment_references_work_item_id_tenant_id_fkey FOREIGN KEY (work_item_id, tenant_id) REFERENCES public.work_items(id, tenant_id);

ALTER TABLE ONLY public.work_item_comments
    ADD CONSTRAINT work_item_comments_author_actor_id_tenant_id_fkey FOREIGN KEY (author_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.work_item_comments
    ADD CONSTRAINT work_item_comments_work_item_id_tenant_id_fkey FOREIGN KEY (work_item_id, tenant_id) REFERENCES public.work_items(id, tenant_id);

ALTER TABLE ONLY public.work_item_description_references
    ADD CONSTRAINT work_item_description_references_actor_id_tenant_id_fkey FOREIGN KEY (actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.work_item_description_references
    ADD CONSTRAINT work_item_description_references_work_item_id_tenant_id_fkey FOREIGN KEY (work_item_id, tenant_id) REFERENCES public.work_items(id, tenant_id);

ALTER TABLE ONLY public.work_item_room_links
    ADD CONSTRAINT work_item_room_links_linked_by_actor_id_tenant_id_fkey FOREIGN KEY (linked_by_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.work_item_room_links
    ADD CONSTRAINT work_item_room_links_origin_message_id_room_id_tenant_id_fkey FOREIGN KEY (origin_message_id, room_id, tenant_id) REFERENCES public.messages(id, room_id, tenant_id);

ALTER TABLE ONLY public.work_item_room_links
    ADD CONSTRAINT work_item_room_links_room_id_tenant_id_fkey FOREIGN KEY (room_id, tenant_id) REFERENCES public.rooms(id, tenant_id);

ALTER TABLE ONLY public.work_item_room_links
    ADD CONSTRAINT work_item_room_links_work_item_id_tenant_id_fkey FOREIGN KEY (work_item_id, tenant_id) REFERENCES public.work_items(id, tenant_id);

ALTER TABLE ONLY public.work_items
    ADD CONSTRAINT work_items_created_by_actor_id_tenant_id_fkey FOREIGN KEY (created_by_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.work_items
    ADD CONSTRAINT work_items_task_control_actor_fk FOREIGN KEY (task_control_requested_by_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

ALTER TABLE ONLY public.work_items
    ADD CONSTRAINT work_items_task_execution_generation_fk FOREIGN KEY (id, tenant_id, task_execution_generation) REFERENCES public.task_execution_generations(task_id, tenant_id, generation) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.work_items
    ADD CONSTRAINT work_items_updated_by_actor_id_tenant_id_fkey FOREIGN KEY (updated_by_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'The schema baseline is forward-only; restore a backup instead of downgrading'; END $$;
-- +goose StatementEnd
