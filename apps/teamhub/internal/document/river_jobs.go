package document

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
)

// Document background jobs run on TeamHub's River client. A job is inserted in
// the same transaction as the fact that requires it, so a rolled back fact
// never leaves work behind.
const (
	latestProjectionObjectCleanupKind = "document.latest_projection_object_cleanup"
	personalWikiGraphUpdateKind       = "document.personal_wiki_graph_update"
	wikiRefreshFollowupKind           = "document.wiki_refresh_followup"

	// riverPendingJobStatesSQL lists the River states that still owe work.
	// Completed, cancelled, and discarded jobs are finished.
	riverPendingJobStatesSQL = `('available','pending','retryable','running','scheduled')`

	// wikiRefreshFollowupPendingSQL holds while the refresh row aliased refresh
	// has a follow-up that still owes work, so its Wiki is still refreshing.
	wikiRefreshFollowupPendingSQL = `EXISTS(SELECT 1 FROM river_job job
		WHERE job.kind='` + wikiRefreshFollowupKind + `' AND job.args->>'refresh_id'=refresh.id
		  AND job.state IN ` + riverPendingJobStatesSQL + `)`

	// latestProjectionObjectCleanupGrace keeps a replaced or abandoned object
	// readable for in-flight readers before it is deleted.
	latestProjectionObjectCleanupGrace = 5 * time.Minute
	// latestProjectionObjectBusyDelay retries a cleanup while an upload holds
	// the object lock.
	latestProjectionObjectBusyDelay = 5 * time.Second

	// personalWikiGraphUpdateMaxAttempts bounds retries of one Memory graph
	// update; River discards the job after the last attempt.
	personalWikiGraphUpdateMaxAttempts = 20
	// personalWikiGraphUpdateTimeout outlasts the Memory client, which waits up
	// to 15 minutes for Memory to update the graph and index Raw.
	personalWikiGraphUpdateTimeout = 16 * time.Minute

	// wikiRefreshFollowupMaxAttempts bounds retries of one follow-up; River
	// discards it after the last attempt.
	wikiRefreshFollowupMaxAttempts = 20
)

// LatestProjectionObjectCleanupArgs asks for a latest projection object to be
// deleted once no projection references it and its grace period has passed.
type LatestProjectionObjectCleanupArgs struct {
	ObjectKey string `json:"object_key"`
}

func (LatestProjectionObjectCleanupArgs) Kind() string { return latestProjectionObjectCleanupKind }

// InsertOpts puts the cleanup, one short transaction and an object delete, on
// the default queue.
func (LatestProjectionObjectCleanupArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: jobs.QueueDefault}
}

// PersonalWikiGraphUpdateArgs carries one published Personal Wiki revision to
// the Memory index.
type PersonalWikiGraphUpdateArgs struct {
	TenantID       string `json:"tenant_id"`
	WikiID         string `json:"wiki_id"`
	OwnerActorID   string `json:"owner_actor_id"`
	WikiRevisionID string `json:"wiki_revision_id"`
}

func (PersonalWikiGraphUpdateArgs) Kind() string { return personalWikiGraphUpdateKind }

// InsertOpts puts the update on the Personal Wiki queue: it can wait 15 minutes
// for Memory, which would hold the default queue's slots from short jobs.
func (PersonalWikiGraphUpdateArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{
		Queue:       jobs.QueuePersonalWiki,
		MaxAttempts: personalWikiGraphUpdateMaxAttempts,
		UniqueOpts:  river.UniqueOpts{ByArgs: true},
	}
}

// WikiRefreshFollowupArgs asks for the next Personal Wiki refresh to follow a
// finished refresh. The transaction that finishes the refresh enqueues it, at
// most once per refresh; the worker reads the current state instead of
// trusting the args.
type WikiRefreshFollowupArgs struct {
	RefreshID string `json:"refresh_id"`
}

func (WikiRefreshFollowupArgs) Kind() string { return wikiRefreshFollowupKind }

func (WikiRefreshFollowupArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{
		Queue:       jobs.QueueDefault,
		MaxAttempts: wikiRefreshFollowupMaxAttempts,
		UniqueOpts:  river.UniqueOpts{ByArgs: true},
	}
}

// AddJobWorkers registers the Document job workers. TeamHub's jobs package
// owns the client that runs them.
func AddJobWorkers(workers *river.Workers, service *Service, updater PublishedWikiGraphUpdater) {
	river.AddWorker(workers, &latestProjectionObjectCleanupWorker{service: service})
	river.AddWorker(workers, &personalWikiGraphUpdateWorker{updater: updater})
	river.AddWorker(workers, &wikiRefreshFollowupWorker{service: service})
	river.AddWorker(workers, &mailWikiInitWorker{service: service})
}

// AddRoomDocumentJobWorkers registers the Room Document Runtime workers. Native
// import jobs need a Document Runtime, so without one they are not registered;
// their rows wait in River until a process with a Runtime runs them.
func AddRoomDocumentJobWorkers(workers *river.Workers, service *Service) {
	if service.runtime == nil {
		return
	}
	river.AddWorker(workers, NewNativeImportMigrationWorker(service))
	river.AddWorker(workers, &commentInputWorker{comments: NewCommentRunWorker(service)})
}

// commentInputWorker settles one comment Run after its mention or thread change.
type commentInputWorker struct {
	river.WorkerDefaults[CommentInputArgs]
	comments *CommentRunWorker
}

func (w *commentInputWorker) Work(ctx context.Context, job *river.Job[CommentInputArgs]) error {
	return w.comments.workRun(ctx, job.Args.RunID)
}

func (s *Service) enqueueLatestProjectionObjectCleanupTx(ctx context.Context, tx pgx.Tx, objectKey string) error {
	return jobs.InsertTx(ctx, tx, LatestProjectionObjectCleanupArgs{ObjectKey: objectKey},
		&river.InsertOpts{ScheduledAt: time.Now().Add(latestProjectionObjectCleanupGrace)})
}

type latestProjectionObjectCleanupWorker struct {
	river.WorkerDefaults[LatestProjectionObjectCleanupArgs]
	service *Service
}

func (w *latestProjectionObjectCleanupWorker) Work(ctx context.Context, job *river.Job[LatestProjectionObjectCleanupArgs]) error {
	return w.service.cleanupLatestProjectionObject(ctx, job.Args.ObjectKey)
}

type personalWikiGraphUpdateWorker struct {
	river.WorkerDefaults[PersonalWikiGraphUpdateArgs]
	updater PublishedWikiGraphUpdater
}

func (w *personalWikiGraphUpdateWorker) Timeout(*river.Job[PersonalWikiGraphUpdateArgs]) time.Duration {
	return personalWikiGraphUpdateTimeout
}

func (w *personalWikiGraphUpdateWorker) Work(ctx context.Context, job *river.Job[PersonalWikiGraphUpdateArgs]) error {
	args := job.Args
	if w.updater == nil {
		// Without Memory the update can never run; discard it rather than
		// retain it, matching a publication that has no index consumer.
		return river.JobCancel(errors.New("Personal Wiki index updater is not configured"))
	}
	return w.updater.UpdatePublishedWiki(ctx, args.TenantID, args.OwnerActorID, args.WikiRevisionID)
}
