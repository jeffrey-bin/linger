-- name: GetActiveMcpContextAgentForShare :one
SELECT actor_id,tenant_id,agent_management_id,agent_type,user_artifact_owner_actor_id
FROM agent_registrations
WHERE agent_management_id=sqlc.arg(agent_management_id)::text
  AND status='active'
FOR SHARE;

-- name: AuthorizeDocumentMcpContextForShare :one
-- A Document comment Context serves its running Run, else its oldest queued
-- Run. A queued Run is ready only once agent_document_run_claimable admits it.
SELECT registration.actor_id,registration.tenant_id,
       local_run.run_id AS local_run_id,runtime_input.payload AS notification_payload,
       (local_run.status='running'
        OR agent_document_run_claimable(local_run.run_id,local_run.context_key))::boolean AS ready
FROM agent_execution_contexts execution_context
JOIN agent_registrations registration
  ON registration.actor_id=execution_context.agent_actor_id
 AND registration.tenant_id=execution_context.tenant_id
 AND registration.agent_management_id=execution_context.agent_management_id
 AND registration.status='active'
JOIN agent_local_runs local_run
  ON local_run.context_key=execution_context.context_key
 AND local_run.status IN ('running','queued')
 AND local_run.created_at>clock_timestamp()-interval '24 hours'
JOIN agent_local_run_inputs run_input
  ON run_input.run_id=local_run.run_id AND run_input.relation='initial'
JOIN agent_runtime_inputs runtime_input
  ON runtime_input.context_key=run_input.context_key
 AND runtime_input.input_id=run_input.input_id
 AND runtime_input.local_run_id=local_run.run_id
 AND runtime_input.status='handled'
WHERE execution_context.agent_management_id=sqlc.arg(agent_management_id)::text
  AND execution_context.context_kind='document'
  AND execution_context.document_id=sqlc.arg(document_id)::text
  AND execution_context.target_residency='active'
  AND document_comment_agent_readable(registration.tenant_id,execution_context.document_id,registration.actor_id)
ORDER BY CASE local_run.status WHEN 'running' THEN 0 ELSE 1 END,
         agent_document_run_claimable(local_run.run_id,local_run.context_key) DESC,
         local_run.created_at,local_run.run_id
LIMIT 1
FOR SHARE OF execution_context,registration,local_run;

-- name: AuthorizePerRoomMetaMcpContextForShare :one
SELECT context.agent_actor_id,context.tenant_id,context.membership_epoch_id
FROM agent_execution_contexts context
JOIN room_members membership
  ON membership.actor_id=context.agent_actor_id
 AND membership.tenant_id=context.tenant_id
 AND membership.room_id=context.room_id
 AND membership.membership_epoch_id=context.membership_epoch_id
JOIN agent_registrations registration
  ON registration.actor_id=context.agent_actor_id
 AND registration.tenant_id=context.tenant_id
 AND registration.agent_management_id=context.agent_management_id
 AND registration.status='active'
WHERE context.agent_management_id=sqlc.arg(agent_management_id)::text
  AND context.context_kind='meta'
  AND context.room_id=sqlc.arg(room_id)::text
  AND context.membership_epoch_id IS NOT NULL
  AND context.target_residency='active'
FOR SHARE OF context,membership,registration;

-- name: AuthorizeAlterEgoMcpContextForShare :one
SELECT registration.actor_id,registration.tenant_id,
       item.task_execution_generation AS generation
FROM agent_registrations registration
JOIN agent_execution_contexts context
  ON context.agent_management_id=registration.agent_management_id
 AND context.agent_actor_id=registration.actor_id
 AND context.tenant_id=registration.tenant_id
 AND context.context_kind='alter_ego'
 AND context.task_id=sqlc.arg(task_id)::text
 AND context.target_residency='active'
JOIN work_items item
  ON item.id=sqlc.arg(task_id)::text
 AND item.tenant_id=registration.tenant_id
 AND item.kind='task'
 AND item.archived_at IS NULL
 AND item.state<>'resolved'
 AND item.task_execution_generation IS NOT NULL
JOIN work_item_room_links work_room_link
  ON work_room_link.work_item_id=item.id
 AND work_room_link.tenant_id=item.tenant_id
 AND work_room_link.link_type='work'
JOIN rooms work_room
  ON work_room.id=work_room_link.room_id
 AND work_room.tenant_id=work_room_link.tenant_id
 AND work_room.deleted_at IS NULL
JOIN task_execution_generations generation
  ON generation.task_id=item.id
 AND generation.tenant_id=item.tenant_id
 AND generation.generation=item.task_execution_generation
 AND generation.terminal_at IS NULL
JOIN task_execution_participants participant
  ON participant.task_id=item.id
 AND participant.tenant_id=item.tenant_id
 AND participant.generation=item.task_execution_generation
 AND participant.actor_id=registration.actor_id
 AND participant.agent_management_id=registration.agent_management_id
WHERE registration.agent_management_id=sqlc.arg(agent_management_id)::text
  AND registration.status='active'
FOR SHARE OF context,item,work_room_link,work_room,generation,participant,registration;
