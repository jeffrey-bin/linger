package voice

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// VoiceDictationRequestIDPattern matches the public common.Id contract used by
// VoiceDictationCommitRequest.
var VoiceDictationRequestIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)

// VoiceSessionModel presents a VoiceSession.
func VoiceSessionModel(value voicemedia.VoiceSession) httpapi.VoiceSession {
	model := httpapi.VoiceSession{
		Id: value.ID, TenantId: value.TenantID, RoomId: value.RoomID,
		CreatedByActorId: value.CreatedByActorID, Status: httpapi.VoiceSessionStatus(value.Status),
		Purpose:              httpapi.VoiceSessionPurpose(value.Purpose),
		CredentialGeneration: value.CredentialGeneration,
		InputReadyGeneration: value.InputReadyGeneration,
		InputStartedOffsetMs: value.InputStartedOffsetMs,
		InputEndedOffsetMs:   value.InputEndedOffsetMs,
		CreatedAt:            value.CreatedAt, UpdatedAt: value.UpdatedAt, ClosedAt: value.ClosedAt,
	}
	if value.LastFailureCode != "" {
		model.LastFailureCode = &value.LastFailureCode
	}
	return model
}

// VoiceCaptureModel presents a Capture.
func VoiceCaptureModel(value voicemedia.Capture) httpapi.VoiceCapture {
	model := httpapi.VoiceCapture{
		Id: value.ID, VoiceSessionId: value.VoiceSessionID, RoomId: value.RoomID,
		Status: httpapi.VoiceCaptureStatus(value.Status), RequestedStartOffsetMs: value.RequestedStartOffsetMS,
		ArchivedThroughMs: value.ArchivedThroughMS,
		GapCount:          value.GapCount, GapDurationMs: value.GapDurationMS,
		CreatedAt: value.CreatedAt, UpdatedAt: value.UpdatedAt,
	}
	if value.LastFailureCode != "" {
		model.LastFailureCode = &value.LastFailureCode
	}
	if value.AudioDocumentVersionID != "" {
		model.AudioDocumentVersionId = &value.AudioDocumentVersionID
	}
	if value.TranscriptDocumentVersionID != "" {
		model.TranscriptDocumentVersionId = &value.TranscriptDocumentVersionID
	}
	if value.SourceAudioDocumentVersionID != "" {
		model.SourceAudioDocumentVersionId = &value.SourceAudioDocumentVersionID
	}
	if value.TranscriptRecoveryStatus != "" {
		status := httpapi.VoiceCaptureTranscriptRecoveryStatus(value.TranscriptRecoveryStatus)
		model.TranscriptRecoveryStatus = &status
		model.TranscriptRecoveryProgressMs = &value.TranscriptRecoveryProgressMS
		model.TranscriptRecoveryTotalMs = &value.TranscriptRecoveryTotalMS
	}
	return model
}

func voiceTranscriptEventModel(row store.ListVoiceTranscriptEventsForAccountRow) httpapi.VoiceTranscriptEvent {
	item := httpapi.VoiceTranscriptEvent{
		Id: row.ID, EventId: row.EventID, VoiceSessionId: row.VoiceSessionID,
		MediaEpoch: row.MediaEpoch, Lane: httpapi.VoiceTranscriptEventLane(row.Lane),
		StartOffsetMs: row.StartOffsetMs, EndOffsetMs: row.EndOffsetMs,
		Text: row.Text, Kind: httpapi.VoiceTranscriptEventKind(row.Kind),
		AcceptedAt: row.AcceptedAt.Time, UpdatedAt: row.UpdatedAt.Time,
	}
	if row.CaptureSessionID != "" {
		value := row.CaptureSessionID
		item.CaptureSessionId = &value
	}
	if row.SpeakerID.Valid && strings.TrimSpace(row.SpeakerID.String) != "" {
		value := row.SpeakerID.String
		item.SpeakerId = &value
	}
	return item
}

// TranscriptEvents reads one page of a VoiceSession's transcript after a
// cursor, with the partial transcript and the event cursor from the same
// snapshot: every segment committed after it has a larger seq, so the event
// feed resumes exactly where this snapshot ends.
func (s *Service) TranscriptEvents(ctx context.Context, accountID, sessionID string, after time.Time, afterID string) (httpapi.VoiceTranscriptEventPage, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return httpapi.VoiceTranscriptEventPage{}, fmt.Errorf("begin Voice transcript snapshot: %w", err)
	}
	defer tx.Rollback(ctx)
	queries := s.queries.WithTx(tx)
	rows, err := queries.ListVoiceTranscriptEventsForAccount(ctx, store.ListVoiceTranscriptEventsForAccountParams{
		AccountID: accountID, VoiceSessionID: sessionID,
		AfterUpdatedAt: pgtype.Timestamptz{Time: after, Valid: true}, AfterID: afterID,
	})
	if err != nil {
		return httpapi.VoiceTranscriptEventPage{}, fmt.Errorf("list Voice transcript events: %w", err)
	}
	partial, err := queries.GetVoiceSessionPartialForAccount(ctx, store.GetVoiceSessionPartialForAccountParams{
		AccountID: accountID, VoiceSessionID: sessionID,
	})
	if err != nil {
		return httpapi.VoiceTranscriptEventPage{}, fmt.Errorf("get Voice partial transcript: %w", err)
	}
	position, err := queries.GetVoiceTranscriptSeq(ctx, sessionID)
	if err != nil {
		return httpapi.VoiceTranscriptEventPage{}, fmt.Errorf("get Voice transcript seq: %w", err)
	}
	items := make([]httpapi.VoiceTranscriptEvent, 0, len(rows))
	for _, row := range rows {
		items = append(items, voiceTranscriptEventModel(row))
	}
	cursor := VoiceEventCursor(sessionID, position)
	page := httpapi.VoiceTranscriptEventPage{Items: items, EventCursor: &cursor}
	if partial.LatestPartialText.Valid {
		page.PartialTranscript = &partial.LatestPartialText.String
		page.PartialStartOffsetMs = &partial.LatestPartialStartOffsetMs.Int64
		page.PartialEndOffsetMs = &partial.LatestPartialEndOffsetMs.Int64
	}
	return page, nil
}

// OwnVoiceSession reports pgx.ErrNoRows unless the login session created the
// VoiceSession; another browser of the same Account is any other caller.
func (s *Service) OwnVoiceSession(ctx context.Context, authSessionID, voiceSessionID string) error {
	owned, err := s.queries.VoiceSessionBelongsToAuthSession(ctx, store.VoiceSessionBelongsToAuthSessionParams{
		VoiceSessionID: voiceSessionID, AuthSessionID: authSessionID,
	})
	if err == nil && !owned {
		err = pgx.ErrNoRows
	}
	return err
}

// OwnCaptureVoiceSession reports pgx.ErrNoRows unless the login session's
// VoiceSession records the Capture.
func (s *Service) OwnCaptureVoiceSession(ctx context.Context, authSessionID, captureID string) error {
	owned, err := s.queries.VoiceCaptureBelongsToAuthSession(ctx, store.VoiceCaptureBelongsToAuthSessionParams{
		CaptureSessionID: captureID, AuthSessionID: authSessionID,
	})
	if err == nil && !owned {
		err = pgx.ErrNoRows
	}
	return err
}

// VoiceSessionPartial reads the VoiceSession's partial transcript.
func (s *Service) VoiceSessionPartial(ctx context.Context, accountID, sessionID string) (store.GetVoiceSessionPartialForAccountRow, error) {
	return s.queries.GetVoiceSessionPartialForAccount(ctx, store.GetVoiceSessionPartialForAccountParams{AccountID: accountID, VoiceSessionID: sessionID})
}

// VoiceStreamState reads the VoiceSession's stream state for the Account.
func (s *Service) VoiceStreamState(ctx context.Context, params store.GetVoiceStreamStateParams) (pgtype.Timestamptz, error) {
	return s.queries.GetVoiceStreamState(ctx, params)
}

// MediaPolicy reads the voice media policy of the Account.
func (s *Service) MediaPolicy(ctx context.Context, params store.GetVoiceMediaPolicyForAccountParams) (store.GetVoiceMediaPolicyForAccountRow, error) {
	return s.queries.GetVoiceMediaPolicyForAccount(ctx, params)
}
