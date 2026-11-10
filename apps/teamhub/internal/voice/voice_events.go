package voice

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// VoiceEventCursor encodes a VoiceSession event position.
func VoiceEventCursor(sessionID string, position int64) string {
	return fmt.Sprintf("%s:%d", sessionID, position)
}

// ParseVoiceEventCursor decodes a VoiceSession event cursor.
func ParseVoiceEventCursor(sessionID, cursor string) (int64, error) {
	if cursor == "" {
		return 0, nil
	}
	prefix := sessionID + ":"
	if len(cursor) > 256 || !strings.HasPrefix(cursor, prefix) {
		return 0, errors.New("cursor belongs to another VoiceSession")
	}
	value := strings.TrimPrefix(cursor, prefix)
	position, err := strconv.ParseInt(value, 10, 64)
	if err != nil || position < 0 || strconv.FormatInt(position, 10) != value {
		return 0, errors.New("invalid voice cursor")
	}
	return position, nil
}

// ReadVoiceEventPage reads transcript events after the cursor and, on the
// last page, the current VoiceSession and the Captures still changing on screen.
// Captures are read before the transcript snapshot, so a page never shows a
// Capture state without the finals that committed before it; the session is
// read in the transcript snapshot, so a closed session never arrives ahead of
// its last finals.
func (s *Service) ReadVoiceEventPage(ctx context.Context, login store.GetActiveSessionRow, sessionID string, after int64) (httpapi.VoiceEventPage, error) {
	accountID := login.AccountID
	page := httpapi.VoiceEventPage{Items: []httpapi.VoiceEvent{}, NextCursor: VoiceEventCursor(sessionID, after)}
	owned, err := s.queries.VoiceSessionBelongsToAuthSession(ctx, store.VoiceSessionBelongsToAuthSessionParams{VoiceSessionID: sessionID, AuthSessionID: login.ID})
	if err == nil && !owned {
		err = pgx.ErrNoRows
	}
	if err != nil {
		return page, err
	}
	captureIDs, err := s.queries.ListVoiceEventCaptureIDs(ctx, pgtype.Text{String: sessionID, Valid: true})
	if err != nil {
		return page, err
	}
	captures := make([]httpapi.VoiceEvent, 0, len(captureIDs))
	for _, captureID := range captureIDs {
		capture, readErr := s.voiceMedia.GetCapture(ctx, accountID, captureID)
		if errors.Is(readErr, pgx.ErrNoRows) {
			continue
		}
		if readErr != nil {
			return page, readErr
		}
		model := VoiceCaptureModel(capture)
		captures = append(captures, httpapi.VoiceEvent{Kind: httpapi.VoiceEventKindCapture, Capture: &model})
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return page, err
	}
	defer tx.Rollback(ctx)
	queries := s.queries.WithTx(tx)
	session, err := queries.GetVoiceSessionForAccount(ctx, store.GetVoiceSessionForAccountParams{AccountID: accountID, ID: sessionID})
	if err != nil {
		return page, err
	}
	rows, err := queries.ListVoiceTranscriptEventsAfterSeq(ctx, store.ListVoiceTranscriptEventsAfterSeqParams{AccountID: accountID, VoiceSessionID: sessionID, AfterSeq: after})
	if err != nil {
		return page, err
	}
	page.HasMore = len(rows) > 100
	if page.HasMore {
		rows = rows[:100]
	}
	for _, row := range rows {
		model := voiceTranscriptEventModel(store.ListVoiceTranscriptEventsForAccountRow(row))
		page.Items = append(page.Items, httpapi.VoiceEvent{Kind: httpapi.VoiceEventKindTranscript, Transcript: &model})
		page.NextCursor = VoiceEventCursor(sessionID, row.Seq)
	}
	if page.HasMore {
		return page, nil
	}
	model := VoiceSessionModel(voicemedia.VoiceSession{
		ID: session.ID, TenantID: session.TenantID, RoomID: session.RoomID, CreatedByActorID: session.CreatedByActorID,
		Status: session.Status, Purpose: session.Purpose, CredentialGeneration: session.CredentialGeneration,
		CreatedAt: session.CreatedAt.Time, UpdatedAt: session.UpdatedAt.Time, LastFailureCode: session.LastFailureCode.String,
	})
	if session.ClosedAt.Valid {
		model.ClosedAt = &session.ClosedAt.Time
	}
	page.Items = append(page.Items, captures...)
	page.Items = append(page.Items, httpapi.VoiceEvent{Kind: httpapi.VoiceEventKindSession, Session: &model})
	return page, nil
}

// HideMeeting removes a meeting from the Space's Meetings only. The Capture,
// its Documents and what Memory already took in are kept. It reports whether
// the meeting existed.
func (s *Service) HideMeeting(ctx context.Context, tenantID, captureSessionID string) (bool, error) {
	return s.queries.HideMeeting(ctx, store.HideMeetingParams{
		CaptureSessionID: captureSessionID, TenantID: tenantID,
	})
}
