-- name: GetOwnedLiveKitCaptureForAccount :one
-- Recording questions are private to the person who recorded.
SELECT capture.id,capture.voice_session_id,capture.tenant_id,capture.created_by_actor_id
FROM capture_sessions capture
JOIN actors caller
  ON caller.id=capture.created_by_actor_id AND caller.account_id=sqlc.arg(account_id)::text AND caller.kind='human'
JOIN active_room_members member ON member.actor_id=caller.id AND member.room_id=capture.room_id
JOIN rooms room ON room.id=capture.room_id AND room.deleted_at IS NULL
WHERE capture.id=sqlc.arg(capture_id)::text
  AND capture.voice_session_id IS NOT NULL;

-- name: CreateVoiceCaptureQuestion :one
INSERT INTO voice_capture_questions(id,capture_session_id,kind,question,answer,answered,cutoff_offset_ms,sources,task_title)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
RETURNING *;

-- name: GetVoiceCaptureQuestion :one
SELECT * FROM voice_capture_questions
WHERE capture_session_id=sqlc.arg(capture_session_id)::text AND id=sqlc.arg(id)::text;

-- name: RecordVoiceCaptureQuestionSent :one
-- A task request is handed to Another Me at most once.
WITH sent AS (
UPDATE voice_capture_questions
SET sent_message_id=sqlc.arg(sent_message_id)::text
WHERE id=sqlc.arg(id)::text AND kind='task' AND sent_message_id IS NULL
RETURNING *
), changed_capture AS (
  UPDATE capture_sessions capture SET updated_at=clock_timestamp()
  FROM sent WHERE capture.id=sent.capture_session_id
  RETURNING capture.id
)
SELECT sent.* FROM sent JOIN changed_capture ON changed_capture.id=sent.capture_session_id;

-- name: ListVoiceCaptureQuestions :many
SELECT * FROM voice_capture_questions
WHERE capture_session_id=$1
ORDER BY created_at,id;

-- name: ListConfirmedVoiceCaptureSpeech :many
-- Confirmed live speech of one recording, read through the VoiceSession
-- timeline index.
SELECT segment.start_offset_ms,segment.end_offset_ms,segment.text,segment.speaker_id
FROM capture_sessions capture
JOIN voice_transcript_segments segment
  ON segment.voice_session_id=capture.voice_session_id AND segment.capture_session_id=capture.id
WHERE capture.id=sqlc.arg(capture_id)::text
  AND segment.lane='live' AND segment.kind='speech'
ORDER BY segment.start_offset_ms,segment.end_offset_ms,segment.id;
