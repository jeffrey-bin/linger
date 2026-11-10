package document

import (
	"context"
	"log/slog"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
)

const runtimeDisconnectKind = "document.runtime_disconnect"

// RuntimeDisconnecter closes open collaboration connections in the Document
// Runtime.
type RuntimeDisconnecter interface {
	Disconnect(ctx context.Context, documentID, actorID string) error
}

// RuntimeDisconnectArgs asks the Runtime to close a Document's connections, or
// one Actor's, once the transaction that changed permissions commits. The
// transaction ID makes the job unique within that transaction only, so a
// later change always gets its own disconnect.
type RuntimeDisconnectArgs struct {
	DocumentID    string `json:"document_id"`
	ActorID       string `json:"actor_id,omitempty"`
	TransactionID string `json:"transaction_id"`
}

// Kind names the River job.
func (RuntimeDisconnectArgs) Kind() string { return runtimeDisconnectKind }

// runtimeDisconnectMaxAttempts spans several hours of River's default backoff.
// A connection the Runtime keeps open stays writable until its token expires,
// which follows the login session, so a brief Runtime outage must not leave a
// revoked Actor editing for that long.
const runtimeDisconnectMaxAttempts = 10

// InsertOpts retries a failed disconnect with backoff. The permission count
// already refuses the old tokens on reconnect, so only connections that stay
// open depend on these attempts.
func (RuntimeDisconnectArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: jobs.QueueDefault, MaxAttempts: runtimeDisconnectMaxAttempts, UniqueOpts: river.UniqueOpts{ByArgs: true}}
}

// insertRuntimeDisconnect enqueues a disconnect in the transaction that
// changed the Document's permissions. An empty actorID closes every
// connection of the Document.
func insertRuntimeDisconnect(ctx context.Context, tx pgx.Tx, documentID, actorID string) error {
	var transactionID string
	if err := tx.QueryRow(ctx, `SELECT txid_current()::text`).Scan(&transactionID); err != nil {
		return err
	}
	return jobs.InsertTx(ctx, tx, RuntimeDisconnectArgs{
		DocumentID: documentID, ActorID: actorID, TransactionID: transactionID,
	}, nil)
}

// RuntimeDisconnectWorker calls the Runtime's disconnect after commit.
type RuntimeDisconnectWorker struct {
	river.WorkerDefaults[RuntimeDisconnectArgs]
	runtime RuntimeDisconnecter
	logger  *slog.Logger
}

// NewRuntimeDisconnectWorker returns a worker that disconnects through
// runtime. Without a Runtime there is no connection to close.
func NewRuntimeDisconnectWorker(runtime RuntimeDisconnecter, logger *slog.Logger) *RuntimeDisconnectWorker {
	if logger == nil {
		logger = slog.Default()
	}
	return &RuntimeDisconnectWorker{runtime: runtime, logger: logger}
}

// Work logs a failed disconnect and returns the error so River retries it.
// The permission change has already committed and returned; a failure never
// reaches the request that caused it.
func (w *RuntimeDisconnectWorker) Work(ctx context.Context, job *river.Job[RuntimeDisconnectArgs]) error {
	if w.runtime == nil {
		return nil
	}
	err := w.runtime.Disconnect(ctx, job.Args.DocumentID, job.Args.ActorID)
	if err != nil {
		w.logger.WarnContext(ctx, "document.runtime_disconnect_failed",
			"document_id", job.Args.DocumentID, "actor_id", job.Args.ActorID,
			"attempt", job.Attempt, "max_attempts", job.MaxAttempts, "error", err)
	}
	return err
}
