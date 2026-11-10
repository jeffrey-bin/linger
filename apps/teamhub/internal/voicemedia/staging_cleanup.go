package voicemedia

import (
	"context"
	"fmt"
	"time"
)

const stagingCleanupRetryWait = time.Minute

// cleanStagingStep deletes the staging prefix of a Capture that is finalized
// or failed and whose epochs no recorder still writes. Nothing reads staging
// after that: materialization and transcript recovery run only while a Capture
// is finalizing or recovering, so recovering Captures keep theirs.
func (s *Service) cleanStagingStep(ctx context.Context, captureID string) (time.Duration, error) {
	ready, err := s.queries.VoiceStagingCleanupReady(ctx, captureID)
	if err != nil {
		return jobErrorWait, err
	}
	if !ready {
		return JobDone, nil
	}
	cleaner := s.materializer.(stagingCleaner)
	if err := cleaner.DeleteCaptureStaging(ctx, captureID); err != nil {
		return stagingCleanupRetryWait, fmt.Errorf("delete staging of Capture %s: %w", captureID, err)
	}
	if err := s.queries.MarkVoiceStagingDeleted(ctx, captureID); err != nil {
		return jobErrorWait, err
	}
	return JobDone, nil
}
