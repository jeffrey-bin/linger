-- name: CreateVoiceSession :one
WITH authority AS (
  SELECT room.tenant_id,caller.id AS actor_id
  FROM rooms room
  JOIN actors caller
    ON caller.tenant_id=room.tenant_id
   AND caller.account_id=sqlc.arg(account_id)::text
   AND caller.kind='human'
  JOIN active_room_members membership
    ON membership.room_id=room.id AND membership.actor_id=caller.id
  WHERE room.id=sqlc.arg(room_id)::text AND room.deleted_at IS NULL
    -- Dictation sends ordinary chat Messages, so any member Room accepts it
    -- except an Agent direct Room whose Agent is no longer active.
    AND (sqlc.arg(purpose)::text='hardware_control'
      OR room.direct_agent_actor_id IS NULL
      OR EXISTS (SELECT 1 FROM agent_registrations registration
        WHERE registration.actor_id=room.direct_agent_actor_id
          AND registration.tenant_id=room.tenant_id AND registration.status='active'))
)
INSERT INTO voice_sessions(
  id,tenant_id,room_id,created_by_actor_id,status,provider_room_name,participant_identity,
  purpose,auth_session_id
)
SELECT sqlc.arg(id)::text,authority.tenant_id,sqlc.arg(room_id)::text,authority.actor_id,
  'provisioning',sqlc.arg(provider_room_name)::text,sqlc.arg(participant_identity)::text,
  sqlc.arg(purpose)::text,sqlc.narg(auth_session_id)::text
FROM authority
RETURNING *;

-- name: GetVoiceSessionForAccount :one
SELECT voice.*
FROM voice_sessions voice
JOIN actors caller
  ON caller.id=voice.created_by_actor_id AND caller.tenant_id=voice.tenant_id
 AND caller.account_id=sqlc.arg(account_id)::text
 AND caller.kind='human'
JOIN active_room_members membership
  ON membership.room_id=voice.room_id AND membership.actor_id=caller.id
JOIN rooms room ON room.id=voice.room_id AND room.deleted_at IS NULL
WHERE voice.id=sqlc.arg(id)::text
  AND (voice.purpose='hardware_control' OR room.direct_agent_actor_id IS NULL OR EXISTS (
    SELECT 1 FROM agent_registrations registration
    WHERE registration.actor_id=room.direct_agent_actor_id
      AND registration.tenant_id=room.tenant_id AND registration.status='active'
  ));

-- name: GetActiveRecordingSessionForAuthSessionRoom :one
-- The recording window resumes only this login session's recording session;
-- a dictation session is never reused for a recording.
SELECT voice.*
FROM voice_sessions voice
JOIN actors caller
  ON caller.id=voice.created_by_actor_id
 AND caller.account_id=sqlc.arg(account_id)::text
 AND caller.kind='human'
JOIN active_room_members membership
  ON membership.room_id=voice.room_id AND membership.actor_id=caller.id
WHERE voice.room_id=sqlc.arg(room_id)::text
  AND voice.auth_session_id=sqlc.arg(auth_session_id)::text
  AND voice.purpose='hardware_control'
  AND voice.status IN ('provisioning','connected','reconnecting','closing');

-- name: VoiceSessionBelongsToAuthSession :one
SELECT EXISTS (SELECT 1 FROM voice_sessions
  WHERE id=sqlc.arg(voice_session_id)::text AND auth_session_id=sqlc.arg(auth_session_id)::text);

-- name: VoiceCaptureBelongsToAuthSession :one
SELECT EXISTS (SELECT 1 FROM capture_sessions capture
  JOIN voice_sessions voice ON voice.id=capture.voice_session_id
  WHERE capture.id=sqlc.arg(capture_session_id)::text AND voice.auth_session_id=sqlc.arg(auth_session_id)::text);

-- name: AuthSessionIsActive :one
-- A VoiceSession whose login session was revoked, expired or deleted closes.
SELECT EXISTS (SELECT 1 FROM auth_sessions
  WHERE id=sqlc.narg(auth_session_id)::text AND revoked_at IS NULL AND expires_at > clock_timestamp());

-- name: ActivateVoiceSession :one
UPDATE voice_sessions
SET status='connected',last_failure_code=NULL,updated_at=clock_timestamp()
WHERE id=$1 AND status IN ('provisioning','reconnecting')
RETURNING *;

-- name: AdvanceVoiceSessionCredentialGeneration :one
UPDATE voice_sessions
SET credential_generation=credential_generation+1,updated_at=clock_timestamp()
WHERE id=$1 AND status IN ('provisioning','connected','reconnecting')
RETURNING *;

-- name: MarkVoiceSessionReconnecting :one
UPDATE voice_sessions
SET status='reconnecting',last_failure_code=$2,updated_at=clock_timestamp()
WHERE id=$1 AND status IN ('provisioning','connected','reconnecting')
RETURNING *;

-- name: ClaimVoiceSessionReconcile :one
-- Takes an open session that no write touched for the reconcile interval; a
-- session whose publisher is absent waits a minute.
UPDATE voice_sessions
SET updated_at=clock_timestamp()
WHERE id=sqlc.arg(id)::text
  AND status IN ('provisioning','connected','reconnecting','closing')
  AND updated_at < clock_timestamp()-CASE
    WHEN last_failure_code='publisher_absent' AND status<>'closing' THEN interval '60 seconds'
    ELSE sqlc.arg(min_age)::interval
  END
RETURNING *;

-- name: VoiceSessionReconcileDueIn :one
-- Seconds until ClaimVoiceSessionReconcile can take the session; Infinity
-- once it is closed.
SELECT coalesce(extract(epoch FROM min(updated_at+CASE
    WHEN last_failure_code='publisher_absent' AND status<>'closing' THEN interval '60 seconds'
    ELSE sqlc.arg(min_age)::interval
  END)-clock_timestamp()),'Infinity')::float8 AS wait_seconds
FROM voice_sessions
WHERE id=sqlc.arg(id)::text AND status IN ('provisioning','connected','reconnecting','closing');

-- name: MarkVoiceSessionPublisherAbsent :exec
UPDATE voice_sessions
SET status='reconnecting',last_failure_code='publisher_absent',updated_at=clock_timestamp()
WHERE id=$1 AND credential_generation=$2 AND status IN ('provisioning','connected','reconnecting');

-- name: CloseVoiceSession :one
-- A closed session keeps no partial text (M11-N16).
UPDATE voice_sessions
SET status='closed',closed_at=coalesce(closed_at,clock_timestamp()),updated_at=clock_timestamp(),
    latest_partial_text=NULL,latest_partial_start_offset_ms=NULL,
    latest_partial_end_offset_ms=NULL,latest_partial_updated_at=NULL
WHERE id=$1 AND status IN ('provisioning','connected','reconnecting','closing','closed')
RETURNING *;

-- name: LockVoiceSession :one
-- NO KEY: commit-time foreign-key checks from children take KEY SHARE on
-- this row and must not wait behind its holder. Transcript writers hold it
-- until commit, which orders voice_transcript_segments.seq by commit.
SELECT * FROM voice_sessions WHERE id=$1 FOR NO KEY UPDATE;

-- name: RequestVoiceSessionClose :one
UPDATE voice_sessions SET status='closing',updated_at=clock_timestamp()
WHERE id=$1 AND status IN ('provisioning','connected','reconnecting','closing')
RETURNING *;

-- name: InvalidateUnauthorizedVoiceSession :one
WITH revoked AS (
  UPDATE voice_sessions voice
  SET status='closing',last_failure_code='membership_revoked',updated_at=clock_timestamp()
  WHERE voice.id=$1 AND voice.status IN ('provisioning','connected','reconnecting')
    AND NOT EXISTS (
      SELECT 1 FROM active_room_members member
      JOIN actors actor ON actor.id=member.actor_id AND actor.tenant_id=member.tenant_id
      JOIN rooms room ON room.id=member.room_id AND room.deleted_at IS NULL
      WHERE member.room_id=voice.room_id AND member.actor_id=voice.created_by_actor_id
        AND actor.kind='human' AND actor.account_id IS NOT NULL
    )
  RETURNING voice.*
), failed_captures AS (
  UPDATE capture_sessions capture SET status='failed',updated_at=clock_timestamp()
  FROM revoked voice
  WHERE capture.voice_session_id=voice.id AND capture.status IN ('starting','recording','finalizing')
  RETURNING capture.id
), failed_epochs AS (
  UPDATE voice_media_epochs epoch
  SET desired_state='sealed',observed_state='failed',last_failure_code='membership_revoked',updated_at=clock_timestamp()
  FROM failed_captures capture WHERE epoch.capture_session_id=capture.id
)
SELECT id FROM revoked;

-- name: CreateLiveKitCaptureSession :one
WITH voice AS (
  SELECT session.*
  FROM voice_sessions session
  JOIN actors caller
    ON caller.id=session.created_by_actor_id
   AND caller.account_id=sqlc.arg(account_id)::text
   AND caller.kind='human'
  JOIN active_room_members membership
    ON membership.room_id=session.room_id AND membership.actor_id=caller.id
  WHERE session.id=sqlc.arg(voice_session_id)::text
    AND session.room_id=sqlc.arg(room_id)::text
    AND session.status IN ('provisioning','connected','reconnecting')
    AND session.purpose='hardware_control'
)
INSERT INTO capture_sessions(
  id,tenant_id,room_id,created_by_actor_id,status,
  voice_session_id,transcript_start_offset_ms,requested_transcript_start_offset_ms
)
SELECT sqlc.arg(id)::text,voice.tenant_id,voice.room_id,voice.created_by_actor_id,
  'starting',voice.id,sqlc.arg(start_offset_ms)::bigint,sqlc.arg(start_offset_ms)::bigint
FROM voice
RETURNING *;

-- name: GetActiveLiveKitCaptureForVoiceSession :one
SELECT * FROM capture_sessions
WHERE voice_session_id=$1
  AND (status IN ('starting','recording','finalizing') OR (status='finalized' AND transcript_document_version_id IS NULL AND voice_completion_failed_at IS NULL))
LIMIT 1;

-- name: GetActiveLiveKitCaptureForAccountRoom :one
SELECT capture.*
FROM capture_sessions capture
JOIN actors caller
  ON caller.id=capture.created_by_actor_id
 AND caller.account_id=sqlc.arg(account_id)::text
 AND caller.kind='human'
JOIN active_room_members membership
  ON membership.room_id=capture.room_id AND membership.actor_id=caller.id
WHERE capture.room_id=sqlc.arg(room_id)::text
  AND (capture.status IN ('starting','recording','finalizing','recovering') OR (capture.status='finalized' AND capture.transcript_document_version_id IS NULL AND capture.voice_completion_failed_at IS NULL))
ORDER BY (capture.status IN ('starting','recording','finalizing')) DESC,capture.created_at DESC
LIMIT 1;

-- name: TransitionLiveKitCaptureStatus :one
UPDATE capture_sessions
SET status=sqlc.arg(status)::text,updated_at=clock_timestamp()
WHERE id=sqlc.arg(id)::text
  AND (
    (status='starting' AND sqlc.arg(status)::text IN ('recording','finalizing','failed')) OR
    (status='recording' AND sqlc.arg(status)::text IN ('finalizing','failed')) OR
    (status='finalizing' AND sqlc.arg(status)::text='failed') OR
    status=sqlc.arg(status)::text
  )
RETURNING *;

-- name: CreateVoiceMediaEpoch :one
INSERT INTO voice_media_epochs(
  id,voice_session_id,capture_session_id,epoch_index,desired_state,observed_state,staging_prefix
) VALUES(
  sqlc.arg(id)::text,sqlc.arg(voice_session_id)::text,sqlc.arg(capture_session_id)::text,
  sqlc.arg(epoch_index)::integer,'active','requested',sqlc.arg(staging_prefix)::text
)
RETURNING *;

-- name: GetVoiceMediaEpoch :one
SELECT * FROM voice_media_epochs WHERE id=$1;

-- name: GetLatestVoiceMediaEpochForCapture :one
SELECT * FROM voice_media_epochs
WHERE capture_session_id=$1
ORDER BY epoch_index DESC
LIMIT 1;

-- name: ListVoiceMediaEpochsForCapture :many
SELECT * FROM voice_media_epochs
WHERE capture_session_id=$1
ORDER BY epoch_index,id;

-- name: ListCaptureMediaRangesForCapture :many
SELECT * FROM capture_media_ranges
WHERE capture_session_id=$1
ORDER BY start_offset_ms,end_offset_ms,id;

-- name: GetCaptureGapSummary :one
SELECT count(*)::bigint AS gap_count,
       coalesce(sum(end_offset_ms-start_offset_ms),0)::bigint AS gap_duration_ms
FROM capture_media_ranges
WHERE capture_session_id=$1 AND kind='gap';

-- name: ListVoiceMediaEpochsForReconcile :many
SELECT epoch.*,voice.provider_room_name,voice.participant_identity,
       capture.status AS capture_status,actor.account_id,capture.stop_requested_at
FROM voice_media_epochs epoch
JOIN voice_sessions voice ON voice.id=epoch.voice_session_id
JOIN capture_sessions capture ON capture.id=epoch.capture_session_id
JOIN actors actor
  ON actor.id=capture.created_by_actor_id AND actor.tenant_id=capture.tenant_id AND actor.kind='human'
WHERE epoch.capture_session_id=sqlc.arg(capture_session_id)::text
  AND (epoch.observed_state IN ('requested','active','sealing','unknown')
       OR (epoch.observed_state='failed' AND epoch.last_failure_code='egress_failed_without_media'))
  AND capture.status IN ('starting','recording','finalizing')
  AND epoch.updated_at < clock_timestamp()-interval '2 seconds'
  AND (epoch.epoch_index=0 OR epoch.first_archived_ms IS NOT NULL
       OR epoch.restart_retry_at IS NULL OR epoch.restart_retry_at<=clock_timestamp())
ORDER BY epoch.updated_at,epoch.id
LIMIT 1;

-- name: VoiceEpochReconciliationDueIn :one
-- Seconds until ListVoiceMediaEpochsForReconcile returns one of the Capture's
-- epochs; a recovery epoch also waits out its delayed recorder restart.
SELECT coalesce(extract(epoch FROM min(greatest(epoch.updated_at+interval '2 seconds',
    CASE WHEN epoch.epoch_index>0 AND epoch.first_archived_ms IS NULL THEN epoch.restart_retry_at END
    ))-clock_timestamp()),'Infinity')::float8 AS wait_seconds
FROM voice_media_epochs epoch
JOIN capture_sessions capture ON capture.id=epoch.capture_session_id
JOIN actors actor
  ON actor.id=capture.created_by_actor_id AND actor.tenant_id=capture.tenant_id AND actor.kind='human'
WHERE epoch.capture_session_id=$1
  AND (epoch.observed_state IN ('requested','active','sealing','unknown')
       OR (epoch.observed_state='failed' AND epoch.last_failure_code='egress_failed_without_media'))
  AND capture.status IN ('starting','recording','finalizing');

-- name: ActivateVoiceMediaEpoch :one
UPDATE voice_media_epochs
SET provider_egress_id=$2,observed_state='active',first_archived_ms=$3,
    archived_through_ms=$3,last_failure_code=NULL,updated_at=clock_timestamp()
WHERE id=$1 AND observed_state IN ('requested','unknown')
RETURNING *;

-- name: MarkVoiceMediaEpochUnknown :one
UPDATE voice_media_epochs
SET observed_state='unknown',last_failure_code=$2,updated_at=clock_timestamp()
WHERE id=$1 AND observed_state IN ('requested','active','sealing','unknown')
RETURNING *;

-- name: MarkVoiceMediaEpochFailed :one
UPDATE voice_media_epochs
SET observed_state='failed',last_failure_code=$2,updated_at=clock_timestamp()
WHERE id=$1 AND observed_state IN ('requested','active','sealing','unknown')
RETURNING *;

-- name: FailVoiceMediaEpochWithoutMedia :exec
WITH target AS MATERIALIZED (
  SELECT epoch.id,epoch.capture_session_id,voice.id AS voice_session_id
  FROM voice_media_epochs epoch JOIN voice_sessions voice ON voice.id=epoch.voice_session_id
  WHERE epoch.id=$1 AND epoch.observed_state IN ('requested','active','sealing','unknown','failed')
  FOR NO KEY UPDATE OF voice
), failed_epoch AS (
  UPDATE voice_media_epochs epoch
  SET observed_state='failed',desired_state='sealed',last_failure_code='egress_failed_without_media',
      restart_retry_at=NULL,updated_at=clock_timestamp()
  FROM target WHERE epoch.id=target.id RETURNING epoch.capture_session_id,epoch.voice_session_id
), failed_capture AS (
  UPDATE capture_sessions capture SET status='failed',updated_at=clock_timestamp()
  FROM failed_epoch WHERE capture.id=failed_epoch.capture_session_id
    AND capture.status IN ('starting','recording','finalizing')
  RETURNING capture.id,capture.voice_session_id
)
UPDATE voice_sessions voice SET status='closing',last_failure_code='egress_failed_without_media',updated_at=clock_timestamp()
FROM failed_capture WHERE voice.id=failed_capture.voice_session_id
  AND voice.status IN ('provisioning','connected','reconnecting');

-- name: RequestSealVoiceMediaEpoch :one
UPDATE voice_media_epochs
SET desired_state='sealed',observed_state=CASE WHEN observed_state='active' THEN 'sealing' ELSE observed_state END,
    updated_at=clock_timestamp()
WHERE id=$1 AND desired_state='active' AND observed_state IN ('requested','active','sealing','unknown')
RETURNING *;

-- name: AdvanceVoiceMediaEpochObservation :one
UPDATE voice_media_epochs
SET provider_egress_id=coalesce(provider_egress_id,$2),observed_state=$3,
    archived_through_ms=greatest(coalesce(archived_through_ms,0),$4),
    last_failure_code=NULL,updated_at=clock_timestamp()
WHERE id=$1 AND observed_state IN ('requested','active','sealing','unknown')
RETURNING *;

-- name: ObserveVoiceMediaSegmentProgress :one
UPDATE voice_media_epochs
SET segment_count=greatest(segment_count,sqlc.arg(segment_count)::bigint),
    last_segment_at=CASE
      WHEN sqlc.arg(segment_count)::bigint > segment_count THEN clock_timestamp()
      ELSE last_segment_at
    END,
    updated_at=clock_timestamp()
WHERE id=sqlc.arg(id)::text AND observed_state IN ('requested','active','sealing','unknown')
RETURNING *;

-- name: SealVoiceMediaEpoch :one
UPDATE voice_media_epochs
SET desired_state='sealed',observed_state='available',playlist_object_key=$2,
    archived_through_ms=$3,final_end_ms=$3,sealed_at=clock_timestamp(),updated_at=clock_timestamp()
WHERE id=$1 AND observed_state IN ('requested','active','sealing','unknown')
RETURNING *;

-- name: CreateCaptureMediaRange :one
INSERT INTO capture_media_ranges(
  id,capture_session_id,epoch_id,kind,start_offset_ms,end_offset_ms,reason
) VALUES($1,$2,$3,$4,$5,$6,$7)
ON CONFLICT(capture_session_id,kind,start_offset_ms,end_offset_ms) DO UPDATE
SET reason=EXCLUDED.reason
WHERE capture_media_ranges.epoch_id IS NOT DISTINCT FROM EXCLUDED.epoch_id
RETURNING *;

-- name: RequestVoiceCaptureStop :one
-- Records the first Stop's commit time: the stop intent the final media end
-- is cut at. A Capture that already has one is left alone.
UPDATE capture_sessions SET stop_requested_at=clock_timestamp()
WHERE id=$1 AND stop_requested_at IS NULL
RETURNING *;

-- name: RequestVoiceCaptureMaterialization :exec
UPDATE capture_sessions SET materialize_requested_at=coalesce(materialize_requested_at,clock_timestamp())
WHERE id=$1;

-- name: SealVoiceMediaEpochAtBoundary :one
UPDATE voice_media_epochs
SET desired_state='sealed',observed_state='available',playlist_object_key=$2,
    archived_through_ms=$3,final_end_ms=$4,sealed_at=clock_timestamp(),updated_at=clock_timestamp()
WHERE id=$1
  AND observed_state IN ('requested','active','sealing','unknown','available')
  AND $4::bigint > coalesce(first_archived_ms,0)
  AND $4::bigint <= $3::bigint
RETURNING *;

-- name: FailLiveKitCaptureTranscriptFinalization :one
WITH failed_capture AS (
  UPDATE capture_sessions capture
  SET status='failed',updated_at=clock_timestamp()
  WHERE capture.id=sqlc.arg(capture_session_id)::text
    AND capture.materialize_requested_at IS NOT NULL
    AND capture.status='finalizing'
  RETURNING capture.*
), marked_epoch AS (
  UPDATE voice_media_epochs epoch
  SET last_failure_code='transcript_unavailable',updated_at=clock_timestamp()
  FROM failed_capture capture
  WHERE epoch.capture_session_id=capture.id
    AND epoch.observed_state='available'
)
SELECT * FROM failed_capture;

-- name: ClaimVoiceMediaMaterialization :one
-- Takes the Capture's due final materialization and counts the attempt.
-- Its River job is the only runner.
UPDATE capture_sessions
SET materialize_attempts=materialize_attempts+1
WHERE id=$1 AND materialize_requested_at IS NOT NULL
  AND (status='finalizing' OR (status='recovering' AND transcript_recovered_at IS NOT NULL))
  AND (materialize_retry_at IS NULL OR materialize_retry_at<=clock_timestamp())
RETURNING materialize_attempts,materialize_requested_at;

-- name: VoiceMediaMaterializationDueIn :one
-- Seconds until ClaimVoiceMediaMaterialization can take the Capture; Infinity
-- when it is settled or not ready.
SELECT coalesce(extract(epoch FROM (
    SELECT materialize_retry_at-clock_timestamp() FROM capture_sessions
    WHERE id=$1 AND materialize_requested_at IS NOT NULL AND materialize_retry_at IS NOT NULL
      AND (status='finalizing' OR (status='recovering' AND transcript_recovered_at IS NOT NULL))
  )),'Infinity')::float8 AS wait_seconds;

-- name: ReleaseVoiceMediaMaterialization :exec
-- Holds the next attempt back by the retry delay. A materialization that waits
-- for the transcript returns the attempt it took, so a long transcript wait
-- does not spend the failure budget.
UPDATE capture_sessions
SET materialize_retry_at=clock_timestamp()+sqlc.arg(retry_delay)::interval,
    materialize_attempts=CASE WHEN sqlc.arg(refund_attempt)::boolean
      THEN greatest(materialize_attempts-1,0) ELSE materialize_attempts END
WHERE id=sqlc.arg(id)::text;

-- name: FailVoiceMediaMaterialization :one
UPDATE capture_sessions
SET status='failed',updated_at=clock_timestamp()
WHERE id=$1 AND materialize_requested_at IS NOT NULL
  AND status IN ('finalizing','recovering')
RETURNING id,tenant_id,room_id,created_by_actor_id;

-- name: GetVoiceMediaMaterializationContext :one
SELECT capture.id AS capture_session_id,capture.tenant_id,capture.room_id,capture.created_by_actor_id,
       capture.materialize_requested_at,actor.account_id,
       range.start_offset_ms,range.end_offset_ms
FROM capture_sessions capture
JOIN actors actor ON actor.id=capture.created_by_actor_id AND actor.tenant_id=capture.tenant_id
JOIN LATERAL (
  SELECT min(start_offset_ms)::bigint AS start_offset_ms,
         max(end_offset_ms)::bigint AS end_offset_ms
  FROM capture_media_ranges
  WHERE capture_session_id=capture.id AND kind='media'
) range ON true
WHERE capture.id=$1 AND capture.materialize_requested_at IS NOT NULL;

-- name: FinalizeLiveKitCapture :one
UPDATE capture_sessions
SET status='finalized',document_id=$2,document_version_id=$3,updated_at=clock_timestamp()
WHERE id=$1 AND status IN ('finalizing','recovering')
  AND (NOT transcript_integrity_lost OR transcript_recovered_at IS NOT NULL)
RETURNING *;

-- name: AttachCaptureMediaOutputDocument :one
UPDATE capture_media_outputs
SET document_id=$2,document_version_id=$3
WHERE id=$1 AND document_id IS NULL AND document_version_id IS NULL
RETURNING *;

-- name: UpdateVoiceSessionPartialTranscript :one
UPDATE voice_sessions
SET latest_partial_text=$2,latest_partial_start_offset_ms=$3,
    latest_partial_end_offset_ms=$4,latest_partial_updated_at=clock_timestamp(),updated_at=clock_timestamp()
WHERE id=$1 AND status IN ('provisioning','connected','reconnecting','closing')
RETURNING *;

-- name: ClearVoiceSessionPartialTranscript :one
UPDATE voice_sessions
SET latest_partial_text=NULL,latest_partial_start_offset_ms=NULL,
    latest_partial_end_offset_ms=NULL,latest_partial_updated_at=NULL,updated_at=clock_timestamp()
WHERE id=$1
RETURNING *;

-- name: ClearConfirmedVoicePartialTranscript :exec
UPDATE voice_sessions
SET latest_partial_text=NULL,latest_partial_start_offset_ms=NULL,
    latest_partial_end_offset_ms=NULL,latest_partial_updated_at=NULL,updated_at=clock_timestamp()
WHERE id=$1 AND latest_partial_end_offset_ms <= $2;

-- name: GetVoiceSessionPartialForAccount :one
SELECT voice.latest_partial_text,voice.latest_partial_start_offset_ms,
       voice.latest_partial_end_offset_ms,voice.latest_partial_updated_at
FROM voice_sessions voice
JOIN actors caller ON caller.id=voice.created_by_actor_id
  AND caller.account_id=sqlc.arg(account_id)::text AND caller.kind='human'
JOIN active_room_members membership ON membership.room_id=voice.room_id AND membership.actor_id=caller.id
JOIN rooms room ON room.id=voice.room_id AND room.deleted_at IS NULL
WHERE voice.id=sqlc.arg(voice_session_id)::text;

-- name: GetVoiceRuntimeSessionContext :one
SELECT voice.*,actor.account_id
FROM voice_sessions voice
JOIN actors actor
  ON actor.id=voice.created_by_actor_id AND actor.tenant_id=voice.tenant_id AND actor.kind='human'
JOIN active_room_members member ON member.room_id=voice.room_id AND member.actor_id=actor.id
JOIN rooms room ON room.id=voice.room_id AND room.deleted_at IS NULL
WHERE voice.id=$1 AND voice.status IN ('provisioning','connected','reconnecting','closing')
  AND (voice.purpose='hardware_control' OR room.direct_agent_actor_id IS NULL OR EXISTS (
    SELECT 1 FROM agent_registrations registration
    WHERE registration.actor_id=room.direct_agent_actor_id
      AND registration.tenant_id=room.tenant_id AND registration.status='active'
  ));

-- name: CreateVoiceTranscriptSegment :one
-- The caller holds LockVoiceSession until commit, so seq (the column default)
-- grows in commit order within the VoiceSession. A retry that changes the
-- words or fills in the speaker takes a new seq so the event feed resends the
-- row; an identical retry keeps it. A captured final is written only while
-- its Capture still accepts speech up to the final's end; otherwise no row
-- is returned and GetVoiceTranscriptSegmentByEvent tells a retry from an
-- ignored final.
WITH writable_capture AS (
  SELECT session.id
  FROM capture_sessions session
  JOIN rooms room
    ON room.id=session.room_id AND room.tenant_id=session.tenant_id AND room.deleted_at IS NULL
  JOIN actors caller
    ON caller.tenant_id=session.tenant_id AND caller.account_id=sqlc.arg(account_id)::text AND caller.kind='human'
  JOIN room_members membership
    ON membership.room_id=session.room_id AND membership.actor_id=caller.id
  WHERE session.id=sqlc.narg(capture_session_id)::text
    AND session.room_id=sqlc.arg(room_id)::text
    AND session.status IN ('starting','recording','finalizing')
    AND (
      session.transcript_end_offset_ms IS NULL OR
      sqlc.arg(end_offset_ms)::bigint <= session.transcript_end_offset_ms
    )
  FOR NO KEY UPDATE OF session
)
INSERT INTO voice_transcript_segments(
  id,event_id,voice_session_id,capture_session_id,media_epoch,lane,
  start_offset_ms,end_offset_ms,text,normalized_text,kind,speaker_id
) SELECT
  sqlc.arg(id)::text,sqlc.arg(event_id)::text,sqlc.arg(voice_session_id)::text,
  sqlc.narg(capture_session_id)::text,sqlc.arg(media_epoch)::integer,sqlc.arg(lane)::text,
  sqlc.arg(start_offset_ms)::bigint,sqlc.arg(end_offset_ms)::bigint,sqlc.arg(text)::text,
  sqlc.arg(normalized_text)::text,sqlc.arg(kind)::text,sqlc.narg(speaker_id)::text
WHERE sqlc.narg(capture_session_id)::text IS NULL OR EXISTS (SELECT 1 FROM writable_capture)
ON CONFLICT(event_id) DO UPDATE SET text=EXCLUDED.text,
  speaker_id=COALESCE(EXCLUDED.speaker_id,voice_transcript_segments.speaker_id),
  seq=CASE WHEN (voice_transcript_segments.text,voice_transcript_segments.speaker_id)
    IS NOT DISTINCT FROM (EXCLUDED.text,COALESCE(EXCLUDED.speaker_id,voice_transcript_segments.speaker_id))
    THEN voice_transcript_segments.seq ELSE nextval('voice_transcript_segment_seq') END
WHERE voice_transcript_segments.normalized_text=EXCLUDED.normalized_text
  AND voice_transcript_segments.kind=EXCLUDED.kind
  AND (
    voice_transcript_segments.speaker_id IS NOT DISTINCT FROM EXCLUDED.speaker_id
    OR voice_transcript_segments.speaker_id IS NULL
  )
RETURNING *;

-- name: GetVoiceTranscriptSegmentByEvent :one
SELECT * FROM voice_transcript_segments WHERE voice_session_id=$1 AND event_id=$2;

-- name: ListVoiceTranscriptEventsForAccount :many
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
  AND (
    segment.accepted_at > sqlc.arg(after_updated_at)::timestamptz OR
    (segment.accepted_at=sqlc.arg(after_updated_at)::timestamptz
      AND segment.id > sqlc.arg(after_id)::text)
  )
ORDER BY segment.accepted_at,segment.id
LIMIT 100;

-- name: GetCaptureMediaOutput :one
SELECT * FROM capture_media_outputs
WHERE capture_session_id=$1 AND purpose=$2 AND range_digest=$3;

-- name: GetFinalCaptureMediaOutput :one
SELECT * FROM capture_media_outputs
WHERE capture_session_id=$1 AND purpose='final';

-- name: GetPendingLiveKitCaptureCompletion :one
-- Reads a finalized Capture whose completion is still owed, with the account
-- that completes it.
SELECT capture.id,capture.tenant_id,capture.room_id,capture.created_by_actor_id,
       actor.account_id,capture.document_id,capture.document_version_id,
       capture.voice_completion_attempts
FROM capture_sessions capture
JOIN actors actor
  ON actor.id=capture.created_by_actor_id AND actor.tenant_id=capture.tenant_id AND actor.kind='human'
  AND actor.account_id IS NOT NULL
JOIN active_room_members member ON member.room_id=capture.room_id AND member.actor_id=actor.id
JOIN rooms room ON room.id=capture.room_id AND room.deleted_at IS NULL
WHERE capture.id=$1
  AND capture.status='finalized'
  AND capture.document_id IS NOT NULL
  AND capture.document_version_id IS NOT NULL
  AND capture.transcript_document_id IS NULL
  AND capture.transcript_document_version_id IS NULL
  AND capture.voice_completion_failed_at IS NULL;

-- name: CreateCaptureMediaOutput :one
INSERT INTO capture_media_outputs(
  id,capture_session_id,purpose,range_digest,object_key,filename,media_type,
  duration_ms,size_bytes,sha256
) VALUES($1,$2,$3,$4,$5,$6,'audio/mp4',$7,$8,$9)
ON CONFLICT(capture_session_id,purpose,range_digest) DO UPDATE
SET object_key=EXCLUDED.object_key
WHERE capture_media_outputs.object_key=EXCLUDED.object_key
  AND capture_media_outputs.duration_ms=EXCLUDED.duration_ms
  AND capture_media_outputs.size_bytes=EXCLUDED.size_bytes
  AND capture_media_outputs.sha256=EXCLUDED.sha256
RETURNING *;
-- name: GetVoiceMediaPolicyForAccount :one
SELECT caller.id AS actor_id,
  coalesce((SELECT voice.room_id FROM voice_sessions voice WHERE voice.created_by_actor_id=caller.id
    AND voice.auth_session_id=sqlc.arg(auth_session_id)::text AND voice.purpose='hardware_control'
    AND voice.status IN ('provisioning','connected','reconnecting','closing')
    ORDER BY voice.created_at DESC LIMIT 1),'')::text AS livekit_room_id
FROM actors caller
WHERE caller.tenant_id=sqlc.arg(tenant_id)::text AND caller.account_id=sqlc.arg(account_id)::text AND caller.kind='human';
-- name: RecordVoiceInputBoundary :exec
WITH previous_input AS (
  SELECT id,last_input_started_ms,last_input_ended_ms
  FROM voice_sessions
  WHERE id=sqlc.arg(voice_session_id)::text
  FOR NO KEY UPDATE
), interrupted_capture AS (
  UPDATE capture_sessions capture
  SET transcript_integrity_lost=true
  FROM previous_input previous
  WHERE capture.voice_session_id=previous.id
    AND capture.status IN ('starting','recording','finalizing')
    AND sqlc.arg(kind)::text='track_started'
    AND sqlc.arg(offset_ms)::bigint > coalesce(previous.last_input_started_ms,-1)
    AND previous.last_input_started_ms IS NOT NULL
    AND (
      previous.last_input_started_ms > coalesce(previous.last_input_ended_ms,-1) OR
      sqlc.arg(offset_ms)::bigint > greatest(coalesce(previous.last_input_ended_ms,sqlc.arg(offset_ms)::bigint),
        coalesce(capture.transcript_start_offset_ms,sqlc.arg(offset_ms)::bigint)) + 250
    )
  RETURNING capture.id,
    greatest(coalesce(capture.transcript_start_offset_ms,0),
      CASE WHEN previous.last_input_started_ms > coalesce(previous.last_input_ended_ms,-1)
      THEN coalesce((SELECT max(coverage.end_offset_ms) FROM capture_transcript_coverage coverage
        WHERE coverage.session_id=capture.id AND coverage.end_offset_ms<=sqlc.arg(offset_ms)::bigint),previous.last_input_started_ms)
      ELSE previous.last_input_ended_ms END) AS uncertainty_start
), uncertainty AS (
  INSERT INTO voice_transcript_uncertainties(capture_session_id,event_id,start_offset_ms,end_offset_ms,reason)
  SELECT id,'track-start:' || sqlc.arg(offset_ms)::bigint::text,uncertainty_start,sqlc.arg(offset_ms)::bigint,'track_interruption'
  FROM interrupted_capture WHERE uncertainty_start<sqlc.arg(offset_ms)::bigint
  ON CONFLICT(capture_session_id,event_id) DO NOTHING
)
UPDATE voice_sessions voice
SET last_input_started_ms=CASE WHEN sqlc.arg(kind)::text='track_started'
      THEN greatest(coalesce(voice.last_input_started_ms,0),sqlc.arg(offset_ms)::bigint) ELSE voice.last_input_started_ms END,
    last_input_ended_ms=CASE WHEN sqlc.arg(kind)::text='track_ended'
      THEN greatest(coalesce(voice.last_input_ended_ms,0),sqlc.arg(offset_ms)::bigint) ELSE voice.last_input_ended_ms END
FROM previous_input previous
WHERE voice.id=previous.id;

-- name: MarkStoppedVoiceTranscriptGap :exec
WITH interrupted AS (
UPDATE capture_sessions capture SET transcript_integrity_lost=true
FROM voice_sessions voice
WHERE capture.id=$1 AND capture.voice_session_id=voice.id
  AND capture.status IN ('starting','recording','finalizing')
  AND voice.last_input_started_ms IS NOT NULL
  AND voice.last_input_ended_ms >= voice.last_input_started_ms
  AND extract(epoch FROM clock_timestamp()-voice.created_at)*1000 > voice.last_input_ended_ms+250
RETURNING capture.id,greatest(coalesce(capture.transcript_start_offset_ms,0),voice.last_input_ended_ms) AS start_ms,
  floor(extract(epoch FROM clock_timestamp()-voice.created_at)*1000)::bigint AS end_ms
)
INSERT INTO voice_transcript_uncertainties(capture_session_id,event_id,start_offset_ms,end_offset_ms,reason)
SELECT id,'input-ended:' || start_ms::text,start_ms,end_ms,'input_ended' FROM interrupted WHERE end_ms>start_ms
ON CONFLICT(capture_session_id,event_id) DO UPDATE SET end_offset_ms=greatest(voice_transcript_uncertainties.end_offset_ms,EXCLUDED.end_offset_ms);

-- name: GetOwedVoiceMediaStop :one
-- Returns the last recorder epoch of a stopped Capture while its recorder is
-- known and still has to be stopped.
SELECT epoch.* FROM capture_sessions capture
JOIN LATERAL (
  SELECT * FROM voice_media_epochs WHERE capture_session_id=capture.id
  ORDER BY epoch_index DESC LIMIT 1
) epoch ON true
WHERE capture.id=$1 AND capture.status='finalizing' AND capture.stop_requested_at IS NOT NULL
  AND epoch.desired_state='sealed' AND epoch.provider_egress_id IS NOT NULL
  AND epoch.observed_state IN ('requested','active','sealing','unknown');

-- name: VoiceStagingCleanupReady :one
-- Reports whether the Capture ended and no recorder can still write its
-- staging; a Capture whose staging is already gone is not ready.
SELECT EXISTS (
  SELECT 1 FROM capture_sessions capture
  WHERE capture.id=$1 AND capture.status IN ('finalized','failed') AND capture.staging_deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM voice_media_epochs epoch WHERE epoch.capture_session_id=capture.id
      AND epoch.observed_state IN ('requested','active','sealing','unknown'))
)::boolean AS ready;

-- name: MarkVoiceStagingDeleted :exec
UPDATE capture_sessions SET staging_deleted_at=clock_timestamp()
WHERE id=$1 AND staging_deleted_at IS NULL;

-- name: ListUnfinishedVoiceWork :many
-- Every voice session and Capture that still owes background work, by the
-- kind of job that does it.
SELECT 'session'::text AS kind,id FROM voice_sessions WHERE status<>'closed'
UNION ALL
SELECT 'capture'::text,id FROM capture_sessions
WHERE voice_session_id IS NOT NULL AND status IN ('starting','recording','finalizing')
UNION ALL
SELECT 'stop'::text,id FROM capture_sessions
WHERE status='finalizing' AND stop_requested_at IS NOT NULL
UNION ALL
SELECT 'materialize'::text,id FROM capture_sessions
WHERE status IN ('finalizing','recovering') AND materialize_requested_at IS NOT NULL
UNION ALL
SELECT 'transcript_recovery'::text,id FROM capture_sessions
WHERE status='recovering' AND transcript_recovered_at IS NULL AND transcript_recovery_status IN ('pending','running')
UNION ALL
SELECT 'completion'::text,id FROM capture_sessions
WHERE status='finalized' AND document_version_id IS NOT NULL
  AND transcript_document_version_id IS NULL AND voice_completion_failed_at IS NULL
UNION ALL
SELECT 'staging_cleanup'::text,id FROM capture_sessions
WHERE voice_session_id IS NOT NULL AND status IN ('finalized','failed') AND staging_deleted_at IS NULL;
