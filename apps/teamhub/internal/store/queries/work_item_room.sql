-- name: CreateWorkItemRoomLink :one
INSERT INTO work_item_room_links(
    work_item_id, tenant_id, link_type, room_id, origin_message_id, linked_by_actor_id
)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING work_item_id, tenant_id, link_type, room_id, origin_message_id,
          linked_by_actor_id, created_at;

-- name: GetWorkItemRoomLink :one
SELECT work_item_id, tenant_id, link_type, room_id, origin_message_id,
       linked_by_actor_id, created_at
FROM work_item_room_links
WHERE work_item_id=$1 AND link_type=$2;

-- name: ListWorkItemRoomLinksByItems :many
SELECT work_item_id, tenant_id, link_type, room_id, origin_message_id,
       linked_by_actor_id, created_at
FROM work_item_room_links
WHERE work_item_id=ANY(sqlc.arg(work_item_ids)::text[])
ORDER BY work_item_id, link_type;

-- name: CreateWorkItemRoomActivity :one
INSERT INTO work_item_activities(
    id, work_item_id, tenant_id, kind, actor_id, room_id
)
VALUES ($1, $2, $3, 'work_room_created', $4, $5)
RETURNING id, work_item_id, tenant_id, kind, actor_id, from_state, to_state,
          target_actor_id, comment_id, room_id, details, occurred_at;
