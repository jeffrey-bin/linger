-- name: GetAccountByEmail :one
-- Login reads the Account without a lock and hashes outside any transaction.
SELECT id, email, password_hash, created_at
FROM accounts
WHERE lower(email) = lower(sqlc.arg(email));

-- name: LockAccountPasswordHash :one
-- Login rechecks the verified hash under the Account row lock that password
-- changes and set-password take, so an old password never signs in after a change.
SELECT password_hash FROM accounts WHERE id = $1 FOR UPDATE;

-- name: CreateSession :one
INSERT INTO auth_sessions(id, account_id, token_hash, expires_at)
VALUES ($1, $2, $3, LEAST(sqlc.arg(expires_at)::timestamptz, now() + sqlc.arg(max_lifetime)::interval))
RETURNING id, account_id, created_at, expires_at;

-- name: GetActiveSession :one
-- A session resolves its Account's single Human Actor once; that Actor's
-- tenant_id is the deployment's Space, and every handler reads both from here.
SELECT s.id, s.account_id, s.created_at, s.expires_at,
       a.email, a.created_at AS account_created_at,
       human.id AS human_actor_id, human.tenant_id AS human_tenant_id,
       human.display_name AS human_display_name
FROM auth_sessions s
JOIN accounts a ON a.id = s.account_id
JOIN actors human ON human.account_id = a.id AND human.kind = 'human'
WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now();

-- name: RenewSession :one
UPDATE auth_sessions
SET expires_at = LEAST(clock_timestamp() + sqlc.arg(idle_ttl)::interval, created_at + sqlc.arg(max_lifetime)::interval)
WHERE token_hash = sqlc.arg(token_hash)
  AND revoked_at IS NULL AND expires_at > clock_timestamp()
  AND created_at + sqlc.arg(max_lifetime)::interval > clock_timestamp()
  AND expires_at < created_at + sqlc.arg(max_lifetime)::interval
  AND expires_at <= clock_timestamp() + sqlc.arg(idle_ttl)::interval - sqlc.arg(renewal_interval)::interval
RETURNING expires_at;

-- name: RevokeSession :exec
UPDATE auth_sessions
SET revoked_at = coalesce(revoked_at, now()),
    revoked_reason = CASE WHEN revoked_at IS NULL THEN 'logout' ELSE revoked_reason END
WHERE token_hash = $1;

-- name: ListActorsForAccount :many
SELECT actors.id,actors.tenant_id,actors.kind,actors.display_name,
       actors.account_id,actors.handle,actors.created_at
FROM actors
WHERE actors.account_id = $1
ORDER BY actors.tenant_id,actors.id;

-- name: ListActorsForTenantAccount :many
SELECT target.id, target.tenant_id, target.kind, target.display_name,
       target.account_id, target.handle, target.created_at,
       target_account.email AS account_email
FROM actors target
LEFT JOIN accounts target_account ON target_account.id=target.account_id
JOIN actors caller
  ON caller.tenant_id=target.tenant_id
 AND caller.account_id=sqlc.arg(account_id)::text
 AND caller.kind='human'
WHERE target.tenant_id = sqlc.arg(tenant_id)::text
  AND (
    target.kind<>'agent' OR EXISTS (
      SELECT 1 FROM agent_registrations registration
      WHERE registration.actor_id=target.id
        AND registration.tenant_id=target.tenant_id
        AND registration.status='active'
        AND (
          registration.visibility_scope='workspace' OR
          registration.created_by_actor_id=caller.id OR
          EXISTS (
            SELECT 1
            FROM active_room_members caller_membership
            JOIN active_room_members agent_membership
              ON agent_membership.room_id=caller_membership.room_id
             AND agent_membership.actor_id=registration.actor_id
            WHERE caller_membership.actor_id=caller.id
          )
        )
    )
  )
  AND (sqlc.arg(cursor)::text = '' OR (target.created_at, target.id) > (
      SELECT created_at, id FROM actors WHERE id = sqlc.arg(cursor)::text AND tenant_id = sqlc.arg(tenant_id)::text
  ))
ORDER BY target.created_at, target.id
LIMIT sqlc.arg(page_limit)::int;

-- name: GetActorForTenantAccount :one
SELECT target.id, target.tenant_id, target.kind, target.display_name,
       target.account_id, target.handle, target.created_at
FROM actors target
JOIN actors caller
  ON caller.tenant_id=target.tenant_id AND caller.account_id=$3 AND caller.kind='human'
WHERE target.tenant_id=$1 AND target.id=$2
  AND (
    target.kind<>'agent' OR EXISTS (
      SELECT 1 FROM agent_registrations registration
      WHERE registration.actor_id=target.id
        AND registration.tenant_id=target.tenant_id
        AND registration.status='active'
        AND (
          registration.visibility_scope='workspace' OR
          registration.created_by_actor_id=caller.id OR
          EXISTS (
            SELECT 1
            FROM active_room_members caller_membership
            JOIN active_room_members agent_membership
              ON agent_membership.room_id=caller_membership.room_id
             AND agent_membership.actor_id=registration.actor_id
            WHERE caller_membership.actor_id=caller.id
          )
        )
    )
  );

-- name: GetHumanActor :one
-- The one lookup of an Account's Human Actor in a Tenant.
SELECT actors.id,actors.tenant_id,actors.kind,actors.display_name,
       actors.account_id,actors.handle,actors.created_at
FROM actors
WHERE actors.tenant_id=$1 AND actors.account_id=$2 AND actors.kind='human';

-- name: GetActor :one
SELECT id, tenant_id, kind, display_name, account_id, handle, created_at
FROM actors
WHERE id=$1 AND tenant_id=$2;

-- name: AcquireAdvisoryTransactionLock :exec
SELECT pg_advisory_xact_lock(hashtextextended(sqlc.arg(lock_key), 0));

-- name: AcquireAdvisoryTransactionSharedLock :exec
SELECT pg_advisory_xact_lock_shared(hashtextextended(sqlc.arg(lock_key), 0));
