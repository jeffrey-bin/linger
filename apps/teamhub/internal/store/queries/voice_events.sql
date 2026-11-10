-- name: ListVoiceEventCaptureIDs :many
-- The Captures an event snapshot carries, oldest first: the newest, every one
-- still on screen as in progress (recording, finalizing, recovering, or
-- finalized while its transcript Document is completing), and every one that
-- changed after the newest started, so a Capture's last change still reaches
-- the stream once a newer Capture exists. Older settled Captures no longer
-- change on screen.
WITH newest AS (
  SELECT id,created_at FROM capture_sessions WHERE voice_session_id=$1
  ORDER BY created_at DESC,id DESC LIMIT 1
)
SELECT capture.id FROM capture_sessions capture, newest
WHERE capture.voice_session_id=$1
  AND (capture.id=newest.id OR capture.updated_at>=newest.created_at
    OR capture.status IN ('starting','recording','finalizing','recovering')
    OR (capture.status='finalized' AND capture.transcript_document_version_id IS NULL
        AND capture.voice_completion_failed_at IS NULL))
ORDER BY capture.created_at,capture.id;

-- name: GetVoiceTranscriptSeq :one
-- The VoiceSession's largest transcript seq. Writers draw seq while holding
-- the VoiceSession row lock, so every segment committed after this read has
-- a larger seq.
SELECT coalesce(max(seq),0)::bigint FROM voice_transcript_segments WHERE voice_session_id=$1;

-- name: GetVoiceStreamState :one
-- One read per SSE heartbeat: the login session still owns the session and
-- its Room membership holds, and the partial change time tells the stream
-- whether a missed notification needs a partial flush.
SELECT voice.latest_partial_updated_at
FROM voice_sessions voice
JOIN actors caller
  ON caller.id=voice.created_by_actor_id AND caller.tenant_id=voice.tenant_id
 AND caller.account_id=sqlc.arg(account_id)::text
 AND caller.kind='human'
JOIN active_room_members membership
  ON membership.room_id=voice.room_id AND membership.actor_id=caller.id
JOIN rooms room ON room.id=voice.room_id AND room.deleted_at IS NULL
WHERE voice.id=sqlc.arg(voice_session_id)::text
  AND voice.auth_session_id=sqlc.arg(auth_session_id)::text
  AND (voice.purpose='hardware_control' OR room.direct_agent_actor_id IS NULL OR EXISTS (
    SELECT 1 FROM agent_registrations registration
    WHERE registration.actor_id=room.direct_agent_actor_id
      AND registration.tenant_id=room.tenant_id AND registration.status='active'
  ));

-- name: ListVoiceTranscriptEventsAfterSeq :many
SELECT segment.id,segment.event_id,segment.voice_session_id,
       coalesce(segment.capture_session_id,'')::text AS capture_session_id,
       segment.media_epoch,segment.lane,segment.start_offset_ms,segment.end_offset_ms,
       segment.text,segment.speaker_id,segment.kind,segment.accepted_at,
       segment.accepted_at::timestamptz AS updated_at,segment.seq
FROM voice_transcript_segments segment
JOIN voice_sessions voice ON voice.id=segment.voice_session_id
JOIN actors caller
  ON caller.id=voice.created_by_actor_id
 AND caller.account_id=sqlc.arg(account_id)::text
 AND caller.kind='human'
JOIN active_room_members membership
  ON membership.room_id=voice.room_id AND membership.actor_id=caller.id
JOIN rooms room ON room.id=voice.room_id AND room.deleted_at IS NULL
WHERE voice.id=sqlc.arg(voice_session_id)::text AND segment.lane='live'
  AND segment.seq > sqlc.arg(after_seq)::bigint
ORDER BY segment.seq
LIMIT 101;
