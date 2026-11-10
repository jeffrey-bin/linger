package integration_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

// deliverWikiAttempt runs one River attempt of the refresh's next available dispatch job,
// the way the processing client does: it claims the available job row, increments
// its attempt, runs the worker's attempt, and records the outcome. The retry
// backoff is not waited for: a failed attempt leaves the job available again.
// The boolean reports whether an attempt ran.
func deliverWikiAttempt(t *testing.T, pool *pgxpool.Pool, dispatcher *document.WikiRefreshDispatcher, refreshID string) (bool, error) {
	t.Helper()
	ctx := t.Context()
	var jobID int64
	var attempt int
	err := pool.QueryRow(ctx, `UPDATE river_job SET state='running',attempt=attempt+1,attempted_at=clock_timestamp()
		WHERE id=(
			SELECT id FROM river_job
			WHERE kind='document.wiki_refresh_dispatch' AND queue='personal_wiki'
			  AND args->>'refresh_id'=$1 AND state IN ('available','scheduled')
			ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
		RETURNING id,attempt`, refreshID).Scan(&jobID, &attempt)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		t.Fatal(err)
	}
	if err := dispatcher.WorkRefresh(ctx, refreshID, attempt); err != nil {
		if _, updateErr := pool.Exec(ctx, `UPDATE river_job SET state='available',scheduled_at=clock_timestamp() WHERE id=$1`, jobID); updateErr != nil {
			t.Fatal(updateErr)
		}
		return true, err
	}
	if _, err := pool.Exec(ctx, `UPDATE river_job SET state='completed',finalized_at=clock_timestamp() WHERE id=$1`, jobID); err != nil {
		t.Fatal(err)
	}
	return true, nil
}

// wikiDispatchJobAttempt returns the River attempt count of the refresh's dispatch job.
func wikiDispatchJobAttempt(t *testing.T, pool *pgxpool.Pool, refreshID string) int {
	t.Helper()
	var attempt int
	if err := pool.QueryRow(context.Background(), `SELECT coalesce(max(attempt),0) FROM river_job
		WHERE kind='document.wiki_refresh_dispatch' AND args->>'refresh_id'=$1`, refreshID).Scan(&attempt); err != nil {
		t.Fatal(err)
	}
	return attempt
}
