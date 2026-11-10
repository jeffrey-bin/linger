-- name: EnsureTaskMetaInbox :exec
INSERT INTO task_meta_inboxes(task_id,tenant_id,agent_actor_id)
VALUES($1,$2,$3)
ON CONFLICT(task_id,agent_actor_id) DO NOTHING;

-- name: GetTaskMetaInboxForUpdate :one
SELECT task_id,tenant_id,agent_actor_id,through_seq,created_at,updated_at
FROM task_meta_inboxes
WHERE task_id=$1 AND tenant_id=$2 AND agent_actor_id=$3
FOR UPDATE;

-- name: CreateTaskMetaMessage :one
INSERT INTO task_meta_messages(
    id,tenant_id,task_id,agent_actor_id,meta_seq,author_actor_id,body,segments
)
VALUES($1,$2,$3,$4,$5,$6,$7,$8)
RETURNING id,tenant_id,task_id,agent_actor_id,meta_seq,author_actor_id,body,segments,created_at;

-- name: SetTaskMetaInboxThroughSeq :execrows
UPDATE task_meta_inboxes
SET through_seq=$4,updated_at=now()
WHERE task_id=$1 AND tenant_id=$2 AND agent_actor_id=$3 AND through_seq<$4;
