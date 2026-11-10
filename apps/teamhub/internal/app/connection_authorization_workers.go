package app

import (
	"context"
	"time"

	"github.com/riverqueue/river"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
)

// connectionAuthorizationSettleWorker settles the cards waiting on a Connection
// that just became active and wakes their Agents.
type connectionAuthorizationSettleWorker struct {
	river.WorkerDefaults[externalsource.ConnectionAuthorizationSettleArgs]
	app *App
}

// Settling and expiring authorization cards only reads and writes the
// database, so a minute is a generous backstop.
func (*connectionAuthorizationSettleWorker) Timeout(*river.Job[externalsource.ConnectionAuthorizationSettleArgs]) time.Duration {
	return time.Minute
}

func (w *connectionAuthorizationSettleWorker) Work(ctx context.Context, job *river.Job[externalsource.ConnectionAuthorizationSettleArgs]) error {
	return w.app.typedCards.SettleConnectionAuthorizations(ctx, job.Args.ConnectionID)
}
