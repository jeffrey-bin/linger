-- Retention deletes at most row_limit rows of one table past their retention
-- period, selected by primary key. Business content (Messages,
-- Room Events, Documents, Wiki, recordings) is never deleted by age.

-- name: DeleteExpiredAuthSessions :execrows
DELETE FROM auth_sessions WHERE id IN (
  SELECT id FROM auth_sessions WHERE expires_at<now() OR revoked_at IS NOT NULL
  LIMIT sqlc.arg(row_limit)::int);

-- name: DeleteExpiredDocumentEvents :execrows
-- Event counters and business replay records outlive the journal. The
-- immutable guard is opened only for this statement's transaction.
WITH guard AS MATERIALIZED (
  SELECT set_config('teamhub.document_retention','on',true)
), doomed AS MATERIALIZED (
  SELECT event.id FROM document_events event, guard
  WHERE event.occurred_at<now()-interval '30 days'
  LIMIT sqlc.arg(row_limit)::int
)
DELETE FROM document_events WHERE id IN (SELECT id FROM doomed);

-- name: DeleteExpiredRoutineEventDeliveries :execrows
DELETE FROM routine_event_deliveries
WHERE (routine_id, source, upstream_event_id) IN (
  SELECT routine_id, source, upstream_event_id FROM routine_event_deliveries
  WHERE created_at<now()-interval '30 days' LIMIT sqlc.arg(row_limit)::int);

-- name: DeleteFinishedOneShotRoutines :execrows
-- A one-shot Routine is done once it is disabled; it cannot be enabled again.
DELETE FROM room_reminders WHERE id IN (
  SELECT id FROM room_reminders
  WHERE cadence_kind='once' AND NOT enabled AND updated_at<now()-interval '7 days'
  LIMIT sqlc.arg(row_limit)::int);

-- name: DeleteRevokedAgentMemories :execrows
-- Memory deletes the rest of its data in the transactions that make it stale;
-- the memory of a deleted (revoked) Agent has no such transaction.
DELETE FROM agent_memories WHERE agent_id IN (
  SELECT memory.agent_id FROM agent_memories memory
  JOIN agent_registrations registration ON registration.agent_management_id=memory.agent_id
  WHERE registration.status='revoked' LIMIT sqlc.arg(row_limit)::int);

-- name: DeleteExpiredVoiceTranscriptSegments :execrows
-- Seven days after a voice session closes, the words spoken outside a
-- recording go.
DELETE FROM voice_transcript_segments WHERE id IN (
  SELECT segment.id FROM voice_sessions voice
  JOIN voice_transcript_segments segment ON segment.voice_session_id=voice.id
  WHERE voice.closed_at<now()-interval '7 days' AND segment.capture_session_id IS NULL
  LIMIT sqlc.arg(row_limit)::int);

-- name: DeleteExpiredVoiceSessions :execrows
-- A session without a recording goes after the segment rule emptied it. A
-- recording and everything it owns stay.
DELETE FROM voice_sessions WHERE id IN (
  SELECT voice.id FROM voice_sessions voice
  WHERE voice.closed_at<now()-interval '7 days'
    AND NOT EXISTS (SELECT 1 FROM capture_sessions capture WHERE capture.voice_session_id=voice.id)
  LIMIT sqlc.arg(row_limit)::int);

-- name: DeleteSettledVoiceTranscriptUncertainties :execrows
-- A recording reads its transcript uncertainties only while it records or
-- recovers; recovering ones keep them for a retry.
DELETE FROM voice_transcript_uncertainties
WHERE (capture_session_id, event_id) IN (
  SELECT uncertainty.capture_session_id, uncertainty.event_id FROM capture_sessions capture
  JOIN voice_transcript_uncertainties uncertainty ON uncertainty.capture_session_id=capture.id
  WHERE capture.status IN ('finalized','failed') AND capture.updated_at<now()-interval '7 days'
  LIMIT sqlc.arg(row_limit)::int);
