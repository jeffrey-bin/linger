-- name: GetRoomParticipationForAccount :one
SELECT NOT room_actor_participating(room.id,caller.id)::boolean AS has_left
FROM rooms room
JOIN actors caller ON caller.tenant_id=room.tenant_id AND caller.account_id=$2 AND caller.kind='human'
JOIN active_room_members membership ON membership.room_id=collaboration_membership_room_id(room.id) AND membership.actor_id=caller.id
WHERE room.id=$1;

-- name: SetRoomParticipation :exec
INSERT INTO room_member_states(room_id,actor_id,read_through_room_seq,left_at,left_room_seq,participation_epoch_id)
VALUES(sqlc.arg(room_id),sqlc.arg(actor_id),sqlc.arg(room_seq),CASE WHEN sqlc.arg(has_left)::boolean THEN clock_timestamp() ELSE NULL END,sqlc.arg(room_seq),(SELECT membership_epoch_id FROM room_members WHERE room_id=sqlc.arg(room_id) AND actor_id=sqlc.arg(actor_id)))
ON CONFLICT (room_id,actor_id) DO UPDATE
SET participation_epoch_id=excluded.participation_epoch_id,left_at=excluded.left_at,left_room_seq=excluded.left_room_seq,
    read_through_room_seq=greatest(room_member_states.read_through_room_seq,excluded.read_through_room_seq),updated_at=now();

-- name: SetThreadParticipationReadStates :exec
INSERT INTO room_member_states(room_id,actor_id,read_through_room_seq,left_at,left_room_seq,participation_epoch_id)
SELECT child.id,sqlc.arg(actor_id),child.next_room_seq,CASE WHEN sqlc.arg(has_left)::boolean THEN clock_timestamp() ELSE NULL END,child.next_room_seq,membership.membership_epoch_id
FROM rooms child
JOIN room_members membership ON membership.room_id=child.parent_room_id AND membership.actor_id=sqlc.arg(actor_id)
WHERE child.parent_room_id=sqlc.arg(room_id)::text
ON CONFLICT (room_id,actor_id) DO UPDATE SET left_room_seq=excluded.left_room_seq,left_at=excluded.left_at,participation_epoch_id=excluded.participation_epoch_id,read_through_room_seq=greatest(room_member_states.read_through_room_seq,excluded.read_through_room_seq);
