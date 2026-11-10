package voice

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

func shouldAdvanceVoiceTranscriptProgress(
	hasCommittedThrough bool,
	hasCapture bool,
	hasTranscriptStart bool,
	committedThroughMS int64,
	transcriptStartMS int64,
	captureStatus string,
) bool {
	return hasCommittedThrough && hasCapture && hasTranscriptStart &&
		committedThroughMS >= transcriptStartMS &&
		(captureStatus == "recording" || captureStatus == "finalizing")
}

// A publisher absence is only a media gap while the Capture is recording, and
// only for the part after the recording clock began. Offsets arrive on the
// VoiceSession clock and are returned on the Capture media timeline.
func voicePublisherAbsenceGap(hasCapture bool, capture store.CaptureSession, startMS, endMS int64) (int64, int64, bool) {
	if !hasCapture || capture.Status != "recording" || !capture.TranscriptStartOffsetMs.Valid {
		return 0, 0, false
	}
	origin := capture.TranscriptStartOffsetMs.Int64
	start := max(startMS, origin) - origin
	end := endMS - origin
	if end-start <= voicePublisherAbsenceToleranceMS {
		return 0, 0, false
	}
	return start, end, true
}

const voicePublisherAbsenceToleranceMS int64 = 250

func int64PointerValue(value *int64) int64 {
	if value == nil {
		return 0
	}
	return *value
}

func optionalSpeakerText(value *string) pgtype.Text {
	if value == nil {
		return pgtype.Text{}
	}
	id := strings.TrimSpace(*value)
	return pgtype.Text{String: id, Valid: id != ""}
}

// VoiceFinalIsFormattingOnly reports a final transcript that carries only formatting.
func VoiceFinalIsFormattingOnly(text string) bool {
	return NormalizeCaptureTranscript(text) == ""
}

// ErrVoiceEventConflict reports a final whose event ID already holds different
// words: it is not a retry of the same observation.
var ErrVoiceEventConflict = errors.New("voice event conflicts with existing evidence")

// applyVoiceFinalObservation writes a final to the session timeline, tagged
// with its Capture. A retry of an applied final writes nothing new, and a
// final its Capture no longer accepts (the Capture ended or its transcript end
// froze before it) is ignored, so both answer accepted rather than a conflict.
func (s *Service) applyVoiceFinalObservation(
	ctx context.Context,
	session store.GetVoiceRuntimeSessionContextRow,
	captureID pgtype.Text,
	request teamhubinternal.VoiceObservation,
) (string, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	queries := s.queries.WithTx(tx)
	if _, err = queries.LockVoiceSession(ctx, session.ID); errors.Is(err, pgx.ErrNoRows) {
		return "ignored", nil
	} else if err != nil {
		return "", err
	}
	text := strings.TrimSpace(*request.Text)
	normalized := NormalizeCaptureTranscript(text)
	kind := "speech"
	if session.Purpose == voicemedia.PurposeChatDictation {
		captureID = pgtype.Text{}
		if request.Kind == teamhubinternal.TurnFinalized {
			kind = "dictation_turn"
		}
	}
	segmentID := "voice_transcript_segment_" + strings.TrimPrefix(request.EventId, "voice_event_")
	speaker := optionalSpeakerText(request.SpeakerId)
	_, err = queries.CreateVoiceTranscriptSegment(ctx, store.CreateVoiceTranscriptSegmentParams{
		ID: segmentID, EventID: request.EventId, VoiceSessionID: session.ID,
		CaptureSessionID: captureID, MediaEpoch: int32(request.MediaEpoch), Lane: string(request.Lane),
		StartOffsetMs: request.StartOffsetMs, EndOffsetMs: request.EndOffsetMs,
		Text: text, NormalizedText: normalized, Kind: kind, SpeakerID: speaker,
		AccountID: session.AccountID.String, RoomID: session.RoomID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		// Either the event holds other words, or its Capture no longer
		// accepts this final; the event's row tells which.
		existing, readErr := queries.GetVoiceTranscriptSegmentByEvent(ctx, store.GetVoiceTranscriptSegmentByEventParams{
			VoiceSessionID: session.ID, EventID: request.EventId,
		})
		switch {
		case errors.Is(readErr, pgx.ErrNoRows):
			return "ignored", nil
		case readErr != nil:
			return "", readErr
		case existing.NormalizedText != normalized || existing.Kind != kind ||
			(existing.SpeakerID.Valid && existing.SpeakerID != speaker):
			return "", ErrVoiceEventConflict
		}
	} else if err != nil {
		return "", err
	}
	if err = queries.ClearConfirmedVoicePartialTranscript(ctx, store.ClearConfirmedVoicePartialTranscriptParams{ID: session.ID, LatestPartialEndOffsetMs: pgtype.Int8{Int64: request.EndOffsetMs, Valid: true}}); err != nil {
		return "", err
	}
	return "applied", tx.Commit(ctx)
}

// ErrVoiceSessionNotFound reports an observation for an unknown VoiceSession.
var ErrVoiceSessionNotFound = errors.New("VoiceSession was not found")

// ErrVoicePurposeConflict reports a dictation turn outside a live chat
// dictation session.
var ErrVoicePurposeConflict = errors.New("dictation turns require a live chat dictation session")

// ReportObservation applies one Voice Runtime observation and returns its
// receipt status: accepted, applied or ignored. Every write is keyed by the
// event ID, the transcript window or a monotonic offset, so a retried
// observation applies again without a receipt table.
func (s *Service) ReportObservation(ctx context.Context, request teamhubinternal.VoiceObservation) (string, error) {
	session, err := s.queries.GetVoiceRuntimeSessionContext(ctx, request.VoiceSessionId)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrVoiceSessionNotFound
	}
	if err != nil {
		return "", fmt.Errorf("resolve Voice Runtime session: %w", err)
	}
	if request.Kind == teamhubinternal.TurnFinalized &&
		(session.Purpose != voicemedia.PurposeChatDictation || request.Lane != teamhubinternal.ObservationLaneLive) {
		return "", ErrVoicePurposeConflict
	}
	if request.Kind == teamhubinternal.Partial {
		if request.Text == nil || strings.TrimSpace(*request.Text) == "" || request.EndOffsetMs <= request.StartOffsetMs {
			return "ignored", nil
		}
		if _, err = s.queries.UpdateVoiceSessionPartialTranscript(ctx, store.UpdateVoiceSessionPartialTranscriptParams{
			ID:                         request.VoiceSessionId,
			LatestPartialText:          pgtype.Text{String: strings.TrimSpace(*request.Text), Valid: true},
			LatestPartialStartOffsetMs: pgtype.Int8{Int64: request.StartOffsetMs, Valid: true},
			LatestPartialEndOffsetMs:   pgtype.Int8{Int64: request.EndOffsetMs, Valid: true},
		}); err != nil {
			return "", fmt.Errorf("update Voice partial transcript: %w", err)
		}
		return "accepted", nil
	}
	activeCapture, captureErr := s.queries.GetActiveLiveKitCaptureForVoiceSession(ctx, pgtype.Text{
		String: session.ID, Valid: true,
	})
	captureID := pgtype.Text{}
	if captureErr == nil && activeCapture.Status != "finalized" {
		captureID = pgtype.Text{String: activeCapture.ID, Valid: true}
	} else if captureErr != nil && !errors.Is(captureErr, pgx.ErrNoRows) {
		return "", fmt.Errorf("resolve active Voice Capture: %w", captureErr)
	}
	status := "applied"
	if request.Kind == teamhubinternal.TrackStarted || request.Kind == teamhubinternal.TrackEnded {
		if err = s.queries.RecordVoiceInputBoundary(ctx, store.RecordVoiceInputBoundaryParams{
			VoiceSessionID: session.ID, Kind: string(request.Kind), OffsetMs: request.EndOffsetMs,
		}); err != nil {
			return "", fmt.Errorf("record Voice input boundary: %w", err)
		}
	}
	if request.Kind == teamhubinternal.Final || request.Kind == teamhubinternal.TurnFinalized {
		if VoiceFinalIsFormattingOnly(*request.Text) {
			status = "ignored"
			if err = s.queries.ClearConfirmedVoicePartialTranscript(ctx, store.ClearConfirmedVoicePartialTranscriptParams{
				ID: session.ID, LatestPartialEndOffsetMs: pgtype.Int8{Int64: request.EndOffsetMs, Valid: true},
			}); err != nil {
				return "", fmt.Errorf("clear formatting-only Voice final: %w", err)
			}
		} else if status, err = s.applyVoiceFinalObservation(ctx, session, captureID, request); errors.Is(err, ErrVoiceEventConflict) {
			return "", err
		} else if err != nil {
			return "", fmt.Errorf("apply Voice final observation: %w", err)
		}
	} else if request.Kind == teamhubinternal.InputGap {
		if captureID.Valid {
			if err = s.queries.RecordVoiceTranscriptUncertainty(ctx, store.RecordVoiceTranscriptUncertaintyParams{
				CaptureSessionID: captureID.String, EventID: request.EventId,
				StartOffsetMs: request.StartOffsetMs, EndOffsetMs: request.EndOffsetMs,
			}); err != nil {
				return "", fmt.Errorf("record Voice transcript uncertainty: %w", err)
			}
		} else {
			status = "ignored"
		}
	} else if request.Kind == teamhubinternal.PublisherAbsent {
		// The recorder keeps archiving silence while no browser publishes. The runtime
		// proves the absence from a clean input end followed by a new publisher
		// generation; TeamHub records it as an unrecoverable capture gap.
		start, end, ok := voicePublisherAbsenceGap(captureID.Valid, activeCapture, request.StartOffsetMs, request.EndOffsetMs)
		if !ok {
			status = "ignored"
		} else if err = s.voiceMedia.RecordPublisherAbsence(ctx, session.ID, activeCapture.ID, start, end); err != nil {
			return "", fmt.Errorf("record Voice publisher absence: %w", err)
		}
	} else if request.Kind == teamhubinternal.Progress {
		if !shouldAdvanceVoiceTranscriptProgress(
			request.CommittedThroughMs != nil,
			captureID.Valid,
			activeCapture.TranscriptStartOffsetMs.Valid,
			int64PointerValue(request.CommittedThroughMs),
			activeCapture.TranscriptStartOffsetMs.Int64,
			activeCapture.Status,
		) {
			status = "ignored"
		} else if _, err = s.queries.AdvanceCaptureTranscriptCoverage(ctx, store.AdvanceCaptureTranscriptCoverageParams{
			SessionID: captureID.String, AccountID: session.AccountID.String, RoomID: session.RoomID,
			StreamID: fmt.Sprintf("voice-runtime-v2:%s:%d", session.ID, request.MediaEpoch), Lane: string(request.Lane),
			StartOffsetMs: max(activeCapture.TranscriptStartOffsetMs.Int64, request.StartOffsetMs),
			EndOffsetMs:   *request.CommittedThroughMs,
		}); err != nil {
			return "", fmt.Errorf("advance Voice transcript coverage: %w", err)
		} else if activeCapture.Status == "finalizing" {
			// A stopped Capture's materialization waits for this coverage.
			if err = s.voiceMedia.WakeMaterialization(ctx, captureID.String); err != nil {
				return "", fmt.Errorf("wake Voice materialization: %w", err)
			}
		}
	} else if request.Kind == teamhubinternal.TrackEnded {
		if _, err = s.queries.ClearVoiceSessionPartialTranscript(ctx, session.ID); err != nil {
			return "", fmt.Errorf("clear Voice partial transcript: %w", err)
		}
		if captureID.Valid && activeCapture.TranscriptStartOffsetMs.Valid &&
			request.EndOffsetMs > activeCapture.TranscriptStartOffsetMs.Int64 &&
			(activeCapture.Status == "recording" || activeCapture.Status == "finalizing") {
			streamID := fmt.Sprintf("voice-runtime-v2:%s:%d", session.ID, request.MediaEpoch)
			coverageStart := max(activeCapture.TranscriptStartOffsetMs.Int64, request.StartOffsetMs)
			if request.StartOffsetMs == request.EndOffsetMs {
				coverageStart, err = s.queries.GetVoiceTranscriptStreamStart(ctx, store.GetVoiceTranscriptStreamStartParams{SessionID: activeCapture.ID, StreamID: streamID, FallbackStartMs: activeCapture.TranscriptStartOffsetMs.Int64})
				if err != nil {
					return "", fmt.Errorf("resolve Voice transcript start: %w", err)
				}
			}
			if _, err = s.queries.AdvanceCaptureTranscriptCoverage(ctx, store.AdvanceCaptureTranscriptCoverageParams{
				SessionID: activeCapture.ID, AccountID: session.AccountID.String, RoomID: session.RoomID,
				StreamID: streamID, Lane: string(request.Lane),
				StartOffsetMs: coverageStart, EndOffsetMs: request.EndOffsetMs,
			}); err != nil {
				return "", fmt.Errorf("complete Voice transcript coverage: %w", err)
			}
		}
		if err = s.queries.FreezeReadyVoiceTranscripts(ctx); err != nil {
			return "", fmt.Errorf("freeze Voice transcript: %w", err)
		}
		if captureID.Valid && activeCapture.Status == "finalizing" {
			if err = s.voiceMedia.WakeMaterialization(ctx, captureID.String); err != nil {
				return "", fmt.Errorf("wake Voice materialization: %w", err)
			}
		}
	}
	return status, nil
}
