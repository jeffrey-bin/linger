-- name: GetCommandReplay :one
SELECT request_hash, resource_id, response_status, response_body, state, invocation_id
FROM command_replays
WHERE scope=sqlc.arg(scope)::text
  AND operation=sqlc.arg(operation)::text
  AND key=sqlc.arg(key)::text;

-- name: CreateCommandReplay :exec
INSERT INTO command_replays (
    scope, operation, key, request_hash, state, resource_id, response_status, response_body,
    invocation_id, credential_id
) VALUES (
    sqlc.arg(scope), sqlc.arg(operation), sqlc.arg(key), sqlc.arg(request_hash), sqlc.arg(state),
    sqlc.narg(resource_id), sqlc.narg(response_status), sqlc.narg(response_body),
    sqlc.narg(invocation_id), sqlc.narg(credential_id)
);

-- name: GetCommandReplayForUpdate :one
SELECT request_hash, resource_id, response_status, response_body, state, invocation_id
FROM command_replays
WHERE scope=sqlc.arg(scope)::text
  AND operation=sqlc.arg(operation)::text
  AND key=sqlc.arg(key)::text
FOR UPDATE;

-- name: CompleteCommandReplay :execrows
-- Only reserved work completes.
UPDATE command_replays
SET resource_id=sqlc.narg(resource_id), response_status=sqlc.arg(response_status)::int,
    response_body=sqlc.arg(response_body)::bytea, state='completed'
WHERE scope=sqlc.arg(scope)::text
  AND operation=sqlc.arg(operation)::text
  AND key=sqlc.arg(key)::text
  AND state='reserved';

-- name: DeleteReservedCommandReplay :exec
DELETE FROM command_replays
WHERE scope=sqlc.arg(scope)::text
  AND operation=sqlc.arg(operation)::text
  AND key=sqlc.arg(key)::text
  AND state='reserved';
