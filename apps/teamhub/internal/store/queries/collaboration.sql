-- name: GetRoomForAccount :one
SELECT r.id, r.tenant_id, r.name, r.description, r.created_by_actor_id,
       r.next_room_seq, r.created_at, r.updated_at,
       r.deletion_started_at,r.deletion_started_by_actor_id,
       r.deleted_at, r.deleted_by_actor_id,
       r.direct_human_actor_id, r.direct_agent_actor_id, r.parent_room_id, r.root_message_id,
       r.team_md_raw_markdown, r.team_md_collaborate_pattern, r.team_md_document,
       r.team_md_revision, r.team_md_updated_at, r.team_md_updated_by_actor_id
FROM rooms r
JOIN actors caller ON caller.tenant_id=r.tenant_id AND caller.account_id=$2 AND caller.kind='human'
JOIN rooms access_room
  ON access_room.id=COALESCE(r.parent_room_id, r.id)
 AND access_room.deleted_at IS NULL
JOIN room_members membership
  ON membership.room_id=access_room.id AND membership.actor_id=caller.id
WHERE r.id=$1 AND r.deleted_at IS NULL
FOR KEY SHARE OF membership;

-- name: GetRoomTenantID :one
SELECT tenant_id
FROM rooms
WHERE id=$1 AND deleted_at IS NULL;

-- name: ListRoomsForTenantAccount :many
SELECT r.id, r.tenant_id, r.name, r.description, r.created_by_actor_id,
       coalesce((
         SELECT max(visible_event.room_seq)
         FROM room_events visible_event
         WHERE visible_event.room_id=r.id
           AND (participation.left_at IS NULL OR visible_event.room_seq<=participation.left_room_seq)
           AND NOT (
             visible_event.event_type='message.created' AND EXISTS (
               SELECT 1 FROM messages hidden_message
               WHERE hidden_message.id=visible_event.resource_id
                 AND hidden_message.room_id=visible_event.room_id
                 AND hidden_message.message_kind='task_terminal_notice'
             )
           )
       ),0)::bigint AS next_room_seq,
       r.created_at, r.updated_at,
       caller.id AS caller_actor_id,
       (participation.left_at IS NOT NULL)::boolean AS has_left,
       coalesce(state.read_through_room_seq,0)::bigint AS read_through_room_seq,
       (SELECT count(*) FROM room_events message_event
        JOIN messages unread_message
          ON unread_message.id=message_event.resource_id
         AND unread_message.room_id=message_event.room_id
        WHERE message_event.room_id=r.id AND message_event.event_type='message.created' AND participation.left_at IS NULL
          AND unread_message.message_kind='conversation'
          AND message_event.room_seq>coalesce(state.read_through_room_seq,0)
          AND message_event.actor_id<>caller.id)::bigint AS unread_message_count,
       ((SELECT count(*) FROM messages mentioning
        WHERE mentioning.room_id=r.id AND mentioning.mentioned_actor_ids<>'{}'
          AND caller.id=ANY(mentioning.mentioned_actor_ids) AND participation.left_at IS NULL
          AND mentioning.room_seq>coalesce(state.read_through_room_seq,0)) +
        (SELECT count(*) FROM room_events comment_event
         WHERE comment_event.room_id=r.id AND comment_event.event_type='document.comment.changed'
           AND participation.left_at IS NULL
           AND comment_event.room_seq>coalesce(state.read_through_room_seq,0)
           AND comment_event.payload->'attention_actor_ids' @> jsonb_build_array(caller.id)))::bigint AS unread_mention_count,
       (latest.message_id IS NOT NULL)::boolean AS latest_message_present,
       coalesce(latest.message_id,'')::text AS latest_message_id,
       coalesce(latest.message_room_seq,0)::bigint AS latest_message_room_seq,
       coalesce(latest.raw_message,'')::text AS latest_message_raw_message,
       latest.message_created_at AS latest_message_created_at,
       coalesce(latest.author_id,'')::text AS latest_message_author_id,
       coalesce(latest.author_kind,'')::text AS latest_message_author_kind,
       coalesce(latest.author_display_name,'')::text AS latest_message_author_display_name,
       (r.direct_agent_actor_id IS NOT NULL)::boolean AS is_direct,
       coalesce(direct_peer.id,'')::text AS direct_peer_id,
       coalesce(direct_peer.kind,'')::text AS direct_peer_kind,
       coalesce(direct_peer.display_name,'')::text AS direct_peer_display_name,
       coalesce(direct_registration.status='active',false)::boolean AS direct_peer_active,
       (r.parent_room_id IS NOT NULL)::boolean AS is_thread,
       coalesce(r.parent_room_id,'')::text AS parent_room_id,
       coalesce(r.root_message_id,'')::text AS root_message_id,
       state.pinned_at,
       coalesce(preview.ids,'{}')::text[] AS member_preview_ids,
       coalesce(preview.kinds,'{}')::text[] AS member_preview_kinds,
       coalesce(preview.names,'{}')::text[] AS member_preview_names
FROM rooms r
JOIN actors caller ON caller.tenant_id=r.tenant_id AND caller.account_id=sqlc.arg(account_id)::text AND caller.kind='human'
JOIN rooms access_room
  ON access_room.id=COALESCE(r.parent_room_id, r.id)
 AND access_room.deleted_at IS NULL
JOIN active_room_members membership
  ON membership.room_id=access_room.id AND membership.actor_id=caller.id
LEFT JOIN room_member_states participation ON participation.room_id=access_room.id AND participation.actor_id=caller.id AND participation.participation_epoch_id=membership.membership_epoch_id
LEFT JOIN room_member_states state ON state.room_id=r.id AND state.actor_id=caller.id
LEFT JOIN actors direct_peer
  ON direct_peer.id=r.direct_agent_actor_id AND direct_peer.tenant_id=r.tenant_id
LEFT JOIN agent_registrations direct_registration
  ON direct_registration.actor_id=r.direct_agent_actor_id AND direct_registration.tenant_id=r.tenant_id
LEFT JOIN LATERAL (
    SELECT message.id AS message_id,event.room_seq AS message_room_seq,
           message.body AS raw_message,message.created_at AS message_created_at,
           author.id AS author_id,author.kind AS author_kind,author.display_name AS author_display_name
    FROM room_events event
    JOIN messages message ON message.id=event.resource_id AND message.room_id=event.room_id
    JOIN actors author ON author.id=message.author_actor_id AND author.tenant_id=message.tenant_id
    WHERE event.room_id=r.id AND event.event_type='message.created'
      AND (participation.left_at IS NULL OR event.room_seq<=participation.left_room_seq)
      AND message.message_kind='conversation'
      AND message.card_context_message_id IS NULL
    ORDER BY event.room_seq DESC
    LIMIT 1
) latest ON true
-- The avatar mosaic: the first nine current members of the Room a Thread
-- belongs to, Humans and Agents alike, in join order (room_members_room_joined_idx).
LEFT JOIN LATERAL (
    SELECT array_agg(first_member.id ORDER BY first_member.joined_at,first_member.id) AS ids,
           array_agg(first_member.kind ORDER BY first_member.joined_at,first_member.id) AS kinds,
           array_agg(first_member.display_name ORDER BY first_member.joined_at,first_member.id) AS names
    FROM (
        SELECT member_actor.id,member_actor.kind,member_actor.display_name,preview_member.joined_at
        FROM active_room_members preview_member
        JOIN actors member_actor
          ON member_actor.id=preview_member.actor_id AND member_actor.tenant_id=preview_member.tenant_id
        WHERE preview_member.room_id=access_room.id
        ORDER BY preview_member.joined_at,preview_member.actor_id
        LIMIT 9
    ) first_member
) preview ON true
WHERE r.tenant_id=sqlc.arg(tenant_id)::text
  AND r.deleted_at IS NULL
  AND (r.parent_room_id IS NULL OR (participation.left_at IS NULL AND EXISTS (
      SELECT 1 FROM thread_room_list_actors listed
      WHERE listed.thread_room_id=r.id AND listed.actor_id=caller.id
  )))
  AND NOT EXISTS (
    SELECT 1 FROM work_item_room_links work_room
    WHERE work_room.tenant_id=r.tenant_id
      AND work_room.room_id=r.id
      AND work_room.link_type='work'
  )
  AND (sqlc.arg(cursor)::text = '' OR (r.created_at, r.id) > (
      SELECT created_at, id FROM rooms WHERE id=sqlc.arg(cursor)::text AND tenant_id=sqlc.arg(tenant_id)::text
  ))
ORDER BY r.created_at, r.id
LIMIT sqlc.arg(page_limit)::int;

-- name: CreateRoom :one
INSERT INTO rooms(id, tenant_id, name, description, created_by_actor_id)
VALUES ($1, $2, $3, $4, $5)
RETURNING id, tenant_id, name, description, created_by_actor_id,
          next_room_seq, created_at, updated_at,
          deletion_started_at,deletion_started_by_actor_id,
          deleted_at, deleted_by_actor_id,
          direct_human_actor_id, direct_agent_actor_id, parent_room_id, root_message_id,
          team_md_raw_markdown, team_md_collaborate_pattern, team_md_document,
          team_md_revision, team_md_updated_at, team_md_updated_by_actor_id;

-- name: UpdateRoom :one
UPDATE rooms
SET name=$2,description=$3,updated_at=now()
WHERE id=$1
RETURNING id,tenant_id,name,description,created_by_actor_id,next_room_seq,created_at,updated_at,
          deletion_started_at,deletion_started_by_actor_id,
          deleted_at,deleted_by_actor_id,
          direct_human_actor_id,direct_agent_actor_id,parent_room_id,root_message_id,
          team_md_raw_markdown,team_md_collaborate_pattern,team_md_document,
          team_md_revision,team_md_updated_at,team_md_updated_by_actor_id;

-- name: CreateRoomMember :one
INSERT INTO room_members(room_id,tenant_id,actor_id,role,added_by_actor_id)
SELECT $1,$2,$3,$4,$5
FROM rooms
WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL
RETURNING *;

-- name: UpdateRoomMemberRole :one
UPDATE room_members SET role=$3,updated_at=now()
WHERE room_id=$1 AND actor_id=$2
RETURNING *;

-- name: ListRoomBoundDocumentIDsForLock :many
-- Every Room-bound Document, in any binding status, for the Document lock that
-- precedes delivery Account locks on Room membership writes.
SELECT document_id FROM document_context_bindings
WHERE room_id=sqlc.arg(room_id)::text AND binding_kind='room'
ORDER BY document_id;

-- name: DeleteRoomMemberForMembershipEpoch :exec
DELETE FROM room_members
WHERE membership_epoch_id=sqlc.arg(membership_epoch_id)::text;

-- name: GetRoomOwnerAuthority :one
SELECT r.tenant_id,caller.id AS caller_actor_id,membership.role
FROM rooms r
JOIN actors caller ON caller.tenant_id=r.tenant_id AND caller.account_id=$2 AND caller.kind='human'
JOIN room_members membership ON membership.room_id=r.id AND membership.actor_id=caller.id
WHERE r.id=$1 AND r.deleted_at IS NULL
  AND r.deletion_started_at IS NULL
FOR UPDATE OF membership;

-- name: ListRoomMembersForDeletion :many
SELECT membership.actor_id, actor.kind AS actor_kind
FROM active_room_members membership
JOIN actors actor
  ON actor.id=membership.actor_id
 AND actor.tenant_id=membership.tenant_id
WHERE membership.room_id=sqlc.arg(room_id)::text
ORDER BY membership.actor_id;

-- name: HasWorkRoomLink :one
SELECT EXISTS(
    SELECT 1 FROM work_item_room_links
    WHERE room_id=sqlc.arg(room_id)::text AND link_type='work'
);

-- name: BeginRoomDeletion :one
UPDATE rooms
SET deletion_started_at=sqlc.arg(deletion_started_at)::timestamptz,
    deletion_started_by_actor_id=sqlc.arg(deletion_started_by_actor_id)::text,
    updated_at=sqlc.arg(deletion_started_at)::timestamptz
WHERE id=sqlc.arg(room_id)::text
  AND deletion_started_at IS NULL
  AND deleted_at IS NULL
RETURNING id;

-- name: GetDeletingRoomForUpdate :one
SELECT tenant_id,deletion_started_by_actor_id
FROM rooms
WHERE id=sqlc.arg(room_id)::text
  AND deletion_started_at IS NOT NULL
  AND deleted_at IS NULL
FOR NO KEY UPDATE;

-- name: HasUnfinalizedRoomMembershipsForDeletion :one
SELECT EXISTS(
    SELECT 1
    FROM room_members
    WHERE room_id=sqlc.arg(room_id)::text
);

-- name: AcquireRoomMutationFence :exec
SELECT pg_advisory_xact_lock_shared(
    hashtextextended('room-mutation|' || sqlc.arg(room_id)::text,0)
);

-- name: GetActiveRoomForMutation :one
SELECT id
FROM rooms
WHERE id=sqlc.arg(room_id)::text
  AND deletion_started_at IS NULL
  AND deleted_at IS NULL;

-- name: FinalizeRoomDeletion :one
UPDATE rooms
SET deleted_at=sqlc.arg(deleted_at)::timestamptz,
    deleted_by_actor_id=deletion_started_by_actor_id,
    updated_at=sqlc.arg(deleted_at)::timestamptz
WHERE id=sqlc.arg(room_id)::text
  AND deletion_started_at IS NOT NULL
  AND deleted_at IS NULL
  AND NOT EXISTS(
      SELECT 1
      FROM room_members
      WHERE room_id=sqlc.arg(room_id)::text
  )
RETURNING id;

-- name: GetRoomMemberForUpdate :one
SELECT membership.room_id,membership.tenant_id,membership.actor_id,membership.role,
       membership.added_by_actor_id,membership.joined_at,membership.updated_at,
       membership.membership_epoch_id,
       member.kind AS actor_kind,member.display_name AS actor_display_name,
       adder.kind AS adder_kind,adder.display_name AS adder_display_name
FROM room_members membership
JOIN actors member ON member.id=membership.actor_id AND member.tenant_id=membership.tenant_id
JOIN actors adder ON adder.id=membership.added_by_actor_id AND adder.tenant_id=membership.tenant_id
WHERE membership.room_id=$1 AND membership.actor_id=$2
FOR UPDATE OF membership;

-- name: GetRoomMemberForNoKeyUpdate :one
SELECT membership.room_id,membership.tenant_id,membership.actor_id,membership.role,
       membership.added_by_actor_id,membership.joined_at,membership.updated_at,
       membership.membership_epoch_id,
       member.kind AS actor_kind,member.display_name AS actor_display_name,
       adder.kind AS adder_kind,adder.display_name AS adder_display_name
FROM room_members membership
JOIN actors member ON member.id=membership.actor_id AND member.tenant_id=membership.tenant_id
JOIN actors adder ON adder.id=membership.added_by_actor_id AND adder.tenant_id=membership.tenant_id
WHERE membership.room_id=$1 AND membership.actor_id=$2
FOR NO KEY UPDATE OF membership;

-- name: GetRoomActorMember :one
SELECT actor.id,actor.tenant_id,actor.kind,actor.display_name,actor.account_id,actor.handle,actor.created_at
FROM active_room_members membership
JOIN actors actor ON actor.id=membership.actor_id AND actor.tenant_id=membership.tenant_id
WHERE membership.room_id=$1 AND membership.actor_id=$2
FOR KEY SHARE OF membership;

-- name: ListRoomMembersForAccount :many
-- Keep authorization separate from the member projection. Flattening both active
-- membership views with all Actor joins makes custom-plan search dominate this read.
WITH authorized_room AS MATERIALIZED (
    SELECT room.id,room.tenant_id
    FROM rooms room
    JOIN actors caller ON caller.tenant_id=room.tenant_id
      AND caller.account_id=sqlc.arg(account_id)::text AND caller.kind='human'
    JOIN active_room_members caller_membership
      ON caller_membership.room_id=room.id AND caller_membership.actor_id=caller.id
    WHERE room.id=collaboration_membership_room_id(sqlc.arg(room_id)::text)
      AND room.deleted_at IS NULL
)
SELECT membership.room_id,membership.tenant_id,membership.actor_id,membership.role,
       membership.added_by_actor_id,membership.joined_at,membership.updated_at,
       member.kind AS actor_kind,member.display_name AS actor_display_name,
       adder.kind AS adder_kind,adder.display_name AS adder_display_name
FROM authorized_room
JOIN active_room_members membership ON membership.room_id=authorized_room.id
  AND membership.tenant_id=authorized_room.tenant_id
JOIN actors member ON member.id=membership.actor_id AND member.tenant_id=membership.tenant_id
JOIN actors adder ON adder.id=membership.added_by_actor_id AND adder.tenant_id=membership.tenant_id
WHERE sqlc.arg(cursor)::text='' OR (membership.joined_at,membership.actor_id)>(
    SELECT joined_at,actor_id FROM active_room_members
    WHERE room_id=authorized_room.id AND actor_id=sqlc.arg(cursor)::text
)
ORDER BY membership.joined_at,membership.actor_id
LIMIT sqlc.arg(page_limit)::int;

-- name: CountRoomOwners :one
SELECT count(*) FROM active_room_members WHERE room_id=$1 AND role='owner';

-- name: CreateMessage :one
-- clock_timestamp keeps Messages written in one transaction in write order.
-- Contexts and attachments arrive already validated, in their order.
INSERT INTO messages(id, tenant_id, room_id, author_actor_id, body, segments, card_context_message_id, message_kind, local_run_id, notice, card_title, card_kind, created_at,
                     reply_to_message_id, context_message_ids, attachments, fired_routine_id, fired_routine_instruction)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, sqlc.narg(notice)::jsonb, sqlc.narg(card_title), sqlc.narg(card_kind), clock_timestamp(),
        sqlc.narg(reply_to_message_id), coalesce(sqlc.narg(context_message_ids)::text[],'{}'),
        coalesce(sqlc.narg(attachments)::jsonb,'[]'::jsonb), sqlc.narg(fired_routine_id), sqlc.narg(fired_routine_instruction))
RETURNING id, tenant_id, room_id, author_actor_id, body, segments,
          card_context_message_id, message_kind, created_at, local_run_id, card_title;

-- A Run an Agent request names owns the Message only while it runs, belongs
-- to the author and shows its status in the Message's collaboration Room.
-- name: ResolveMessageRunClaim :one
SELECT run.run_id
FROM agent_local_runs run
JOIN agent_execution_contexts context ON context.context_key=run.context_key
WHERE run.run_id=sqlc.arg(run_id)::text AND run.status='running'
  AND context.tenant_id=sqlc.arg(tenant_id)::text
  AND context.agent_actor_id=sqlc.arg(agent_actor_id)::text
  AND collaboration_membership_room_id(run.status_room_id)=collaboration_membership_room_id(sqlc.arg(room_id)::text);

-- name: GetMessageForAccount :one
SELECT m.id, m.tenant_id, m.room_id, m.author_actor_id, m.body, m.segments,
       m.card_context_message_id, m.message_kind, m.notice, m.card_title, m.card_kind,
       m.created_at,
       m.reply_to_message_id,
       (card.message_id IS NOT NULL)::boolean AS has_card,
       author.kind AS author_kind,author.display_name AS author_display_name,
       author.account_id AS author_account_id,author.handle AS author_handle,
       author.created_at AS author_created_at
FROM messages m
JOIN rooms r ON r.id=m.room_id
JOIN actors author ON author.id=m.author_actor_id AND author.tenant_id=m.tenant_id
LEFT JOIN message_cards card ON card.message_id=m.id
WHERE m.id=$1 AND m.room_id=$2
  AND m.message_kind NOT IN ('agent_runtime','task_terminal_notice')
  AND EXISTS (
      SELECT 1 FROM actors caller
      JOIN active_room_members membership
        ON membership.actor_id=caller.id
       AND membership.room_id=collaboration_membership_room_id(r.id)
      WHERE caller.tenant_id=r.tenant_id AND caller.account_id=$3 AND caller.kind='human'
        -- After leaving, only Messages up to the Room's frozen position, as in the Message list.
        AND (room_actor_participating(r.id,caller.id) OR EXISTS (
          SELECT 1 FROM room_member_states frozen JOIN room_events saved ON saved.room_id=frozen.room_id
          WHERE frozen.room_id=r.id AND frozen.actor_id=caller.id
            AND frozen.participation_epoch_id=membership.membership_epoch_id
            AND frozen.left_at IS NOT NULL AND saved.resource_id=m.id AND saved.event_type='message.created'
            AND saved.room_seq<=frozen.left_room_seq
        ))
  );

-- name: ListMessagesForRoomAccount :many
WITH message_page AS (
  SELECT m.id
  FROM messages m
  JOIN rooms r ON r.id=m.room_id
  WHERE m.room_id=sqlc.arg(room_id)::text
    AND m.message_kind NOT IN ('agent_runtime','task_terminal_notice')
    AND EXISTS (
        SELECT 1 FROM actors caller
        JOIN active_room_members membership
          ON membership.actor_id=caller.id
         AND membership.room_id=collaboration_membership_room_id(r.id)
        WHERE caller.tenant_id=r.tenant_id AND caller.account_id=sqlc.arg(account_id)::text AND caller.kind='human'
          AND (room_actor_participating(r.id,caller.id) OR EXISTS (
            SELECT 1 FROM room_member_states frozen JOIN room_events saved ON saved.room_id=frozen.room_id
            WHERE frozen.room_id=r.id AND frozen.actor_id=caller.id
              AND frozen.participation_epoch_id=membership.membership_epoch_id
              AND frozen.left_at IS NOT NULL AND saved.resource_id=m.id AND saved.event_type='message.created'
              AND saved.room_seq<=frozen.left_room_seq
          ))
    )
    AND (sqlc.arg(cursor)::text = '' OR (m.created_at, m.id) < (
        SELECT created_at, id FROM messages WHERE id=sqlc.arg(cursor)::text AND room_id=sqlc.arg(room_id)::text
    ))
  ORDER BY m.created_at DESC, m.id DESC
  LIMIT sqlc.arg(page_limit)::int
)
SELECT m.id, m.tenant_id, m.room_id, m.author_actor_id, m.body, m.segments,
       m.card_context_message_id, m.message_kind, m.notice, m.card_title, m.card_kind,
       m.created_at,
       m.reply_to_message_id,
       (card.message_id IS NOT NULL)::boolean AS has_card,
       author.kind AS author_kind,author.display_name AS author_display_name,
       author.account_id AS author_account_id,author.handle AS author_handle,
       author.created_at AS author_created_at
FROM message_page page
JOIN messages m ON m.id=page.id
JOIN actors author ON author.id=m.author_actor_id AND author.tenant_id=m.tenant_id
LEFT JOIN message_cards card ON card.message_id=m.id
ORDER BY m.created_at, m.id;

-- name: LockRoomDocumentMessageReference :one
SELECT document.id
FROM documents document
JOIN document_context_bindings binding
  ON binding.tenant_id=document.tenant_id AND binding.document_id=document.id
 AND binding.binding_kind='room'
 AND binding.room_id=collaboration_membership_room_id(sqlc.arg(room_id)::text)
 AND binding.status='active'
JOIN rooms room ON room.id=binding.room_id AND room.tenant_id=binding.tenant_id
WHERE document.id=sqlc.arg(document_id)::text
  AND document.tenant_id=sqlc.arg(tenant_id)::text
  AND document.status='active'
  AND room.deletion_started_at IS NULL
FOR SHARE OF document,binding,room;

-- name: HumanRoomNameTaken :one
SELECT EXISTS(
  SELECT 1 FROM rooms room
  JOIN active_room_members member
    ON member.room_id=room.id AND member.actor_id=sqlc.arg(actor_id)::text
  WHERE room.tenant_id=sqlc.arg(tenant_id)::text AND room.deleted_at IS NULL
    AND lower(btrim(room.name))=sqlc.arg(normalized_name)::text
)::boolean;

-- name: GetActiveRoomDocumentBindingID :one
SELECT id FROM document_context_bindings
WHERE tenant_id=sqlc.arg(tenant_id)::text AND document_id=sqlc.arg(document_id)::text
  AND binding_kind='room' AND room_id=sqlc.arg(room_id)::text AND status='active';

-- name: ListRoutineMessageNames :many
-- Routine provenance is projected only into Human Message responses. A
-- one-shot follow-up the replying Agent scheduled for itself carries no label:
-- its created event names that Agent, it is not a template Routine, and its
-- row is cadence 'once' or already gone.
WITH output_runs AS (
    SELECT message.id AS message_id,message.local_run_id AS run_id
    FROM messages message
    WHERE message.room_id=sqlc.arg(room_id)::text AND message.id=ANY(sqlc.arg(message_ids)::text[])
      AND message.local_run_id IS NOT NULL
),
routine_sources AS (
    SELECT output.message_id,fired.resource_id AS routine_id,fired.room_seq AS fired_seq,
           fired.payload->>'routine_name' AS routine_name
    FROM output_runs output
    JOIN messages reply ON reply.id=output.message_id
    JOIN agent_local_run_inputs relation
      ON relation.run_id=output.run_id AND relation.relation='initial'
    JOIN agent_runtime_inputs input
      ON input.context_key=relation.context_key AND input.input_id=relation.input_id
    JOIN LATERAL (
      SELECT jsonb_array_elements_text(
        CASE WHEN input.source_kind='inbox'
          AND jsonb_typeof(input.payload->'invocationMessageIds')='array'
          THEN input.payload->'invocationMessageIds'
          ELSE '[]'::jsonb END) AS id
    ) source_ref ON true
    JOIN messages source ON source.id=source_ref.id
      AND source.room_id=sqlc.arg(room_id)::text AND source.message_kind='agent_runtime'
      AND source.mentioned_actor_ids<>'{}'
    JOIN room_events fired ON fired.tenant_id=source.tenant_id
      AND fired.room_id=source.room_id AND fired.room_seq=source.room_seq+1
      AND fired.event_type='routine.changed'
      AND fired.payload->>'change_kind'='fired'
    LEFT JOIN room_reminders routine ON routine.id=fired.resource_id
      AND routine.tenant_id=fired.tenant_id AND routine.room_id=fired.room_id
    WHERE NOT (
      routine.template_routine_key IS NULL
      AND (routine.id IS NULL OR routine.cadence_kind='once')
      AND EXISTS (
        SELECT 1 FROM room_events created
        WHERE created.room_id=fired.room_id AND created.room_seq<fired.room_seq
          AND created.tenant_id=fired.tenant_id AND created.resource_id=fired.resource_id
          AND created.event_type='routine.changed'
          AND created.payload->>'change_kind'='created'
          AND created.actor_id=reply.author_actor_id
      )
    )
)
SELECT message_id::text AS message_id,
       ((array_agg(routine_name ORDER BY fired_seq DESC)
         FILTER (WHERE routine_name IS NOT NULL))[1])::text AS routine_name
FROM routine_sources
GROUP BY message_id
HAVING count(DISTINCT routine_id)=1 AND count(routine_name)>0;
