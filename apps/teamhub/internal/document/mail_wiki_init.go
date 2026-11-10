package document

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
)

const (
	mailWikiInitKind = "document.mail_wiki_init"
	// mailWikiInitDelay lets the texts of the snapshot's last mail page become
	// ready before the refresh freezes them.
	mailWikiInitDelay = time.Minute
)

// MailWikiInitArgs asks for the Human's Wiki refresh over a mailbox snapshot
// that just completed, so a newly connected mailbox does not wait for the
// nightly refresh. It is inserted in the transaction that settles the last
// mail page.
type MailWikiInitArgs struct {
	TenantID     string `json:"tenant_id"`
	OwnerActorID string `json:"owner_actor_id"`
	ConnectionID string `json:"connection_id"`
	Revision     int64  `json:"revision"`
}

// Kind names the River job.
func (MailWikiInitArgs) Kind() string { return mailWikiInitKind }

// InsertOpts bounds the retries and queues one job per snapshot.
func (MailWikiInitArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{MaxAttempts: wikiRefreshFollowupMaxAttempts, UniqueOpts: river.UniqueOpts{ByArgs: true}}
}

// QueueMailWikiInit queues the refresh over a completed mailbox snapshot.
func QueueMailWikiInit(ctx context.Context, tx pgx.Tx, args MailWikiInitArgs) error {
	return jobs.InsertTx(ctx, tx, args, &river.InsertOpts{ScheduledAt: time.Now().Add(mailWikiInitDelay)})
}

type mailWikiInitWorker struct {
	river.WorkerDefaults[MailWikiInitArgs]
	service *Service
}

// Work requests the nightly kind of refresh, over every changed source; one
// that does not fit a request follows itself until the snapshot is in.
func (w *mailWikiInitWorker) Work(ctx context.Context, job *river.Job[MailWikiInitArgs]) error {
	_, err := w.service.requestWikiRefreshForOwner(ctx, job.Args.TenantID, job.Args.OwnerActorID,
		stableCreateID("mail-wiki-init-", job.Args.ConnectionID, strconv.FormatInt(job.Args.Revision, 10)), "")
	if errors.Is(err, ErrNotFound) || errors.Is(err, ErrInvalidInput) {
		return nil
	}
	return err
}
