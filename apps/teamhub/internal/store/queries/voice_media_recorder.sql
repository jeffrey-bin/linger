-- name: GetVoiceMediaEpochByStagingPrefix :one
SELECT * FROM voice_media_epochs WHERE staging_prefix=$1;

-- name: ReportVoiceMediaRecorder :one
-- A terminal report is final: a late active report from the same recorder
-- cannot revive an epoch that already failed or sealed.
UPDATE voice_media_epochs
SET recorder_state=sqlc.arg(recorder_state),
    recorder_started_at=coalesce(recorder_started_at, sqlc.narg(recorder_started_at)),
    recorder_archived_through_ms=greatest(coalesce(recorder_archived_through_ms, 0), sqlc.arg(recorder_archived_through_ms)::bigint),
    recorder_failure_code=sqlc.narg(recorder_failure_code),
    recorder_reported_at=clock_timestamp(),
    -- Reconciliation orders epochs by updated_at; a recording that reports
    -- every segment must not keep itself out of the queue.
    updated_at=CASE WHEN recorder_state IS DISTINCT FROM sqlc.arg(recorder_state) THEN clock_timestamp() ELSE updated_at END
WHERE staging_prefix=sqlc.arg(staging_prefix)
  AND (recorder_state IS NULL OR recorder_state='active')
RETURNING *;

-- name: GetVoiceSessionProviderRoom :one
SELECT provider_room_name FROM voice_sessions WHERE id=$1;

-- name: DeferVoiceMediaEpochReconcile :exec
-- A reconciliation that fails moves its epoch to the back of the queue, so
-- one epoch that keeps failing cannot hold every other Capture behind it.
UPDATE voice_media_epochs SET updated_at=clock_timestamp() WHERE id=$1;

