package document

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
)

type disconnectFunc func(ctx context.Context, documentID, actorID string) error

func (f disconnectFunc) Disconnect(ctx context.Context, documentID, actorID string) error {
	return f(ctx, documentID, actorID)
}

// The permission change has already committed and returned when the job runs,
// so a failed disconnect is logged and retried by River, never surfaced.
func TestRuntimeDisconnectFailureLogsAndRetries(t *testing.T) {
	t.Parallel()
	var logs bytes.Buffer
	var calls []string
	worker := NewRuntimeDisconnectWorker(disconnectFunc(func(_ context.Context, documentID, actorID string) error {
		calls = append(calls, documentID+"/"+actorID)
		return errors.New("Runtime unavailable")
	}), slog.New(slog.NewJSONHandler(&logs, nil)))
	job := &river.Job[RuntimeDisconnectArgs]{
		JobRow: &rivertype.JobRow{Attempt: 1, MaxAttempts: runtimeDisconnectMaxAttempts},
		Args: RuntimeDisconnectArgs{
			DocumentID: "document_revoked", ActorID: "actor_revoked", TransactionID: "42",
		},
	}
	if err := worker.Work(context.Background(), job); err == nil {
		t.Fatal("failed disconnect was not returned for retry")
	}
	if len(calls) != 1 || calls[0] != "document_revoked/actor_revoked" {
		t.Fatalf("disconnect calls=%v", calls)
	}
	if !strings.Contains(logs.String(), "document.runtime_disconnect_failed") ||
		!strings.Contains(logs.String(), "document_revoked") {
		t.Fatalf("failed disconnect was not logged: %s", logs.String())
	}
	if opts := (RuntimeDisconnectArgs{}).InsertOpts(); opts.MaxAttempts != runtimeDisconnectMaxAttempts {
		t.Fatalf("disconnect MaxAttempts=%d want %d", opts.MaxAttempts, runtimeDisconnectMaxAttempts)
	}
}

func TestRuntimeDisconnectWithoutRuntimeDoesNothing(t *testing.T) {
	t.Parallel()
	worker := NewRuntimeDisconnectWorker(nil, nil)
	if err := worker.Work(context.Background(), &river.Job[RuntimeDisconnectArgs]{
		Args: RuntimeDisconnectArgs{DocumentID: "document_trashed"},
	}); err != nil {
		t.Fatal(err)
	}
}
