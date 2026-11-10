package document

import (
	"context"
	"time"

	"github.com/riverqueue/river"

	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
)

// cleanupLatestProjectionObject deletes one replaced or abandoned latest
// projection object. Each run takes the object lock without waiting, so an
// upload in progress is never interrupted. The grace period is the latest
// scheduled cleanup for the same object: a later replacement enqueues its own
// job, and an earlier run snoozes until that grace has passed.
func (s *Service) cleanupLatestProjectionObject(ctx context.Context, key string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var locked bool
	if err := tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock(hashtextextended('document-latest-object:' || $1,0))`, key).Scan(&locked); err != nil {
		return err
	}
	if !locked {
		return river.JobSnooze(latestProjectionObjectBusyDelay)
	}
	// Recheck the grace period after taking the object lock: an upload may have
	// enqueued a later cleanup between this job's scheduling and now.
	var graceRemaining float64
	if err := tx.QueryRow(ctx, `SELECT coalesce(max(extract(epoch FROM scheduled_at-clock_timestamp())),0)::float8
		FROM river_job
		WHERE kind=$1 AND args->>'object_key'=$2
		  AND state IN ('available','pending','retryable','running','scheduled')`,
		latestProjectionObjectCleanupKind, key).Scan(&graceRemaining); err != nil {
		return err
	}
	if graceRemaining > 0 {
		return river.JobSnooze(time.Duration(graceRemaining * float64(time.Second)))
	}
	var referenced bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM document_latest_projections WHERE content_object_id=$1)`, key).Scan(&referenced); err != nil {
		return err
	}
	if !referenced {
		if err := artifactstore.DeleteDetached(ctx, s.objects, key); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
