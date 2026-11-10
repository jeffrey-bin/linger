package voicemedia

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func createRecoveryEpoch(ctx context.Context, q *store.Queries, previous store.VoiceMediaEpoch) (store.VoiceMediaEpoch, error) {
	index := previous.EpochIndex + 1
	return q.CreateVoiceMediaEpoch(ctx, store.CreateVoiceMediaEpochParams{ID: stableID("voice_media_epoch", previous.CaptureSessionID, fmt.Sprint(index)), VoiceSessionID: previous.VoiceSessionID, CaptureSessionID: previous.CaptureSessionID, EpochIndex: index, StagingPrefix: fmt.Sprintf("%sepoch-%d", captureStagingPrefix(previous.CaptureSessionID), index)})
}

// A terminal recorder report is an outcome to reconcile, never an invitation to retry
// Start against its old prefix. Preserve its recoverable media and identity.
// A salvaged final epoch completes the stop and queues materialization.
func (s *Service) recoverFailedMediaEpoch(ctx context.Context, epoch store.VoiceMediaEpoch, accountID pgtype.Text, observation providerObservation) error {
	duration := observation.ArchivedThroughMS
	if duration <= 0 {
		inspector, ok := s.materializer.(salvageInspector)
		if !ok {
			return ErrProviderUnavailable
		}
		var err error
		duration, err = inspector.InspectSalvagePrefix(ctx, epoch.StagingPrefix)
		if err != nil && !errors.Is(err, ErrNoSalvageMedia) {
			return err
		}
		if errors.Is(err, ErrNoSalvageMedia) {
			duration = 0
		}
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	q := s.queries.WithTx(tx)
	if _, err = q.LockVoiceSession(ctx, epoch.VoiceSessionID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "SELECT id FROM capture_sessions WHERE id=$1 FOR UPDATE", epoch.CaptureSessionID); err != nil {
		return err
	}
	capture, err := q.GetCaptureSessionForAccount(ctx, store.GetCaptureSessionForAccountParams{ID: epoch.CaptureSessionID, AccountID: accountID})
	if err != nil {
		return err
	}
	current, err := q.GetLatestVoiceMediaEpochForCapture(ctx, capture.ID)
	if err != nil {
		return err
	}
	if current.ID != epoch.ID {
		return nil
	}
	previous, err := q.GetPreviousVoiceMediaEpoch(ctx, epoch.ID)
	if errors.Is(err, pgx.ErrNoRows) && epoch.EpochIndex == 0 {
		previous.FinalEndMs = pgtype.Int8{Valid: true}
	} else if err != nil {
		return err
	}
	stopRequested := capture.Status == "finalizing"
	if !stopRequested && capture.Status != "recording" && capture.Status != "starting" {
		return ErrCaptureConflict
	}
	if stopRequested {
		if !capture.StopRequestedAt.Valid {
			return ErrCaptureConflict
		}
		if !observation.StartedAt.IsZero() && !observation.StartedAt.Before(capture.StopRequestedAt.Time) {
			duration = 0
		}
	}
	if duration == 0 {
		recorded, readErr := q.GetLatestRecordedVoiceMediaEpoch(ctx, capture.ID)
		if errors.Is(readErr, pgx.ErrNoRows) {
			if err = q.FailVoiceMediaEpochWithoutMedia(ctx, epoch.ID); err != nil {
				return err
			}
			return tx.Commit(ctx)
		}
		if readErr != nil {
			return readErr
		}
		if current.ArchivedThroughMs.Int64 > current.FirstArchivedMs.Int64 {
			return ErrNoSalvageMedia
		}
		if _, err = q.RequestSealVoiceMediaEpoch(ctx, epoch.ID); err != nil && current.DesiredState != "sealed" {
			return err
		}
		emptyAt := previous.FinalEndMs
		if current.FirstArchivedMs.Valid {
			emptyAt = current.FirstArchivedMs
		}
		if _, err = q.SealEmptyVoiceMediaEpoch(ctx, store.SealEmptyVoiceMediaEpochParams{ID: epoch.ID, FirstArchivedMs: emptyAt, ProviderEgressID: pgtype.Text{String: observation.EgressID, Valid: observation.EgressID != ""}}); err != nil {
			return err
		}
		if stopRequested {
			if _, err = s.completeCaptureStopTx(ctx, tx, capture, recorded, capture.StopRequestedAt, providerObservation{State: "available", PlaylistObjectKey: recorded.PlaylistObjectKey.String, ArchivedThroughMS: recorded.ArchivedThroughMs.Int64 - recorded.FirstArchivedMs.Int64}); err != nil {
				return err
			}
		}
	} else {
		start := current.FirstArchivedMs.Int64
		if !current.FirstArchivedMs.Valid {
			started, err := initialMediaStart(capture.CreatedAt.Time, observation.StartedAt)
			if err != nil {
				return err
			}
			start = max(previous.FinalEndMs.Int64, started.Sub(capture.CreatedAt.Time).Milliseconds())
			current, err = q.ActivateVoiceMediaEpoch(ctx, store.ActivateVoiceMediaEpochParams{ID: epoch.ID, ProviderEgressID: pgtype.Text{String: observation.EgressID, Valid: true}, FirstArchivedMs: pgtype.Int8{Int64: start, Valid: true}})
			if err != nil {
				return err
			}
		}
		if err = recordRecoveryGap(ctx, q, capture.ID, previous.FinalEndMs.Int64, start, "egress_restart"); err != nil {
			return err
		}
		observation.PlaylistObjectKey = epoch.StagingPrefix + salvagedPlaylistSuffix
		observation.ArchivedThroughMS = duration
		if stopRequested {
			_, err := s.completeCaptureStopTx(ctx, tx, capture, current, capture.StopRequestedAt, observation)
			if err != nil {
				return err
			}
		} else {
			if _, err = q.SealVoiceMediaEpoch(ctx, store.SealVoiceMediaEpochParams{ID: epoch.ID, PlaylistObjectKey: pgtype.Text{String: observation.PlaylistObjectKey, Valid: true}, ArchivedThroughMs: pgtype.Int8{Int64: start + duration, Valid: true}}); err != nil {
				return err
			}
			if _, err = q.CreateCaptureMediaRange(ctx, store.CreateCaptureMediaRangeParams{ID: stableID("capture_media_range", capture.ID, epoch.ID, fmt.Sprint(start), fmt.Sprint(start+duration)), CaptureSessionID: capture.ID, EpochID: pgtype.Text{String: epoch.ID, Valid: true}, Kind: "media", StartOffsetMs: start, EndOffsetMs: start + duration, Reason: "egress_salvaged"}); err != nil {
				return err
			}
		}
	}
	if err = q.RecordRecoveredVoiceEpochFailure(ctx, epoch.ID); err != nil {
		return err
	}
	if !stopRequested {
		if _, err = createRecoveryEpoch(ctx, q, epoch); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func recordRecoveryGap(ctx context.Context, q *store.Queries, captureID string, start, end int64, reason string) error {
	if end <= start {
		return nil
	}
	ranges, err := q.ListCaptureMediaRangesForCapture(ctx, captureID)
	if err != nil {
		return err
	}
	// Preserve the union of a continuous outage, rather than counting the
	// already recorded leading gap again when a failed epoch is stopped.
	for changed := true; changed; {
		changed = false
		for _, span := range ranges {
			if span.Kind != "gap" || span.EndOffsetMs < start || span.StartOffsetMs > end {
				continue
			}
			a, b := min(start, span.StartOffsetMs), max(end, span.EndOffsetMs)
			if a != start || b != end {
				start, end = a, b
				changed = true
			}
		}
	}
	if err = q.DeleteOverlappingVoiceMediaGaps(ctx, store.DeleteOverlappingVoiceMediaGapsParams{CaptureSessionID: captureID, StartOffsetMs: start, EndOffsetMs: end}); err != nil {
		return err
	}
	_, err = q.CreateCaptureMediaRange(ctx, store.CreateCaptureMediaRangeParams{ID: stableID("capture_media_range", captureID, "gap", fmt.Sprint(start), fmt.Sprint(end)), CaptureSessionID: captureID, Kind: "gap", StartOffsetMs: start, EndOffsetMs: end, Reason: reason})
	return err
}
