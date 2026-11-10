package reminder

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// Each Reminder occurrence is one River job on the schedule queue, named by its
// due time. The job locks the Reminder at that occurrence before acting, so an
// edited, paused, deleted, or already advanced Reminder makes it a no-op.
const (
	fireKind = "reminder.fire"

	// fireMaxAttempts bounds delivery retries for one occurrence. On the last
	// attempt the occurrence is skipped so later occurrences still run.
	fireMaxAttempts = 10
)

// FireArgs names one scheduled occurrence of a Reminder.
type FireArgs struct {
	ReminderID string    `json:"reminder_id"`
	DueAt      time.Time `json:"due_at"`
}

func (FireArgs) Kind() string { return fireKind }

// InsertOpts counts a retrying occurrence as a duplicate, so the repair sweep
// cannot enqueue a second job that would make River discard the retry and
// restart its attempts.
func (FireArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{
		Queue:       jobs.QueueSchedule,
		MaxAttempts: fireMaxAttempts,
		UniqueOpts:  jobs.UniqueUnfinishedOrRetrying,
	}
}

// enqueueFireTx schedules an occurrence in the transaction that set next_run_at.
// An occurrence already due is available at once instead of waiting for River's
// promoter to move it out of the scheduled state.
func enqueueFireTx(ctx context.Context, tx pgx.Tx, reminderID string, dueAt time.Time) error {
	// next_run_at is stored at microsecond precision; keep the job args equal to it.
	dueAt = dueAt.Truncate(time.Microsecond)
	var opts river.InsertOpts
	if dueAt.After(time.Now()) {
		opts.ScheduledAt = dueAt.UTC()
	}
	return jobs.InsertTx(ctx, tx, FireArgs{ReminderID: reminderID, DueAt: dueAt.UTC()}, &opts)
}

// AddJobWorkers registers the occurrence worker. onFired, when set, receives
// each delivered occurrence after commit. A scheduled wake for the AnotherMe of
// a Human's direct Room joins the quiet-wake queue instead of going out at once.
func AddJobWorkers(workers *river.Workers, service *Service, onFired func(ScheduleResult), logger *slog.Logger) {
	river.AddWorker(workers, &fireWorker{service: service, onFired: onFired, logger: logger})
}

type fireWorker struct {
	river.WorkerDefaults[FireArgs]
	service *Service
	onFired func(ScheduleResult)
	logger  *slog.Logger
}

func (w *fireWorker) Work(ctx context.Context, job *river.Job[FireArgs]) error {
	args := job.Args
	result, fired, err := w.service.fireOccurrence(ctx, args.ReminderID, args.DueAt)
	if err != nil {
		if job.Attempt < fireMaxAttempts {
			return err
		}
		skipped, skipErr := w.service.skipOccurrence(ctx, args.ReminderID, args.DueAt)
		if skipErr != nil {
			return skipErr
		}
		if skipped {
			w.logger.ErrorContext(ctx, "skip Reminder occurrence after last delivery attempt",
				"reminder_id", args.ReminderID, "due_at", args.DueAt, "error", err)
		}
		return nil
	}
	if fired && w.onFired != nil {
		w.onFired(result)
	}
	return nil
}

// EnqueueOverdueOccurrences restores jobs for enabled Reminders whose occurrence
// is past due with no job waiting. Pending and retrying jobs dedupe, so repeated
// sweeps are harmless.
func (s *Service) EnqueueOverdueOccurrences(ctx context.Context) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := store.New(tx).ListOverdueRoomReminderOccurrences(ctx)
	if err != nil {
		return err
	}
	for _, row := range rows {
		if err := enqueueFireTx(ctx, tx, row.ID, row.NextRunAt.Time); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
