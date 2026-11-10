-- name: GetActiveWorkItemAgentAuthority :one
SELECT actor.id, actor.tenant_id, actor.kind, actor.display_name,
       actor.account_id, actor.handle, actor.created_at
FROM agent_registrations registration
JOIN actors actor
  ON actor.id=registration.actor_id
 AND actor.tenant_id=registration.tenant_id
 AND actor.kind='agent'
WHERE registration.agent_management_id=sqlc.arg(agent_management_id)::text
  AND registration.status='active';

-- name: GetWorkItemForAgent :one
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
  AND wi.tenant_id=sqlc.arg(tenant_id)::text
  AND (
      wi.created_by_actor_id=sqlc.arg(agent_actor_id)::text OR
      EXISTS (
          SELECT 1 FROM work_item_assignments assignment
          WHERE assignment.work_item_id=wi.id
            AND assignment.actor_id=sqlc.arg(agent_actor_id)::text
      ) OR
      EXISTS (
          SELECT 1 FROM work_item_description_references reference
          WHERE reference.work_item_id=wi.id
            AND reference.actor_id=sqlc.arg(agent_actor_id)::text
      ) OR
      EXISTS (
          SELECT 1 FROM work_item_comment_references reference
          WHERE reference.work_item_id=wi.id
            AND reference.actor_id=sqlc.arg(agent_actor_id)::text
      ) OR
      EXISTS (
          SELECT 1 FROM work_item_access_grants access_grant
          WHERE access_grant.work_item_id=wi.id
            AND access_grant.actor_id=sqlc.arg(agent_actor_id)::text
      )
  );

-- name: GetWorkItemForAgentForUpdate :one
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
  AND wi.tenant_id=sqlc.arg(tenant_id)::text
  AND (
      wi.created_by_actor_id=sqlc.arg(agent_actor_id)::text OR
      EXISTS (SELECT 1 FROM work_item_assignments a WHERE a.work_item_id=wi.id AND a.actor_id=sqlc.arg(agent_actor_id)::text) OR
      EXISTS (SELECT 1 FROM work_item_description_references r WHERE r.work_item_id=wi.id AND r.actor_id=sqlc.arg(agent_actor_id)::text) OR
      EXISTS (SELECT 1 FROM work_item_comment_references r WHERE r.work_item_id=wi.id AND r.actor_id=sqlc.arg(agent_actor_id)::text) OR
      EXISTS (SELECT 1 FROM work_item_access_grants g WHERE g.work_item_id=wi.id AND g.actor_id=sqlc.arg(agent_actor_id)::text)
  )
FOR UPDATE OF wi;

-- name: ListWorkItemsForAgent :many
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
  AND (sqlc.arg(kind_filter)::text = '' OR wi.kind=sqlc.arg(kind_filter)::text)
  AND (sqlc.arg(state_filter)::text = '' OR wi.state=sqlc.arg(state_filter)::text)
  AND (sqlc.arg(include_archived)::boolean OR wi.archived_at IS NULL)
  AND (
      sqlc.arg(work_room_id)::text = '' OR EXISTS (
          SELECT 1 FROM work_item_room_links link
          WHERE link.work_item_id=wi.id
            AND link.tenant_id=wi.tenant_id
            AND link.link_type='work'
            AND link.room_id=sqlc.arg(work_room_id)::text
      )
  )
  AND (
      wi.created_by_actor_id=sqlc.arg(agent_actor_id)::text OR
      EXISTS (SELECT 1 FROM work_item_assignments a WHERE a.work_item_id=wi.id AND a.actor_id=sqlc.arg(agent_actor_id)::text) OR
      EXISTS (SELECT 1 FROM work_item_description_references r WHERE r.work_item_id=wi.id AND r.actor_id=sqlc.arg(agent_actor_id)::text) OR
      EXISTS (SELECT 1 FROM work_item_comment_references r WHERE r.work_item_id=wi.id AND r.actor_id=sqlc.arg(agent_actor_id)::text) OR
      EXISTS (SELECT 1 FROM work_item_access_grants g WHERE g.work_item_id=wi.id AND g.actor_id=sqlc.arg(agent_actor_id)::text)
  )
  AND (
      NOT sqlc.arg(has_cursor)::boolean OR
      (wi.updated_at, wi.id) < (sqlc.arg(cursor_updated_at)::timestamptz, sqlc.arg(cursor_id)::text)
  )
ORDER BY wi.updated_at DESC, wi.id DESC
LIMIT sqlc.arg(page_limit)::int;

-- name: IsWorkItemAssignedToActor :one
SELECT EXISTS (
    SELECT 1 FROM work_item_assignments
    WHERE work_item_id=$1 AND actor_id=$2
);

-- name: CreateWorkItemComment :one
INSERT INTO work_item_comments(
    id, work_item_id, tenant_id, author_actor_id, body, segments
)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING id, work_item_id, tenant_id, author_actor_id, body, segments,
          version, deleted_at, created_at, updated_at;

-- name: GetWorkItemCommentForUpdate :one
SELECT id, work_item_id, tenant_id, author_actor_id, body, segments,
       version, deleted_at, created_at, updated_at
FROM work_item_comments
WHERE id=$1 AND work_item_id=$2
FOR UPDATE;

-- name: ListWorkItemComments :many
SELECT id, work_item_id, tenant_id, author_actor_id, body, segments,
       version, deleted_at, created_at, updated_at
FROM work_item_comments
WHERE work_item_id=sqlc.arg(work_item_id)::text
  AND (
      NOT sqlc.arg(has_cursor)::boolean OR
      (created_at, id) > (sqlc.arg(cursor_created_at)::timestamptz, sqlc.arg(cursor_id)::text)
  )
ORDER BY created_at, id
LIMIT sqlc.arg(page_limit)::int;

-- name: UpdateWorkItemComment :one
UPDATE work_item_comments
SET body=$3, segments=$4, version=version+1, updated_at=now()
WHERE id=$1 AND work_item_id=$2 AND deleted_at IS NULL
RETURNING id, work_item_id, tenant_id, author_actor_id, body, segments,
          version, deleted_at, created_at, updated_at;

-- name: SoftDeleteWorkItemComment :one
UPDATE work_item_comments
SET body='', segments='[]'::jsonb, version=version+1, deleted_at=now(), updated_at=now()
WHERE id=$1 AND work_item_id=$2 AND deleted_at IS NULL
RETURNING id, work_item_id, tenant_id, author_actor_id, body, segments,
          version, deleted_at, created_at, updated_at;

-- name: DeleteWorkItemCommentReferences :exec
DELETE FROM work_item_comment_references WHERE comment_id=$1;

-- name: ListWorkItemCommentReferenceActorIDs :many
SELECT actor_id
FROM work_item_comment_references
WHERE comment_id=$1
ORDER BY actor_id;

-- name: CreateWorkItemCommentReference :exec
INSERT INTO work_item_comment_references(comment_id, work_item_id, tenant_id, actor_id)
VALUES ($1, $2, $3, $4);

-- name: CreateWorkItemCommentActivity :one
INSERT INTO work_item_activities(
    id, work_item_id, tenant_id, kind, actor_id, comment_id
)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING id, work_item_id, tenant_id, kind, actor_id, from_state, to_state,
          target_actor_id, comment_id, room_id, details, occurred_at;

-- name: ListWorkItemTimelineRefs :many
SELECT entry_type, entry_id, occurred_at
FROM (
    SELECT 'activity'::text AS entry_type, id AS entry_id, occurred_at
    FROM work_item_activities
    WHERE work_item_id=sqlc.arg(work_item_id)::text
    UNION ALL
    SELECT 'comment'::text AS entry_type, id AS entry_id, created_at AS occurred_at
    FROM work_item_comments
    WHERE work_item_id=sqlc.arg(work_item_id)::text
) timeline
WHERE (
    NOT sqlc.arg(has_cursor)::boolean OR
    (occurred_at, entry_id) > (sqlc.arg(cursor_occurred_at)::timestamptz, sqlc.arg(cursor_id)::text)
)
ORDER BY occurred_at, entry_id
LIMIT sqlc.arg(page_limit)::int;

-- name: GetWorkItemComment :one
SELECT id, work_item_id, tenant_id, author_actor_id, body, segments,
       version, deleted_at, created_at, updated_at
FROM work_item_comments
WHERE id=$1 AND work_item_id=$2;

-- name: GetWorkItemActivity :one
SELECT id, work_item_id, tenant_id, kind, actor_id, from_state, to_state,
       target_actor_id, comment_id, room_id, details, occurred_at
FROM work_item_activities
WHERE id=$1 AND work_item_id=$2;
