-- name: GetPreviousVoiceMediaEpoch :one
SELECT previous.* FROM voice_media_epochs current
JOIN voice_media_epochs previous ON previous.capture_session_id=current.capture_session_id
  AND previous.epoch_index=current.epoch_index-1
WHERE current.id=$1;

-- name: ClaimVoiceEpochRestart :one
-- Only the Capture's reconcile job restarts a recovery epoch's recorder; an
-- unknown restart outcome holds the next try back.
SELECT id FROM voice_media_epochs
WHERE id=$1 AND (restart_retry_at IS NULL OR restart_retry_at<=clock_timestamp());

-- name: DeferVoiceEpochRestart :exec
UPDATE voice_media_epochs SET restart_retry_at=clock_timestamp()+interval '35 seconds'
WHERE id=$1;

-- name: RetryLiveKitCaptureCompletion :one
UPDATE capture_sessions
SET voice_completion_attempts=voice_completion_attempts+1,
    voice_completion_failed_at=CASE
      WHEN voice_completion_attempts+1>=sqlc.arg(max_attempts)::int THEN clock_timestamp()
      ELSE NULL
    END,
    voice_completion_failure_code=CASE
      WHEN voice_completion_attempts+1>=sqlc.arg(max_attempts)::int THEN sqlc.arg(failure_code)::text
      ELSE NULL
    END
WHERE id=sqlc.arg(id)::text AND status='finalized'
  AND transcript_document_version_id IS NULL
  AND voice_completion_failed_at IS NULL
RETURNING voice_completion_attempts, voice_completion_failed_at, voice_completion_failure_code;

-- name: FailLiveKitCaptureCompletion :one
UPDATE capture_sessions
SET voice_completion_attempts=voice_completion_attempts+1,
    voice_completion_failed_at=clock_timestamp(),
    voice_completion_failure_code=sqlc.arg(failure_code)::text
WHERE id=sqlc.arg(id)::text AND status='finalized'
  AND transcript_document_version_id IS NULL
  AND voice_completion_failed_at IS NULL
RETURNING voice_completion_attempts, voice_completion_failed_at, voice_completion_failure_code;

-- name: SealEmptyVoiceMediaEpoch :one
UPDATE voice_media_epochs epoch
SET observed_state='available',first_archived_ms=$2,archived_through_ms=$2,final_end_ms=$2,
    provider_egress_id=coalesce(epoch.provider_egress_id,$3),sealed_at=clock_timestamp(),updated_at=clock_timestamp()
WHERE epoch.id=$1 AND epoch.desired_state='sealed'
  AND coalesce(epoch.archived_through_ms,0)<=coalesce(epoch.first_archived_ms,0)
  AND NOT EXISTS(SELECT 1 FROM capture_media_ranges span WHERE span.epoch_id=epoch.id AND span.kind='media')
RETURNING epoch.*;
