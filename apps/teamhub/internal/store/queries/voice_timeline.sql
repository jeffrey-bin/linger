-- name: ConfirmInitialVoiceMediaTimeline :one
UPDATE capture_sessions capture
SET created_at=sqlc.arg(started_at)::timestamptz,
    transcript_start_offset_ms=floor(extract(epoch FROM (sqlc.arg(started_at)::timestamptz-voice.created_at))*1000)::bigint,
    transcript_end_offset_ms=NULL,
    status=CASE WHEN capture.status='starting' THEN 'recording' ELSE capture.status END,
    updated_at=clock_timestamp()
FROM voice_sessions voice
WHERE capture.id=sqlc.arg(capture_id)::text AND voice.id=capture.voice_session_id
  AND capture.status IN ('starting','finalizing')
RETURNING capture.*;

-- name: AlignInitialVoiceTranscriptCoverage :exec
UPDATE capture_transcript_coverage
SET start_offset_ms=$2
WHERE session_id=$1 AND start_offset_ms<$2 AND end_offset_ms>=$2;

-- name: CancelInitialVoiceMediaBeforeStart :exec
WITH stopped AS (
  UPDATE capture_sessions capture SET status='failed',updated_at=clock_timestamp()
  WHERE capture.id=sqlc.arg(capture_id)::text AND capture.status='finalizing'
  RETURNING capture.id,capture.voice_session_id
), closing AS (
  UPDATE voice_sessions voice SET status='closing',last_failure_code='stopped_before_media',updated_at=clock_timestamp()
  FROM stopped WHERE voice.id=stopped.voice_session_id
    AND voice.status IN ('provisioning','connected','reconnecting')
)
UPDATE voice_media_epochs epoch SET desired_state='sealed',observed_state='failed',
  last_failure_code='stopped_before_media',provider_egress_id=coalesce(epoch.provider_egress_id,sqlc.narg(provider_egress_id)::text),updated_at=clock_timestamp()
FROM stopped WHERE epoch.capture_session_id=stopped.id AND epoch.epoch_index=0;

-- name: FreezeReadyVoiceTranscripts :exec
-- 50ms covers two 48kHz AAC frames plus millisecond rounding. It is not a gap.
WITH endings AS (
  SELECT capture.id,capture.transcript_start_offset_ms AS base,
    greatest(epoch.final_end_ms,coalesce((SELECT max(gap.end_offset_ms)
      FROM capture_media_ranges gap WHERE gap.capture_session_id=capture.id AND gap.kind='gap'),0)) AS media_end,
    floor(extract(epoch FROM (capture.stop_requested_at-capture.created_at))*1000)::bigint AS stop_end,
    voice.last_input_ended_ms AS input_end
  FROM capture_sessions capture
  JOIN voice_sessions voice ON voice.id=capture.voice_session_id
  JOIN voice_media_epochs epoch ON epoch.capture_session_id=capture.id
  WHERE capture.status='finalizing'
    AND NOT capture.transcript_integrity_lost AND capture.transcript_end_offset_ms IS NULL
    AND epoch.epoch_index=(SELECT max(latest.epoch_index) FROM voice_media_epochs latest WHERE latest.capture_session_id=capture.id)
    AND epoch.observed_state='available' AND epoch.final_end_ms>0
    AND voice.last_input_ended_ms>=coalesce(voice.last_input_started_ms,0)
    AND voice.last_input_ended_ms>=capture.transcript_start_offset_ms
)
UPDATE capture_sessions capture
SET transcript_end_offset_ms=least(endings.base+CASE
      WHEN endings.stop_end>=endings.media_end AND endings.stop_end-endings.media_end<=50 THEN endings.stop_end
      ELSE endings.media_end END,endings.input_end),updated_at=clock_timestamp()
FROM endings WHERE capture.id=endings.id AND capture.transcript_end_offset_ms IS NULL;

-- name: GetLatestRecordedVoiceMediaEpoch :one
SELECT * FROM voice_media_epochs
WHERE capture_session_id=$1 AND observed_state='available' AND final_end_ms>coalesce(first_archived_ms,0)
ORDER BY epoch_index DESC LIMIT 1;

-- name: RecordRecoveredVoiceEpochFailure :exec
UPDATE voice_media_epochs SET last_failure_code='egress_failed'
WHERE id=$1;

-- name: DeleteOverlappingVoiceMediaGaps :exec
DELETE FROM capture_media_ranges
WHERE capture_session_id=sqlc.arg(capture_session_id)::text AND kind='gap'
  AND end_offset_ms>=sqlc.arg(start_offset_ms)::bigint AND start_offset_ms<=sqlc.arg(end_offset_ms)::bigint;
