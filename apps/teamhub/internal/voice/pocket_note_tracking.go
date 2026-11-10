package voice

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// Tracking Items follow today's Pocket Note during the day: a change of the
// page schedules one refresh a while later, which hands Memory the page as it
// is then, additions and deletions alike. The midnight Daily still reads the
// closed day.
const (
	pocketNoteTrackingKind = "voice.pocket_note_tracking"
	// PocketNoteTrackingDelay lets a burst of edits settle into one refresh.
	PocketNoteTrackingDelay = 5 * time.Minute
	// pocketNoteTrackingMaxAttempts bounds retries of one refresh; River
	// discards it after the last attempt and the midnight Daily catches up.
	pocketNoteTrackingMaxAttempts = 5
	// pocketNoteTrackingTimeout outlasts the Memory client.
	pocketNoteTrackingTimeout = 6 * time.Minute
)

// PocketNoteTrackingArgs names the Human's Pocket Note day to follow.
type PocketNoteTrackingArgs struct {
	TenantID     string `json:"tenant_id"`
	OwnerActorID string `json:"owner_actor_id"`
	Date         string `json:"date"`
}

// Kind names the River job.
func (PocketNoteTrackingArgs) Kind() string { return pocketNoteTrackingKind }

// InsertOpts keeps one refresh per Human and day waiting. River counts a
// running refresh as a duplicate too, so a change made while it runs is
// caught by the refresh itself: it runs again when the page moved meanwhile.
func (PocketNoteTrackingArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{
		Queue:       jobs.QueueDefault,
		MaxAttempts: pocketNoteTrackingMaxAttempts,
		UniqueOpts: river.UniqueOpts{ByArgs: true, ByState: []rivertype.JobState{
			rivertype.JobStateAvailable, rivertype.JobStatePending, rivertype.JobStateRetryable,
			rivertype.JobStateRunning, rivertype.JobStateScheduled,
		}},
	}
}

// enqueuePocketNoteTrackingTx schedules the refresh in the transaction that
// changed today's page.
func enqueuePocketNoteTrackingTx(ctx context.Context, tx pgx.Tx, tenantID, ownerID string, day pgtype.Date) error {
	return jobs.InsertTx(ctx, tx, PocketNoteTrackingArgs{
		TenantID: tenantID, OwnerActorID: ownerID, Date: day.Time.Format(PocketNoteDateLayout),
	}, &river.InsertOpts{ScheduledAt: time.Now().Add(PocketNoteTrackingDelay)})
}

// PocketNoteTrackingRefresher hands Memory a changed Pocket Note day.
type PocketNoteTrackingRefresher interface {
	RefreshPocketNoteTracking(ctx context.Context, tenantID, ownerActorID, date string) error
}

// AddPocketNoteTrackingWorker registers the refresh. Without Memory each
// refresh is cancelled; the page still reaches Tracking Items at midnight.
func AddPocketNoteTrackingWorker(workers *river.Workers, queries *store.Queries, refresher PocketNoteTrackingRefresher) {
	river.AddWorker(workers, &pocketNoteTrackingWorker{
		refresher: refresher,
		changedAt: func(ctx context.Context, args PocketNoteTrackingArgs) (time.Time, error) {
			day, err := time.Parse(PocketNoteDateLayout, args.Date)
			if err != nil {
				return time.Time{}, err
			}
			updatedAt, err := queries.GetPocketNoteUpdatedAt(ctx, store.GetPocketNoteUpdatedAtParams{
				TenantID: args.TenantID, OwnerActorID: args.OwnerActorID, NoteDate: pgtype.Date{Time: day, Valid: true},
			})
			if errors.Is(err, pgx.ErrNoRows) {
				return time.Time{}, nil
			}
			return updatedAt.Time, err
		},
		now: time.Now,
	})
}

type pocketNoteTrackingWorker struct {
	river.WorkerDefaults[PocketNoteTrackingArgs]
	refresher PocketNoteTrackingRefresher
	// changedAt is when the page last changed; zero when it has no row.
	changedAt func(context.Context, PocketNoteTrackingArgs) (time.Time, error)
	now       func() time.Time
}

func (w *pocketNoteTrackingWorker) Timeout(*river.Job[PocketNoteTrackingArgs]) time.Duration {
	return pocketNoteTrackingTimeout
}

func (w *pocketNoteTrackingWorker) Work(ctx context.Context, job *river.Job[PocketNoteTrackingArgs]) error {
	args := job.Args
	if w.refresher == nil {
		return river.JobCancel(errors.New("Memory is not configured for Pocket Note tracking"))
	}
	// A closed day belongs to its midnight Daily, which reads the whole day.
	if args.Date != PocketNoteDay(w.now()).Format(PocketNoteDateLayout) {
		return nil
	}
	before, err := w.changedAt(ctx, args)
	if err != nil {
		return err
	}
	if err := w.refresher.RefreshPocketNoteTracking(ctx, args.TenantID, args.OwnerActorID, args.Date); err != nil {
		return err
	}
	after, err := w.changedAt(ctx, args)
	if err != nil {
		return err
	}
	if !after.Equal(before) {
		return river.JobSnooze(PocketNoteTrackingDelay)
	}
	return nil
}
