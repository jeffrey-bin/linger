-- name: LockTenantDeliveryRooms :exec
-- Multi-Room writers take every Room sequence row they will advance in id
-- order before their first Room Event.
SELECT id FROM rooms
WHERE tenant_id=sqlc.arg(tenant_id)::text AND id=ANY(sqlc.arg(room_ids)::text[])
ORDER BY id FOR NO KEY UPDATE;

-- name: LockWorkItemDeliveryRooms :exec
SELECT id FROM rooms
WHERE tenant_id=sqlc.arg(tenant_id)::text AND (
  id=sqlc.arg(origin_room_id)::text OR id IN (
    SELECT room_id FROM message_cards WHERE tenant_id=sqlc.arg(tenant_id)::text
      AND work_item_id=sqlc.arg(work_item_id)::text
    UNION
    SELECT room_id FROM work_item_room_links WHERE tenant_id=sqlc.arg(tenant_id)::text
      AND work_item_id=sqlc.arg(work_item_id)::text
  )
)
ORDER BY id FOR NO KEY UPDATE;

-- name: LockTenantDeliveryAccountsForRooms :exec
-- The Task execution writer's Room lock; the same lock set as
-- LockTenantDeliveryRooms.
SELECT id FROM rooms
WHERE tenant_id=sqlc.arg(tenant_id)::text AND id=ANY(sqlc.arg(room_ids)::text[])
ORDER BY id FOR NO KEY UPDATE;

-- name: LockWorkItemDeliveryAccounts :exec
-- The Work Item change writer's Room lock; the same lock set as
-- LockWorkItemDeliveryRooms.
SELECT id FROM rooms
WHERE tenant_id=sqlc.arg(tenant_id)::text AND (
  id=sqlc.arg(origin_room_id)::text OR id IN (
    SELECT room_id FROM message_cards WHERE tenant_id=sqlc.arg(tenant_id)::text
      AND work_item_id=sqlc.arg(work_item_id)::text
    UNION
    SELECT room_id FROM work_item_room_links WHERE tenant_id=sqlc.arg(tenant_id)::text
      AND work_item_id=sqlc.arg(work_item_id)::text
  )
)
ORDER BY id FOR NO KEY UPDATE;

-- name: LockCardRooms :exec
-- Card decisions may later write other cards or their Work Item's linked
-- Rooms; take all of those Rooms in id order first.
WITH affected_items AS MATERIALIZED (
  SELECT work_item_id FROM message_cards WHERE tenant_id=sqlc.arg(tenant_id)::text
    AND message_id=ANY(sqlc.arg(message_ids)::text[]) AND work_item_id IS NOT NULL
)
SELECT id FROM rooms WHERE tenant_id=sqlc.arg(tenant_id)::text AND id IN (
  SELECT room_id FROM message_cards WHERE tenant_id=sqlc.arg(tenant_id)::text
    AND (message_id=ANY(sqlc.arg(message_ids)::text[]) OR work_item_id IN (SELECT work_item_id FROM affected_items))
  UNION
  SELECT room_id FROM work_item_room_links WHERE tenant_id=sqlc.arg(tenant_id)::text
    AND work_item_id IN (SELECT work_item_id FROM affected_items)
)
ORDER BY id FOR NO KEY UPDATE;

-- name: ListRoomMentionTargets :many
SELECT target.id,target.tenant_id,target.kind,target.display_name,
       target.account_id,target.handle,target.created_at
FROM room_members membership
JOIN actors target ON target.id=membership.actor_id AND target.tenant_id=membership.tenant_id
WHERE membership.room_id=collaboration_membership_room_id(sqlc.arg(room_id)::text)
  AND target.id=ANY(sqlc.arg(actor_ids)::text[])
ORDER BY target.id
FOR KEY SHARE OF membership;

-- name: ListTenantMentionTargets :many
SELECT target.id,target.tenant_id,target.kind,target.display_name,
       target.account_id,target.handle,target.created_at
FROM actors target
WHERE target.tenant_id=$1 AND target.id=ANY($2::text[])
ORDER BY target.id
FOR KEY SHARE OF target;

-- name: CreateRoomMemberState :exec
INSERT INTO room_member_states(room_id,actor_id,read_through_room_seq)
VALUES($1,$2,$3)
ON CONFLICT (room_id,actor_id) DO NOTHING;

-- name: GetRoomReadStateAuthority :one
SELECT room.id AS room_id,room.tenant_id,room.next_room_seq,
       caller.id AS actor_id,coalesce(state.read_through_room_seq,0)::bigint AS read_through_room_seq
FROM rooms room
JOIN actors caller ON caller.tenant_id=room.tenant_id AND caller.account_id=$2 AND caller.kind='human'
JOIN room_members membership
  ON membership.room_id=collaboration_membership_room_id(room.id)
 AND membership.actor_id=caller.id
LEFT JOIN room_member_states state ON state.room_id=room.id AND state.actor_id=caller.id
WHERE room.id=$1
FOR UPDATE OF membership;

-- name: AdvanceRoomMemberReadState :one
INSERT INTO room_member_states(room_id,actor_id,read_through_room_seq)
VALUES($1,$2,$3)
ON CONFLICT (room_id,actor_id) DO UPDATE
SET read_through_room_seq=greatest(room_member_states.read_through_room_seq,excluded.read_through_room_seq),
    updated_at=CASE
        WHEN excluded.read_through_room_seq>room_member_states.read_through_room_seq THEN now()
        ELSE room_member_states.updated_at
    END
RETURNING room_id,actor_id,read_through_room_seq,updated_at;

-- name: SetRoomMemberPin :one
INSERT INTO room_member_states(room_id,actor_id,read_through_room_seq,pinned_at)
VALUES(sqlc.arg(room_id)::text,sqlc.arg(actor_id)::text,0,
       CASE WHEN sqlc.arg(pinned)::boolean THEN now() ELSE NULL END)
ON CONFLICT (room_id,actor_id) DO UPDATE
SET pinned_at=CASE
        WHEN sqlc.arg(pinned)::boolean THEN coalesce(room_member_states.pinned_at,now())
        ELSE NULL
    END
RETURNING room_id,pinned_at;
