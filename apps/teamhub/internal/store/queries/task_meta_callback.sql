-- name: EnsureTaskMetaCallback :exec
INSERT INTO task_meta_callbacks(
    task_id,tenant_id,generation,coordinator_actor_id,coordinator_context_key
)
VALUES($1,$2,$3,$4,$5)
ON CONFLICT(task_id,tenant_id) DO NOTHING;

-- name: GetTaskMetaCallbackForUpdate :one
SELECT task_id,tenant_id,generation,coordinator_actor_id,coordinator_context_key,
       through_seq,created_at,updated_at
FROM task_meta_callbacks
WHERE task_id=$1 AND tenant_id=$2
FOR UPDATE;

-- name: CreateTaskMetaCallbackMessage :one
INSERT INTO task_meta_callback_messages(
    id,task_id,tenant_id,generation,meta_seq,author_actor_id,body,segments,non_actionable
)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
RETURNING id,task_id,tenant_id,generation,meta_seq,author_actor_id,body,segments,
          non_actionable,created_at;

-- name: SetTaskMetaCallbackThroughSeq :execrows
UPDATE task_meta_callbacks
SET through_seq=$3,updated_at=now()
WHERE task_id=$1 AND tenant_id=$2 AND through_seq<$3;
