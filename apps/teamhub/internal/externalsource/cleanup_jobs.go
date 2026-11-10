package externalsource

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
)

// CleanupArgs names one upstream account to revoke and the Connection it
// belonged to. Its upstream receipt records that TeamHub gave it up; the
// River job is the only record of the revoke still to do. A disconnecting
// Connection stays due, so the reconcile sweep queues its revoke again.
type CleanupArgs struct {
	ConnectionID string `json:"connection_id"`
	UpstreamID   string `json:"upstream_id"`
}

const (
	cleanupKind = "external.connection_cleanup"
	// cleanupMaxAttempts bounds database errors. A revoke failure snoozes, which
	// spends no attempt, so a revoke keeps retrying until it succeeds.
	cleanupMaxAttempts = 25
	cleanupRetryDelay  = 5 * time.Minute
)

func (CleanupArgs) Kind() string { return cleanupKind }

func (CleanupArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: jobs.QueueExternal, MaxAttempts: cleanupMaxAttempts, UniqueOpts: jobs.UniqueUnfinished}
}

// enqueueRevokeTx gives up an upstream account in the transaction that stops
// using it: its receipt is marked, so it is never adopted again, and its
// revoke is queued.
func enqueueRevokeTx(ctx context.Context, tx pgx.Tx, connectionID, upstreamID string) error {
	if _, err := tx.Exec(ctx, `UPDATE external_connection_upstreams SET revoke_requested_at=coalesce(revoke_requested_at,now()) WHERE upstream_id=$1`, upstreamID); err != nil {
		return err
	}
	return jobs.InsertTx(ctx, tx, CleanupArgs{ConnectionID: connectionID, UpstreamID: upstreamID}, nil)
}

type cleanupWorker struct {
	river.WorkerDefaults[CleanupArgs]
	service *Service
}

func (*cleanupWorker) Timeout(*river.Job[CleanupArgs]) time.Duration { return connectionJobTimeout }

func (w *cleanupWorker) Work(ctx context.Context, job *river.Job[CleanupArgs]) error {
	return w.service.runCleanupJob(ctx, job.Args.ConnectionID, job.Args.UpstreamID)
}

// upstreamGone reports a Composio account that no longer exists.
func upstreamGone(err error) bool {
	status, ok := composio.ErrorStatus(err)
	return ok && (status == http.StatusNotFound || status == http.StatusGone)
}

// runCleanupJob revokes one upstream. A revoke failure snoozes the job, which
// spends no attempt; a disconnecting Connection shows the failure meanwhile.
// Revoking a disconnecting Connection's own upstream ends the Connection.
func (s *Service) runCleanupJob(ctx context.Context, connectionID, upstreamID string) error {
	var accountID, provider string
	err := s.pool.QueryRow(ctx, `SELECT account_id,provider FROM external_connections WHERE id=$1`, connectionID).Scan(&accountID, &provider)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	retry := func(code string, cause error) error {
		// A snooze never reaches River's error handler, so the cause is logged here.
		s.logger.Warn("retry External Connection cleanup", "connection_id", connectionID, "upstream_id", upstreamID, "code", code, "error", cause)
		err := s.commitAccountExternalConnectionsMutation(ctx, accountID, func(tx pgx.Tx) (bool, error) {
			result, updateErr := tx.Exec(ctx, `UPDATE external_connections SET status_error_code=$3,next_status_check_at=now()+$4::interval,updated_at=now() WHERE id=$1 AND upstream_connection_id=$2 AND status='disconnecting' AND status_error_code IS DISTINCT FROM $3`, connectionID, upstreamID, code, durationInterval(cleanupRetryDelay))
			return updateErr == nil && result.RowsAffected() == 1, updateErr
		})
		if err != nil {
			return err
		}
		return river.JobSnooze(cleanupRetryDelay)
	}
	adapter, adapterErr := s.connectionAdapter(provider)
	if adapterErr != nil {
		return retry("provider_revoke_unavailable", adapterErr)
	}
	// An account Composio no longer has is as good as revoked.
	if err = adapter.Revoke(ctx, upstreamID); err != nil && !upstreamGone(err) {
		return retry("provider_revoke_failed", err)
	}
	return s.commitAccountExternalConnectionsMutation(ctx, accountID, func(tx pgx.Tx) (bool, error) {
		result, updateErr := tx.Exec(ctx, `UPDATE external_connections SET status='revoked',status_error_code=NULL,updated_at=now() WHERE id=$1 AND upstream_connection_id=$2 AND status IN ('disconnecting','revoke_pending')`, connectionID, upstreamID)
		return updateErr == nil && result.RowsAffected() == 1, updateErr
	})
}
