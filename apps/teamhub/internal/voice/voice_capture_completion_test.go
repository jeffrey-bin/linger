package voice

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func TestLiveKitCaptureCompletionFailureCode(t *testing.T) {
	t.Parallel()
	for _, tt := range []struct {
		name string
		err  error
		want string
	}{
		{name: "success", err: nil},
		{name: "document not found", err: document.ErrNotFound, want: liveKitCaptureCompletionFailureDocumentNotFound},
		{name: "wrapped document not found", err: fmt.Errorf("load version: %w", document.ErrNotFound), want: liveKitCaptureCompletionFailureDocumentNotFound},
		{name: "authority incomplete", err: errLiveKitCaptureCompletionAuthorityIncomplete, want: liveKitCaptureCompletionFailureAuthorityIncomplete},
		{name: "retryable", err: errors.New("Capture Direct Room Agent is unavailable")},
		{name: "incomplete transcript", err: errCaptureTranscriptIncomplete},
		{name: "canceled", err: context.Canceled},
		{name: "deadline exceeded", err: context.DeadlineExceeded},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if got := liveKitCaptureCompletionFailureCode(tt.err); got != tt.want {
				t.Fatalf("failure code=%q want=%q", got, tt.want)
			}
		})
	}
}

func TestLiveKitCaptureCompletionShouldDelay(t *testing.T) {
	t.Parallel()
	for _, tt := range []struct {
		name      string
		cause     error
		workerErr error
		delay     bool
	}{
		{name: "incomplete transcript", cause: errCaptureTranscriptIncomplete, delay: true},
		{name: "worker canceled", cause: context.Canceled, workerErr: context.Canceled, delay: true},
		{name: "worker deadline", cause: context.DeadlineExceeded, workerErr: context.DeadlineExceeded, delay: true},
		{name: "downstream canceled", cause: context.Canceled},
		{name: "downstream deadline", cause: context.DeadlineExceeded},
		{name: "wrapped downstream deadline", cause: fmt.Errorf("get version: %w", context.DeadlineExceeded)},
		{name: "unrelated worker error", cause: errors.New("Capture Direct Room Agent is unavailable"), workerErr: errors.New("pool exhausted")},
		{name: "document not found", cause: document.ErrNotFound},
		{name: "retryable", cause: errors.New("Capture Direct Room Agent is unavailable")},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if got := liveKitCaptureCompletionShouldDelay(tt.cause, tt.workerErr); got != tt.delay {
				t.Fatalf("delay=%v want=%v", got, tt.delay)
			}
		})
	}
}

func TestLiveKitCaptureCompletionRetryDelay(t *testing.T) {
	t.Parallel()
	want := []time.Duration{
		5 * time.Second,
		10 * time.Second,
		20 * time.Second,
		40 * time.Second,
		80 * time.Second,
		160 * time.Second,
		5 * time.Minute,
		5 * time.Minute,
	}
	for attempts, delay := range want {
		if got := liveKitCaptureCompletionRetryDelay(int32(attempts)); got != delay {
			t.Fatalf("attempts=%d delay=%s want=%s", attempts, got, delay)
		}
	}
	if got := liveKitCaptureCompletionRetryDelay(-1); got != 5*time.Second {
		t.Fatalf("negative attempts delay=%s", got)
	}
	if LiveKitCaptureCompletionMaxAttempts < 1 {
		t.Fatal("max attempts must fail a retryable Capture")
	}
}
