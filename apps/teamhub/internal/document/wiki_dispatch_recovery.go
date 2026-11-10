package document

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
)

// wikiRefreshFollowupWorker requests the next Personal Wiki refresh once a
// frozen refresh has finished: the nightly refresh a request asked for while
// it ran, the next batch of a nightly refresh, or a conflicted refresh again.
// River owns the retry schedule and crash recovery.
type wikiRefreshFollowupWorker struct {
	river.WorkerDefaults[WikiRefreshFollowupArgs]
	service *Service
}

func (w *wikiRefreshFollowupWorker) Work(ctx context.Context, job *river.Job[WikiRefreshFollowupArgs]) error {
	return w.service.runWikiRefreshFollowup(ctx, job.Args.RefreshID)
}

func (s *Service) runWikiRefreshFollowup(ctx context.Context, refreshID string) error {
	var tenantID, ownerID, wikiID, status, captureID string
	var followupRequested bool
	err := s.pool.QueryRow(ctx, `SELECT refresh.tenant_id,wiki.owner_actor_id,wiki.id,refresh.status,
		coalesce(refresh.capture_id,''),refresh.followup_requested
		FROM document_wiki_refreshes refresh
		JOIN personal_wikis wiki ON wiki.id=refresh.wiki_id
		WHERE refresh.id=$1`, refreshID).Scan(&tenantID, &ownerID, &wikiID, &status, &captureID, &followupRequested)
	if errors.Is(err, pgx.ErrNoRows) {
		// The refresh was removed with its Wiki, so there is nothing to follow up.
		return nil
	}
	if err != nil {
		return err
	}
	// The followed refresh is finished. If another one is running, admission
	// marks it and its own finish enqueues the next follow-up.
	if status == "failed" {
		// Retry a failed generation only when a newer source snapshot arrived. A
		// permanent provider/input error must not create an endless generation loop.
		var changed bool
		if err := s.pool.QueryRow(ctx, `WITH current_sources AS (
   SELECT source_id,version_id FROM wiki_current_sources WHERE wiki_id=$1
  ), frozen AS (
   SELECT document_id,frozen_document_version_id AS version_id FROM document_wiki_refresh_sources WHERE refresh_id=$2
  ) SELECT EXISTS(SELECT * FROM current_sources EXCEPT SELECT * FROM frozen)
   OR EXISTS(SELECT * FROM frozen EXCEPT SELECT * FROM current_sources)`, wikiID, refreshID).Scan(&changed); err != nil {
			return err
		}
		if !changed {
			return nil
		}
	}
	// A nightly request that arrived while the refresh ran covers every
	// changed source, the followed meeting included. Otherwise a conflicted
	// meeting refresh admits the same meeting again.
	if followupRequested {
		captureID = ""
	}
	_, err = s.requestWikiRefreshForOwner(ctx, tenantID, ownerID,
		stableCreateID("wiki-followup-", refreshID), captureID)
	if errors.Is(err, ErrNotFound) || errors.Is(err, ErrInvalidInput) {
		return nil
	}
	return err
}

// WikiRefreshDispatchArgs runs one attempt of a staging refresh: generation,
// freezing, and settlement. The job is enqueued in the transaction that moves
// the refresh to staging.
type WikiRefreshDispatchArgs struct {
	RefreshID string `json:"refresh_id"`
}

// wikiRefreshDispatchRiverAttempts leaves spare attempts beyond the worker's own
// limit, so a rescued job still reaches a worker that fails the refresh.
const wikiRefreshDispatchRiverAttempts = 10

// wikiRefreshDispatchTimeoutMargin is added to the generation timeout so the
// job timeout covers the whole attempt, including settlement.
const wikiRefreshDispatchTimeoutMargin = 5 * time.Minute

// Uniqueness covers only unfinished states, so one refresh has at most one
// pending dispatch while a finished job never blocks a later enqueue.
var wikiRefreshDispatchInsertOpts = river.InsertOpts{
	Queue:       jobs.QueuePersonalWiki,
	MaxAttempts: wikiRefreshDispatchRiverAttempts,
	UniqueOpts:  jobs.UniqueUnfinished,
}

func (WikiRefreshDispatchArgs) Kind() string                 { return "document.wiki_refresh_dispatch" }
func (WikiRefreshDispatchArgs) InsertOpts() river.InsertOpts { return wikiRefreshDispatchInsertOpts }

type wikiRefreshDispatchWorker struct {
	river.WorkerDefaults[WikiRefreshDispatchArgs]
	dispatcher *WikiRefreshDispatcher
}

func (w *wikiRefreshDispatchWorker) Work(ctx context.Context, job *river.Job[WikiRefreshDispatchArgs]) error {
	return w.dispatcher.WorkRefresh(ctx, job.Args.RefreshID, job.Attempt)
}

// Timeout is the generation timeout plus a margin. The River client's rescue
// horizon is minutes, but River's rescuer ignores a job until its own Timeout
// has elapsed since attempted_at (river v0.49 internal/maintenance/job_rescuer.go
// makeRetryDecision), so a long generation is not rescued while it is still
// within its timeout.
func (w *wikiRefreshDispatchWorker) Timeout(*river.Job[WikiRefreshDispatchArgs]) time.Duration {
	return w.dispatcher.options.GenerationTimeout + wikiRefreshDispatchTimeoutMargin
}

// ResumeInterruptedWikiDispatch makes the dispatch attempts that were running
// when the previous TeamHub process stopped available again. TeamHub calls it
// before its River client starts: River rescues a running job only after the
// job's whole Timeout, which covers a generation of up to hours. A deploy or a
// local reload starts the new process while the old one is still stopping, so
// an attempt reset here may still be running there; WorkRefresh's lock makes
// the resumed attempt wait for it. Only dispatch is reset: other
// kinds on the queue, such as the Memory graph update, are left to River's
// rescuer.
//
// The interrupted attempt is given back: a restart is not a failure of the
// refresh, so it does not spend one of its attempts. WorkRefresh still fails
// a refresh older than jobs.ComputerOfflineWaitLimit, which bounds restarts.
func ResumeInterruptedWikiDispatch(ctx context.Context, pool *pgxpool.Pool) error {
	_, err := pool.Exec(ctx, `UPDATE river_job SET state='available',attempt=GREATEST(attempt-1,0)
		WHERE queue=$1 AND kind=$2 AND state='running'`, jobs.QueuePersonalWiki, WikiRefreshDispatchArgs{}.Kind())
	return err
}

// AddWikiRefreshDispatchWorker registers the dispatch worker with the processing client.
func AddWikiRefreshDispatchWorker(workers *river.Workers, dispatcher *WikiRefreshDispatcher) {
	river.AddWorker(workers, &wikiRefreshDispatchWorker{dispatcher: dispatcher})
}

// enqueueWikiRefreshDispatch must run in the transaction that moves the refresh to staging.
func enqueueWikiRefreshDispatch(ctx context.Context, tx pgx.Tx, refreshID string) error {
	return jobs.InsertTx(ctx, tx, WikiRefreshDispatchArgs{RefreshID: refreshID}, nil)
}

// wikiRefreshDispatchBusyDelay is how long an attempt waits while another
// attempt of the same refresh still runs, such as one in a TeamHub process
// that is stopping. A generation LLM Wiki stopped for its own restart waits
// as long before it runs again.
const wikiRefreshDispatchBusyDelay = time.Minute

// WorkRefresh runs one River attempt. Attempts of one refresh never run side
// by side: while another holds the refresh, this one is snoozed, which does
// not spend an attempt. A refresh that is no longer staging has nothing to
// do; an attempt that repeats a committed settlement returns nil. Failures
// return an error for River's retry schedule, except terminal failures and
// the final attempt, which fail the refresh and return nil.
func (d *WikiRefreshDispatcher) WorkRefresh(ctx context.Context, refreshID string, attempt int) error {
	release, held, err := d.holdRefresh(ctx, refreshID)
	if err != nil {
		return err
	}
	if !held {
		return river.JobSnooze(wikiRefreshDispatchBusyDelay)
	}
	defer release()
	claimed, staging, err := d.loadStagingRefresh(ctx, refreshID)
	if err != nil || !staging {
		return err
	}
	claimed.AttemptCount = attempt
	// Snoozes and restarts spend no attempt; the refresh's age bounds them.
	if attempt > d.options.MaxAttempts || jobs.ComputerOfflineWaitExpired(claimed.CreatedAt, time.Now()) {
		return d.failRefresh(ctx, refreshID, "")
	}
	candidates, candidateHash, generated, errorCode, err := d.prepareCandidates(ctx, claimed)
	if errors.Is(err, errWikiBaseChanged) {
		return d.service.conflictWikiRefresh(ctx, refreshID)
	}
	if err == nil {
		_, err = d.service.settleWikiRefresh(ctx, settleWikiRefreshInput{
			RefreshID: claimed.ID, GeneratorAgentActorID: claimed.GeneratorAgentActorID,
			Candidates: candidates, CandidateHash: candidateHash, Unsettled: generated.Unsettled, Deferred: generated.Deferred,
		})
		if err != nil {
			errorCode = "settlement_unavailable"
		}
	}
	if err == nil {
		return nil
	}
	// A lost COMMIT acknowledgement can miss after this attempt already committed.
	finished, confirmErr := d.refreshFinished(ctx, refreshID)
	if confirmErr != nil {
		return errors.Join(err, confirmErr)
	}
	if finished {
		return nil
	}
	action := wikiDispatchFailureAction(err, attempt, d.options.MaxAttempts, claimed.CreatedAt, time.Now())
	if action == wikiDispatchFail {
		return d.failRefresh(ctx, refreshID, errorCode)
	}
	if recordErr := d.recordDispatchError(ctx, refreshID, errorCode); recordErr != nil {
		return errors.Join(err, recordErr)
	}
	if action == wikiDispatchWaitForComputer {
		return river.JobSnooze(jobs.ComputerOfflineRetryDelay)
	}
	if action == wikiDispatchWaitForRestart {
		return river.JobSnooze(wikiRefreshDispatchBusyDelay)
	}
	return err
}

type wikiDispatchAction int

const (
	wikiDispatchRetry wikiDispatchAction = iota
	wikiDispatchWaitForComputer
	wikiDispatchWaitForRestart
	wikiDispatchFail
)

// wikiDispatchFailureAction decides what a failed attempt does. An offline
// Computer snoozes the job, which does not spend an attempt, until the refresh
// has existed for jobs.ComputerOfflineWaitLimit.
func wikiDispatchFailureAction(err error, attempt, maxAttempts int, createdAt, now time.Time) wikiDispatchAction {
	if errors.Is(err, ErrWikiCandidateComputerOffline) {
		if jobs.ComputerOfflineWaitExpired(createdAt, now) {
			return wikiDispatchFail
		}
		return wikiDispatchWaitForComputer
	}
	if errors.Is(err, ErrWikiCandidateServiceStopping) {
		if jobs.ComputerOfflineWaitExpired(createdAt, now) {
			return wikiDispatchFail
		}
		return wikiDispatchWaitForRestart
	}
	if isWikiCandidateTerminal(err) || attempt >= maxAttempts {
		return wikiDispatchFail
	}
	return wikiDispatchRetry
}

// holdRefresh takes the refresh's session lock on a connection of its own.
// A TeamHub process that stops closes its connections, which releases the
// locks of the attempts it was running.
func (d *WikiRefreshDispatcher) holdRefresh(ctx context.Context, refreshID string) (func(), bool, error) {
	session, err := d.pool.Acquire(ctx)
	if err != nil {
		return nil, false, err
	}
	key := "wiki-refresh-dispatch:" + refreshID
	var locked bool
	if err := session.QueryRow(ctx, `SELECT pg_try_advisory_lock(hashtextextended($1,0))`, key).Scan(&locked); err != nil {
		// Cancellation can hide a successful acquisition. Do not return the
		// session to the pool with unknown lock ownership.
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = session.Hijack().Close(closeCtx)
		return nil, false, err
	}
	if !locked {
		session.Release()
		return nil, false, nil
	}
	return func() {
		unlockCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		var unlocked bool
		if err := session.QueryRow(unlockCtx, `SELECT pg_advisory_unlock(hashtextextended($1,0))`, key).Scan(&unlocked); err != nil || !unlocked {
			_ = session.Hijack().Close(unlockCtx)
			return
		}
		session.Release()
	}, true, nil
}

func (d *WikiRefreshDispatcher) loadStagingRefresh(ctx context.Context, refreshID string) (claimedWikiRefresh, bool, error) {
	var claimed claimedWikiRefresh
	var status string
	err := d.pool.QueryRow(ctx, `SELECT id,tenant_id,generator_agent_actor_id,status,created_at
		FROM document_wiki_refreshes WHERE id=$1`, refreshID).Scan(
		&claimed.ID, &claimed.TenantID, &claimed.GeneratorAgentActorID, &status, &claimed.CreatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return claimedWikiRefresh{}, false, nil
	}
	if err != nil {
		return claimedWikiRefresh{}, false, err
	}
	return claimed, status == "staging", nil
}

func (d *WikiRefreshDispatcher) refreshFinished(ctx context.Context, refreshID string) (bool, error) {
	var finished bool
	err := d.pool.QueryRow(ctx, `SELECT status IN ('settled','conflicted','failed')
		FROM document_wiki_refreshes WHERE id=$1`, refreshID).Scan(&finished)
	if errors.Is(err, pgx.ErrNoRows) {
		return true, nil
	}
	return finished, err
}

func (d *WikiRefreshDispatcher) failRefresh(ctx context.Context, refreshID, errorCode string) error {
	tx, err := d.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var followupRequested bool
	err = tx.QueryRow(ctx, `UPDATE document_wiki_refreshes
		SET status='failed',preview_pages=NULL,preview_revision=0,outcome='failed',
		    dispatch_last_error_code=coalesce(nullif($2,''),dispatch_last_error_code),
		    updated_at=clock_timestamp()
		WHERE id=$1 AND status='staging'
		RETURNING followup_requested`, refreshID, errorCode).Scan(&followupRequested)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := finishFailedWikiRefresh(ctx, tx, refreshID, followupRequested); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (d *WikiRefreshDispatcher) recordDispatchError(ctx context.Context, refreshID, errorCode string) error {
	_, err := d.pool.Exec(ctx, `UPDATE document_wiki_refreshes
		SET dispatch_last_error_code=$2,preview_pages=NULL,updated_at=clock_timestamp(),
            preview_revision=CASE WHEN preview_pages IS NULL THEN preview_revision ELSE preview_revision+1 END
		WHERE id=$1 AND status='staging'`, refreshID, errorCode)
	return err
}
