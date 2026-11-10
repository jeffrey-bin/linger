package integration_test

import (
	"context"
	"log/slog"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/reminder"
)

// A sweep that a crashed process left running holds its uniqueness key, so
// every later period's insert is skipped. River's rescuer must discard it
// within minutes, not the hour River adds to the job timeout by default, so
// the next period runs again.
func TestRiverRescuesASweepLeftRunningByACrash(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := t.Context()
	pool, err := pgxpool.New(ctx, newIntegrationDatabaseWithoutSkills(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	insertSweep := func() {
		t.Helper()
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if err := jobs.InsertTx(ctx, tx, reminder.SweepArgs{}, nil); err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}
	sweepRows := func(state string) int {
		t.Helper()
		var count int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM river_job WHERE kind=$1 AND state=$2`,
			reminder.SweepArgs{}.Kind(), state).Scan(&count); err != nil {
			t.Fatal(err)
		}
		return count
	}

	insertSweep()
	// The process stopped seven minutes into the run, past the client's rescue
	// horizon but far inside River's default one.
	if _, err := pool.Exec(ctx, `UPDATE river_job
		SET state='running', attempt=1, attempted_at=now()-interval '7 minutes'
		WHERE kind=$1`, reminder.SweepArgs{}.Kind()); err != nil {
		t.Fatal(err)
	}
	insertSweep()
	if running, available := sweepRows("running"), sweepRows("available"); running != 1 || available != 0 {
		t.Fatalf("stuck sweep did not hold its key: running=%d available=%d", running, available)
	}

	workers := river.NewWorkers()
	reminder.AddListenerJobWorkers(workers, reminder.New(pool), nil, nil, slog.Default(), func() bool { return true })
	client, err := jobs.NewClient(pool, jobs.Options{Workers: workers, PollInterval: riverTestPollInterval, TestOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		stopCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = client.Stop(stopCtx)
	})
	waitForSweep := func(state string) {
		t.Helper()
		deadline := time.Now().Add(20 * time.Second)
		for sweepRows(state) == 0 {
			if time.Now().After(deadline) {
				t.Fatalf("no sweep reached %s", state)
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	waitForSweep("discarded")
	insertSweep()
	waitForSweep("completed")
}
