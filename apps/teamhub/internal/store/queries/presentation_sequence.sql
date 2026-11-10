-- name: CreateAgentPresentationSequence :one
INSERT INTO agent_presentation_sequences(id,tenant_id,room_id,agent_actor_id,local_run_id,reply_to_message_id,status)
VALUES(sqlc.arg(id)::text,sqlc.arg(tenant_id)::text,sqlc.arg(room_id)::text,sqlc.arg(agent_actor_id)::text,sqlc.narg(local_run_id)::text,sqlc.narg(reply_to_message_id)::text,'pending')
RETURNING *;

-- name: CreateAgentPresentationSequenceItem :one
INSERT INTO agent_presentation_sequence_items(sequence_id,position,content,pause_before,not_before)
VALUES(sqlc.arg(sequence_id)::text,sqlc.arg(position)::integer,sqlc.arg(content)::text,sqlc.arg(pause_before)::text,sqlc.arg(not_before)::timestamptz)
RETURNING *;

-- name: LockDueAgentPresentationSequenceItems :many
SELECT item.sequence_id,item.position,item.content,item.pause_before,item.not_before,
       sequence.tenant_id,sequence.room_id,sequence.agent_actor_id,sequence.reply_to_message_id,
       sequence.local_run_id
FROM agent_presentation_sequence_items item
JOIN agent_presentation_sequences sequence ON sequence.id=item.sequence_id
WHERE sequence.status IN ('pending','delivering')
  AND item.delivered_at IS NULL
  AND item.not_before<=clock_timestamp()
  AND (
    item.position=1
    OR EXISTS (
      SELECT 1 FROM agent_presentation_sequence_items previous
      WHERE previous.sequence_id=item.sequence_id
        AND previous.position=item.position-1
        AND previous.delivered_at IS NOT NULL
        AND previous.delivered_at + CASE item.pause_before
          WHEN 'brief' THEN interval '1 second'
          WHEN 'natural' THEN interval '1500 milliseconds'
          ELSE interval '0 seconds'
        END<=clock_timestamp()
    )
  )
ORDER BY item.not_before,item.sequence_id,item.position
LIMIT sqlc.arg(row_limit)::integer
FOR UPDATE OF item SKIP LOCKED;

-- name: NextAgentPresentationSequenceItemWaitMilliseconds :one
-- The wait is measured on the database clock that LockDueAgentPresentationSequenceItems uses.
SELECT CEIL(EXTRACT(EPOCH FROM (
  GREATEST(item.not_before, COALESCE(previous.delivered_at + CASE item.pause_before
    WHEN 'brief' THEN interval '1 second'
    WHEN 'natural' THEN interval '1500 milliseconds'
    ELSE interval '0 seconds'
  END, item.not_before)) - clock_timestamp()
)) * 1000)::bigint AS wait_milliseconds
FROM agent_presentation_sequence_items item
JOIN agent_presentation_sequences sequence ON sequence.id=item.sequence_id
LEFT JOIN agent_presentation_sequence_items previous
  ON previous.sequence_id=item.sequence_id AND previous.position=item.position-1
WHERE sequence.status IN ('pending','delivering')
  AND item.delivered_at IS NULL
  AND (item.position=1 OR previous.delivered_at IS NOT NULL)
ORDER BY wait_milliseconds
LIMIT 1;

-- name: MarkAgentPresentationSequenceItemDelivered :one
UPDATE agent_presentation_sequence_items
SET delivered_message_id=sqlc.arg(message_id)::text,delivered_at=clock_timestamp()
WHERE sequence_id=sqlc.arg(sequence_id)::text
  AND position=sqlc.arg(position)::integer
  AND delivered_at IS NULL
RETURNING *;

-- name: MarkAgentPresentationSequenceDelivering :execrows
UPDATE agent_presentation_sequences
SET status='delivering',updated_at=clock_timestamp()
WHERE id=sqlc.arg(sequence_id)::text AND status='pending';

-- name: CompleteAgentPresentationSequenceIfDelivered :execrows
UPDATE agent_presentation_sequences sequence
SET status='completed',updated_at=clock_timestamp()
WHERE sequence.id=sqlc.arg(sequence_id)::text
  AND sequence.status IN ('pending','delivering')
  AND NOT EXISTS (
    SELECT 1 FROM agent_presentation_sequence_items item
    WHERE item.sequence_id=sequence.id AND item.delivered_at IS NULL
  );

-- name: CancelAgentPresentationSequence :execrows
UPDATE agent_presentation_sequences
SET status='canceled',updated_at=clock_timestamp()
WHERE id=sqlc.arg(sequence_id)::text AND status IN ('pending','delivering');

-- name: GetAgentPresentationSequence :one
SELECT * FROM agent_presentation_sequences WHERE id=sqlc.arg(id)::text;
