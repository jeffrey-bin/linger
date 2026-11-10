package voicemedia

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomevent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

const (
	voiceMediaFirstSegmentTimeout         = 20 * time.Second
	voiceMediaSegmentStallTimeout         = 10 * time.Second
	voiceMediaNoEgressFinalizationTimeout = time.Minute
	voiceMediaStopRecoveryDelay           = 35 * time.Second
	voiceRuntimeDispatchReconcileInterval = 5 * time.Second
	voiceRuntimeDispatchReconcileTimeout  = 5 * time.Second
)

// stopCaptureStep stops the last recorder of a Capture whose stop committed,
// once that recorder is known.
func (s *Service) stopCaptureStep(ctx context.Context, captureID string) (time.Duration, error) {
	// A recorder that is not known yet is stopped once its start is confirmed,
	// which queues this job again.
	epoch, err := s.queries.GetOwedVoiceMediaStop(ctx, captureID)
	if errors.Is(err, pgx.ErrNoRows) {
		return JobDone, nil
	}
	if err != nil {
		return jobErrorWait, err
	}
	roomName, err := s.queries.GetVoiceSessionProviderRoom(ctx, epoch.VoiceSessionID)
	if err == nil {
		_, err = s.provider.StopCapture(ctx, providerCapture{
			VoiceSessionID: epoch.VoiceSessionID, CaptureSessionID: epoch.CaptureSessionID,
			EpochID: epoch.ID, EpochIndex: epoch.EpochIndex, RoomName: roomName,
			StagingPrefix: epoch.StagingPrefix, EgressID: epoch.ProviderEgressID.String,
		})
	}
	if err != nil {
		return jobErrorWait, err
	}
	// Reconciliation observes the stopped recorder and completes the stop; until
	// it does, the stop is sent again, because a provider that accepted it may
	// still keep the recorder running.
	return voiceMediaStopRecoveryDelay, s.wake(ctx, CaptureReconcileArgs{CaptureSessionID: captureID})
}

// reconcileSessionStep reconciles an open voice session that no write touched
// for the reconcile interval, until the session closes.
func (s *Service) reconcileSessionStep(ctx context.Context, id string) (time.Duration, error) {
	minAge := durationInterval(voiceRuntimeDispatchReconcileInterval)
	record, err := s.queries.ClaimVoiceSessionReconcile(ctx, store.ClaimVoiceSessionReconcileParams{ID: id, MinAge: minAge})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		// Not due yet: the due query below decides when to look again.
		err = nil
	case err != nil:
		return jobErrorWait, err
	default:
		err = s.reconcileSession(ctx, record)
	}
	seconds, dueErr := s.queries.VoiceSessionReconcileDueIn(ctx, store.VoiceSessionReconcileDueInParams{ID: id, MinAge: minAge})
	return dueWait(seconds), errors.Join(err, dueErr)
}

func (s *Service) reconcileSession(ctx context.Context, record store.VoiceSession) error {
	reconcileCtx, cancel := context.WithTimeout(ctx, voiceRuntimeDispatchReconcileTimeout)
	defer cancel()
	if record.Purpose == PurposeChatLive && record.Status != "closing" && record.LiveLeaseUntil.Valid && !record.LiveLeaseUntil.Time.After(time.Now()) {
		closing, err := s.queries.RequestVoiceSessionClose(reconcileCtx, record.ID)
		if err != nil {
			return err
		}
		return s.reconcileClosingSession(reconcileCtx, closing)
	}
	if record.Status == "closing" {
		return s.reconcileClosingSession(reconcileCtx, record)
	}
	if revoked, err := s.invalidateUnauthorizedSession(reconcileCtx, record); err != nil || revoked {
		return err
	}
	signedIn, err := s.queries.AuthSessionIsActive(reconcileCtx, record.AuthSessionID)
	if err != nil {
		return err
	}
	if !signedIn {
		return s.closeSignedOutSession(reconcileCtx, record)
	}
	session := providerSessionModel(record)
	session.RequirePublisher = true
	if err = s.provider.EnsureSession(reconcileCtx, session); err != nil {
		if errors.Is(err, errPublisherAbsent) {
			if record.LastFailureCode.String == "publisher_absent" {
				return s.retireUnpublishedSession(reconcileCtx, record)
			}
			return s.queries.MarkVoiceSessionPublisherAbsent(reconcileCtx, store.MarkVoiceSessionPublisherAbsentParams{
				ID: record.ID, CredentialGeneration: record.CredentialGeneration,
			})
		}
		_, markErr := s.queries.MarkVoiceSessionReconnecting(context.WithoutCancel(ctx), store.MarkVoiceSessionReconnectingParams{
			ID: record.ID, LastFailureCode: pgtype.Text{String: "runtime_dispatch_unavailable", Valid: true},
		})
		return joinCompensation(err, markErr)
	}
	if _, err = s.queries.ActivateVoiceSession(ctx, record.ID); errors.Is(err, pgx.ErrNoRows) && record.Status == "connected" {
		err = nil
	}
	return err
}

func (s *Service) retireUnpublishedSession(ctx context.Context, observed store.VoiceSession) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	queries := s.queries.WithTx(tx)
	current, err := queries.LockVoiceSession(ctx, observed.ID)
	if err != nil {
		return err
	}
	if current.CredentialGeneration != observed.CredentialGeneration ||
		!current.UpdatedAt.Time.Equal(observed.UpdatedAt.Time) ||
		current.LastInputStartedMs != observed.LastInputStartedMs || current.LastInputEndedMs != observed.LastInputEndedMs ||
		current.Status != "reconnecting" || current.LastFailureCode.String != "publisher_absent" {
		return nil
	}
	current, err = queries.RequestVoiceSessionClose(ctx, current.ID)
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	return s.reconcileClosingSession(ctx, current)
}

// closeSignedOutSession ends a session whose login session was revoked, expired
// or deleted the way a departed publisher's ends: a running recording is
// stopped and saved, then the publisher is revoked. Logout, password changes
// and expiry all arrive here.
func (s *Service) closeSignedOutSession(ctx context.Context, record store.VoiceSession) error {
	closing, err := s.queries.RequestVoiceSessionClose(ctx, record.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	return s.reconcileClosingSession(ctx, closing)
}

func (s *Service) reconcileClosingSession(ctx context.Context, record store.VoiceSession) error {
	capture, err := s.queries.GetActiveLiveKitCaptureForVoiceSession(ctx, pgtype.Text{String: record.ID, Valid: true})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if err == nil && (capture.Status == "starting" || capture.Status == "recording") {
		session, err := s.queries.GetVoiceRuntimeSessionContext(ctx, record.ID)
		if err != nil {
			return err
		}
		_, err = s.EndCapture(ctx, EndCaptureRequest{AccountID: session.AccountID.String, CaptureSessionID: capture.ID})
		return err
	}
	if err == nil && capture.Status == "finalizing" {
		return nil
	}
	_, err = s.finishClosingVoiceSession(ctx, record)
	return err
}

func (s *Service) invalidateUnauthorizedSession(ctx context.Context, record store.VoiceSession) (bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	queries := s.queries.WithTx(tx)
	if _, err = queries.LockVoiceSession(ctx, record.ID); err != nil {
		return false, err
	}
	capture, captureErr := queries.GetActiveLiveKitCaptureForVoiceSession(ctx, pgtype.Text{String: record.ID, Valid: true})
	if captureErr != nil && !errors.Is(captureErr, pgx.ErrNoRows) {
		return false, captureErr
	}
	_, err = queries.InvalidateUnauthorizedVoiceSession(ctx, record.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if captureErr == nil {
		if err = roomevent.AppendCaptureSessionChanged(ctx, queries, capture.TenantID, capture.RoomID, capture.CreatedByActorID, capture.ID, "failed"); err != nil {
			return false, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return false, err
	}
	_, err = s.finishClosingVoiceSession(ctx, record)
	return true, err
}

// reconcileCaptureStep observes the Capture's due recorder epoch, until no
// epoch is left to observe. A Capture that ended by then gets its staging
// cleaned up.
func (s *Service) reconcileCaptureStep(ctx context.Context, captureID string) (time.Duration, error) {
	if _, err := s.reconcileCaptureEpoch(ctx, captureID); err != nil {
		return jobErrorWait, err
	}
	seconds, err := s.queries.VoiceEpochReconciliationDueIn(ctx, captureID)
	if err != nil {
		return jobErrorWait, err
	}
	if next := dueWait(seconds); next != JobDone {
		return next, nil
	}
	ready, err := s.queries.VoiceStagingCleanupReady(ctx, captureID)
	if err != nil {
		return jobErrorWait, err
	}
	if !ready {
		return JobDone, nil
	}
	if err := s.wake(ctx, StagingCleanupArgs{CaptureSessionID: captureID}); err != nil {
		return jobErrorWait, err
	}
	return JobDone, nil
}

func (s *Service) reconcileCaptureEpoch(ctx context.Context, captureID string) (processed bool, err error) {
	rows, err := s.queries.ListVoiceMediaEpochsForReconcile(ctx, captureID)
	if err != nil || len(rows) == 0 {
		return false, err
	}
	row := rows[0]
	defer func() {
		if err != nil {
			_ = s.queries.DeferVoiceMediaEpochReconcile(context.WithoutCancel(ctx), row.ID)
		}
	}()
	if row.EpochIndex > 0 && !row.FirstArchivedMs.Valid {
		epoch, err := s.queries.GetVoiceMediaEpoch(ctx, row.ID)
		if err != nil {
			return true, err
		}
		err = s.resumeRecoveryEpochStart(ctx, epoch, row.ProviderRoomName, row.AccountID)
		if errors.Is(err, errVoiceEpochRecoveryDeferred) {
			// Not due yet: look again after the usual reconcile interval.
			return false, s.queries.DeferVoiceMediaEpochReconcile(ctx, row.ID)
		}
		return true, err
	}
	if row.ObservedState == "failed" {
		epoch, err := s.queries.GetVoiceMediaEpoch(ctx, row.ID)
		if err != nil {
			return true, err
		}
		return true, s.recoverFailedMediaEpoch(ctx, epoch, row.AccountID, providerObservation{State: "failed", EgressID: row.ProviderEgressID.String})
	}
	capture := providerCapture{
		VoiceSessionID: row.VoiceSessionID, CaptureSessionID: row.CaptureSessionID,
		EpochID: row.ID, EpochIndex: row.EpochIndex, RoomName: row.ProviderRoomName,
		StagingPrefix: row.StagingPrefix, EgressID: row.ProviderEgressID.String,
	}
	observation, err := s.provider.ObserveCapture(ctx, capture)
	if err != nil {
		_, markErr := s.queries.MarkVoiceMediaEpochUnknown(context.WithoutCancel(ctx), store.MarkVoiceMediaEpochUnknownParams{
			ID: row.ID, LastFailureCode: pgtype.Text{String: "observe_failed", Valid: true},
		})
		return true, joinCompensation(err, markErr)
	}
	if voiceMediaFinalizingWithoutEgressExpired(row, observation, time.Now()) {
		observation.State = "failed"
	}
	if row.DesiredState == "active" && (observation.State == "requested" || observation.State == "active" || observation.State == "sealing" || observation.State == "unknown") {
		if inspector, ok := s.materializer.(salvageInspector); ok {
			segmentCount, countErr := inspector.SegmentCount(ctx, row.StagingPrefix, row.SegmentCount)
			if countErr != nil {
				return true, countErr
			}
			progress, progressErr := s.queries.ObserveVoiceMediaSegmentProgress(ctx, store.ObserveVoiceMediaSegmentProgressParams{
				ID: row.ID, SegmentCount: segmentCount,
			})
			if progressErr != nil {
				return true, progressErr
			}
			if voiceMediaDataPlaneStalled(
				progress.SegmentCount,
				progress.LastSegmentAt,
				progress.CreatedAt,
				time.Now(),
			) {
				// A stalled data plane does not prove that the recorder is terminal.
				// Stop the same provider identity first; only its terminal receipt
				// may freeze this prefix and admit a successor epoch.
				if observation.EgressID != "" {
					capture.EgressID = observation.EgressID
				}
				if capture.EgressID == "" {
					_, markErr := s.queries.MarkVoiceMediaEpochUnknown(ctx, store.MarkVoiceMediaEpochUnknownParams{ID: row.ID, LastFailureCode: pgtype.Text{String: "stalled_egress_identity_unconfirmed", Valid: true}})
					return true, joinCompensation(ErrProviderUnavailable, markErr)
				}
				if observation.State != "sealing" {
					observation, err = s.provider.StopCapture(ctx, capture)
					if err != nil {
						_, markErr := s.queries.MarkVoiceMediaEpochUnknown(ctx, store.MarkVoiceMediaEpochUnknownParams{ID: row.ID, LastFailureCode: pgtype.Text{String: "stalled_egress_stop_unconfirmed", Valid: true}})
						return true, joinCompensation(err, markErr)
					}
				}
			}
		}
	}
	base := int64(0)
	if row.FirstArchivedMs.Valid {
		base = row.FirstArchivedMs.Int64
	}
	archivedThrough := base + observation.ArchivedThroughMS
	if archivedThrough < base {
		archivedThrough = base
	}
	if observation.State == "failed" && archivedThrough == base {
		inspector, ok := s.materializer.(salvageInspector)
		if !ok {
			return true, errors.New("voice media salvage inspection is unavailable")
		}
		durationMS, inspectErr := inspector.InspectSalvagePrefix(ctx, row.StagingPrefix)
		if inspectErr != nil {
			if errors.Is(inspectErr, ErrNoSalvageMedia) {
				epoch, readErr := s.queries.GetVoiceMediaEpoch(ctx, row.ID)
				if readErr != nil {
					return true, readErr
				}
				return true, s.recoverFailedMediaEpoch(ctx, epoch, row.AccountID, observation)
			}
			_, markErr := s.queries.MarkVoiceMediaEpochUnknown(context.WithoutCancel(ctx), store.MarkVoiceMediaEpochUnknownParams{
				ID: row.ID, LastFailureCode: pgtype.Text{String: "salvage_inspection_failed", Valid: true},
			})
			return true, joinCompensation(inspectErr, markErr)
		}
		archivedThrough = base + durationMS
		observation.ArchivedThroughMS = durationMS
	}
	if row.EpochIndex == 0 && !row.FirstArchivedMs.Valid && (observation.State == "active" || ((observation.State == "available" || observation.State == "failed") && archivedThrough > base)) {
		if observation.StartedAt.IsZero() {
			// ACTIVE admission is not yet a recording clock. Keep the same recorder
			// recoverable, and yield the queue while output metadata catches up.
			_, err = s.queries.MarkVoiceMediaEpochUnknown(ctx, store.MarkVoiceMediaEpochUnknownParams{ID: row.ID, LastFailureCode: pgtype.Text{String: "media_start_unconfirmed", Valid: true}})
			return true, err
		}
		epoch, err := s.queries.GetVoiceMediaEpoch(ctx, row.ID)
		if err != nil {
			return true, err
		}
		confirmed, err := s.confirmInitialMediaStart(ctx, row.AccountID.String, epoch, observation)
		if errors.Is(err, errCaptureStoppedBeforeMedia) {
			return true, nil
		}
		if err != nil {
			return true, err
		}
		archivedThrough = confirmed.FirstArchivedMs.Int64 + archivedThrough - base
		row.FirstArchivedMs = confirmed.FirstArchivedMs
		if row.CaptureStatus == "starting" {
			row.CaptureStatus = "recording"
		}
	}
	switch observation.State {
	case "requested", "active", "sealing", "unknown":
		_, updateErr := s.queries.AdvanceVoiceMediaEpochObservation(ctx, store.AdvanceVoiceMediaEpochObservationParams{
			ID:                row.ID,
			ProviderEgressID:  pgtype.Text{String: observation.EgressID, Valid: observation.EgressID != ""},
			ObservedState:     observation.State,
			ArchivedThroughMs: pgtype.Int8{Int64: archivedThrough, Valid: true},
		})
		if updateErr == nil && row.CaptureStatus == "finalizing" && !row.ProviderEgressID.Valid && observation.EgressID != "" {
			// The stop waited for this recorder's identity.
			updateErr = s.wake(ctx, CaptureStopArgs{CaptureSessionID: row.CaptureSessionID})
		}
		return true, updateErr
	case "available":
		if row.DesiredState == "sealed" {
			return true, s.completeReconciledStop(ctx, row, observation)
		}
		return true, s.restartAvailableEpoch(ctx, row, observation, archivedThrough, false)
	case "failed":
		epoch, err := s.queries.GetVoiceMediaEpoch(ctx, row.ID)
		if err != nil {
			return true, err
		}
		return true, s.recoverFailedMediaEpoch(ctx, epoch, row.AccountID, observation)
	default:
		return true, nil
	}
}

func voiceMediaFinalizingWithoutEgressExpired(
	row store.ListVoiceMediaEpochsForReconcileRow,
	observation providerObservation,
	now time.Time,
) bool {
	graceStartedAt := row.CreatedAt
	if row.ProviderEgressID.Valid {
		graceStartedAt = row.StopRequestedAt
	}
	return row.CaptureStatus == "finalizing" && row.DesiredState == "sealed" &&
		observation.State == "unknown" && observation.Missing && graceStartedAt.Valid &&
		now.Sub(graceStartedAt.Time) >= voiceMediaNoEgressFinalizationTimeout
}

func voiceMediaDataPlaneStalled(
	segmentCount int64,
	lastSegmentAt pgtype.Timestamptz,
	createdAt pgtype.Timestamptz,
	now time.Time,
) bool {
	if segmentCount == 0 {
		return createdAt.Valid && now.Sub(createdAt.Time) >= voiceMediaFirstSegmentTimeout
	}
	return lastSegmentAt.Valid && now.Sub(lastSegmentAt.Time) >= voiceMediaSegmentStallTimeout
}

func (s *Service) restartAvailableEpoch(
	ctx context.Context,
	row store.ListVoiceMediaEpochsForReconcileRow,
	observation providerObservation,
	archivedThrough int64,
	salvage bool,
) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	queries := s.queries.WithTx(tx)
	if _, err = queries.LockVoiceSession(ctx, row.VoiceSessionID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "SELECT id FROM capture_sessions WHERE id=$1 FOR UPDATE", row.CaptureSessionID); err != nil {
		return err
	}
	capture, err := queries.GetCaptureSessionForAccount(ctx, store.GetCaptureSessionForAccountParams{ID: row.CaptureSessionID, AccountID: row.AccountID})
	if err != nil {
		return err
	}
	current, err := queries.GetLatestVoiceMediaEpochForCapture(ctx, row.CaptureSessionID)
	if err != nil {
		return err
	}
	if current.ID != row.ID || (capture.Status != "recording" && capture.Status != "starting") {
		return nil
	}
	playlist := observation.PlaylistObjectKey
	if salvage || playlist == "" {
		playlist = row.StagingPrefix + salvagedPlaylistSuffix
	}
	if _, err = queries.SealVoiceMediaEpoch(ctx, store.SealVoiceMediaEpochParams{ID: row.ID, PlaylistObjectKey: pgtype.Text{String: playlist, Valid: true}, ArchivedThroughMs: pgtype.Int8{Int64: archivedThrough, Valid: true}}); err != nil {
		return err
	}
	if _, err := queries.CreateCaptureMediaRange(ctx, store.CreateCaptureMediaRangeParams{
		ID:               stableID("capture_media_range", row.CaptureSessionID, row.ID, fmt.Sprint(row.FirstArchivedMs.Int64), fmt.Sprint(archivedThrough)),
		CaptureSessionID: row.CaptureSessionID, EpochID: pgtype.Text{String: row.ID, Valid: true},
		Kind: "media", StartOffsetMs: row.FirstArchivedMs.Int64, EndOffsetMs: archivedThrough,
		Reason: "egress_salvaged",
	}); err != nil {
		return err
	}
	next, err := createRecoveryEpoch(ctx, queries, current)
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	return s.resumeRecoveryEpochStart(ctx, next, row.ProviderRoomName, row.AccountID)
}

func (s *Service) completeReconciledStop(ctx context.Context, row store.ListVoiceMediaEpochsForReconcileRow, observation providerObservation) error {
	record, err := s.queries.GetCaptureSessionForAccount(ctx, store.GetCaptureSessionForAccountParams{ID: row.CaptureSessionID, AccountID: row.AccountID})
	if err != nil {
		return err
	}
	epoch, err := s.queries.GetVoiceMediaEpoch(ctx, row.ID)
	if err != nil {
		return err
	}
	_, err = s.completeCaptureStop(ctx, record, epoch, record.StopRequestedAt, observation)
	return err
}
