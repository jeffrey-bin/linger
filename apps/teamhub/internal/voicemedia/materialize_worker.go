package voicemedia

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomevent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

const voiceTranscriptFinalizeTimeout = time.Minute

// A long recording's final audio is cut and uploaded within one attempt.
const materializationTimeout = 30 * time.Minute

var errTranscriptRecoveryQueued = errors.New("voice transcript recovery queued")

const (
	voiceMaterializationMaxAttempts = 12
	voiceMaterializationRetryBase   = 5 * time.Second
	voiceMaterializationRetryCap    = 5 * time.Minute

	voiceMaterializationFailureDocumentNotFound = "document_not_found"
	voiceMaterializationFailureRetryExhausted   = "retry_exhausted"
)

// materializeStep saves a stopped Capture's final audio once its transcript
// covers the recording, and settles the materialization when that cannot
// happen.
func (s *Service) materializeStep(ctx context.Context, captureID string) (time.Duration, error) {
	claim, err := s.queries.ClaimVoiceMediaMaterialization(ctx, captureID)
	if errors.Is(err, pgx.ErrNoRows) {
		seconds, dueErr := s.queries.VoiceMediaMaterializationDueIn(ctx, captureID)
		return dueWait(seconds), dueErr
	}
	if err != nil {
		return jobErrorWait, err
	}
	processErr := s.processMaterialization(ctx, captureID)
	if processErr == nil {
		return JobDone, nil
	}
	// A transcript wait returns its attempt and holds nothing back, so the
	// next transcript progress wakes the job at once; a failure backs off.
	release := func(delay time.Duration, refund bool) error {
		return s.queries.ReleaseVoiceMediaMaterialization(context.WithoutCancel(ctx), store.ReleaseVoiceMediaMaterializationParams{
			ID: captureID, RetryDelay: durationInterval(delay), RefundAttempt: refund,
		})
	}
	switch {
	case errors.Is(processErr, errTranscriptRecoveryQueued):
		return time.Second, release(0, true)
	case errors.Is(processErr, ErrTranscriptIntegrityLost):
		return settled(s.failTranscriptFinalization(context.WithoutCancel(ctx), captureID))
	case errors.Is(processErr, ErrTranscriptIncomplete):
		if transcriptWaitExpired(claim.MaterializeRequestedAt.Time, time.Now()) {
			return settled(s.failTranscriptFinalization(context.WithoutCancel(ctx), captureID))
		}
		_ = release(0, true)
		return time.Second, nil
	case ctx.Err() != nil:
		_ = release(voiceMaterializationRetryBase, true)
		return voiceMaterializationRetryBase, processErr
	}
	if code := voiceMaterializationTerminalCode(processErr, claim.MaterializeAttempts); code != "" {
		return settled(s.failMaterialization(context.WithoutCancel(ctx), captureID, code))
	}
	delay := voiceMaterializationRetryDelay(claim.MaterializeAttempts)
	_ = release(delay, false)
	return delay, processErr
}

// settled ends a job whose work reached a terminal state; a failed settlement
// write retries the step.
func settled(err error) (time.Duration, error) {
	if err != nil {
		return jobErrorWait, err
	}
	return JobDone, nil
}

// A Document or Room ownership that no longer resolves cannot recover by
// retrying; every other failure retries with backoff until the budget runs out.
func voiceMaterializationTerminalCode(err error, attempts int32) string {
	switch {
	case errors.Is(err, document.ErrNotFound):
		return voiceMaterializationFailureDocumentNotFound
	case attempts >= voiceMaterializationMaxAttempts:
		return voiceMaterializationFailureRetryExhausted
	default:
		return ""
	}
}

// attempts counts the current Claim, so the first failure waits the base delay.
func voiceMaterializationRetryDelay(attempts int32) time.Duration {
	delay := voiceMaterializationRetryBase << min(max(attempts-1, 0), 6)
	return min(delay, voiceMaterializationRetryCap)
}

func (s *Service) failMaterialization(ctx context.Context, captureID string, failureCode string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	queries := s.queries.WithTx(tx)
	failed, err := queries.FailVoiceMediaMaterialization(ctx, captureID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	err = roomevent.AppendCaptureSessionChanged(
		ctx, queries, failed.TenantID, failed.RoomID, failed.CreatedByActorID, failed.ID, "failed",
	)
	// A Room under deletion accepts no events but must still stop the retry.
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if err = enqueue(ctx, tx, StagingCleanupArgs{CaptureSessionID: failed.ID}); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	slog.ErrorContext(ctx, "Voice materialization failed", "capture_session_id", failed.ID, "failure_code", failureCode)
	return nil
}

func transcriptWaitExpired(requestedAt, now time.Time) bool {
	return !requestedAt.IsZero() && now.Sub(requestedAt) >= voiceTranscriptFinalizeTimeout
}

func (s *Service) failTranscriptFinalization(ctx context.Context, captureID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	queries := s.queries.WithTx(tx)
	capture, err := queries.FailLiveKitCaptureTranscriptFinalization(ctx, captureID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if err = roomevent.AppendCaptureSessionChanged(
		ctx, queries, capture.TenantID, capture.RoomID, capture.CreatedByActorID,
		capture.ID, "failed",
	); err != nil {
		return err
	}
	if err = enqueue(ctx, tx, StagingCleanupArgs{CaptureSessionID: capture.ID}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) processMaterialization(ctx context.Context, captureID string) error {
	job, err := s.queries.GetVoiceMediaMaterializationContext(ctx, captureID)
	if err != nil {
		return err
	}
	if !job.AccountID.Valid || job.EndOffsetMs <= job.StartOffsetMs {
		return ErrCaptureConflict
	}
	var source store.CaptureMediaOutput
	if s.archiveASR != nil {
		source, err = s.saveSourceAudio(ctx, job)
		if err != nil {
			return err
		}
	}
	captureSession, err := s.queries.GetCaptureSessionForAccount(ctx, store.GetCaptureSessionForAccountParams{
		ID: job.CaptureSessionID, AccountID: job.AccountID,
	})
	if err == nil && !captureSession.TranscriptEndOffsetMs.Valid {
		// The transcript end freezes once the input track and the final media
		// epoch have both ended; the Runtime's track_ended freezes it too.
		if err = s.queries.FreezeReadyVoiceTranscripts(ctx); err == nil {
			captureSession, err = s.queries.GetCaptureSessionForAccount(ctx, store.GetCaptureSessionForAccountParams{
				ID: job.CaptureSessionID, AccountID: job.AccountID,
			})
		}
	}
	if err != nil {
		return err
	}
	acceptedOffsetMS, err := s.queries.GetCaptureTranscriptAcceptedOffset(ctx, job.CaptureSessionID)
	if err != nil {
		return err
	}
	incomplete := !voiceTranscriptCoversCapture(
		captureSession.TranscriptStartOffsetMs.Valid,
		captureSession.TranscriptEndOffsetMs,
		acceptedOffsetMS,
	)
	if source.ID != "" && !captureSession.TranscriptRecoveredAt.Valid &&
		(captureSession.TranscriptIntegrityLost || (incomplete && time.Since(job.MaterializeRequestedAt.Time) >= 5*time.Second)) {
		if err = s.queueTranscriptRecovery(ctx, job, source.DurationMs); err != nil {
			return err
		}
		return errTranscriptRecoveryQueued
	}
	if captureSession.TranscriptIntegrityLost && !captureSession.TranscriptRecoveredAt.Valid {
		return ErrTranscriptIntegrityLost
	}
	if incomplete {
		return ErrTranscriptIncomplete
	}
	const purpose = "final"
	materialized, err := s.Materialize(ctx, MaterializeRequest{
		AccountID: job.AccountID.String, CaptureSessionID: job.CaptureSessionID,
		FromMS: job.StartOffsetMs, ThroughMS: job.EndOffsetMs,
		Purpose: purpose,
	})
	if err != nil {
		return err
	}
	output, err := s.queries.GetCaptureMediaOutput(ctx, store.GetCaptureMediaOutputParams{
		CaptureSessionID: job.CaptureSessionID, Purpose: purpose,
		RangeDigest: mediaRangeDigest(job.CaptureSessionID, purpose, job.StartOffsetMs, job.EndOffsetMs),
	})
	if err != nil {
		return err
	}
	digest, err := hex.DecodeString(materialized.SHA256)
	if err != nil || len(digest) != sha256.Size {
		return errors.New("materialized voice media SHA-256 is invalid")
	}
	var objectSHA [sha256.Size]byte
	copy(objectSHA[:], digest)
	object := artifactstore.Object{Key: materialized.ObjectKey, Size: materialized.SizeBytes, SHA256: objectSHA}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	queries := s.queries.WithTx(tx)
	version, err := s.documents.CreateStoredRoomUploadTx(ctx, tx, document.StoredRoomUploadInput{
		AccountID: job.AccountID.String, RoomID: job.RoomID,
		CommandID: "voice-capture-finalize:" + job.CaptureSessionID,
		Filename:  materialized.Filename, RepresentationFormat: "m4a",
		MediaType: materialized.MediaType, Object: object,
	})
	if err != nil {
		return err
	}
	if _, err = queries.AttachCaptureMediaOutputDocument(ctx, store.AttachCaptureMediaOutputDocumentParams{
		ID: output.ID, DocumentID: pgtype.Text{String: version.DocumentID, Valid: true},
		DocumentVersionID: pgtype.Text{String: version.ID, Valid: true},
	}); err != nil {
		return err
	}
	if _, err = queries.FinalizeLiveKitCapture(ctx, store.FinalizeLiveKitCaptureParams{
		ID: job.CaptureSessionID, DocumentID: pgtype.Text{String: version.DocumentID, Valid: true},
		DocumentVersionID: pgtype.Text{String: version.ID, Valid: true},
	}); err != nil {
		return err
	}
	if err = roomevent.AppendCaptureSessionChanged(
		ctx, queries, job.TenantID, job.RoomID, job.CreatedByActorID,
		job.CaptureSessionID, "finalized",
	); err != nil {
		return err
	}
	if err = enqueue(ctx, tx,
		CaptureCompletionArgs{CaptureSessionID: job.CaptureSessionID},
		StagingCleanupArgs{CaptureSessionID: job.CaptureSessionID},
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func voiceTranscriptCoversCapture(
	hasStart bool,
	end pgtype.Int8,
	acceptedOffsetMS int64,
) bool {
	return hasStart && end.Valid && acceptedOffsetMS >= end.Int64
}

func durationInterval(duration time.Duration) pgtype.Interval {
	return pgtype.Interval{Microseconds: int64(duration / time.Microsecond), Valid: true}
}
