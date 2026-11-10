-- name: GetAgentSponsor :one
SELECT registration.created_by_actor_id AS sponsor_actor_id
FROM agent_registrations registration
JOIN actors sponsor
  ON sponsor.id=registration.created_by_actor_id
 AND sponsor.tenant_id=registration.tenant_id
 AND sponsor.kind='human'
 AND sponsor.account_id IS NOT NULL
WHERE registration.tenant_id=sqlc.arg(tenant_id)::text
  AND registration.actor_id=sqlc.arg(agent_actor_id)::text
  AND registration.agent_management_id=sqlc.arg(agent_management_id)::text
  AND registration.status='active'
  AND registration.agent_type IN ('general','anotherme')
FOR SHARE OF registration;

-- name: ListAgentSponsorAvailableAgents :many
SELECT registration.actor_id,
       actor.display_name AS name,
       registration.description,
       registration.created_at
FROM agent_registrations registration
JOIN actors actor
  ON actor.id=registration.actor_id
 AND actor.tenant_id=registration.tenant_id
 AND actor.kind='agent'
WHERE registration.tenant_id=sqlc.arg(tenant_id)::text
  AND registration.status='active'
  AND registration.agent_type='general'
  AND (
    registration.visibility_scope='workspace' OR
    registration.created_by_actor_id=sqlc.arg(sponsor_actor_id)::text OR
    EXISTS (
      SELECT 1
      FROM active_room_members sponsor_membership
      JOIN active_room_members agent_membership
        ON agent_membership.tenant_id=sponsor_membership.tenant_id
       AND agent_membership.room_id=sponsor_membership.room_id
       AND agent_membership.actor_id=registration.actor_id
      WHERE sponsor_membership.tenant_id=registration.tenant_id
        AND sponsor_membership.actor_id=sqlc.arg(sponsor_actor_id)::text
    )
  )
  AND (
    sqlc.arg(cursor)::text='' OR
    (registration.created_at,registration.actor_id)>(
      SELECT cursor_registration.created_at,cursor_registration.actor_id
      FROM agent_registrations cursor_registration
      WHERE cursor_registration.tenant_id=sqlc.arg(tenant_id)::text
        AND cursor_registration.actor_id=sqlc.arg(cursor)::text
        AND cursor_registration.status='active'
        AND cursor_registration.agent_type='general'
        AND (
          cursor_registration.visibility_scope='workspace' OR
          cursor_registration.created_by_actor_id=sqlc.arg(sponsor_actor_id)::text OR
          EXISTS (
            SELECT 1
            FROM active_room_members sponsor_membership
            JOIN active_room_members agent_membership
              ON agent_membership.tenant_id=sponsor_membership.tenant_id
             AND agent_membership.room_id=sponsor_membership.room_id
             AND agent_membership.actor_id=cursor_registration.actor_id
            WHERE sponsor_membership.tenant_id=cursor_registration.tenant_id
              AND sponsor_membership.actor_id=sqlc.arg(sponsor_actor_id)::text
          )
        )
    )
  )
ORDER BY registration.created_at,registration.actor_id
LIMIT sqlc.arg(page_limit)::int;
