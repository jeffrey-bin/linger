package personalprofile

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
)

// memory.md follows the Profile: publishing a Revision schedules one sync a
// minute later, so the Revisions an Agent writes in quick succession reach
// Memory once, as the last of them. A sync that keeps failing is dropped;
// memory.md then keeps the Profile it last took in until the next publication.
const (
	profileMemorySyncKind = "personal_profile.memory_sync"
	// ProfileMemorySyncDelay lets a burst of Revisions settle into one sync.
	ProfileMemorySyncDelay = time.Minute
	// profileMemorySyncMaxAttempts bounds retries of one sync.
	profileMemorySyncMaxAttempts = 5
	// profileMemorySyncTimeout outlasts the Memory client.
	profileMemorySyncTimeout = 6 * time.Minute
)

// ProfileMemorySyncArgs names the Human whose memory.md takes in the Profile.
type ProfileMemorySyncArgs struct {
	TenantID     string `json:"tenant_id"`
	OwnerActorID string `json:"owner_actor_id"`
}

// Kind names the River job.
func (ProfileMemorySyncArgs) Kind() string { return profileMemorySyncKind }

// InsertOpts keeps one sync per Human waiting. River counts a running sync as
// a duplicate too, so a Revision published while it runs is caught by the
// sync itself: it runs again when the current Revision moved meanwhile.
func (ProfileMemorySyncArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{
		Queue:       jobs.QueueDefault,
		MaxAttempts: profileMemorySyncMaxAttempts,
		UniqueOpts: river.UniqueOpts{ByArgs: true, ByState: []rivertype.JobState{
			rivertype.JobStateAvailable, rivertype.JobStatePending, rivertype.JobStateRetryable,
			rivertype.JobStateRunning, rivertype.JobStateScheduled,
		}},
	}
}

// enqueueProfileMemorySyncTx schedules the sync in the transaction that
// published the Revision.
func enqueueProfileMemorySyncTx(ctx context.Context, tx pgx.Tx, tenantID, ownerActorID string) error {
	return jobs.InsertTx(ctx, tx, ProfileMemorySyncArgs{TenantID: tenantID, OwnerActorID: ownerActorID},
		&river.InsertOpts{ScheduledAt: time.Now().Add(ProfileMemorySyncDelay)})
}

// ProfileMemorySyncer hands Memory a Human's newly published Profile.
type ProfileMemorySyncer interface {
	SyncProfileMemory(ctx context.Context, tenantID, ownerActorID string) error
}

// AddMemorySyncWorker registers the sync. Without Memory each sync is
// cancelled and memory.md keeps the Profile it last took in.
func AddMemorySyncWorker(workers *river.Workers, service *Service, syncer ProfileMemorySyncer) {
	river.AddWorker(workers, &profileMemorySyncWorker{currentRevision: service.currentRevisionID, syncer: syncer})
}

type profileMemorySyncWorker struct {
	river.WorkerDefaults[ProfileMemorySyncArgs]
	currentRevision func(ctx context.Context, tenantID, ownerActorID string) (string, error)
	syncer          ProfileMemorySyncer
}

func (w *profileMemorySyncWorker) Timeout(*river.Job[ProfileMemorySyncArgs]) time.Duration {
	return profileMemorySyncTimeout
}

func (w *profileMemorySyncWorker) Work(ctx context.Context, job *river.Job[ProfileMemorySyncArgs]) error {
	args := job.Args
	if w.syncer == nil {
		return river.JobCancel(errors.New("Memory is not configured for Profile sync"))
	}
	before, err := w.currentRevision(ctx, args.TenantID, args.OwnerActorID)
	if err != nil {
		return err
	}
	if err := w.syncer.SyncProfileMemory(ctx, args.TenantID, args.OwnerActorID); err != nil {
		return err
	}
	after, err := w.currentRevision(ctx, args.TenantID, args.OwnerActorID)
	if err != nil {
		return err
	}
	if after != before {
		return river.JobSnooze(ProfileMemorySyncDelay)
	}
	return nil
}

// currentRevisionID is the Human's current Revision, empty when there is none.
func (s *Service) currentRevisionID(ctx context.Context, tenantID, ownerActorID string) (string, error) {
	var revisionID string
	err := s.pool.QueryRow(ctx, `SELECT revision_id FROM personal_profile_currents WHERE tenant_id=$1 AND owner_actor_id=$2`, tenantID, ownerActorID).Scan(&revisionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return revisionID, err
}
