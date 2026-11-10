package integration_test

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func TestDocumentTrashRetriesConcurrentUpdateWithoutDuplicateEffects(t *testing.T) {
	allowParallelIntegrationTest(t)
	fixtureCtx, databaseURL := newNativeDocumentConcurrencyDatabase(t)
	ctx, cancel := context.WithTimeout(fixtureCtx, 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	blocker, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = blocker.Rollback(context.Background()) }()
	if _, err := blocker.Exec(ctx, `UPDATE documents SET updated_at=clock_timestamp() WHERE id=$1`, nativeConcurrencyDocumentID); err != nil {
		t.Fatal(err)
	}
	service := document.New(pool)
	input := document.TrashDocumentInput{AccountID: "account_document_a", DocumentID: nativeConcurrencyDocumentID}
	done := make(chan error, 1)
	go func() {
		done <- service.Trash(ctx, input)
	}()
	// Wait until Trash has taken its serializable snapshot and is blocked on our
	// row update. Committing now deterministically invalidates that first attempt.
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		var waiting bool
		if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
   WHERE datname=current_database() AND pid<>pg_backend_pid()
   AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE OF document%')`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("Trash returned before contention: %v", err)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-ticker.C:
		}
	}
	if err := blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Trash must recover from serialization failure: %v", err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := service.Trash(ctx, input); err != nil {
		t.Fatalf("replay Trash: %v", err)
	}
	var documentStatus string
	var disconnects, events int
	if err := pool.QueryRow(ctx, `SELECT status,
  (SELECT count(*) FROM river_job WHERE kind='document.runtime_disconnect' AND args->>'document_id'=$1),
  (SELECT count(*) FROM document_events WHERE document_id=$1 AND event_type='document.access_invalidated')
  FROM documents WHERE id=$1`, input.DocumentID).Scan(&documentStatus, &disconnects, &events); err != nil {
		t.Fatal(err)
	}
	if documentStatus != "trashed" || disconnects != 1 || events != 1 {
		t.Fatalf("status=%s disconnects=%d events=%d", documentStatus, disconnects, events)
	}
}
