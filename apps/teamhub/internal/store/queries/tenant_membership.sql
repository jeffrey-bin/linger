-- name: LockActiveTenantHumanMembership :one
-- A Human Actor row is its Space membership; the share lock keeps it in place
-- while a Work Item assignment that names it commits.
SELECT actor.account_id
FROM actors actor
WHERE actor.tenant_id=$1 AND actor.id=$2 AND actor.kind='human'
FOR SHARE;
