package jobs

import (
	"context"
	"log/slog"
	"maps"
	"math"
	"slices"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	// dueNotifierFallback bounds the wait when no wake or due time arrives,
	// covering a wake lost while the realtime Listener reconnects.
	dueNotifierFallback  = time.Minute
	dueNotifierErrorWait = time.Second
	// River's producer can lose a notification: a job that finishes while a
	// fetch is in flight drops the pending "fetch when a slot frees", so a
	// notified job can stay available until the queue's minute poll. A job
	// finishing outside the maintenance queue wakes a normal step, which
	// notifies every queue with a due backlog. After a step that notified, a
	// recheck follows after dueRecheckDelay and notifies again each queue
	// whose available job fell due within dueRecheckWindow. Older available
	// jobs, such as kinds no process registers, are never rechecked, so the
	// recheck costs nothing while idle.
	dueRecheckDelay  = 2 * time.Second
	dueRecheckWindow = 10 * time.Second
	// dueNotifierMinGap spaces steps started by wakes: every job insert,
	// snooze, or retry wakes the notifier, so under heavy churn steps would
	// otherwise run back to back, each scanning river_job and renotifying
	// every queue with a backlog. Wakes during the gap collapse into one step
	// that rereads the database, so none is lost.
	dueNotifierMinGap = 250 * time.Millisecond
)

// dueStep notifies every queue that holds a due available job, and each queue
// in $1, and reports how many queues it notified and when the next known job
// falls due. With $2 set it is a recheck and notifies only jobs due within
// the last $3 seconds. It does not track what an earlier step notified: a
// snooze or retry can commit after its own due time, and a repeated
// notification only costs the producer one fetch. A job of a kind no process
// registers stays available, so its queue is notified on every normal step.
//
// A scheduled or retryable job due at T is normally moved to available by
// River's scheduler, which looks ahead by its interval, before T and without
// a notification; the step at T notifies it. When the scheduler moves the job
// only after T, the scheduler notifies the overdue job itself.
const dueStep = `
WITH notified AS (
	SELECT notify_river_queue(queue) FROM (
		SELECT queue FROM river_job WHERE state = 'available' AND scheduled_at <= now()
		  AND (NOT $2::boolean OR scheduled_at > now() - make_interval(secs => $3::float8))
		UNION SELECT unnest($1::text[])
	) due
)
-- Referencing notified makes PostgreSQL run its notifications.
SELECT (SELECT count(*) FROM notified),
	(SELECT extract(epoch FROM min(scheduled_at) - now())::float8 FROM river_job
	 WHERE state IN ('available', 'scheduled', 'retryable') AND scheduled_at > now())`

// DueNotifier sends River's insert notification for a job when its future due
// time arrives. River notifies only jobs inserted due now, so without it a
// scheduled, snoozed, or retried job would wait for its queue's poll. A commit
// that gives a job a future or changed due time wakes it through the realtime
// Listener; between wakes it sleeps until the next due time.
//
// The realtime Listener may lose notifications of any kind while it
// reconnects, so a reconnect makes the next step notify every queue. The
// first step does the same: River's producers fetch at start but LISTEN only
// shortly after, and an insert in between would otherwise wait for the poll.
type DueNotifier struct {
	pool      *pgxpool.Pool
	queues    []string
	notifyAll atomic.Bool
	logger    *slog.Logger
	afterStep func()
	wake      chan struct{}
}

// NewDueNotifier creates a notifier for the queues of the client that options
// build. afterStep runs after each successful step so tests can count steps;
// production passes nil.
func NewDueNotifier(pool *pgxpool.Pool, options Options, afterStep func()) *DueNotifier {
	logger := options.Logger
	if logger == nil {
		logger = slog.Default()
	}
	n := &DueNotifier{
		pool: pool, queues: slices.Sorted(maps.Keys(queueConfigs(options))),
		logger: logger, afterStep: afterStep, wake: make(chan struct{}, 1),
	}
	n.notifyAll.Store(true)
	return n
}

// Wake asks for a step without waiting; wakes before the step collapse.
// After a Listener reconnect that step notifies every queue.
func (n *DueNotifier) Wake(reconnect bool) {
	if reconnect {
		n.notifyAll.Store(true)
	}
	select {
	case n.wake <- struct{}{}:
	default:
	}
}

// Run steps until ctx ends. A wake is taken before each step, so a commit
// that wakes it during a step gets another step.
func (n *DueNotifier) Run(ctx context.Context) {
	errorWait := dueNotifierErrorWait
	recheck := false
	for {
		select {
		case <-n.wake:
		default:
		}
		var notified int64
		var dueIn *float64
		wait := dueNotifierFallback
		var queues []string
		stepStart := time.Now()
		all := n.notifyAll.Swap(false)
		if all {
			queues = n.queues
		}
		if err := n.pool.QueryRow(ctx, dueStep, queues, recheck && !all, dueRecheckWindow.Seconds()).Scan(&notified, &dueIn); err != nil {
			if ctx.Err() != nil {
				return
			}
			if all {
				n.notifyAll.Store(true)
			}
			n.logger.ErrorContext(ctx, "notify due TeamHub jobs", "error", err, "retry_in_ms", errorWait.Milliseconds())
			if !sleep(ctx, errorWait) {
				return
			}
			errorWait = min(2*errorWait, dueNotifierFallback)
			continue
		}
		errorWait = dueNotifierErrorWait
		if n.afterStep != nil {
			n.afterStep()
		}
		if dueIn != nil {
			wait = min(wait, time.Duration(math.Ceil(*dueIn*float64(time.Second))))
		}
		if notified > 0 {
			wait = min(wait, dueRecheckDelay)
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-n.wake:
			timer.Stop()
			recheck = false
			if !sleep(ctx, dueNotifierMinGap-time.Since(stepStart)) {
				return
			}
		case <-timer.C:
			// Jobs that fall due now are recent, so a recheck covers them too.
			recheck = notified > 0
		}
	}
}

func sleep(ctx context.Context, wait time.Duration) bool {
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
