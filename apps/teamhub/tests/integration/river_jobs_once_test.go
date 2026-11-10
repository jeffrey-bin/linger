package integration_test

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
)

// runJobsOnce works the available and running jobs of kinds on a temporary
// River client with only the workers register adds, then stops it. Failed
// attempts that wait for a retry are left to the schedule, so one call runs
// each job's next step.
func runJobsOnce(ctx context.Context, pool *pgxpool.Pool, register func(*river.Workers), kinds ...string) error {
	workers := river.NewWorkers()
	register(workers)
	client, err := jobs.NewClient(pool, jobs.Options{Workers: workers, PollInterval: riverTestPollInterval})
	if err != nil {
		return err
	}
	if err := client.Start(context.Background()); err != nil {
		return err
	}
	defer func() {
		stopCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = client.Stop(stopCtx)
	}()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		var pending int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM river_job
			WHERE kind = ANY($1) AND state IN ('available','pending','running')`, kinds).Scan(&pending); err != nil {
			return err
		}
		if pending == 0 {
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return errors.New("background jobs did not drain")
}
