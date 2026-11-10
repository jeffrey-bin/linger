-- name: GetHumanMessageReactionAuthority :one
SELECT message.id AS message_id,message.tenant_id,message.room_id,caller.id AS actor_id,
       (message.message_kind='conversation'
        AND message.card_context_message_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM message_cards card WHERE card.message_id=message.id)
       )::boolean AS supported
FROM messages message
JOIN actors caller
  ON caller.tenant_id=message.tenant_id
 AND caller.account_id=sqlc.arg(account_id)::text
 AND caller.kind='human'
JOIN room_members membership
  ON membership.tenant_id=message.tenant_id
 AND membership.room_id=collaboration_membership_room_id(message.room_id)
 AND membership.actor_id=caller.id
WHERE message.id=sqlc.arg(message_id)::text
  AND message.room_id=sqlc.arg(room_id)::text
FOR KEY SHARE OF message,membership;

-- name: GetAgentMessageReactionAuthority :one
SELECT message.id AS message_id,message.tenant_id,message.room_id,
       collaboration_membership_room_id(message.room_id) AS membership_room_id,
       (message.message_kind='conversation'
        AND message.card_context_message_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM message_cards card WHERE card.message_id=message.id)
       )::boolean AS supported
FROM messages message
JOIN room_members membership
  ON membership.tenant_id=message.tenant_id
 AND membership.room_id=collaboration_membership_room_id(message.room_id)
 AND membership.actor_id=sqlc.arg(agent_actor_id)::text
JOIN rooms room
  ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id AND room.deletion_started_at IS NULL
WHERE message.id=sqlc.arg(message_id)::text
  AND message.tenant_id=sqlc.arg(tenant_id)::text
FOR KEY SHARE OF message,membership;

-- name: CountMessageReactions :one
SELECT count(*)::bigint FROM message_reactions WHERE message_id=$1;

-- name: MessageReactionExists :one
SELECT EXISTS(
  SELECT 1 FROM message_reactions
  WHERE message_id=$1 AND actor_id=$2 AND reaction_id=$3
)::boolean;

-- name: PutMessageReaction :execrows
INSERT INTO message_reactions(message_id,tenant_id,room_id,actor_id,reaction_id)
VALUES($1,$2,$3,$4,$5)
ON CONFLICT DO NOTHING;

-- name: DeleteMessageReaction :execrows
DELETE FROM message_reactions
WHERE message_id=$1 AND actor_id=$2 AND reaction_id=$3;

-- name: ListMessageReactionsForMessages :many
SELECT message_id,reaction_id,actor_id,created_at
FROM message_reactions
WHERE message_id=ANY(sqlc.arg(message_ids)::text[])
ORDER BY message_id,created_at,reaction_id,actor_id;
