-- name: GetCaptureSessionForAccount :one
SELECT session.*
FROM capture_sessions session
JOIN actors caller
  ON caller.tenant_id=session.tenant_id AND caller.account_id=$2 AND caller.kind='human'
JOIN room_members membership
  ON membership.room_id=session.room_id AND membership.actor_id=caller.id
JOIN rooms room
  ON room.id=session.room_id AND room.tenant_id=session.tenant_id AND room.deleted_at IS NULL
WHERE session.id=$1
FOR KEY SHARE OF membership;

-- name: AttachCaptureTranscriptDocument :one
UPDATE capture_sessions
SET transcript_document_id=$2,transcript_document_version_id=$3,updated_at=clock_timestamp()
WHERE id=$1 AND status='finalized'
  AND transcript_document_id IS NULL AND transcript_document_version_id IS NULL
RETURNING *;

-- name: ListCaptureTranscriptSegments :many
-- A Capture's transcript: its live speech that archive recovery did not
-- replace, and the recovered text.
SELECT * FROM voice_transcript_segments
WHERE capture_session_id=sqlc.arg(capture_session_id)::text AND superseded_at IS NULL
  AND start_offset_ms >= sqlc.arg(start_offset_ms)::bigint AND end_offset_ms <= sqlc.arg(end_offset_ms)::bigint
ORDER BY start_offset_ms,end_offset_ms,id;

-- name: ListLiveKitCaptureCompletionSegments :many
-- Completion keeps speech that starts at or after the requested Start,
-- including a final that straddles Stop. Speech before the requested Start stays
-- private. The requested Start, not the later recorder media clock, is the
-- boundary, so speech during recorder startup reaches the delivered transcript.
SELECT segment.* FROM voice_transcript_segments segment
JOIN capture_sessions session ON session.id=segment.capture_session_id
WHERE session.id=$1 AND segment.superseded_at IS NULL
  AND segment.start_offset_ms >= session.requested_transcript_start_offset_ms
  AND segment.start_offset_ms < session.transcript_end_offset_ms
ORDER BY segment.start_offset_ms,segment.end_offset_ms,segment.id;

-- name: GetCaptureTranscriptAcceptedOffset :one
WITH ordered AS (
  SELECT coverage.start_offset_ms,coverage.end_offset_ms,session.transcript_start_offset_ms,
    max(coverage.end_offset_ms) OVER (
      ORDER BY coverage.start_offset_ms,coverage.end_offset_ms,coverage.stream_id
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ) AS previous_end_offset_ms
  FROM capture_sessions session
  LEFT JOIN capture_transcript_coverage coverage ON coverage.session_id=session.id
  WHERE session.id=$1
), grouped AS (
  SELECT *,sum(CASE
    WHEN start_offset_ms IS NULL THEN 0
    WHEN start_offset_ms > coalesce(previous_end_offset_ms,transcript_start_offset_ms) THEN 1
    ELSE 0
  END) OVER (
    ORDER BY start_offset_ms,end_offset_ms
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  ) AS gap_group
  FROM ordered
)
SELECT coalesce(
  max(end_offset_ms) FILTER (WHERE gap_group=0),
  max(transcript_start_offset_ms),
  0
)::bigint
FROM grouped;

-- name: AdvanceCaptureTranscriptCoverage :one
WITH writable_session AS (
  SELECT session.id,session.transcript_end_offset_ms
  FROM capture_sessions session
  JOIN rooms room
    ON room.id=session.room_id AND room.tenant_id=session.tenant_id AND room.deleted_at IS NULL
  JOIN actors caller
    ON caller.tenant_id=session.tenant_id AND caller.account_id=sqlc.arg(account_id)::text AND caller.kind='human'
  JOIN room_members membership
    ON membership.room_id=session.room_id AND membership.actor_id=caller.id
  WHERE session.id=sqlc.arg(session_id)::text
    AND session.room_id=sqlc.arg(room_id)::text
    AND session.status IN ('recording','finalizing')
    AND (
      session.transcript_end_offset_ms IS NULL OR
      sqlc.arg(start_offset_ms)::bigint <= session.transcript_end_offset_ms
    )
  FOR NO KEY UPDATE OF session
)
INSERT INTO capture_transcript_coverage(
  session_id,stream_id,lane,start_offset_ms,end_offset_ms
) SELECT
  session.id,sqlc.arg(stream_id)::text,sqlc.arg(lane)::text,
  sqlc.arg(start_offset_ms)::bigint,
  least(sqlc.arg(end_offset_ms)::bigint,coalesce(session.transcript_end_offset_ms,sqlc.arg(end_offset_ms)::bigint))
FROM writable_session session
ON CONFLICT (session_id,stream_id) DO UPDATE
SET end_offset_ms=greatest(capture_transcript_coverage.end_offset_ms,EXCLUDED.end_offset_ms),updated_at=now()
WHERE capture_transcript_coverage.lane=EXCLUDED.lane
  AND capture_transcript_coverage.start_offset_ms=EXCLUDED.start_offset_ms
RETURNING end_offset_ms;
