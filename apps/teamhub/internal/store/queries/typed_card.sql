
-- name: CreateTypedCardWorkItem :one
INSERT INTO work_items(
    id,tenant_id,number,kind,title,description,priority,state,
    resolution,version,created_by_actor_id,updated_by_actor_id
)
VALUES($1,$2,$3,$4,$5,$6,$7,'in_progress',NULL,1,$8,$8)
RETURNING id,tenant_id,number,kind,title,description,priority,state,resolution,version,
          created_by_actor_id,updated_by_actor_id,archived_at,created_at,updated_at,
          task_source_key,task_execution_generation,task_execution_status,
          task_execution_revision,task_execution_reason_code,task_desired_control,
          task_control_revision,task_control_settled_revision,task_control_outcome,
          task_control_source_kind,task_control_source_id,task_control_requested_by_actor_id,
          task_control_requested_at,task_control_payload,
          task_execution_updated_at,task_next_reconcile_at,task_worker_id,
          task_lease_token_hash,task_lease_generation,task_lease_expires_at;

-- name: CreateMessageCard :exec
INSERT INTO message_cards(
    message_id,tenant_id,room_id,work_item_id,
    decision_owner_actor_id,card_type,intent
)
VALUES($1,$2,$3,$4,$5,$6,$7);

-- name: GetMessageCard :one
SELECT message_id,tenant_id,room_id,work_item_id,
       decision_owner_actor_id,card_type,intent,version,created_at,updated_at
FROM message_cards
WHERE message_id=$1;

-- name: ListMessageCards :many
SELECT message_id,tenant_id,room_id,work_item_id,
       decision_owner_actor_id,card_type,intent,version,created_at,updated_at
FROM message_cards
WHERE message_id=ANY(sqlc.arg(message_ids)::text[])
ORDER BY array_position(sqlc.arg(message_ids)::text[],message_id);

-- name: GetTypedCardWorkItem :one
SELECT id,tenant_id,number,kind,title,description,priority,state,resolution,version,
       created_by_actor_id,updated_by_actor_id,archived_at,created_at,updated_at,
       task_source_key,task_execution_generation,task_execution_status,
       task_execution_revision,task_execution_reason_code,task_desired_control,
       task_control_revision,task_control_settled_revision,task_control_outcome,
       task_control_source_kind,task_control_source_id,task_control_requested_by_actor_id,
       task_control_requested_at,task_control_payload,
       task_execution_updated_at,task_next_reconcile_at,task_worker_id,
       task_lease_token_hash,task_lease_generation,task_lease_expires_at
FROM work_items
WHERE id=$1;

-- name: AdvanceCardVersions :many
-- Raise each card's version. room_live reports whether its Room may still
-- record card.changed; a Room whose deletion started allocates no room_seq.
WITH advanced AS (
  UPDATE message_cards card
  SET version=card.version+1,updated_at=now()
  WHERE card.tenant_id=sqlc.arg(tenant_id)::text
    AND card.message_id=ANY(sqlc.arg(message_ids)::text[])
  RETURNING card.message_id,card.room_id,card.version
)
SELECT advanced.message_id,advanced.room_id,advanced.version,
       (room.deletion_started_at IS NULL AND room.deleted_at IS NULL)::boolean AS room_live
FROM advanced
JOIN rooms room ON room.id=advanced.room_id
ORDER BY advanced.room_id,advanced.message_id;


-- name: GetTypedCardMessage :one
SELECT message.id,message.tenant_id,message.room_id,message.body,message.segments,
       message.card_context_message_id,message.message_kind,message.created_at,
       author.id AS author_id,author.kind AS author_kind,
       author.display_name AS author_display_name,author.account_id AS author_account_id,
       author.handle AS author_handle,author.created_at AS author_created_at
FROM messages message
JOIN actors author
  ON author.id=message.author_actor_id AND author.tenant_id=message.tenant_id
WHERE message.id=$1;

-- name: HasPendingTypedCardDecisionForMember :one
-- A member who must decide a pending Room creation, or whose request waits
-- on one, stays until it is decided.
SELECT EXISTS (
    SELECT 1
    FROM decisions decision
    WHERE decision.kind='room_creation'
      AND decision.room_id=sqlc.arg(room_id)::text
      AND (
          decision.decider_actor_id=sqlc.arg(actor_id)::text OR
          decision.requested_by_actor_id=sqlc.arg(actor_id)::text
      )
      AND decision.status='pending'
)::boolean AS pending;

-- name: ResolveCreationApprovalAgentSource :one
SELECT room.tenant_id,agent.id AS agent_actor_id,agent.kind AS agent_kind,
       agent.display_name AS agent_display_name,agent.account_id AS agent_account_id,
       agent.handle AS agent_handle,agent.created_at AS agent_created_at,
       registration.agent_management_id,registration.created_by_actor_id,
       registration.visibility_scope
FROM rooms room
JOIN agent_registrations registration
  ON registration.tenant_id=room.tenant_id
 AND registration.agent_management_id=sqlc.arg(agent_management_id)::text
 AND registration.status='active'
JOIN actors agent
  ON agent.id=registration.actor_id AND agent.tenant_id=registration.tenant_id
JOIN room_members membership
  ON membership.room_id=room.id AND membership.tenant_id=room.tenant_id
 AND membership.actor_id=agent.id
WHERE room.id=sqlc.arg(room_id)::text AND room.deleted_at IS NULL
FOR KEY SHARE OF room,registration,agent,membership;
