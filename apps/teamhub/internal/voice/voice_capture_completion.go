package voice

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
)

const (
	// LiveKitCaptureCompletionMaxAttempts bounds the attempts to complete a Capture.
	LiveKitCaptureCompletionMaxAttempts = 12
	liveKitCaptureCompletionRetryBase   = 5 * time.Second
	liveKitCaptureCompletionRetryCap    = 5 * time.Minute
	// A Capture whose transcript is not complete yet, or whose step stopped,
	// waits this long without spending an attempt.
	liveKitCaptureCompletionWait = 5 * time.Second
)

const (
	liveKitCaptureCompletionFailureDocumentNotFound    = "document_not_found"
	liveKitCaptureCompletionFailureAuthorityIncomplete = "authority_incomplete"
	liveKitCaptureCompletionFailureRetryExhausted      = "retry_exhausted"
)

var errLiveKitCaptureCompletionAuthorityIncomplete = errors.New("LiveKit Capture completion authority is incomplete")

// CompleteCaptureStep writes a finalized Capture's transcript Document and
// completion message. A Capture whose transcript is incomplete waits; a
// missing Document or authority fails it; other failures retry with backoff
// until the attempt budget runs out.
func (s *Service) CompleteCaptureStep(ctx context.Context, captureID string) (time.Duration, error) {
	row, err := s.queries.GetPendingLiveKitCaptureCompletion(ctx, captureID)
	if errors.Is(err, pgx.ErrNoRows) {
		return voicemedia.JobDone, nil
	}
	if err != nil {
		return liveKitCaptureCompletionWait, err
	}
	cause := s.completeLiveKitCapture(ctx, row)
	if cause == nil {
		return voicemedia.JobDone, nil
	}
	settleCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	return s.SettleLiveKitCaptureCompletion(settleCtx, row.ID, row.VoiceCompletionAttempts, cause, ctx.Err())
}

func (s *Service) completeLiveKitCapture(ctx context.Context, row store.GetPendingLiveKitCaptureCompletionRow) error {
	if !row.AccountID.Valid || !row.DocumentVersionID.Valid {
		return errLiveKitCaptureCompletionAuthorityIncomplete
	}
	version, err := s.documents.GetVersion(ctx, row.AccountID.String, row.DocumentVersionID.String)
	if err != nil {
		return err
	}
	body, err := json.Marshal(documentVersionModel(version))
	if err != nil {
		return err
	}
	_, err = s.completeCaptureRecording(ctx, row.AccountID.String, row.ID, body)
	return err
}

func liveKitCaptureCompletionFailureCode(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, document.ErrNotFound):
		return liveKitCaptureCompletionFailureDocumentNotFound
	case errors.Is(err, errLiveKitCaptureCompletionAuthorityIncomplete):
		return liveKitCaptureCompletionFailureAuthorityIncomplete
	default:
		return ""
	}
}

func liveKitCaptureCompletionShouldDelay(cause, workerErr error) bool {
	return errors.Is(cause, errCaptureTranscriptIncomplete) ||
		errors.Is(workerErr, context.Canceled) ||
		errors.Is(workerErr, context.DeadlineExceeded)
}

func liveKitCaptureCompletionRetryDelay(attempts int32) time.Duration {
	if attempts < 0 {
		attempts = 0
	}
	delay := liveKitCaptureCompletionRetryBase << min(attempts, 6)
	return min(delay, liveKitCaptureCompletionRetryCap)
}

// SettleLiveKitCaptureCompletion records how a Capture completion attempt ended.
func (s *Service) SettleLiveKitCaptureCompletion(ctx context.Context, captureID string, attempts int32, cause, workerErr error) (time.Duration, error) {
	if liveKitCaptureCompletionShouldDelay(cause, workerErr) {
		if errors.Is(cause, errCaptureTranscriptIncomplete) {
			return liveKitCaptureCompletionWait, nil
		}
		return liveKitCaptureCompletionWait, cause
	}
	if code := liveKitCaptureCompletionFailureCode(cause); code != "" {
		_, failErr := s.queries.FailLiveKitCaptureCompletion(ctx, store.FailLiveKitCaptureCompletionParams{
			ID: captureID, FailureCode: code,
		})
		if errors.Is(failErr, pgx.ErrNoRows) {
			return voicemedia.JobDone, cause
		}
		if failErr != nil {
			return liveKitCaptureCompletionWait, errors.Join(cause, failErr)
		}
		s.logLiveKitCaptureCompletionFailure(captureID, code)
		return voicemedia.JobDone, nil
	}
	retried, retryErr := s.queries.RetryLiveKitCaptureCompletion(ctx, store.RetryLiveKitCaptureCompletionParams{
		ID: captureID, MaxAttempts: LiveKitCaptureCompletionMaxAttempts,
		FailureCode: liveKitCaptureCompletionFailureRetryExhausted,
	})
	if errors.Is(retryErr, pgx.ErrNoRows) {
		return voicemedia.JobDone, cause
	}
	if retryErr != nil {
		return liveKitCaptureCompletionWait, errors.Join(cause, retryErr)
	}
	if retried.VoiceCompletionFailedAt.Valid {
		s.logLiveKitCaptureCompletionFailure(captureID, liveKitCaptureCompletionFailureRetryExhausted)
		return voicemedia.JobDone, nil
	}
	return liveKitCaptureCompletionRetryDelay(attempts), cause
}

func (s *Service) logLiveKitCaptureCompletionFailure(captureID, failureCode string) {
	s.logger.Error("LiveKit Capture completion failed", "capture_id", captureID, "failure_code", failureCode)
}
