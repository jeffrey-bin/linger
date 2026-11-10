package voicemedia

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomevent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

var errCaptureStoppedBeforeMedia = errors.New("Capture stopped before media began")

func initialMediaStart(requested, started time.Time) (time.Time, error) {
	if started.IsZero() || started.Before(requested) {
		return time.Time{}, fmt.Errorf("%w: initial media start timestamp is missing or precedes the request", ErrProviderUnavailable)
	}
	return started, nil
}

// Capture.created_at becomes the recording clock when the first recorder is
// confirmed.
func (s *Service) confirmInitialMediaStart(ctx context.Context, accountID string, epoch store.VoiceMediaEpoch, observation providerObservation) (store.VoiceMediaEpoch, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return store.VoiceMediaEpoch{}, err
	}
	defer tx.Rollback(ctx)
	q := s.queries.WithTx(tx)
	if _, err = q.LockVoiceSession(ctx, epoch.VoiceSessionID); err != nil {
		return store.VoiceMediaEpoch{}, err
	}
	if _, err = tx.Exec(ctx, "SELECT id FROM capture_sessions WHERE id=$1 FOR UPDATE", epoch.CaptureSessionID); err != nil {
		return store.VoiceMediaEpoch{}, err
	}
	capture, err := q.GetCaptureSessionForAccount(ctx, store.GetCaptureSessionForAccountParams{ID: epoch.CaptureSessionID, AccountID: pgtype.Text{String: accountID, Valid: true}})
	if err != nil {
		return store.VoiceMediaEpoch{}, err
	}
	current, err := q.GetVoiceMediaEpoch(ctx, epoch.ID)
	if err != nil {
		return store.VoiceMediaEpoch{}, err
	}
	if current.FirstArchivedMs.Valid {
		if current.ProviderEgressID.String != observation.EgressID {
			return store.VoiceMediaEpoch{}, ErrCaptureConflict
		}
		return current, tx.Commit(ctx)
	}
	started, err := initialMediaStart(capture.CreatedAt.Time, observation.StartedAt)
	if err != nil {
		return store.VoiceMediaEpoch{}, err
	}
	if capture.StopRequestedAt.Valid && !started.Before(capture.StopRequestedAt.Time) {
		if err = q.CancelInitialVoiceMediaBeforeStart(ctx, store.CancelInitialVoiceMediaBeforeStartParams{CaptureID: capture.ID, ProviderEgressID: pgtype.Text{String: observation.EgressID, Valid: true}}); err != nil {
			return store.VoiceMediaEpoch{}, err
		}
		if err = roomevent.AppendCaptureSessionChanged(ctx, q, capture.TenantID, capture.RoomID, capture.CreatedByActorID, capture.ID, "failed"); err != nil {
			return store.VoiceMediaEpoch{}, err
		}
		if err = tx.Commit(ctx); err != nil {
			return store.VoiceMediaEpoch{}, err
		}
		return store.VoiceMediaEpoch{}, errCaptureStoppedBeforeMedia
	}
	capture, err = q.ConfirmInitialVoiceMediaTimeline(ctx, store.ConfirmInitialVoiceMediaTimelineParams{CaptureID: capture.ID, StartedAt: pgtype.Timestamptz{Time: started, Valid: true}})
	if err != nil {
		return store.VoiceMediaEpoch{}, err
	}
	if err = q.AlignInitialVoiceTranscriptCoverage(ctx, store.AlignInitialVoiceTranscriptCoverageParams{SessionID: capture.ID, StartOffsetMs: capture.TranscriptStartOffsetMs.Int64}); err != nil {
		return store.VoiceMediaEpoch{}, err
	}
	current, err = q.ActivateVoiceMediaEpoch(ctx, store.ActivateVoiceMediaEpochParams{ID: epoch.ID, ProviderEgressID: pgtype.Text{String: observation.EgressID, Valid: true}, FirstArchivedMs: pgtype.Int8{Valid: true}})
	if err != nil {
		return store.VoiceMediaEpoch{}, err
	}
	if capture.StopRequestedAt.Valid {
		// A stop requested before the recorder was known can proceed now.
		if err = enqueue(ctx, tx, CaptureStopArgs{CaptureSessionID: capture.ID}); err != nil {
			return store.VoiceMediaEpoch{}, err
		}
	}
	return current, tx.Commit(ctx)
}
