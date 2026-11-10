// Package jobs owns TeamHub's River plumbing: the one processing client, its
// queues, error logging, and the insert helper that domain packages call inside
// the transaction that commits the fact requiring the work. Domain packages
// register their workers and periodic jobs; this package imports none of them.
package jobs

import (
	"context"
	"errors"
	"log/slog"
	"maps"
	"slices"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivertype"
)

// UnfinishedStates are the states that still owe work. Uniqueness that uses
// them lets one job per key run while keeping completed jobs out of the key.
var UnfinishedStates = []rivertype.JobState{
	rivertype.JobStateAvailable,
	rivertype.JobStatePending,
	rivertype.JobStateRunning,
	rivertype.JobStateScheduled,
}

const (
	// QueueDefault runs short jobs, most of which someone waits on: decision
	// runs and expiry, Connection authorization settlement, proactive wakes,
	// Task follow-ups, Document and Personal Wiki follow-ups, and object cleanup.
	// Work that holds a slot for minutes belongs on its own queue.
	QueueDefault = river.QueueDefault
	// QueueMaintenance runs periodic sweeps. Each sweep is one job per period.
	QueueMaintenance = "maintenance"
	// QueueIndexing runs Document search-text indexing.
	QueueIndexing = "indexing"
	// QueuePersonalWiki runs Personal Wiki refresh dispatch and the Memory graph
	// update of each published Wiki revision. Both run for many minutes, so each
	// worker overrides Timeout; see the document package.
	QueuePersonalWiki = "personal_wiki"
	// QueueGeneration runs Personal Profile and Personal Insight generation.
	// These LLM-backed jobs are long, so they get their own queue.
	QueueGeneration = "generation"
	// QueueSchedule runs one job per due Reminder occurrence.
	QueueSchedule = "schedule"
	// QueueExternal runs External Source work: Connection checks and
	// reauthorization, mail imports and their Profile hand-off, app listener
	// polls, and cleanup. Imports and polls hold slots for minutes.
	QueueExternal = "external"
	// QueueDocumentInput runs the short transaction that starts or fails a
	// queued Document comment Run after its mention or thread changed, and the
	// safety-net sweep for it, apart from maintenance so other sweeps cannot
	// delay it.
	QueueDocumentInput = "document_input"

	// jobTimeout bounds a job whose worker sets no Timeout. It also sets how
	// soon River rescues a job that a stopped process left running. Workers
	// that can run longer, such as model calls, mail imports, Personal Wiki
	// dispatch, and the Memory graph update, override Timeout.
	jobTimeout = 5 * time.Minute
	// RescueStuckJobsAfter is how long a job may stay running before River's
	// rescuer, which runs every 30 seconds, retries it or discards it after its
	// last attempt; a job whose worker overrides Timeout also waits out that
	// Timeout. It must not be less than jobTimeout, and the minute beyond it lets
	// a cancelled job return first. River's default is jobTimeout plus an hour,
	// which left a sweep that a crash left running blocking its later periods.
	RescueStuckJobsAfter = jobTimeout + time.Minute

	// SweepTimeout bounds one run of a maintenance sweep. A sweep drains its
	// backlog step by step, so a cut run leaves the rest to the next period.
	SweepTimeout = 2 * time.Minute
)

// Options configures the TeamHub processing client.
type Options struct {
	// Workers must contain every job kind that the client should fetch.
	Workers *river.Workers
	// Queues adds the queues of optional features. A feature that registers no
	// workers adds none, so its queues are not polled.
	Queues map[string]river.QueueConfig
	// Periodic runs on the elected leader only. Nil leaves sweeps unscheduled.
	Periodic []*river.PeriodicJob
	// PersonalWikiConcurrency bounds the concurrent Personal Wiki dispatches and
	// Memory graph updates together. Zero uses 4.
	PersonalWikiConcurrency int
	// PollInterval is the fetch poll interval (config.JobsConfig). Every job
	// that becomes due is notified: River's own notification for a job inserted
	// due now, notify_river_queue for SQL inserts, and DueNotifier for a job
	// whose future due time arrives, so the poll only recovers a notification
	// lost while River's own LISTEN connection was down.
	PollInterval time.Duration
	// TestOnly passes River's TestOnly switch, which starts leader maintenance
	// without its staggered delay. Only tests may set it.
	TestOnly bool
	Logger   *slog.Logger
}

// NewClient builds the River client that works TeamHub jobs over pool. Call
// Start to process jobs and Stop to drain them.
func NewClient(pool *pgxpool.Pool, options Options) (*river.Client[pgx.Tx], error) {
	poll := options.PollInterval
	return river.NewClient(riverpgxv5.New(pool), &river.Config{
		Queues:       queueConfigs(options),
		Workers:      options.Workers,
		PeriodicJobs: options.Periodic,
		// Jobs of kinds this process does not register stay available for a
		// process that does, instead of failing here.
		FetchOnlyKnownKinds:  true,
		TestOnly:             options.TestOnly,
		FetchPollInterval:    poll,
		FetchCooldown:        min(poll, river.FetchCooldownDefault),
		JobTimeout:           jobTimeout,
		RescueStuckJobsAfter: RescueStuckJobsAfter,
		Logger:               options.Logger,
		ErrorHandler:         errorLogger{logger: options.Logger},
	})
}

// queueConfigs returns the queues of the client options build. It is the one
// source of the queue list, which DueNotifier also notifies.
func queueConfigs(options Options) map[string]river.QueueConfig {
	queues := map[string]river.QueueConfig{
		QueueDefault:       {MaxWorkers: 4},
		QueueMaintenance:   {MaxWorkers: 2},
		QueueIndexing:      {MaxWorkers: 2},
		QueuePersonalWiki:  {MaxWorkers: personalWikiConcurrency(options.PersonalWikiConcurrency)},
		QueueGeneration:    {MaxWorkers: 4},
		QueueSchedule:      {MaxWorkers: 2},
		QueueExternal:      {MaxWorkers: 4},
		QueueDocumentInput: {MaxWorkers: 2},
	}
	maps.Copy(queues, options.Queues)
	return queues
}

func personalWikiConcurrency(configured int) int {
	if configured > 0 {
		return configured
	}
	return 4
}

// UniqueUnfinished makes a job unique among its unfinished copies. Completed
// and retryable jobs do not block a new one, so a finished entity or occurrence
// can be enqueued again; each worker re-checks its entity under lock.
var UniqueUnfinished = river.UniqueOpts{ByArgs: true, ByState: UnfinishedStates}

// UniqueUnfinishedOrRetrying also counts a job waiting for its retry, for work
// that a sweep enqueues: River discards a due retry whose key another job
// holds, so without it a sweep would cut every backoff short.
var UniqueUnfinishedOrRetrying = river.UniqueOpts{
	ByArgs:  true,
	ByState: append(slices.Clone(UnfinishedStates), rivertype.JobStateRetryable),
}

var insertClient = struct {
	once   sync.Once
	client *river.Client[pgx.Tx]
	err    error
}{}

// inserter returns the insert-only client. It needs no pool because the
// caller's transaction is the executor; the processing client owns execution.
// River sends at most one insert notification per queue per FetchCooldown, so
// the minimum lets each insert notify: a job committed while the processing
// client cools down from a fetch then gets a trailing fetch instead of waiting
// for the poll.
func inserter() (*river.Client[pgx.Tx], error) {
	insertClient.once.Do(func() {
		insertClient.client, insertClient.err = river.NewClient(riverpgxv5.New(nil), &river.Config{FetchCooldown: river.FetchCooldownMin})
	})
	return insertClient.client, insertClient.err
}

// InsertTx enqueues a job in the caller's transaction, so a rolled back fact
// never leaves work behind.
func InsertTx(ctx context.Context, tx pgx.Tx, args river.JobArgs, opts *river.InsertOpts) error {
	client, err := inserter()
	if err != nil {
		return err
	}
	_, err = client.InsertTx(ctx, tx, args, opts)
	return err
}

// InsertOrWakeTx enqueues a unique job like InsertTx. When an equivalent job is
// already scheduled, retryable, or available only later, it is made available
// now: River leaves a job snoozed for less than its scheduler interval
// available with a future scheduled_at, which the fetch skips until then. The
// skipped insert still sends River's insert notification, so the woken job is
// fetched at commit. A running job is left alone. River records a job's
// completion asynchronously, so a worker that already read its state and
// returned still counts as running for a moment and the wake is lost; callers
// need a sweep that enqueues the work again.
func InsertOrWakeTx(ctx context.Context, tx pgx.Tx, args river.JobArgs, opts *river.InsertOpts) error {
	client, err := inserter()
	if err != nil {
		return err
	}
	// A retryable job must count as a duplicate, or it is never found to wake.
	var wakeOpts river.InsertOpts
	if opts != nil {
		wakeOpts = *opts
	} else if withOpts, ok := args.(river.JobArgsWithInsertOpts); ok {
		wakeOpts = withOpts.InsertOpts()
	}
	if len(wakeOpts.UniqueOpts.ByState) > 0 && !slices.Contains(wakeOpts.UniqueOpts.ByState, rivertype.JobStateRetryable) {
		wakeOpts.UniqueOpts.ByState = append(slices.Clone(wakeOpts.UniqueOpts.ByState), rivertype.JobStateRetryable)
	}
	opts = &wakeOpts
	result, err := client.InsertTx(ctx, tx, args, opts)
	if err != nil {
		return err
	}
	if !result.UniqueSkippedAsDuplicate {
		return nil
	}
	switch result.Job.State {
	case rivertype.JobStateScheduled, rivertype.JobStateRetryable, rivertype.JobStateAvailable:
		// River's retry leaves an available job that is already due alone.
		_, err = client.JobRetryTx(ctx, tx, result.Job.ID)
		return err
	}
	return nil
}

// errorLogger reports job failures through TeamHub's logger. River still
// applies its retry schedule, so the handler never cancels a job.
type errorLogger struct {
	logger *slog.Logger
}

func (h errorLogger) log() *slog.Logger {
	if h.logger != nil {
		return h.logger
	}
	return slog.Default()
}

func (h errorLogger) HandleError(ctx context.Context, job *rivertype.JobRow, err error) *river.ErrorHandlerResult {
	attrs := []any{"kind", job.Kind, "job_id", job.ID, "attempt", job.Attempt, "error", err}
	if retryableJobFailure(err) {
		h.log().WarnContext(ctx, "run TeamHub job", attrs...)
		return nil
	}
	h.log().ErrorContext(ctx, "run TeamHub job", attrs...)
	return nil
}

// retryableJobFailureMarker is implemented by worker errors that River will
// retry and that should be logged at WARN. Domain packages implement it on
// their error types; this package imports none of them.
type retryableJobFailureMarker interface {
	RetryableJobFailure() bool
}

func retryableJobFailure(err error) bool {
	var marker retryableJobFailureMarker
	if !errors.As(err, &marker) || !marker.RetryableJobFailure() {
		return false
	}
	joined, ok := err.(interface{ Unwrap() []error })
	if !ok {
		return true
	}
	for _, inner := range joined.Unwrap() {
		if inner == nil {
			continue
		}
		var innerMarker retryableJobFailureMarker
		if !errors.As(inner, &innerMarker) || !innerMarker.RetryableJobFailure() {
			return false
		}
	}
	return true
}

func (h errorLogger) HandlePanic(ctx context.Context, job *rivertype.JobRow, panicVal any, _ string) *river.ErrorHandlerResult {
	h.log().ErrorContext(ctx, "panic in TeamHub job", "kind", job.Kind, "job_id", job.ID, "attempt", job.Attempt, "panic", panicVal)
	return nil
}

// AddWorkerWhen registers worker so that each job returns without working
// while enabled reports false. A feature whose configuration can appear at run
// time keeps its workers registered and checks the configuration per job.
func AddWorkerWhen[T river.JobArgs](workers *river.Workers, enabled func() bool, worker river.Worker[T]) {
	river.AddWorker[T](workers, &enabledWorker[T]{Worker: worker, enabled: enabled})
}

type enabledWorker[T river.JobArgs] struct {
	river.Worker[T]
	enabled func() bool
}

func (w *enabledWorker[T]) Work(ctx context.Context, job *river.Job[T]) error {
	if !w.enabled() {
		return nil
	}
	return w.Worker.Work(ctx, job)
}
