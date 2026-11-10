-- name: AllocateTenantWorkItemNumber :one
-- A Space's Work Item numbers live on its Human's Account row (the first
-- Human when tests add a peer); the row lock keeps them gapless and unique.
UPDATE accounts
SET work_item_last_number = work_item_last_number + 1
WHERE id = (
    SELECT human.account_id FROM actors human
    WHERE human.tenant_id = sqlc.arg(tenant_id)::text AND human.kind = 'human'
      AND human.account_id IS NOT NULL
    ORDER BY human.created_at, human.id
    LIMIT 1
)
RETURNING work_item_last_number;

-- name: CreateWorkItem :one
INSERT INTO work_items(
    id, tenant_id, number, kind, title, description, priority, state,
    resolution, version, created_by_actor_id, updated_by_actor_id
)
VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', NULL, 1, $8, $8)
RETURNING id, tenant_id, number, kind, title, description, priority, state, resolution, version,
          created_by_actor_id, updated_by_actor_id, archived_at, created_at, updated_at,
          task_source_key, task_execution_generation, task_execution_status,
          task_execution_revision, task_execution_reason_code, task_desired_control,
          task_control_revision, task_control_settled_revision, task_control_outcome,
          task_control_source_kind, task_control_source_id, task_control_requested_by_actor_id,
          task_control_requested_at, task_control_payload,
          task_execution_updated_at, task_next_reconcile_at, task_worker_id,
          task_lease_token_hash, task_lease_generation, task_lease_expires_at;

-- name: GetWorkItemForHuman :one
SELECT wi.id, wi.tenant_id, wi.number, wi.kind, wi.title, wi.description, wi.priority,
       wi.state, wi.resolution, wi.version, wi.created_by_actor_id, wi.updated_by_actor_id,
       wi.archived_at, wi.created_at, wi.updated_at,
       wi.task_source_key, wi.task_execution_generation, wi.task_execution_status,
       wi.task_execution_revision, wi.task_execution_reason_code, wi.task_desired_control,
       wi.task_control_revision, wi.task_control_settled_revision, wi.task_control_outcome,
       wi.task_control_source_kind, wi.task_control_source_id, wi.task_control_requested_by_actor_id,
       wi.task_control_requested_at, wi.task_control_payload,
       wi.task_execution_updated_at, wi.task_next_reconcile_at, wi.task_worker_id,
       wi.task_lease_token_hash, wi.task_lease_generation, wi.task_lease_expires_at
FROM work_items wi
WHERE wi.id=sqlc.arg(id)::text
  AND EXISTS (
      SELECT 1 FROM actors caller
      WHERE caller.tenant_id=wi.tenant_id
        AND caller.account_id=sqlc.arg(account_id)::text
        AND caller.kind='human'
  );

-- name: GetWorkItemForHumanForUpdate :one
SELECT wi.id, wi.tenant_id, wi.number, wi.kind, wi.title, wi.description, wi.priority,
       wi.state, wi.resolution, wi.version, wi.created_by_actor_id, wi.updated_by_actor_id,
       wi.archived_at, wi.created_at, wi.updated_at,
       wi.task_source_key, wi.task_execution_generation, wi.task_execution_status,
       wi.task_execution_revision, wi.task_execution_reason_code, wi.task_desired_control,
       wi.task_control_revision, wi.task_control_settled_revision, wi.task_control_outcome,
       wi.task_control_source_kind, wi.task_control_source_id, wi.task_control_requested_by_actor_id,
       wi.task_control_requested_at, wi.task_control_payload,
       wi.task_execution_updated_at, wi.task_next_reconcile_at, wi.task_worker_id,
       wi.task_lease_token_hash, wi.task_lease_generation, wi.task_lease_expires_at
FROM work_items wi
WHERE wi.id=sqlc.arg(id)::text
  AND EXISTS (
      SELECT 1 FROM actors caller
      WHERE caller.tenant_id=wi.tenant_id
        AND caller.account_id=sqlc.arg(account_id)::text
        AND caller.kind='human'
  )
FOR UPDATE OF wi;

-- name: ListWorkItemsForHuman :many
SELECT wi.id, wi.tenant_id, wi.number, wi.kind, wi.title, wi.description, wi.priority,
       wi.state, wi.resolution, wi.version, wi.created_by_actor_id, wi.updated_by_actor_id,
       wi.archived_at, wi.created_at, wi.updated_at,
       wi.task_source_key, wi.task_execution_generation, wi.task_execution_status,
       wi.task_execution_revision, wi.task_execution_reason_code, wi.task_desired_control,
       wi.task_control_revision, wi.task_control_settled_revision, wi.task_control_outcome,
       wi.task_control_source_kind, wi.task_control_source_id, wi.task_control_requested_by_actor_id,
       wi.task_control_requested_at, wi.task_control_payload,
       wi.task_execution_updated_at, wi.task_next_reconcile_at, wi.task_worker_id,
       wi.task_lease_token_hash, wi.task_lease_generation, wi.task_lease_expires_at
FROM work_items wi
WHERE wi.tenant_id=sqlc.arg(tenant_id)::text
  AND EXISTS (
      SELECT 1 FROM actors caller
      WHERE caller.tenant_id=wi.tenant_id
        AND caller.account_id=sqlc.arg(account_id)::text
        AND caller.kind='human'
        AND (
            sqlc.arg(scope_filter)::text <> 'personal'
            OR wi.created_by_actor_id=caller.id
            OR EXISTS (
                SELECT 1 FROM work_item_assignments direct_assignment
                WHERE direct_assignment.work_item_id=wi.id
                  AND direct_assignment.actor_id=caller.id
            )
            OR EXISTS (
                SELECT 1 FROM message_cards card
                WHERE card.work_item_id=wi.id
                  AND card.decision_owner_actor_id=caller.id
            )
            OR EXISTS (
                SELECT 1
                FROM work_item_assignments sponsored_assignment
                JOIN agent_registrations registration
                  ON registration.actor_id=sponsored_assignment.actor_id
                 AND registration.tenant_id=wi.tenant_id
                WHERE sponsored_assignment.work_item_id=wi.id
                  AND registration.created_by_actor_id=caller.id
            )
        )
  )
  AND (sqlc.arg(kind_filter)::text = '' OR wi.kind=sqlc.arg(kind_filter)::text)
  AND (sqlc.arg(state_filter)::text = '' OR wi.state=sqlc.arg(state_filter)::text)
  AND (sqlc.arg(priority_filter)::text = '' OR wi.priority=sqlc.arg(priority_filter)::text)
  AND (sqlc.arg(execution_status_filter)::text = ''
       OR wi.task_execution_status=sqlc.arg(execution_status_filter)::text)
  AND (NOT sqlc.arg(has_pending_control_filter)::boolean
       OR ((wi.task_control_revision > wi.task_control_settled_revision)
           = sqlc.arg(pending_control_filter)::boolean))
  AND (
      sqlc.arg(assignee_actor_id)::text = '' OR EXISTS (
          SELECT 1 FROM work_item_assignments assignment
          WHERE assignment.work_item_id=wi.id
            AND assignment.actor_id=sqlc.arg(assignee_actor_id)::text
      )
  )
  AND (
      sqlc.arg(origin_room_id)::text = '' OR EXISTS (
          SELECT 1 FROM work_item_room_links link
          WHERE link.work_item_id=wi.id
            AND link.link_type='origin'
            AND link.room_id=sqlc.arg(origin_room_id)::text
      )
  )
  AND (
      sqlc.arg(work_room_id)::text = '' OR EXISTS (
          SELECT 1 FROM work_item_room_links link
          WHERE link.work_item_id=wi.id
            AND link.link_type='work'
            AND link.room_id=sqlc.arg(work_room_id)::text
      )
  )
  AND (sqlc.arg(include_archived)::boolean OR wi.archived_at IS NULL)
  AND (
      NOT sqlc.arg(has_cursor)::boolean OR
      (wi.updated_at, wi.id) < (sqlc.arg(cursor_updated_at)::timestamptz, sqlc.arg(cursor_id)::text)
  )
ORDER BY wi.updated_at DESC, wi.id DESC
LIMIT sqlc.arg(page_limit)::int;

-- name: UpdateWorkItemMetadata :one
UPDATE work_items
SET title=sqlc.arg(title),
    description=sqlc.arg(description),
    priority=sqlc.arg(priority),
    updated_by_actor_id=sqlc.arg(updated_by_actor_id),
    version=version+1,
    updated_at=now()
WHERE id=sqlc.arg(id)::text AND tenant_id=sqlc.arg(tenant_id)::text
RETURNING id, tenant_id, number, kind, title, description, priority, state, resolution, version,
          created_by_actor_id, updated_by_actor_id, archived_at, created_at, updated_at,
          task_source_key, task_execution_generation, task_execution_status,
          task_execution_revision, task_execution_reason_code, task_desired_control,
          task_control_revision, task_control_settled_revision, task_control_outcome,
          task_control_source_kind, task_control_source_id, task_control_requested_by_actor_id,
          task_control_requested_at, task_control_payload,
          task_execution_updated_at, task_next_reconcile_at, task_worker_id,
          task_lease_token_hash, task_lease_generation, task_lease_expires_at;

-- name: TransitionWorkItem :one
UPDATE work_items
SET state=sqlc.arg(state),
    resolution=sqlc.narg(resolution),
    updated_by_actor_id=sqlc.arg(updated_by_actor_id),
    version=version+1,
    updated_at=now()
WHERE id=sqlc.arg(id)::text AND tenant_id=sqlc.arg(tenant_id)::text
RETURNING id, tenant_id, number, kind, title, description, priority, state, resolution, version,
          created_by_actor_id, updated_by_actor_id, archived_at, created_at, updated_at,
          task_source_key, task_execution_generation, task_execution_status,
          task_execution_revision, task_execution_reason_code, task_desired_control,
          task_control_revision, task_control_settled_revision, task_control_outcome,
          task_control_source_kind, task_control_source_id, task_control_requested_by_actor_id,
          task_control_requested_at, task_control_payload,
          task_execution_updated_at, task_next_reconcile_at, task_worker_id,
          task_lease_token_hash, task_lease_generation, task_lease_expires_at;

-- name: SetWorkItemArchived :one
UPDATE work_items
SET archived_at=CASE WHEN sqlc.arg(archived)::boolean THEN now() ELSE NULL END,
    updated_by_actor_id=sqlc.arg(updated_by_actor_id),
    version=version+1,
    updated_at=now()
WHERE id=sqlc.arg(id)::text AND tenant_id=sqlc.arg(tenant_id)::text
RETURNING id, tenant_id, number, kind, title, description, priority, state, resolution, version,
          created_by_actor_id, updated_by_actor_id, archived_at, created_at, updated_at,
          task_source_key, task_execution_generation, task_execution_status,
          task_execution_revision, task_execution_reason_code, task_desired_control,
          task_control_revision, task_control_settled_revision, task_control_outcome,
          task_control_source_kind, task_control_source_id, task_control_requested_by_actor_id,
          task_control_requested_at, task_control_payload,
          task_execution_updated_at, task_next_reconcile_at, task_worker_id,
          task_lease_token_hash, task_lease_generation, task_lease_expires_at;

-- name: TouchWorkItem :exec
UPDATE work_items
SET updated_by_actor_id=$3, updated_at=now()
WHERE id=$1 AND tenant_id=$2;

-- name: DeleteWorkItemDescriptionReferences :exec
DELETE FROM work_item_description_references WHERE work_item_id=$1;

-- name: CreateWorkItemDescriptionReference :exec
INSERT INTO work_item_description_references(work_item_id, tenant_id, actor_id, ordinal)
VALUES ($1, $2, $3, $4);

-- name: ListWorkItemDescriptionReferencesByItems :many
SELECT work_item_id, tenant_id, actor_id, ordinal, created_at
FROM work_item_description_references
WHERE work_item_id = ANY(sqlc.arg(work_item_ids)::text[])
ORDER BY work_item_id, ordinal;

-- name: GetWorkItemAssignment :one
SELECT work_item_id, tenant_id, actor_id, assigned_by_actor_id, assigned_at
FROM work_item_assignments
WHERE work_item_id=$1 AND actor_id=$2;

-- name: CreateWorkItemAssignment :one
INSERT INTO work_item_assignments(work_item_id, tenant_id, actor_id, assigned_by_actor_id)
VALUES ($1, $2, $3, $4)
RETURNING work_item_id, tenant_id, actor_id, assigned_by_actor_id, assigned_at;

-- name: DeleteWorkItemAssignment :execrows
DELETE FROM work_item_assignments WHERE work_item_id=$1 AND actor_id=$2;

-- name: ListWorkItemAssignmentsByItems :many
SELECT work_item_id, tenant_id, actor_id, assigned_by_actor_id, assigned_at
FROM work_item_assignments
WHERE work_item_id = ANY(sqlc.arg(work_item_ids)::text[])
ORDER BY work_item_id, assigned_at, actor_id;

-- name: GetWorkItemAccessGrant :one
SELECT work_item_id, tenant_id, actor_id, granted_by_actor_id, granted_at
FROM work_item_access_grants
WHERE work_item_id=$1 AND actor_id=$2;

-- name: CreateWorkItemAccessGrant :one
INSERT INTO work_item_access_grants(work_item_id, tenant_id, actor_id, granted_by_actor_id)
VALUES ($1, $2, $3, $4)
RETURNING work_item_id, tenant_id, actor_id, granted_by_actor_id, granted_at;

-- name: DeleteWorkItemAccessGrant :execrows
DELETE FROM work_item_access_grants WHERE work_item_id=$1 AND actor_id=$2;

-- name: ListWorkItemAccessGrantsByItems :many
SELECT work_item_id, tenant_id, actor_id, granted_by_actor_id, granted_at
FROM work_item_access_grants
WHERE work_item_id = ANY(sqlc.arg(work_item_ids)::text[])
ORDER BY work_item_id, granted_at, actor_id;

-- name: ListActorsByTenantIDs :many
SELECT id, tenant_id, kind, display_name, account_id, handle, created_at
FROM actors
WHERE tenant_id=sqlc.arg(tenant_id)::text
  AND id = ANY(sqlc.arg(actor_ids)::text[])
ORDER BY id;

-- name: CreateWorkItemActivity :one
INSERT INTO work_item_activities(
    id, work_item_id, tenant_id, kind, actor_id, from_state, to_state, target_actor_id
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING id, work_item_id, tenant_id, kind, actor_id, from_state, to_state,
          target_actor_id, comment_id, room_id, details, occurred_at;
