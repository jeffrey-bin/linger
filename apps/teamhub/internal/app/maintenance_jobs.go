package app

import (
	"context"
	"fmt"
	"time"

	"github.com/riverqueue/river"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
)

// The interval of every periodic job tests do not shorten (the others are in
// config.JobsConfig). A safety-net sweep runs at
// most once a minute: work that a commit creates is enqueued in that
// transaction, and work due at a time is scheduled for that time, so the sweep
// only catches what those paths miss.
const (
	// documentAssetCollectInterval bounds how long an unreferenced Document
	// asset object outlives its grace period.
	documentAssetCollectInterval = time.Minute
	// connectionReconcileSweepInterval enqueues External Connection status checks that are due.
	connectionReconcileSweepInterval = time.Minute
	// connectionAuthReconcileInterval is the safety net for Connection
	// authorization cards. Activation settles them and each card's own job
	// expires it, so only a lost settlement waits for this.
	connectionAuthReconcileInterval = time.Minute
	// listenerSweepInterval enqueues app listener polls that are due.
	listenerSweepInterval = time.Minute
	// mailSyncSweepInterval enqueues the nightly mail syncs once their time has
	// passed, and catches up after a TeamHub that was down then starts.
	mailSyncSweepInterval = 10 * time.Minute
	// scheduleRepairInterval re-enqueues schedule occurrences that a lost job
	// left overdue. Pending jobs dedupe, so most sweeps enqueue nothing.
	scheduleRepairInterval = 5 * time.Minute
	// proactiveListenerSweepInterval installs missing app listeners.
	proactiveListenerSweepInterval = 10 * time.Minute
	agentCredentialGCInterval      = time.Hour
	// retentionInterval deletes data past its retention period (internal/retention).
	retentionInterval = time.Hour
	// documentRetentionInterval starts a pass over every native Document that
	// deletes write evidence past the replay window and the Revisions History no
	// longer needs, then trims Wiki pages to their newest Versions. The window
	// is a day, so an hour adds little.
	documentRetentionInterval = time.Hour
)

// Maintenance sweeps are River periodic jobs. River schedules them on the
// elected leader and runs one job per period. MaxAttempts 1 makes the next
// period the retry. Uniqueness covers only unfinished states so a slow sweep
// does not queue a second run behind it; River's default would also count
// completed jobs (retained for 24 hours) and block every later period. A sweep
// that a stopped process left running holds the key until River's rescuer
// discards it, a few minutes later (see the jobs package).
var maintenanceInsertOpts = river.InsertOpts{
	Queue:       jobs.QueueMaintenance,
	MaxAttempts: 1,
	UniqueOpts:  jobs.UniqueUnfinished,
}

// River identifies a job kind by its args type, so each sweep has its own
// empty args type.
type (
	agentCredentialGCArgs        struct{}
	documentCommentInputArgs     struct{}
	documentAssetCollectArgs     struct{}
	documentRetentionArgs        struct{}
	scheduleRepairArgs           struct{}
	connectionAuthReconcileArgs  struct{}
	connectionReconcileSweepArgs struct{}
	mailSyncSweepArgs            struct{}
	retentionArgs                struct{}
)

func (agentCredentialGCArgs) Kind() string                 { return "maintenance.agent_credential_gc" }
func (agentCredentialGCArgs) InsertOpts() river.InsertOpts { return maintenanceInsertOpts }

func (documentCommentInputArgs) Kind() string { return "maintenance.document_comment_input" }
func (documentCommentInputArgs) InsertOpts() river.InsertOpts {
	// The sweep shares the event jobs' queue so other sweeps cannot delay it.
	opts := maintenanceInsertOpts
	opts.Queue = jobs.QueueDocumentInput
	return opts
}

func (documentAssetCollectArgs) Kind() string                 { return "maintenance.document_asset_collect" }
func (documentAssetCollectArgs) InsertOpts() river.InsertOpts { return maintenanceInsertOpts }
func (documentRetentionArgs) Kind() string                    { return "maintenance.document_retention" }
func (documentRetentionArgs) InsertOpts() river.InsertOpts    { return maintenanceInsertOpts }
func (scheduleRepairArgs) Kind() string                       { return "maintenance.schedule_repair" }
func (scheduleRepairArgs) InsertOpts() river.InsertOpts       { return maintenanceInsertOpts }

func (connectionReconcileSweepArgs) Kind() string {
	return "external.connection_reconcile_sweep"
}
func (connectionReconcileSweepArgs) InsertOpts() river.InsertOpts { return maintenanceInsertOpts }

func (mailSyncSweepArgs) Kind() string                 { return "external.mail_sync_sweep" }
func (mailSyncSweepArgs) InsertOpts() river.InsertOpts { return maintenanceInsertOpts }

func (retentionArgs) Kind() string                 { return "maintenance.retention" }
func (retentionArgs) InsertOpts() river.InsertOpts { return maintenanceInsertOpts }

func (connectionAuthReconcileArgs) Kind() string {
	return "typedcard.connection_auth_reconcile"
}
func (connectionAuthReconcileArgs) InsertOpts() river.InsertOpts { return maintenanceInsertOpts }

// sweepWorker runs one sweep. Its error reaches the shared job logger.
type sweepWorker[A river.JobArgs] struct {
	river.WorkerDefaults[A]
	sweep func(context.Context) error
}

func (w *sweepWorker[A]) Timeout(*river.Job[A]) time.Duration { return jobs.SweepTimeout }

func (w *sweepWorker[A]) Work(ctx context.Context, _ *river.Job[A]) error {
	return w.sweep(ctx)
}

func addSweepWorker[A river.JobArgs](workers *river.Workers, sweep func(context.Context) error) {
	river.AddWorker(workers, &sweepWorker[A]{sweep: sweep})
}

// sweepSchedule runs sweep A every interval. RunOnStart runs it once when a
// new leader starts, as the former ticker loops did at startup. River spins on a
// non-positive interval, so callers must resolve a positive one first.
func sweepSchedule[A river.JobArgs](interval time.Duration) *river.PeriodicJob {
	if interval <= 0 {
		panic(fmt.Sprintf("sweep %T scheduled with non-positive interval %s", *new(A), interval))
	}
	return river.NewPeriodicJob(river.PeriodicInterval(interval), func() (river.JobArgs, *river.InsertOpts) {
		var args A
		return args, nil
	}, &river.PeriodicJobOpts{RunOnStart: true})
}

// roomDocumentSweepJobs registers the Room Document sweeps and returns their
// schedules. Comment input needs a Document Runtime, so it is scheduled only
// when one is configured. Events enqueue comment input themselves;
// commentSweep only controls the safety-net schedule.
func (a *App) roomDocumentSweepJobs(workers *river.Workers, retention *document.RetentionCollector, runtimeConfigured, commentSweep bool) []*river.PeriodicJob {
	assets := document.NewAssetCollector(a.documents, document.AssetCollectorOptions{
		UploadStagingRetention: a.cfg.RoomDocument.AssetUploadStagingRetention,
		AssetGCGrace:           a.cfg.RoomDocument.AssetGCGrace,
	})
	addSweepWorker[documentAssetCollectArgs](workers, func(ctx context.Context) error {
		return drainSweep(ctx, assets.RunOne)
	})
	wikiVersions := document.NewWikiVersionPruner(a.documents)
	addSweepWorker[documentRetentionArgs](workers, func(ctx context.Context) error {
		if err := drainSweep(ctx, retention.RunOnce); err != nil {
			return err
		}
		return drainSweep(ctx, wikiVersions.RunOnce)
	})
	periodic := []*river.PeriodicJob{
		sweepSchedule[documentAssetCollectArgs](documentAssetCollectInterval),
		sweepSchedule[documentRetentionArgs](documentRetentionInterval),
	}
	if runtimeConfigured {
		comments := document.NewCommentRunWorker(a.documents)
		addSweepWorker[documentCommentInputArgs](workers, func(ctx context.Context) error {
			return drainSweep(ctx, comments.RunOne)
		})
		if commentSweep {
			periodic = append(periodic, sweepSchedule[documentCommentInputArgs](a.cfg.Jobs.DocumentCommentSweepInterval))
		}
	}
	return periodic
}

// drainSweep runs step until it reports no more work, so one period clears a
// backlog. A failed step ends the run; the next period retries the rest.
func drainSweep(ctx context.Context, step func(context.Context) (bool, error)) error {
	for ctx.Err() == nil {
		worked, err := step(ctx)
		if err != nil || !worked {
			return err
		}
	}
	return nil
}

// maintenanceJobs registers the sweep workers and returns their schedules.
// Lifecycle sweeps are scheduled only when lifecycle workers run.
func (a *App) maintenanceJobs(workers *river.Workers, lifecycleWorkers bool) []*river.PeriodicJob {
	addSweepWorker[agentCredentialGCArgs](workers, func(ctx context.Context) error {
		_, err := a.agentCredentials.DeleteExpired(ctx)
		return err
	})
	addSweepWorker[scheduleRepairArgs](workers, func(ctx context.Context) error {
		return a.reminders.EnqueueOverdueOccurrences(ctx)
	})
	addSweepWorker[retentionArgs](workers, func(ctx context.Context) error { return a.retention.Sweep(ctx) })

	var periodic []*river.PeriodicJob
	if lifecycleWorkers {
		periodic = append(periodic, sweepSchedule[agentCredentialGCArgs](agentCredentialGCInterval))
	}
	return append(periodic,
		sweepSchedule[scheduleRepairArgs](scheduleRepairInterval),
		sweepSchedule[retentionArgs](retentionInterval),
	)
}

// connectedAppSweeps registers the connected app sweeps and returns their
// schedules. They are always scheduled because a Composio API key can be saved
// after start; until then the reconcile sweep enqueues nothing.
func (a *App) connectedAppSweeps(workers *river.Workers) []*river.PeriodicJob {
	addSweepWorker[connectionReconcileSweepArgs](workers, func(ctx context.Context) error {
		if !a.connectedAppsConfigured() {
			return nil
		}
		return a.externalSources.EnqueueDueConnectionReconciles(ctx)
	})
	addSweepWorker[connectionAuthReconcileArgs](workers, func(ctx context.Context) error {
		return a.typedCards.ReconcileConnectionAuthorizations(ctx)
	})
	addSweepWorker[mailSyncSweepArgs](workers, func(ctx context.Context) error {
		if !a.connectedAppsConfigured() {
			return nil
		}
		return a.externalSources.EnqueueMailSyncs(ctx, time.Now())
	})
	return []*river.PeriodicJob{
		sweepSchedule[connectionAuthReconcileArgs](connectionAuthReconcileInterval),
		sweepSchedule[connectionReconcileSweepArgs](connectionReconcileSweepInterval),
		sweepSchedule[mailSyncSweepArgs](mailSyncSweepInterval),
	}
}
