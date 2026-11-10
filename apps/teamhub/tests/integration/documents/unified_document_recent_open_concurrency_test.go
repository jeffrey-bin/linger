package documents_test

import (
	"context"
	"testing"
	"time"

	documentfixture "github.com/simplexai-labs/linger/apps/teamhub/tests/integration/documents/fixture"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func TestDocumentGetSurvivesConcurrentRecentOpen(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	db, pool := newUnifiedDocumentDatabase(t, documentfixture.IdentitySQL)
	documentfixture.InsertContext(t, ctx, db)
	service := document.New(pool)
	original, err := service.Get(ctx, "account_document_a", "document_human_a")
	if err != nil {
		t.Fatal(err)
	}
	writer, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Rollback(context.Background())
	var writerPID int
	var writtenAt time.Time
	if err := writer.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&writerPID); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Exec(ctx, `UPDATE documents SET title='concurrent title'
		WHERE id='document_human_a'`); err != nil {
		t.Fatal(err)
	}
	if err := writer.QueryRow(ctx, `UPDATE document_recent_opens
		SET last_opened_at=clock_timestamp()
		WHERE document_id='document_human_a'
		RETURNING last_opened_at`).Scan(&writtenAt); err != nil {
		t.Fatal(err)
	}
	type result struct {
		value document.Document
		err   error
	}
	completed := make(chan result, 1)
	go func() {
		value, err := service.Get(ctx, "account_document_a", "document_human_a")
		completed <- result{value, err}
	}()
	// Observe the actual UPSERT lock wait before committing the competing open.
	// Both transactions now necessarily hold snapshots older than this commit.
	for {
		var waiting bool
		err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
			WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))
			AND query LIKE '%INSERT INTO document_recent_opens%')`, writerPID).Scan(&waiting)
		if err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case got := <-completed:
			t.Fatalf("Get finished before competing UPSERT: %v", got.err)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(10 * time.Millisecond):
		}
	}
	if err := writer.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	got := <-completed
	if got.err != nil || got.value.ID != "document_human_a" || !got.value.Capabilities.Read {
		t.Fatalf("authorized Document read failed due to recent-open contention: id=%s error=%v", got.value.ID, got.err)
	}
	if got.value.Title != original.Title {
		t.Fatal("Document read lost its original consistent snapshot")
	}
	var recordedAt time.Time
	if err := pool.QueryRow(ctx, `SELECT last_opened_at FROM document_recent_opens
		WHERE document_id='document_human_a'`).Scan(&recordedAt); err != nil {
		t.Fatal(err)
	}
	if recordedAt.Before(writtenAt) {
		t.Fatal("concurrent recent open was lost")
	}
	latest, err := service.Get(ctx, "account_document_a", "document_human_a")
	if err != nil || latest.Title != "concurrent title" {
		t.Fatalf("subsequent read did not observe current Document: title=%s error=%v", latest.Title, err)
	}
}
