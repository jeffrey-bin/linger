package app

import (
	"context"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/voice"
)

// LiveKitCaptureCompletionMaxAttemptsForTest exposes the completion attempt
// budget to integration tests.
func LiveKitCaptureCompletionMaxAttemptsForTest() int32 {
	return voice.LiveKitCaptureCompletionMaxAttempts
}

// CompleteCaptureForTest runs one step of a Capture's completion job.
func (a *App) CompleteCaptureForTest(ctx context.Context, captureID string) (time.Duration, error) {
	return a.voice.CompleteCaptureStep(ctx, captureID)
}

// SettleLiveKitCaptureCompletionForTest settles a failed completion step as
// the job would; a canceled ctx stands for a step that stopped.
func (a *App) SettleLiveKitCaptureCompletionForTest(ctx context.Context, captureID string, attempts int32, cause error) (time.Duration, error) {
	settleCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	return a.voice.SettleLiveKitCaptureCompletion(settleCtx, captureID, attempts, cause, ctx.Err())
}
