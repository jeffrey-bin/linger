-- name: ListDecisionsByMessages :many
-- A card page never reads a permission card's screenshot.
SELECT id,tenant_id,room_id,message_id,kind,requested_by_actor_id,decider_actor_id,alter_ego_task_id,status,
       request,view,answer,result,expires_at,decided_at,decided_by_actor_id,finished_at,created_at,
       (screenshot IS NOT NULL)::boolean AS has_screenshot
FROM decisions
WHERE message_id=ANY(sqlc.arg(message_ids)::text[]);

-- name: InsertDecision :one
-- A lifetime of zero seconds makes a card that waits until it is answered.
INSERT INTO decisions (id,tenant_id,room_id,message_id,kind,requested_by_actor_id,decider_actor_id,
    alter_ego_task_id,request,view,expires_at,screenshot,screenshot_media_type)
VALUES (sqlc.arg(id)::text,sqlc.arg(tenant_id)::text,sqlc.arg(room_id)::text,sqlc.arg(message_id)::text,
    sqlc.arg(kind)::text,sqlc.arg(requested_by_actor_id)::text,sqlc.arg(decider_actor_id)::text,
    sqlc.narg(alter_ego_task_id)::text,sqlc.arg(request)::jsonb,sqlc.arg(view)::jsonb,
    CASE WHEN sqlc.arg(lifetime_seconds)::float8>0
      THEN clock_timestamp()+make_interval(secs => sqlc.arg(lifetime_seconds)::float8) END,
    sqlc.narg(screenshot)::bytea,sqlc.narg(screenshot_media_type)::text)
RETURNING expires_at;

-- name: LocateDecision :one
SELECT tenant_id,room_id FROM decisions WHERE id=$1;

-- name: GetDecisionAuthority :one
-- Any member of the card's Room sees the decision; the caller row names the
-- member deciding it. requester_visibility_scope is the requesting Agent's.
-- A connection authorization stays open while authorizing, so the Human can
-- still cancel the OAuth they started.
SELECT decision.message_id,decision.decider_actor_id,caller.id AS caller_actor_id,card.version AS card_version,
       decision.kind,decision.tenant_id,decision.room_id,decision.requested_by_actor_id,
       coalesce(decision.alter_ego_task_id,'')::text AS alter_ego_task_id,decision.request,decision.view,decision.status,
       ((decision.status='pending' OR decision.kind='connection_auth' AND decision.status='authorizing')
         AND (decision.expires_at IS NULL OR decision.expires_at>clock_timestamp()))::boolean AS open,
       coalesce(registration.visibility_scope,'')::text AS requester_visibility_scope
FROM decisions decision
JOIN message_cards card ON card.message_id=decision.message_id
LEFT JOIN agent_registrations registration
  ON registration.actor_id=decision.requested_by_actor_id AND registration.tenant_id=decision.tenant_id
JOIN actors caller
  ON caller.tenant_id=decision.tenant_id
 AND caller.account_id=sqlc.arg(account_id)::text
 AND caller.kind='human'
JOIN active_room_members membership
  ON membership.room_id=collaboration_membership_room_id(decision.room_id)
 AND membership.actor_id=caller.id
WHERE decision.id=sqlc.arg(decision_id)::text
FOR UPDATE OF decision, card;

-- name: GetHumanRoomMemberActor :one
SELECT actor.*
FROM actors actor
JOIN active_room_members membership
  ON membership.actor_id=actor.id
 AND membership.tenant_id=actor.tenant_id
 AND membership.room_id=collaboration_membership_room_id(sqlc.arg(room_id)::text)
WHERE actor.id=sqlc.arg(actor_id)::text
  AND actor.tenant_id=sqlc.arg(tenant_id)::text
  AND actor.kind=sqlc.arg(kind)::text;

-- name: GetRoomCreationSubmissionReplay :one
SELECT decision.id,decision.message_id,idempotency.request_hash,
       idempotency.response_status,idempotency.response_body
FROM decisions decision
JOIN command_replays idempotency
  ON idempotency.scope='agent:'||decision.requested_by_actor_id
 AND idempotency.resource_id=decision.message_id
WHERE decision.kind='room_creation'
  AND decision.requested_by_actor_id=sqlc.arg(agent_actor_id)::text
  AND decision.request->>'submission_id'=sqlc.arg(submission_id)::text
  AND idempotency.operation=sqlc.arg(operation)::text
  AND idempotency.key=sqlc.arg(submission_id)::text;

-- name: GetTaskOriginRoomID :one
SELECT room_id FROM work_item_room_links
WHERE work_item_id=sqlc.arg(work_item_id)::text AND tenant_id=sqlc.arg(tenant_id)::text AND link_type='origin';

-- name: HumanAndAgentShareRoom :one
SELECT (
  EXISTS(
    SELECT 1 FROM active_room_members member
    JOIN actors actor ON actor.id=member.actor_id AND actor.tenant_id=member.tenant_id AND actor.kind='human'
    WHERE member.room_id=sqlc.arg(room_id)::text AND member.tenant_id=sqlc.arg(tenant_id)::text
      AND member.actor_id=sqlc.arg(human_actor_id)::text
  )
  AND EXISTS(
    SELECT 1 FROM active_room_members member
    WHERE member.room_id=sqlc.arg(room_id)::text AND member.tenant_id=sqlc.arg(tenant_id)::text
      AND member.actor_id=sqlc.arg(agent_actor_id)::text
  )
)::boolean;

-- name: GetPendingProfileSetupCard :one
-- The AnotherMe setup card still open in its Direct Room. The pending
-- requester index keeps this cheap on the Human's message path.
SELECT message_id FROM decisions
WHERE requested_by_actor_id=sqlc.arg(agent_actor_id)::text AND status='pending'
  AND room_id=sqlc.arg(room_id)::text AND kind IN ('profile_setup_apps','profile_setup_sources')
ORDER BY created_at DESC,id DESC
LIMIT 1;

-- name: HumanWroteInRoom :one
-- Whether the Human has written in the Room themselves: published
-- conversation Messages that are not a card's recorded result.
SELECT EXISTS(
  SELECT 1 FROM messages
  WHERE room_id=sqlc.arg(room_id)::text AND author_actor_id=sqlc.arg(human_actor_id)::text
    AND message_kind='conversation' AND room_seq IS NOT NULL AND card_context_message_id IS NULL
)::boolean;
