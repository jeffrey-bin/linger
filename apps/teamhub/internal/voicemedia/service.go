package voicemedia

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicetranscription"
)

var ErrNoActiveCapture = fmt.Errorf("no active Voice Capture: %w", pgx.ErrNoRows)

type Service struct {
	pool                *pgxpool.Pool
	queries             *store.Queries
	provider            provider
	materializer        materializer
	documents           *document.Service
	archiveASR          voicetranscription.ArchiveTranscriber
	normalizeTranscript func(string) string
	// Concurrent provider calls per archive recovery; values below 1 run serially.
	archiveRecoveryConcurrency int
}

// SetArchiveTranscriber enables archive transcript recovery. normalize is
// required and must match live ingest so recovered rows satisfy the same
// transcript checks.
func (s *Service) SetArchiveTranscriber(asr voicetranscription.ArchiveTranscriber, normalize func(string) string) {
	s.archiveASR, s.normalizeTranscript = asr, normalize
}

func (s *Service) SetArchiveRecoveryConcurrency(limit int) {
	s.archiveRecoveryConcurrency = limit
}

// captureStagingPrefix holds every epoch the recorder writes for one Capture;
// the cleanup after the Capture ends deletes under it.
func captureStagingPrefix(captureID string) string {
	return "voice-staging/" + captureID + "/"
}

// Two 48 kHz AAC frames (42.7ms) plus millisecond timestamp rounding.
const voiceMediaTailToleranceMS int64 = 50

var _ Plane = (*Service)(nil)

func New(pool *pgxpool.Pool, mediaProvider provider, audioMaterializer materializer) *Service {
	return NewWithDocuments(pool, mediaProvider, audioMaterializer, nil)
}

func NewWithDocuments(
	pool *pgxpool.Pool,
	mediaProvider provider,
	audioMaterializer materializer,
	documents *document.Service,
) *Service {
	return &Service{
		pool: pool, queries: store.New(pool), provider: mediaProvider,
		materializer: audioMaterializer, documents: documents,
	}
}

// CreateVoiceSession opens a VoiceSession for one login session. A login
// session holds one open VoiceSession, so a second creation conflicts.
func (s *Service) CreateVoiceSession(ctx context.Context, input CreateVoiceSessionRequest) (VoiceSession, error) {
	if input.Purpose != PurposeHardwareControl && input.Purpose != PurposeChatDictation && input.Purpose != PurposeChatLive {
		return VoiceSession{}, ErrCaptureConflict
	}
	if _, authorityErr := s.queries.GetRoomForAccount(ctx, store.GetRoomForAccountParams{ID: input.RoomID, AccountID: pgtype.Text{String: input.AccountID, Valid: true}}); authorityErr != nil {
		return VoiceSession{}, authorityErr
	}
	id := ids.New("voice_session")
	var record store.VoiceSession
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		var createErr error
		record, createErr = s.queries.WithTx(tx).CreateVoiceSession(ctx, store.CreateVoiceSessionParams{
			ID: id, AccountID: input.AccountID, RoomID: input.RoomID,
			ProviderRoomName: "voice-" + id, ParticipantIdentity: "publisher-" + id,
			Purpose:       input.Purpose,
			AuthSessionID: pgtype.Text{String: input.AuthSessionID, Valid: true},
		})
		if createErr != nil {
			return createErr
		}
		return enqueue(ctx, tx, VoiceSessionReconcileArgs{VoiceSessionID: record.ID})
	})
	var liveError *pgconn.PgError
	if input.Purpose == PurposeChatLive && errors.As(err, &liveError) && liveError.Code == "23514" && liveError.ConstraintName == "voice_live_agent_required" {
		return VoiceSession{}, ErrLiveUnavailable
	}
	if isActiveVoiceSessionConflict(err) {
		return VoiceSession{}, ErrCaptureConflict
	}
	if err != nil {
		return VoiceSession{}, err
	}
	return s.ensureSession(ctx, record)
}

func (s *Service) ensureSession(ctx context.Context, record store.VoiceSession) (VoiceSession, error) {
	if record.Status == "closed" {
		return voiceSessionModel(record), ErrSessionClosed
	}
	if s.provider == nil {
		return voiceSessionModel(record), ErrProviderUnavailable
	}
	if err := s.provider.EnsureSession(ctx, providerSessionModel(record)); err != nil {
		_, markErr := s.queries.MarkVoiceSessionReconnecting(context.WithoutCancel(ctx), store.MarkVoiceSessionReconnectingParams{
			ID: record.ID, LastFailureCode: pgtype.Text{String: "provider_unavailable", Valid: true},
		})
		return voiceSessionModel(record), joinCompensation(fmt.Errorf("%w: %w", ErrProviderUnavailable, err), markErr)
	}
	activated, err := s.queries.ActivateVoiceSession(ctx, record.ID)
	if errors.Is(err, pgx.ErrNoRows) && record.Status == "connected" {
		activated = record
		err = nil
	}
	return voiceSessionModel(activated), err
}

func (s *Service) GetVoiceSession(ctx context.Context, accountID, id string) (VoiceSession, error) {
	record, err := s.queries.GetVoiceSessionForAccount(ctx, store.GetVoiceSessionForAccountParams{
		AccountID: accountID, ID: id,
	})
	if err != nil {
		return VoiceSession{}, err
	}
	model := voiceSessionModel(record)
	// Accepted input completion is durable truth, independent of LiveKit's
	// readiness attributes (the Runtime may already have disconnected).
	if model.Purpose == "chat_dictation" && model.InputStartedOffsetMs != nil && model.InputEndedOffsetMs != nil && *model.InputEndedOffsetMs >= *model.InputStartedOffsetMs {
		return model, nil
	}
	if readiness, ok := s.provider.(inputReadinessProvider); ok {
		generation, readyErr := readiness.InputReadyGeneration(ctx, providerSessionModel(record), record.CredentialGeneration)
		if readyErr != nil {
			return VoiceSession{}, fmt.Errorf("%w: %w", ErrProviderUnavailable, readyErr)
		}
		model.InputReadyGeneration = &generation
	}
	return model, nil
}

// GetActiveVoiceSession returns the recording session the login session has
// open in the Room.
func (s *Service) GetActiveVoiceSession(ctx context.Context, accountID, authSessionID, roomID string) (VoiceSession, error) {
	record, err := s.queries.GetActiveRecordingSessionForAuthSessionRoom(ctx, store.GetActiveRecordingSessionForAuthSessionRoomParams{
		AccountID: accountID, RoomID: roomID, AuthSessionID: authSessionID,
	})
	return voiceSessionModel(record), err
}

func (s *Service) IssuePublisherGrant(ctx context.Context, accountID, id string) (PublisherGrant, error) {
	record, err := s.queries.GetVoiceSessionForAccount(ctx, store.GetVoiceSessionForAccountParams{
		AccountID: accountID, ID: id,
	})
	if err != nil {
		return PublisherGrant{}, err
	}
	if record.Status == "closed" || record.Status == "closing" {
		return PublisherGrant{}, ErrSessionClosed
	}
	if s.provider == nil {
		return PublisherGrant{}, ErrProviderUnavailable
	}
	var advanced store.VoiceSession
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		var advanceErr error
		if advanced, advanceErr = s.queries.WithTx(tx).AdvanceVoiceSessionCredentialGeneration(ctx, id); advanceErr != nil {
			return advanceErr
		}
		return enqueue(ctx, tx, VoiceSessionReconcileArgs{VoiceSessionID: id})
	})
	if err != nil {
		return PublisherGrant{}, err
	}
	return s.issuePublisherGrant(ctx, advanced, advanced.CredentialGeneration)
}

func (s *Service) issuePublisherGrant(
	ctx context.Context,
	record store.VoiceSession,
	generation int64,
) (PublisherGrant, error) {
	session := providerSessionModel(record)
	// LiveKit deletes room-scoped dispatches when an idle Room expires. Restore
	// the Room and Voice Runtime dispatch before every reconnect credential.
	if err := s.provider.EnsureSession(ctx, session); err != nil {
		return PublisherGrant{}, fmt.Errorf("%w: %w", ErrProviderUnavailable, err)
	}
	grant, err := s.provider.IssuePublisherGrant(ctx, session, generation)
	if err != nil {
		return PublisherGrant{}, fmt.Errorf("%w: %w", ErrProviderUnavailable, err)
	}
	return grant, nil
}

func (s *Service) CloseVoiceSession(ctx context.Context, accountID, id string) (VoiceSession, error) {
	record, err := s.queries.GetVoiceSessionForAccount(ctx, store.GetVoiceSessionForAccountParams{
		AccountID: accountID, ID: id,
	})
	if err != nil {
		return VoiceSession{}, err
	}
	if record.Status == "closed" {
		return voiceSessionModel(record), nil
	}
	if s.provider == nil {
		return VoiceSession{}, ErrProviderUnavailable
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return VoiceSession{}, err
	}
	defer tx.Rollback(ctx)
	queries := s.queries.WithTx(tx)
	record, err = queries.LockVoiceSession(ctx, id)
	if err != nil {
		return VoiceSession{}, err
	}
	if record.Status == "closed" {
		return voiceSessionModel(record), nil
	}
	if _, activeErr := queries.GetActiveLiveKitCaptureForVoiceSession(ctx, pgtype.Text{String: id, Valid: true}); activeErr == nil {
		return VoiceSession{}, ErrCaptureConflict
	} else if !errors.Is(activeErr, pgx.ErrNoRows) {
		return VoiceSession{}, activeErr
	}
	record, err = queries.RequestVoiceSessionClose(ctx, id)
	if err != nil {
		return VoiceSession{}, err
	}
	if err = enqueue(ctx, tx, VoiceSessionReconcileArgs{VoiceSessionID: id}); err != nil {
		return VoiceSession{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return VoiceSession{}, err
	}
	return s.finishClosingVoiceSession(ctx, record)
}

// CommitDictationTurn is a transient Runtime drain request, not a Capture or a
// message command. The accepted turn event identifies the ordinary chat send.
func (s *Service) CommitDictationTurn(ctx context.Context, accountID, id, requestID string) error {
	voice, err := s.queries.GetVoiceSessionForAccount(ctx, store.GetVoiceSessionForAccountParams{AccountID: accountID, ID: id})
	if err != nil {
		return err
	}
	if voice.Purpose != PurposeChatDictation {
		return ErrCaptureConflict
	}
	if voice.Status != "connected" && voice.Status != "reconnecting" && voice.Status != "provisioning" {
		return ErrSessionClosed
	}
	committer, ok := s.provider.(dictationCommitProvider)
	if !ok {
		return ErrProviderUnavailable
	}
	if err := committer.CommitDictationTurn(ctx, providerSessionModel(voice), requestID); err != nil {
		return fmt.Errorf("%w: %w", ErrProviderUnavailable, err)
	}
	return nil
}

func (s *Service) finishClosingVoiceSession(ctx context.Context, record store.VoiceSession) (VoiceSession, error) {
	var err error
	if err = s.provider.RevokePublisher(ctx, providerSessionModel(record)); err != nil {
		return VoiceSession{}, fmt.Errorf("%w: %w", ErrProviderUnavailable, err)
	}
	closed, err := s.queries.CloseVoiceSession(ctx, record.ID)
	return voiceSessionModel(closed), err
}

func (s *Service) BeginCapture(ctx context.Context, input BeginCaptureRequest) (Capture, error) {
	if input.StartOffsetMS < 0 {
		return Capture{}, ErrCaptureConflict
	}
	captureID := ids.New("capture_session")
	epochID := stableID("voice_media_epoch", captureID, "0")
	prefix := captureStagingPrefix(captureID) + "epoch-0"
	voice, err := s.queries.GetVoiceSessionForAccount(ctx, store.GetVoiceSessionForAccountParams{
		AccountID: input.AccountID, ID: input.VoiceSessionID,
	})
	if err != nil {
		return Capture{}, err
	}
	if voice.Purpose != PurposeHardwareControl {
		return Capture{}, ErrCaptureConflict
	}
	startOffsetMS := captureStartOffset(voice.CreatedAt.Time, time.Now())
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Capture{}, err
	}
	defer tx.Rollback(ctx)
	queries := s.queries.WithTx(tx)
	voice, err = queries.LockVoiceSession(ctx, input.VoiceSessionID)
	if err != nil {
		return Capture{}, err
	}
	// A VoiceSession records one Capture at a time, so a repeated start conflicts.
	captureRecord, err := queries.CreateLiveKitCaptureSession(ctx, store.CreateLiveKitCaptureSessionParams{
		ID: captureID, AccountID: input.AccountID, VoiceSessionID: input.VoiceSessionID, RoomID: input.RoomID,
		StartOffsetMs: startOffsetMS,
	})
	var activeCapture *pgconn.PgError
	if errors.As(err, &activeCapture) && activeCapture.Code == "23505" && activeCapture.ConstraintName == "capture_sessions_active_voice_idx" {
		return Capture{}, ErrCaptureConflict
	}
	if err != nil {
		return Capture{}, err
	}
	epoch, err := queries.CreateVoiceMediaEpoch(ctx, store.CreateVoiceMediaEpochParams{
		ID: epochID, VoiceSessionID: input.VoiceSessionID, CaptureSessionID: captureID,
		EpochIndex: 0, StagingPrefix: prefix,
	})
	if err != nil {
		return Capture{}, err
	}
	// Reconciliation confirms the recording and watches it until it stops.
	if err = enqueue(ctx, tx, CaptureReconcileArgs{CaptureSessionID: captureID}); err != nil {
		return Capture{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Capture{}, err
	}
	return s.startCapture(ctx, input.AccountID, captureRecord, voice, epoch)
}

// ignoreStateMoved treats pgx.ErrNoRows from a guarded UPDATE ... RETURNING as
// "the row already left the guarded state", which is not a failure.
func ignoreStateMoved(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	return err
}

// joinCompensation appends a failed compensating write to the original error
// while keeping the original error first and unchanged when the write succeeds.
func joinCompensation(cause, compensationErr error) error {
	if compensationErr = ignoreStateMoved(compensationErr); compensationErr == nil {
		return cause
	}
	return errors.Join(cause, compensationErr)
}

func captureStartOffset(sessionCreatedAt, now time.Time) int64 {
	return max(int64(0), now.Sub(sessionCreatedAt).Milliseconds())
}

func (s *Service) startCapture(
	ctx context.Context,
	accountID string,
	captureRecord store.CaptureSession,
	voice store.VoiceSession,
	epoch store.VoiceMediaEpoch,
) (Capture, error) {
	if s.provider == nil {
		return captureModel(captureRecord, epoch), ErrProviderUnavailable
	}
	observation, err := s.provider.StartCapture(ctx, providerCaptureModel(voice, epoch))
	if err != nil {
		var compensationErrs []error
		if observation.EgressID != "" {
			_, advanceErr := s.queries.AdvanceVoiceMediaEpochObservation(context.WithoutCancel(ctx), store.AdvanceVoiceMediaEpochObservationParams{
				ID: epoch.ID, ProviderEgressID: pgtype.Text{String: observation.EgressID, Valid: true},
				ObservedState: "unknown", ArchivedThroughMs: pgtype.Int8{Int64: 0, Valid: true},
			})
			compensationErrs = append(compensationErrs, ignoreStateMoved(advanceErr))
		}
		_, epochErr := s.queries.MarkVoiceMediaEpochUnknown(context.WithoutCancel(ctx), store.MarkVoiceMediaEpochUnknownParams{
			ID: epoch.ID, LastFailureCode: pgtype.Text{String: "start_outcome_unknown", Valid: true},
		})
		compensationErrs = append(compensationErrs, ignoreStateMoved(epochErr))
		return captureModel(captureRecord, epoch), errors.Join(append([]error{fmt.Errorf("%w: %w", ErrProviderUnavailable, err)}, compensationErrs...)...)
	}
	_, err = s.confirmInitialMediaStart(ctx, accountID, epoch, observation)
	if err != nil && !errors.Is(err, errCaptureStoppedBeforeMedia) {
		return Capture{}, err
	}
	return s.GetCapture(ctx, accountID, captureRecord.ID)
}

func (s *Service) GetCapture(ctx context.Context, accountID, id string) (Capture, error) {
	record, err := s.queries.GetCaptureSessionForAccount(ctx, store.GetCaptureSessionForAccountParams{
		ID: id, AccountID: pgtype.Text{String: accountID, Valid: true},
	})
	if err != nil {
		return Capture{}, err
	}
	if !record.VoiceSessionID.Valid {
		return Capture{}, ErrCaptureConflict
	}
	epoch, epochErr := s.queries.GetLatestVoiceMediaEpochForCapture(ctx, id)
	if epochErr != nil && !errors.Is(epochErr, pgx.ErrNoRows) {
		return Capture{}, epochErr
	}
	return s.captureWithGapSummary(ctx, record, epoch)
}

func (s *Service) GetActiveCapture(ctx context.Context, accountID, roomID string) (Capture, error) {
	record, err := s.queries.GetActiveLiveKitCaptureForAccountRoom(ctx, store.GetActiveLiveKitCaptureForAccountRoomParams{
		AccountID: accountID, RoomID: roomID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return Capture{}, ErrNoActiveCapture
	}
	if err != nil {
		return Capture{}, err
	}
	epoch, err := s.queries.GetLatestVoiceMediaEpochForCapture(ctx, record.ID)
	if err != nil {
		return Capture{}, err
	}
	return s.captureWithGapSummary(ctx, record, epoch)
}

func (s *Service) EndCapture(ctx context.Context, input EndCaptureRequest) (Capture, error) {
	record, err := s.queries.GetCaptureSessionForAccount(ctx, store.GetCaptureSessionForAccountParams{
		ID: input.CaptureSessionID, AccountID: pgtype.Text{String: input.AccountID, Valid: true},
	})
	if err != nil {
		return Capture{}, err
	}
	if !record.VoiceSessionID.Valid {
		return Capture{}, ErrCaptureConflict
	}
	if record.Status == "failed" || record.Status == "finalized" || record.Status == "recovering" {
		return s.GetCapture(ctx, input.AccountID, record.ID)
	}
	if s.provider == nil {
		return Capture{}, ErrProviderUnavailable
	}
	if record.StopRequestedAt.Valid {
		return s.GetCapture(ctx, input.AccountID, record.ID)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Capture{}, err
	}
	defer tx.Rollback(ctx)
	queries := s.queries.WithTx(tx)
	if _, err = queries.LockVoiceSession(ctx, record.VoiceSessionID.String); err != nil {
		return Capture{}, err
	}
	if _, err = tx.Exec(ctx, "SELECT id FROM capture_sessions WHERE id=$1 FOR UPDATE", record.ID); err != nil {
		return Capture{}, err
	}
	record, err = queries.GetCaptureSessionForAccount(ctx, store.GetCaptureSessionForAccountParams{ID: record.ID, AccountID: pgtype.Text{String: input.AccountID, Valid: true}})
	if err != nil {
		return Capture{}, err
	}
	if record.StopRequestedAt.Valid {
		return s.GetCapture(ctx, input.AccountID, record.ID)
	}
	epoch, err := queries.GetLatestVoiceMediaEpochForCapture(ctx, record.ID)
	if err != nil {
		return Capture{}, err
	}
	if _, err = queries.RequestVoiceCaptureStop(ctx, record.ID); err != nil {
		return Capture{}, err
	}
	if epoch, err = queries.RequestSealVoiceMediaEpoch(ctx, epoch.ID); err != nil {
		return Capture{}, err
	}
	if err = queries.MarkStoppedVoiceTranscriptGap(ctx, record.ID); err != nil {
		return Capture{}, err
	}
	if record, err = queries.TransitionLiveKitCaptureStatus(ctx, store.TransitionLiveKitCaptureStatusParams{
		ID: record.ID, Status: "finalizing",
	}); err != nil {
		return Capture{}, err
	}
	if err = enqueue(ctx, tx, CaptureStopArgs{CaptureSessionID: record.ID}, CaptureReconcileArgs{CaptureSessionID: record.ID}); err != nil {
		return Capture{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Capture{}, err
	}
	return s.captureWithGapSummary(ctx, record, epoch)
}

// RecordPublisherAbsence discloses an interval in which no browser published
// microphone audio although the recorder kept archiving. The archive holds filler
// silence there, so materialization removes it like a missing media range.
// Gap rows are unioned under the same locks as every other gap writer, so a
// concurrent recorder restart cannot leave two overlapping rows behind.
func (s *Service) RecordPublisherAbsence(ctx context.Context, voiceSessionID, captureID string, startMS, endMS int64) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	queries := s.queries.WithTx(tx)
	if _, err = queries.LockVoiceSession(ctx, voiceSessionID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "SELECT id FROM capture_sessions WHERE id=$1 FOR UPDATE", captureID); err != nil {
		return err
	}
	if err = recordRecoveryGap(ctx, queries, captureID, startMS, endMS, "publisher_absent"); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) completeCaptureStop(
	ctx context.Context,
	record store.CaptureSession,
	epoch store.VoiceMediaEpoch,
	stopIntentAt pgtype.Timestamptz,
	observation providerObservation,
) (Capture, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Capture{}, err
	}
	defer tx.Rollback(ctx)
	if _, err = s.queries.WithTx(tx).LockVoiceSession(ctx, record.VoiceSessionID.String); err != nil {
		return Capture{}, err
	}
	if _, err = tx.Exec(ctx, "SELECT id FROM capture_sessions WHERE id=$1 FOR UPDATE", record.ID); err != nil {
		return Capture{}, err
	}
	sealed, err := s.completeCaptureStopTx(ctx, tx, record, epoch, stopIntentAt, observation)
	if err != nil {
		return Capture{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Capture{}, err
	}
	return s.captureWithGapSummary(ctx, record, sealed)
}

// completeCaptureStopTx seals the stopped Capture's last epoch and queues its
// final materialization in tx.
func (s *Service) completeCaptureStopTx(ctx context.Context, tx pgx.Tx, record store.CaptureSession, epoch store.VoiceMediaEpoch, stopIntentAt pgtype.Timestamptz, observation providerObservation) (store.VoiceMediaEpoch, error) {
	queries := s.queries.WithTx(tx)
	mediaStart := int64(0)
	if epoch.FirstArchivedMs.Valid {
		mediaStart = epoch.FirstArchivedMs.Int64
	}
	archivedEnd := absoluteVoiceMediaEnd(mediaStart, observation.ArchivedThroughMS)
	mediaEnd, err := voiceMediaFinalEnd(record.CreatedAt, stopIntentAt, archivedEnd)
	if err != nil {
		return store.VoiceMediaEpoch{}, err
	}
	sealed, err := queries.SealVoiceMediaEpochAtBoundary(ctx, store.SealVoiceMediaEpochAtBoundaryParams{
		ID:                epoch.ID,
		PlaylistObjectKey: pgtype.Text{String: observation.PlaylistObjectKey, Valid: observation.PlaylistObjectKey != ""},
		ArchivedThroughMs: pgtype.Int8{Int64: archivedEnd, Valid: true},
		FinalEndMs:        pgtype.Int8{Int64: mediaEnd, Valid: true},
	})
	if err != nil {
		return store.VoiceMediaEpoch{}, err
	}
	if _, err = queries.CreateCaptureMediaRange(ctx, store.CreateCaptureMediaRangeParams{
		ID:               stableID("capture_media_range", record.ID, epoch.ID, fmt.Sprint(mediaStart), fmt.Sprint(mediaEnd)),
		CaptureSessionID: record.ID, EpochID: pgtype.Text{String: epoch.ID, Valid: true},
		Kind: "media", StartOffsetMs: mediaStart, EndOffsetMs: mediaEnd, Reason: "egress_archived",
	}); err != nil {
		return store.VoiceMediaEpoch{}, err
	}
	stopEnd := stopIntentAt.Time.Sub(record.CreatedAt.Time).Milliseconds()
	if stopEnd-archivedEnd > voiceMediaTailToleranceMS {
		if err = recordRecoveryGap(ctx, queries, record.ID, archivedEnd, stopEnd, "media_ended_before_stop"); err != nil {
			return store.VoiceMediaEpoch{}, err
		}
	}
	if err = queries.RequestVoiceCaptureMaterialization(ctx, record.ID); err != nil {
		return store.VoiceMediaEpoch{}, err
	}
	return sealed, enqueue(ctx, tx, CaptureMaterializeArgs{CaptureSessionID: record.ID})
}

func (s *Service) captureWithGapSummary(
	ctx context.Context,
	record store.CaptureSession,
	epoch store.VoiceMediaEpoch,
) (Capture, error) {
	model := captureModel(record, epoch)
	summary, err := s.queries.GetCaptureGapSummary(ctx, record.ID)
	if err != nil {
		return Capture{}, err
	}
	model.GapCount = summary.GapCount
	model.GapDurationMS = summary.GapDurationMs
	return model, nil
}

func voiceMediaFinalEnd(
	captureCreatedAt pgtype.Timestamptz,
	stopIntentAt pgtype.Timestamptz,
	archivedEndMS int64,
) (int64, error) {
	if !captureCreatedAt.Valid || !stopIntentAt.Valid || archivedEndMS <= 0 {
		return 0, ErrCaptureConflict
	}
	intentEndMS := stopIntentAt.Time.Sub(captureCreatedAt.Time).Milliseconds()
	if intentEndMS <= 0 {
		return 0, ErrCaptureConflict
	}
	return min(archivedEndMS, intentEndMS), nil
}

func absoluteVoiceMediaEnd(firstArchivedMS, epochDurationMS int64) int64 {
	if epochDurationMS <= 0 {
		return firstArchivedMS
	}
	return firstArchivedMS + epochDurationMS
}

func isActiveVoiceSessionConflict(err error) bool {
	var postgresError *pgconn.PgError
	return errors.As(err, &postgresError) && postgresError.Code == "23505" &&
		(postgresError.ConstraintName == "voice_sessions_active_auth_session_idx" || postgresError.ConstraintName == "voice_sessions_live_foreground_idx")
}

func (s *Service) Materialize(ctx context.Context, input MaterializeRequest) (MaterializedAudio, error) {
	if s.materializer == nil {
		return MaterializedAudio{}, ErrProviderUnavailable
	}
	if _, err := s.GetCapture(ctx, input.AccountID, input.CaptureSessionID); err != nil {
		return MaterializedAudio{}, err
	}
	rangeDigest := mediaRangeDigest(input.CaptureSessionID, input.Purpose, input.FromMS, input.ThroughMS)
	existing, err := s.queries.GetCaptureMediaOutput(ctx, store.GetCaptureMediaOutputParams{
		CaptureSessionID: input.CaptureSessionID, Purpose: input.Purpose, RangeDigest: rangeDigest,
	})
	if err == nil {
		return mediaOutputModel(existing), nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return MaterializedAudio{}, err
	}
	if input.Purpose == "final" {
		// Published audio is cut from the saved source of the same range.
		source := input
		source.Purpose = "source"
		if _, err = s.Materialize(ctx, source); err != nil {
			return MaterializedAudio{}, err
		}
	}
	result, err := s.materializer.Materialize(ctx, input)
	if err != nil {
		return MaterializedAudio{}, err
	}
	record, err := s.queries.CreateCaptureMediaOutput(ctx, store.CreateCaptureMediaOutputParams{
		ID:               stableID("capture_media_output", input.CaptureSessionID, input.Purpose, rangeDigest),
		CaptureSessionID: input.CaptureSessionID, Purpose: input.Purpose, RangeDigest: rangeDigest,
		ObjectKey: result.ObjectKey, Filename: result.Filename, DurationMs: result.DurationMS,
		SizeBytes: result.SizeBytes, Sha256: result.SHA256,
	})
	if err != nil {
		return MaterializedAudio{}, err
	}
	return mediaOutputModel(record), nil
}

// mediaRangeDigest names one saved recording of a Capture range.
func mediaRangeDigest(captureID, purpose string, fromMS, throughMS int64) string {
	digest := requestHash("voice-media-range-v1", captureID, purpose, fmt.Sprint(fromMS), fmt.Sprint(throughMS))
	return hex.EncodeToString(digest[:])
}

func stableID(prefix string, parts ...string) string {
	digest := requestHash(prefix, parts...)
	return prefix + "_" + hex.EncodeToString(digest[:16])
}

func requestHash(kind string, parts ...string) [sha256.Size]byte {
	value := kind
	for _, part := range parts {
		value += "\x00" + part
	}
	return sha256.Sum256([]byte(value))
}

func voiceSessionModel(record store.VoiceSession) VoiceSession {
	model := VoiceSession{
		ID: record.ID, TenantID: record.TenantID, RoomID: record.RoomID,
		CreatedByActorID: record.CreatedByActorID, Status: record.Status,
		Purpose: record.Purpose, CredentialGeneration: record.CredentialGeneration,
		CreatedAt: record.CreatedAt.Time, UpdatedAt: record.UpdatedAt.Time,
	}
	if record.LastFailureCode.Valid {
		model.LastFailureCode = record.LastFailureCode.String
	}
	if record.LastInputStartedMs.Valid {
		value := record.LastInputStartedMs.Int64
		model.InputStartedOffsetMs = &value
	}
	if record.LastInputEndedMs.Valid {
		value := record.LastInputEndedMs.Int64
		model.InputEndedOffsetMs = &value
	}
	if record.LatestPartialText.Valid {
		model.PartialTranscript = record.LatestPartialText.String
		if record.LatestPartialStartOffsetMs.Valid {
			value := record.LatestPartialStartOffsetMs.Int64
			model.PartialStartOffsetMs = &value
		}
		if record.LatestPartialEndOffsetMs.Valid {
			value := record.LatestPartialEndOffsetMs.Int64
			model.PartialEndOffsetMs = &value
		}
	}
	if record.ClosedAt.Valid {
		closed := record.ClosedAt.Time
		model.ClosedAt = &closed
	}
	return model
}

func providerSessionModel(record store.VoiceSession) providerSession {
	model := providerSession{
		VoiceSessionID: record.ID, RoomName: record.ProviderRoomName,
		Purpose:             record.Purpose,
		ParticipantIdentity: record.ParticipantIdentity, CreatedAt: record.CreatedAt.Time,
	}
	if record.LastInputStartedMs.Valid {
		model.LastInputStartedAt = record.CreatedAt.Time.Add(time.Duration(record.LastInputStartedMs.Int64) * time.Millisecond)
	}
	return model
}

func providerCaptureModel(voice store.VoiceSession, epoch store.VoiceMediaEpoch) providerCapture {
	return providerCapture{
		VoiceSessionID: voice.ID, CaptureSessionID: epoch.CaptureSessionID,
		EpochID: epoch.ID, EpochIndex: epoch.EpochIndex, RoomName: voice.ProviderRoomName,
		StagingPrefix: epoch.StagingPrefix, EgressID: epoch.ProviderEgressID.String,
	}
}

func captureModel(record store.CaptureSession, epoch store.VoiceMediaEpoch) Capture {
	model := Capture{
		ID: record.ID, VoiceSessionID: record.VoiceSessionID.String, RoomID: record.RoomID,
		Status: record.Status, RequestedStartOffsetMS: record.RequestedTranscriptStartOffsetMs,
		CreatedAt: record.CreatedAt.Time, UpdatedAt: record.UpdatedAt.Time,
	}
	if record.Status == "finalized" && !record.TranscriptDocumentVersionID.Valid {
		model.Status = "finalizing"
	}
	model.AudioDocumentVersionID = record.DocumentVersionID.String
	model.SourceAudioDocumentVersionID = record.SourceAudioDocumentVersionID.String
	model.TranscriptDocumentVersionID = record.TranscriptDocumentVersionID.String
	if epoch.ArchivedThroughMs.Valid {
		value := epoch.ArchivedThroughMs.Int64
		model.ArchivedThroughMS = &value
	}
	if epoch.LastFailureCode.Valid {
		model.LastFailureCode = epoch.LastFailureCode.String
	}
	if record.TranscriptIntegrityLost && !record.TranscriptRecoveredAt.Valid && (model.LastFailureCode == "" || model.LastFailureCode == "transcript_unavailable") {
		model.LastFailureCode = "transcript_incomplete"
	}
	if record.TranscriptRecoveryStatus.Valid {
		model.TranscriptRecoveryStatus = record.TranscriptRecoveryStatus.String
		model.TranscriptRecoveryProgressMS = record.TranscriptRecoveryProgressMs
		model.TranscriptRecoveryTotalMS = record.TranscriptRecoveryTotalMs.Int64
		if record.TranscriptRecoveryFailureCode.Valid {
			model.LastFailureCode = record.TranscriptRecoveryFailureCode.String
		}
	}
	return model
}

func mediaOutputModel(record store.CaptureMediaOutput) MaterializedAudio {
	return MaterializedAudio{
		ObjectKey: record.ObjectKey, Filename: record.Filename, MediaType: record.MediaType,
		DurationMS: record.DurationMs, SizeBytes: record.SizeBytes, SHA256: record.Sha256,
	}
}
