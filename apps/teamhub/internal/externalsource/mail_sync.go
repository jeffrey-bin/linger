package externalsource

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// MailSyncArgs reads into the Wiki the mail a Connection received since its
// snapshot or its last sync: the nightly fetchSince. Admitted messages become
// Wiki sources and filtered ones are recorded, as in the snapshot; the
// Profile keeps reading the snapshot.
type MailSyncArgs struct {
	ConnectionID string `json:"connection_id"`
	Revision     int64  `json:"revision"`
	// Due names the night, so a Connection syncs at most once per night: a
	// run River retried to its limit waits for the next one.
	Due time.Time `json:"due"`
}

// Kind names the nightly mail sync job.
func (MailSyncArgs) Kind() string { return "external.mail_sync" }

// InsertOpts keeps one sync per Connection, revision and night, whatever
// state an earlier one for them ended in.
func (MailSyncArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: jobs.QueueExternal, MaxAttempts: 5, UniqueOpts: river.UniqueOpts{
		ByArgs: true,
		ByState: append(slices.Clone(jobs.UnfinishedStates),
			rivertype.JobStateRetryable, rivertype.JobStateCompleted, rivertype.JobStateDiscarded),
	}}
}

// mailSyncOverlap rereads the end of the previous window, so mail the
// provider indexed late is not missed; a message read again changes nothing.
const mailSyncOverlap = time.Hour

// The nightly sync runs at 23:30 process-local time, half an hour before the
// nightly Memory run starts at midnight, so the day's mail is text by then.
const mailSyncHour, mailSyncMinute = 23, 30

// mailSyncDue is the latest nightly sync time at or before now. A Connection
// whose position is earlier is due.
func mailSyncDue(now time.Time) time.Time {
	local := now.In(time.Local)
	due := time.Date(local.Year(), local.Month(), local.Day(), mailSyncHour, mailSyncMinute, 0, 0, time.Local)
	if due.After(local) {
		due = due.AddDate(0, 0, -1)
	}
	return due
}

type mailSyncWorker struct {
	river.WorkerDefaults[MailSyncArgs]
	service *Service
}

func (w *mailSyncWorker) Timeout(*river.Job[MailSyncArgs]) time.Duration { return 10 * time.Minute }

func (w *mailSyncWorker) Work(ctx context.Context, job *river.Job[MailSyncArgs]) error {
	return w.service.syncMail(ctx, job.Args)
}

// EnqueueMailSyncs queues the sync of every mail Connection whose snapshot
// completed at its current revision and that has not synced since the last
// nightly sync time.
func (s *Service) EnqueueMailSyncs(ctx context.Context, now time.Time) error {
	due := mailSyncDue(now)
	connections, err := store.New(s.pool).ListMailSyncConnections(ctx, pgtype.Timestamptz{Time: due, Valid: true})
	if err != nil || len(connections) == 0 {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for _, connection := range connections {
		if err = jobs.InsertTx(ctx, tx, MailSyncArgs{ConnectionID: connection.ID, Revision: connection.Revision, Due: due}, nil); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// syncMail reads, within one run, every page of the mail received since the
// Connection's sync position, and then moves the position to where it read
// to. A run that fails leaves the position, so River's retry or the next
// night reads the window again. A Connection that changed meanwhile, or whose
// owner left the Tenant, is left alone.
func (s *Service) syncMail(ctx context.Context, args MailSyncArgs) error {
	queries := store.New(s.pool)
	state, err := queries.GetMailSync(ctx, store.GetMailSyncParams{ID: args.ConnectionID, Revision: args.Revision})
	if errors.Is(err, pgx.ErrNoRows) || err == nil && s.provider == nil {
		return nil
	}
	if err != nil {
		return err
	}
	job := &importRun{
		ConnectionID: args.ConnectionID, ConnectionRevision: args.Revision, AccountID: state.AccountID,
		TenantID: state.TenantID, Provider: state.Provider, UpstreamConnectionID: state.UpstreamConnectionID,
		ProviderCallBudget: mailImportBudget, CreatedAt: time.Now().UTC(),
	}
	if job.OwnerActorID, err = s.ownerActorID(ctx, state.AccountID, state.TenantID); errors.Is(err, ErrNotFound) {
		return nil
	} else if err != nil {
		return err
	}
	since, end := state.SyncedUntil.Time, time.Now().UTC().Truncate(time.Second)
	if !since.Before(end) {
		return nil
	}
	options := composio.MailImportPageOptions{Start: since.Add(-mailSyncOverlap), End: end}
	read := 0
	for read < composio.MailImportMaxMessages {
		options.Limit = min(100, composio.MailImportMaxMessages-read)
		page, err := appProviderCall(ctx, s, job, s.provider, func(callCtx context.Context) (composio.MailImportPage, error) {
			return s.provider.FetchMailImportPage(callCtx, job.UpstreamConnectionID, job.Provider, options)
		})
		if err != nil {
			return s.mailSyncFailure(ctx, job, err)
		}
		if page.Read < 0 || page.Read > options.Limit || page.NextCursor != "" && (page.NextCursor == options.Cursor || page.Read == 0) {
			return fmt.Errorf("mail sync of Connection %s read an invalid provider page", job.ConnectionID)
		}
		if err = s.publishMailPage(ctx, job, page.Documents); err != nil {
			return err
		}
		read += page.Read
		if page.NextCursor == "" {
			break
		}
		options.Cursor = page.NextCursor
	}
	if read >= composio.MailImportMaxMessages {
		s.logger.Warn("mail sync reached its message limit; older mail of the window is left out",
			"connection_id", job.ConnectionID, "provider", job.Provider, "read", read)
	}
	_, err = queries.AdvanceMailSync(ctx, store.AdvanceMailSyncParams{
		ID: args.ConnectionID, Revision: args.Revision,
		SyncedUntil: pgtype.Timestamptz{Time: end, Valid: true}, Previous: state.SyncedUntil,
	})
	return err
}

// mailSyncFailure lets River retry a transient provider failure. Any other
// failure ends the run without moving the position; the next night reads the
// window again.
func (s *Service) mailSyncFailure(ctx context.Context, job *importRun, err error) error {
	if errors.Is(err, ErrStaleRevision) {
		return nil
	}
	var limited *composio.RateLimitError
	if ctx.Err() != nil || errors.As(err, &limited) || mailImportTransient(err) {
		return fmt.Errorf("mail sync provider failure: %w", err)
	}
	s.logger.Warn("mail sync stopped", "connection_id", job.ConnectionID, "provider", job.Provider, "error", err)
	return nil
}
