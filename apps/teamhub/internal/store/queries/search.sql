-- name: LimitSearchStatementTime :exec
-- Every keyword search runs in a transaction whose statements stop after five
-- seconds, so a slow search answers SEARCH_TIMEOUT instead of holding a
-- connection.
SELECT set_config('statement_timeout', '5s', true);

-- name: SearchTenantMessagesForAccount :many
-- Keyword search over conversation Messages the caller can read across one
-- Tenant. Visibility is the Message list's: membership through the parent Room
-- for threads, and after leaving, only Messages up to each Room's own frozen
-- left_room_seq. The Room list exclusions also apply, so every hit opens
-- through an existing route. The query is one substring; both sides are
-- lower-cased here. The page is chosen from narrow rows first and only its
-- hits are joined to authors and Rooms, so a word found in every Message sorts
-- ids instead of whole rows.
WITH page AS (
  SELECT m.id, m.created_at
  FROM messages m
  JOIN rooms r ON r.id=m.room_id
  JOIN actors caller ON caller.tenant_id=r.tenant_id AND caller.account_id=sqlc.arg(account_id)::text AND caller.kind='human'
  JOIN rooms access_room
    ON access_room.id=COALESCE(r.parent_room_id, r.id)
   AND access_room.deleted_at IS NULL
   AND access_room.deletion_started_at IS NULL
  JOIN active_room_members membership
    ON membership.room_id=access_room.id AND membership.actor_id=caller.id
  -- Leaving is recorded on the Room that grants membership, while the frozen
  -- position is each Room's own: a thread numbers its Messages separately.
  -- Joining both per Room keeps the check off every matching Message.
  LEFT JOIN room_member_states departure
    ON departure.room_id=access_room.id AND departure.actor_id=caller.id
   AND departure.participation_epoch_id=membership.membership_epoch_id
   AND departure.left_at IS NOT NULL
  LEFT JOIN room_member_states frozen
    ON frozen.room_id=r.id AND frozen.actor_id=caller.id
   AND frozen.participation_epoch_id=membership.membership_epoch_id
   AND frozen.left_at IS NOT NULL
  WHERE r.tenant_id=sqlc.arg(tenant_id)::text
    AND r.deleted_at IS NULL
    AND r.deletion_started_at IS NULL
    AND m.message_kind='conversation'
    AND m.card_context_message_id IS NULL
    AND (departure.room_id IS NULL OR EXISTS (
      SELECT 1 FROM room_events saved
      WHERE saved.tenant_id=r.tenant_id AND saved.room_id=r.id AND saved.resource_id=m.id
        AND saved.event_type='message.created' AND saved.room_seq<=frozen.left_room_seq
    ))
    AND NOT EXISTS (
      SELECT 1 FROM work_item_room_links work_room
      WHERE work_room.tenant_id=r.tenant_id AND work_room.room_id=r.id AND work_room.link_type='work'
    )
    AND strpos(lower(m.body),lower(sqlc.arg(query)::text))>0
    AND (sqlc.arg(cursor)::text='' OR (m.created_at,m.id) < (
      SELECT created_at,id FROM messages WHERE id=sqlc.arg(cursor)::text
    ))
  ORDER BY m.created_at DESC, m.id DESC
  LIMIT sqlc.arg(page_limit)::int
)
SELECT m.id, m.tenant_id, m.room_id, m.author_actor_id, m.body, m.segments, m.message_kind,
       m.card_context_message_id, m.card_title, m.card_kind, m.created_at,
       m.reply_to_message_id,
       author.kind AS author_kind, author.display_name AS author_display_name,
       author.account_id AS author_account_id, author.handle AS author_handle,
       author.created_at AS author_created_at,
       r.name AS room_name,
       (r.direct_agent_actor_id IS NOT NULL)::boolean AS is_direct,
       coalesce(direct_peer.display_name,'')::text AS direct_peer_display_name,
       (r.parent_room_id IS NOT NULL)::boolean AS is_thread,
       coalesce(r.parent_room_id,'')::text AS parent_room_id,
       coalesce(r.root_message_id,'')::text AS root_message_id
FROM page
JOIN messages m ON m.id=page.id
JOIN rooms r ON r.id=m.room_id
JOIN actors author ON author.id=m.author_actor_id AND author.tenant_id=m.tenant_id
LEFT JOIN actors direct_peer
  ON direct_peer.id=r.direct_agent_actor_id AND direct_peer.tenant_id=r.tenant_id
ORDER BY page.created_at DESC, page.id DESC;
