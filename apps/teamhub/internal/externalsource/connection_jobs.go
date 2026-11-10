package externalsource

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
)

// ConnectionReconcileArgs names one External Connection status reconcile. The
// Connection's next_status_check_at is the durable schedule; the River job only
// performs the check that is due.
type ConnectionReconcileArgs struct {
	ConnectionID string `json:"connection_id"`
	// RequestedAt names a status check a user asked for. It makes the job
	// distinct from a reconcile that is already running, which could otherwise
	// absorb the request and finish without seeing it.
	RequestedAt *time.Time `json:"requested_at,omitempty"`
}

const (
	connectionReconcileKind = "external.connection_reconcile"
	// connectionReconcileMaxAttempts bounds errors for one reconcile. The sweep
	// re-enqueues a Connection that is still due after its job is discarded.
	connectionReconcileMaxAttempts = 25
	// connectionReconcileSweepLimit bounds one sweep so a large backlog spreads over sweeps.
	connectionReconcileSweepLimit = 500
)

// connectionJobTimeout bounds each External Connection job on the external
// queue: a reconcile, status check, reauthorization or upstream cleanup makes
// one or two Composio requests of at most 20 seconds each. It is a backstop
// against a stuck worker, not tuning.
const connectionJobTimeout = time.Minute

// pendingAuthorizationPoll rechecks a connection or reauthorization the user
// has not finished authorizing, until its Connect Link expires. A returning
// OAuth popup makes the check due at once.
const pendingAuthorizationPoll = time.Minute

// connectingPoll rechecks a new Connection or reauthorization while its user is
// most likely still in the OAuth window, so a finished authorization shows
// within seconds even when the popup never returns to the callback page.
const connectingPoll = 5 * time.Second

// connectingWindow is how long after Connect or Reconnect the fast poll lasts.
const connectingWindow = 3 * time.Minute

// pendingConnectionPoll is the wait before rechecking a pending Connection.
func pendingConnectionPoll(createdAt, now time.Time) time.Duration {
	if now.Sub(createdAt) < connectingWindow {
		return connectingPoll
	}
	return pendingAuthorizationPoll
}

// connectionPending reports a Connection that is still connecting. The worker
// polls again after poll instead of waiting for the six-hour check.
type connectionPending struct{ poll time.Duration }

func (*connectionPending) Error() string { return "external connection pending" }

func (ConnectionReconcileArgs) Kind() string { return connectionReconcileKind }

// InsertOpts keep one reconcile per Connection while that job is unfinished or
// waiting for its retry, so the sweep cannot insert attempt 1 while River is
// still backing off. Completed and discarded jobs free the key, so a later due
// check or a sweep after max attempts can enqueue again.
func (ConnectionReconcileArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: jobs.QueueExternal, MaxAttempts: connectionReconcileMaxAttempts, UniqueOpts: jobs.UniqueUnfinishedOrRetrying}
}

type connectionReconcileWorker struct {
	river.WorkerDefaults[ConnectionReconcileArgs]
	service *Service
}

func (*connectionReconcileWorker) Timeout(*river.Job[ConnectionReconcileArgs]) time.Duration {
	return connectionJobTimeout
}

// NextRetry uses the same Connection-ID delay as next_status_check_at, including
// the hourly floor, so River does not retry before the durable schedule.
func (w *connectionReconcileWorker) NextRetry(job *river.Job[ConnectionReconcileArgs]) time.Time {
	return time.Now().Add(connectionReconcileRetryDelay(job.Args.ConnectionID, job.Attempt, time.Minute))
}

func (w *connectionReconcileWorker) Work(ctx context.Context, job *river.Job[ConnectionReconcileArgs]) error {
	return connectionReconcileWorkResult(w.service.reconcileConnectionJob(ctx, job.Args.ConnectionID, job.Attempt))
}

// connectionReconcileWorkResult keeps River on the persisted next_status_check_at.
// Rate limits and discord_guild_required snooze (no attempt) for max(Retry-After,
// the written delay), counted from Work's return. Other errors use NextRetry.
func connectionReconcileWorkResult(err error) error {
	if err == nil {
		return nil
	}
	var pending *connectionPending
	if errors.As(err, &pending) {
		return river.JobSnooze(pending.poll)
	}
	var deferred *connectionCheckDeferred
	if errors.As(err, &deferred) {
		return river.JobSnooze(time.Until(deferred.until))
	}
	var failure *connectionCheckFailure
	errors.As(err, &failure)
	persistedWait := time.Duration(0)
	if failure != nil {
		persistedWait = failure.retryDelay
	}
	var limited *composio.RateLimitError
	if errors.As(err, &limited) && limited.RetryAfter > 0 {
		return river.JobSnooze(max(limited.RetryAfter, persistedWait))
	}
	if failure != nil && failure.code == "discord_guild_required" {
		return river.JobSnooze(persistedWait)
	}
	return err
}

// EnqueueDueConnectionReconciles is the repair sweep. It enqueues each Connection
// whose status check is due and has no unfinished or retryable reconcile job,
// and the revoke of each disconnecting Connection whose revoke is overdue.
func (s *Service) EnqueueDueConnectionReconciles(ctx context.Context) error {
	rows, err := s.pool.Query(ctx, `SELECT id,status,upstream_connection_id FROM external_connections WHERE status IN ('pending','active','expired','failed','disconnecting') AND next_status_check_at<=now() ORDER BY next_status_check_at,id LIMIT $1`, connectionReconcileSweepLimit)
	if err != nil {
		return err
	}
	type due struct{ id, status, upstream string }
	connections, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (due, error) {
		var item due
		return item, row.Scan(&item.id, &item.status, &item.upstream)
	})
	if err != nil {
		return err
	}
	if len(connections) == 0 {
		return nil
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for _, connection := range connections {
		if connection.status == "disconnecting" {
			err = jobs.InsertTx(ctx, tx, CleanupArgs{ConnectionID: connection.id, UpstreamID: connection.upstream}, nil)
		} else {
			err = enqueueConnectionReconcileTx(ctx, tx, connection.id)
		}
		if err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// enqueueConnectionReconcileTx queues a reconcile in the transaction that makes a
// Connection due, so its check runs without waiting for the sweep.
func enqueueConnectionReconcileTx(ctx context.Context, tx pgx.Tx, connectionID string) error {
	return jobs.InsertTx(ctx, tx, ConnectionReconcileArgs{ConnectionID: connectionID}, nil)
}
