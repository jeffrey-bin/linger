package voicemedia

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

var errVoiceEpochRecoveryDeferred = errors.New("voice epoch recovery is awaiting retry")

// The requested epoch survives both process loss before Start and an unknown
// provider result. Discover that exact prefix before retrying.
func (s *Service) resumeRecoveryEpochStart(ctx context.Context, epoch store.VoiceMediaEpoch, roomName string, accountID pgtype.Text) (err error) {
	if _, err = s.queries.ClaimVoiceEpochRestart(ctx, epoch.ID); errors.Is(err, pgx.ErrNoRows) {
		return errVoiceEpochRecoveryDeferred
	} else if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			defer cancel()
			err = errors.Join(err, s.queries.DeferVoiceEpochRestart(cleanup, epoch.ID))
		}
	}()
	jobCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	input := providerCapture{VoiceSessionID: epoch.VoiceSessionID, CaptureSessionID: epoch.CaptureSessionID, EpochID: epoch.ID, EpochIndex: epoch.EpochIndex, RoomName: roomName, StagingPrefix: epoch.StagingPrefix, EgressID: epoch.ProviderEgressID.String}
	observation, err := s.provider.ObserveCapture(jobCtx, input)
	if err != nil {
		return err
	}
	if observation.Missing {
		capture, readErr := s.queries.GetCaptureSessionForAccount(jobCtx, store.GetCaptureSessionForAccountParams{ID: epoch.CaptureSessionID, AccountID: accountID})
		if readErr != nil {
			return readErr
		}
		if capture.Status == "finalizing" {
			return s.finishUnstartedRecoveryEpoch(jobCtx, epoch, accountID)
		}
		if capture.Status != "recording" && capture.Status != "starting" {
			return ErrCaptureConflict
		}
		observation, err = s.provider.StartCapture(jobCtx, input)
		if err != nil {
			return err
		}
	}
	if observation.State == "failed" {
		return s.recoverFailedMediaEpoch(jobCtx, epoch, accountID, observation)
	}
	if observation.State != "active" && observation.State != "available" {
		return ErrProviderUnavailable
	}
	if !observation.StartedAt.IsZero() {
		capture, readErr := s.queries.GetCaptureSessionForAccount(jobCtx, store.GetCaptureSessionForAccountParams{ID: epoch.CaptureSessionID, AccountID: accountID})
		if readErr != nil {
			return readErr
		}
		if capture.StopRequestedAt.Valid && !observation.StartedAt.Before(capture.StopRequestedAt.Time) {
			// Admission can finish after Stop. It contains no pre-Stop audio.
			input.EgressID = observation.EgressID
			if _, err = s.provider.StopCapture(jobCtx, input); err != nil {
				return err
			}
			epoch.ProviderEgressID = pgtype.Text{String: observation.EgressID, Valid: true}
			return s.finishUnstartedRecoveryEpoch(jobCtx, epoch, accountID)
		}
	}
	return s.commitRecoveryEpochStart(jobCtx, epoch, accountID, observation)
}

func (s *Service) commitRecoveryEpochStart(ctx context.Context, epoch store.VoiceMediaEpoch, accountID pgtype.Text, observation providerObservation) error {
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
	previous, err := q.GetPreviousVoiceMediaEpoch(ctx, epoch.ID)
	if err != nil {
		return err
	}
	if !previous.FinalEndMs.Valid {
		return ErrCaptureConflict
	}
	gapStart := previous.FinalEndMs.Int64
	startedAt, err := initialMediaStart(capture.CreatedAt.Time, observation.StartedAt)
	if err != nil {
		return err
	}
	gapEnd := max(gapStart, startedAt.Sub(capture.CreatedAt.Time).Milliseconds())
	if _, err = q.ActivateVoiceMediaEpoch(ctx, store.ActivateVoiceMediaEpochParams{ID: epoch.ID, ProviderEgressID: pgtype.Text{String: observation.EgressID, Valid: true}, FirstArchivedMs: pgtype.Int8{Int64: gapEnd, Valid: true}}); err != nil {
		return err
	}
	if err = recordRecoveryGap(ctx, q, epoch.CaptureSessionID, gapStart, gapEnd, "egress_restart"); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Stop can arrive after the next intent commits but before any new recorder
// exists. Retain the sealed prefix and disclose the interrupted tail as a gap.
func (s *Service) finishUnstartedRecoveryEpoch(ctx context.Context, epoch store.VoiceMediaEpoch, accountID pgtype.Text) error {
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
	previous, err := q.GetLatestRecordedVoiceMediaEpoch(ctx, epoch.CaptureSessionID)
	if err != nil {
		return err
	}
	if !capture.StopRequestedAt.Valid {
		return ErrCaptureConflict
	}
	gapStart := previous.FinalEndMs.Int64
	gapEnd := max(gapStart, capture.StopRequestedAt.Time.Sub(capture.CreatedAt.Time).Milliseconds())
	if _, err = q.SealEmptyVoiceMediaEpoch(ctx, store.SealEmptyVoiceMediaEpochParams{ID: epoch.ID, FirstArchivedMs: pgtype.Int8{Int64: gapEnd, Valid: true}, ProviderEgressID: epoch.ProviderEgressID}); err != nil {
		return err
	}
	if _, err = s.completeCaptureStopTx(ctx, tx, capture, previous, capture.StopRequestedAt, providerObservation{State: "available", PlaylistObjectKey: previous.PlaylistObjectKey.String, ArchivedThroughMS: previous.ArchivedThroughMs.Int64 - previous.FirstArchivedMs.Int64}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
