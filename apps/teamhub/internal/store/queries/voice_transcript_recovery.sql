-- name: AttachVoiceSourceAudio :one
UPDATE capture_sessions
SET source_audio_document_id=$2,source_audio_document_version_id=$3,updated_at=clock_timestamp()
WHERE id=$1 AND status IN ('finalizing','recovering')
  AND (source_audio_document_version_id IS NULL OR source_audio_document_version_id=$3)
RETURNING *;

-- name: QueueVoiceTranscriptRecovery :one
-- Queues archive recovery once. A queued or failed recovery keeps its status;
-- the source duration it was queued with never changes.
UPDATE capture_sessions
SET status='recovering',transcript_recovery_status=coalesce(transcript_recovery_status,'pending'),
    transcript_recovery_total_ms=sqlc.arg(source_duration_ms)::bigint,updated_at=clock_timestamp()
WHERE id=sqlc.arg(capture_session_id)::text AND status IN ('finalizing','recovering')
  AND source_audio_document_version_id IS NOT NULL AND transcript_recovered_at IS NULL
  AND (transcript_recovery_total_ms IS NULL OR transcript_recovery_total_ms=sqlc.arg(source_duration_ms)::bigint)
RETURNING *;

-- name: RecordVoiceTranscriptUncertainty :exec
WITH capture AS (
  UPDATE capture_sessions SET transcript_integrity_lost=true
  WHERE id=sqlc.arg(capture_session_id)::text AND status IN ('starting','recording','finalizing')
    AND sqlc.arg(end_offset_ms)::bigint > greatest(sqlc.arg(start_offset_ms)::bigint,coalesce(transcript_start_offset_ms,0))
  RETURNING id,transcript_start_offset_ms
)
INSERT INTO voice_transcript_uncertainties(capture_session_id,event_id,start_offset_ms,end_offset_ms,reason)
SELECT id,sqlc.arg(event_id)::text,greatest(sqlc.arg(start_offset_ms)::bigint,coalesce(transcript_start_offset_ms,0)),
  sqlc.arg(end_offset_ms)::bigint,'input_gap' FROM capture
ON CONFLICT(capture_session_id,event_id) DO NOTHING;

-- name: ListVoiceTranscriptUncertainties :many
SELECT * FROM voice_transcript_uncertainties WHERE capture_session_id=$1 ORDER BY start_offset_ms,end_offset_ms;

-- name: ListVoiceRecoveryCoverage :many
SELECT * FROM capture_transcript_coverage WHERE session_id=$1 ORDER BY start_offset_ms,end_offset_ms;

-- name: GetVoiceTranscriptStreamStart :one
SELECT coalesce((SELECT start_offset_ms FROM capture_transcript_coverage
  WHERE session_id=sqlc.arg(session_id)::text AND stream_id=sqlc.arg(stream_id)::text),sqlc.arg(fallback_start_ms)::bigint)::bigint;

-- name: ClaimVoiceTranscriptRecovery :one
-- Takes the Capture's queued recovery. Its River job is the only runner, so a
-- running recovery belongs to a run that stopped and is taken again. Provider
-- blocks live only in the run's memory, so every run starts at the source
-- audio's beginning.
UPDATE capture_sessions capture
SET transcript_recovery_status='running',transcript_recovery_progress_ms=0
FROM active_room_members member, rooms room
WHERE capture.id=sqlc.arg(capture_session_id)::text
  AND member.room_id=capture.room_id AND member.actor_id=capture.created_by_actor_id
  AND room.id=capture.room_id AND room.deleted_at IS NULL
  AND capture.status='recovering' AND capture.transcript_recovered_at IS NULL
  AND (capture.transcript_recovery_status='running' OR (capture.transcript_recovery_status='pending'
       AND (capture.transcript_recovery_retry_at IS NULL OR capture.transcript_recovery_retry_at<=clock_timestamp())))
RETURNING capture.*;

-- name: VoiceTranscriptRecoveryDueIn :one
-- Seconds until ClaimVoiceTranscriptRecovery can take the Capture's recovery;
-- Infinity when it cannot: a failed recovery waits for a manual retry.
SELECT coalesce(extract(epoch FROM (
    SELECT capture.transcript_recovery_retry_at-clock_timestamp() FROM capture_sessions capture
    JOIN active_room_members member ON member.room_id=capture.room_id AND member.actor_id=capture.created_by_actor_id
    JOIN rooms room ON room.id=capture.room_id AND room.deleted_at IS NULL
    WHERE capture.id=$1 AND capture.status='recovering' AND capture.transcript_recovered_at IS NULL
      AND capture.transcript_recovery_status='pending' AND capture.transcript_recovery_retry_at IS NOT NULL
  )),'Infinity')::float8 AS wait_seconds;

-- name: AdvanceVoiceTranscriptRecoveryProgress :one
UPDATE capture_sessions
SET transcript_recovery_progress_ms=sqlc.arg(end_offset_ms)::bigint
WHERE id=sqlc.arg(capture_session_id)::text AND transcript_recovery_status='running'
  AND transcript_recovery_progress_ms=sqlc.arg(start_offset_ms)::bigint
  AND sqlc.arg(end_offset_ms)::bigint <= transcript_recovery_total_ms
RETURNING id;

-- name: ReleaseVoiceTranscriptRecovery :exec
UPDATE capture_sessions
SET transcript_recovery_status=sqlc.arg(status)::text,
    transcript_recovery_failures=transcript_recovery_failures+1,
    transcript_recovery_failure_code=sqlc.arg(failure_code)::text,
    transcript_recovery_retry_at=clock_timestamp()+sqlc.arg(retry_delay)::interval
WHERE id=sqlc.arg(capture_session_id)::text AND transcript_recovery_status='running';

-- name: RetryVoiceTranscriptRecovery :one
UPDATE capture_sessions capture
SET transcript_recovery_status='pending',transcript_recovery_failures=0,
    transcript_recovery_failure_code=NULL,transcript_recovery_retry_at=NULL,updated_at=clock_timestamp()
FROM actors actor,active_room_members member,rooms room
WHERE capture.id=sqlc.arg(capture_session_id)::text AND capture.status='recovering'
  AND capture.transcript_recovery_status IN ('failed','pending')
  AND actor.id=capture.created_by_actor_id AND actor.account_id=sqlc.arg(account_id)::text
  AND member.actor_id=actor.id AND member.room_id=capture.room_id
  AND room.id=capture.room_id AND room.deleted_at IS NULL
RETURNING capture.id;

-- name: MarkVoiceTranscriptRecovered :one
WITH authority AS MATERIALIZED (
  SELECT capture.id FROM capture_sessions capture
  JOIN room_members member ON member.room_id=capture.room_id AND member.actor_id=capture.created_by_actor_id
  JOIN rooms room ON room.id=capture.room_id AND room.deleted_at IS NULL
  WHERE capture.id=sqlc.arg(capture_session_id)::text
  FOR SHARE OF member,room
)
UPDATE capture_sessions SET transcript_recovered_at=clock_timestamp(),
  transcript_end_offset_ms=sqlc.arg(end_offset_ms)::bigint,updated_at=clock_timestamp(),
  transcript_recovery_status='succeeded',transcript_recovery_failures=0,transcript_recovery_failure_code=NULL
WHERE id=sqlc.arg(capture_session_id)::text AND status='recovering' AND transcript_recovered_at IS NULL
  AND transcript_recovery_status='running' AND transcript_recovery_progress_ms=transcript_recovery_total_ms
  AND EXISTS(SELECT 1 FROM authority)
RETURNING *;

-- name: SupersedeVoiceRecoverySpeech :exec
-- Live speech the recovery replaces stays on the live lane for captions and
-- recording Ask but leaves the Capture's transcript. Speech inside a
-- disclosed gap has no archive audio to replace it and stays.
UPDATE voice_transcript_segments speech SET superseded_at=clock_timestamp()
FROM capture_sessions capture
WHERE speech.capture_session_id=sqlc.arg(capture_session_id)::text AND capture.id=speech.capture_session_id
  AND speech.lane='live' AND speech.superseded_at IS NULL
  AND NOT (speech.id = ANY(coalesce(sqlc.arg(preserved_ids)::text[],ARRAY[]::text[])))
  AND NOT EXISTS (
    SELECT 1 FROM capture_media_ranges gap
    WHERE gap.capture_session_id=capture.id AND gap.kind='gap'
      AND speech.start_offset_ms < capture.transcript_start_offset_ms+gap.end_offset_ms
      AND speech.end_offset_ms > capture.transcript_start_offset_ms+gap.start_offset_ms
  );

-- name: InsertRecoveredVoiceTranscriptSegment :exec
-- The caller holds LockVoiceSession, so the drawn seq keeps commit order.
INSERT INTO voice_transcript_segments(
  id,event_id,voice_session_id,capture_session_id,media_epoch,lane,
  start_offset_ms,end_offset_ms,text,normalized_text,kind,speaker_id)
SELECT sqlc.arg(id)::text,sqlc.arg(id)::text,capture.voice_session_id,capture.id,0,'recovery',
  sqlc.arg(start_offset_ms)::bigint,sqlc.arg(end_offset_ms)::bigint,
  sqlc.arg(text)::text,sqlc.arg(normalized_text)::text,'speech',sqlc.narg(speaker_id)::text
FROM capture_sessions capture WHERE capture.id=sqlc.arg(capture_session_id)::text;

-- name: SetVoiceRecoveredCoverage :exec
INSERT INTO capture_transcript_coverage(session_id,stream_id,lane,start_offset_ms,end_offset_ms)
VALUES($1,'archive-recovery-v1','recovery',$2,$3)
ON CONFLICT(session_id,stream_id) DO UPDATE SET end_offset_ms=EXCLUDED.end_offset_ms,updated_at=clock_timestamp();

-- name: GetVoiceSourceAudio :one
SELECT * FROM capture_media_outputs WHERE capture_session_id=$1 AND purpose='source' LIMIT 1;
