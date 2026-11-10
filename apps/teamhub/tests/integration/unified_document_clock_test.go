package integration_test

import (
	"database/sql"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func TestUnifiedDocumentWritesSurviveClockRegression(t *testing.T) {
	allowParallelIntegrationTest(t)
	t.Run("wiki_upload_time_boundaries_and_document_mutations", func(t *testing.T) {
		ctx := t.Context()
		db, pool := newUnifiedDocumentActionsFixture(t)
		db, pool = newDocumentDatabaseClock(t, db, pool)
		setDocumentClockAhead(t, db)
		objects, err := artifactstore.NewLocalStore(t.TempDir(), 1<<20)
		if err != nil {
			t.Fatal(err)
		}
		service := document.NewWithObjectStore(pool, objects)
		var created document.UploadDocumentResult
		// The 96-source identity/replay matrix is pure and lives in upload_test.go.
		// PostgreSQL proves the three distinct timestamp relations, transaction
		// replay, unique facts, and rejection of a conflicting idempotency request.
		storedTime := time.Date(2100, 1, 1, 0, 0, 0, 0, time.UTC)
		seenDocuments := map[string]bool{}
		for _, testCase := range []struct {
			name string
			now  time.Time
			want time.Time
		}{
			{name: "forward", now: storedTime.Add(time.Second), want: storedTime.Add(time.Second)},
			{name: "equal", now: storedTime, want: storedTime},
			{name: "backward", now: storedTime.Add(-time.Second), want: storedTime},
		} {
			if _, err := db.ExecContext(ctx, `UPDATE document_test_clock.value SET fixed_at=$1`, testCase.now); err != nil {
				t.Fatal(err)
			}
			input := document.UploadDocumentContextInput{
				UploadDocumentInput: document.UploadDocumentInput{
					AccountID: "account_document_a", IdempotencyKey: "clock-wiki-source-" + testCase.name,
					Filename: "source.txt", RepresentationFormat: "plain_text",
					MediaType: "text/plain", Content: strings.NewReader("Wiki source"),
				},
				Kind: "wiki", TenantID: "tenant_document_a",
			}
			created, err = service.UploadToContext(ctx, input)
			if err != nil || created.Replayed || created.Document.CurrentVersion == nil {
				t.Fatalf("%s upload=%+v error=%v", testCase.name, created, err)
			}
			if seenDocuments[created.Document.ID] {
				t.Fatalf("different keys with identical source metadata collided: %s", created.Document.ID)
			}
			seenDocuments[created.Document.ID] = true
			var updated time.Time
			if err := db.QueryRowContext(ctx, `SELECT updated_at FROM documents WHERE id=$1`, created.Document.ID).Scan(&updated); err != nil || !updated.Equal(testCase.want) {
				t.Fatalf("%s updated_at=%s want=%s error=%v", testCase.name, updated, testCase.want, err)
			}
			input.Content = strings.NewReader("Wiki source")
			replay, err := service.UploadToContext(ctx, input)
			if err != nil || !replay.Replayed || replay.Document.ID != created.Document.ID ||
				replay.Document.CurrentVersion == nil || replay.Document.CurrentVersion.ID != created.Document.CurrentVersion.ID {
				t.Fatalf("%s replay=%+v error=%v", testCase.name, replay, err)
			}
			input.Content = strings.NewReader("Different source")
			if _, err := service.UploadToContext(ctx, input); !errors.Is(err, document.ErrIdempotencyConflict) {
				t.Fatalf("%s conflicting replay must be rejected: %v", testCase.name, err)
			}
		}
		var boundSources, versions, commands int
		if err := db.QueryRowContext(ctx, `SELECT
			(SELECT count(*) FROM document_context_bindings
			 WHERE wiki_id='wiki_document_a' AND binding_kind='wiki_source' AND status='active'),
			(SELECT count(*) FROM document_versions version JOIN document_context_bindings binding
			 ON binding.document_id=version.document_id WHERE binding.wiki_id='wiki_document_a'),
			(SELECT count(*) FROM command_replays WHERE operation='document.upload.wiki'
			 AND key LIKE 'clock-wiki-source-%')`).Scan(&boundSources, &versions, &commands); err != nil || boundSources != 3 || versions != 3 || commands != 3 {
			t.Fatalf("upload/replay/conflict facts: sources=%d versions=%d commands=%d want 3/3/3 error=%v", boundSources, versions, commands, err)
		}

		id := created.Document.ID
		replacementInput := document.UploadDocumentVersionInput{
			AccountID: "account_document_a", DocumentID: id, IdempotencyKey: "clock-replacement",
			ExpectedCurrentVersionID: created.Document.CurrentVersion.ID,
			Filename:                 "replacement.txt", RepresentationFormat: "plain_text", MediaType: "text/plain",
			Content: strings.NewReader("Updated source"),
		}
		replacement, err := service.UploadVersion(ctx, replacementInput)
		if err != nil || replacement.Version.VersionNumber != 2 {
			t.Fatalf("replacement=%+v error=%v", replacement, err)
		}
		assertDocumentClockAhead(t, db, id)
		replacementInput.IdempotencyKey = "clock-stale-replacement"
		replacementInput.Content = strings.NewReader("Stale source")
		if _, err := service.UploadVersion(ctx, replacementInput); !errors.Is(err, document.ErrVersionConflict) {
			t.Fatalf("stale replacement must remain rejected: %v", err)
		}
		metadata, err := service.UpdateMetadata(ctx, document.UpdateMetadataInput{
			AccountID: "account_document_a", DocumentID: id, Title: "Renamed source",
		})
		if err != nil || !metadata.Changed || metadata.Document.Title != "Renamed source" {
			t.Fatalf("rename=%+v error=%v", metadata, err)
		}
		assertDocumentClockAhead(t, db, id)
		duplicate, err := service.Duplicate(ctx, document.DuplicateDocumentInput{
			AccountID: "account_document_a", DocumentID: id,
		})
		if err != nil || duplicate.Document.ID == id || duplicate.Document.CurrentVersion == nil {
			t.Fatalf("duplicate=%+v error=%v", duplicate, err)
		}
		assertDocumentClockAhead(t, db, duplicate.Document.ID)

		if err := service.Trash(ctx, document.TrashDocumentInput{
			AccountID: "account_document_a", DocumentID: id,
		}); err != nil {
			t.Fatalf("trash error=%v", err)
		}
		assertDocumentClockAhead(t, db, id)
		if err := service.Restore(ctx, document.RestoreDocumentInput{
			AccountID: "account_document_a", DocumentID: id,
		}); err != nil {
			t.Fatalf("restore error=%v", err)
		}
		assertDocumentClockAhead(t, db, id)
		var lifecycleTimesValid bool
		if err := db.QueryRowContext(ctx, `SELECT status='active' AND trashed_at=updated_at AND restored_at=updated_at
			FROM documents WHERE id=$1`, id).Scan(&lifecycleTimesValid); err != nil || !lifecycleTimesValid {
			t.Fatalf("lifecycle timestamps valid=%t error=%v", lifecycleTimesValid, err)
		}
		if _, err := db.ExecContext(ctx, `UPDATE documents SET updated_at=updated_at-interval '1 second' WHERE id=$1`, id); err == nil || !strings.Contains(err.Error(), "Document updated time is irreversible") {
			t.Fatalf("database must still reject timestamp regression: %v", err)
		}
	})
}

// Both clients in this private clone read the same committed clock control.
// fixed_at is only for exact Document timestamp boundaries. Lease tests leave
// it NULL and advance clock_offset, so time keeps progressing after the jump.
// The modes cannot be combined. Only explicit, unqualified clock_timestamp()
// calls follow search_path: other clocks, qualified calls, separate search_path
// and already-bound schema defaults do not. TestDocumentDatabaseClockSQLRemainsShadowable
// guards the relevant production SQL; this is not a global database fake clock.
func newDocumentDatabaseClock(t *testing.T, db *sql.DB, pool *pgxpool.Pool) (*sql.DB, *pgxpool.Pool) {
	t.Helper()
	if _, err := pool.Exec(t.Context(), `CREATE SCHEMA document_test_clock;
		CREATE TABLE document_test_clock.value(
		  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
		  fixed_at timestamptz,clock_offset interval NOT NULL DEFAULT interval '0 seconds',
		  CHECK(fixed_at IS NULL OR clock_offset=interval '0 seconds'));
		INSERT INTO document_test_clock.value DEFAULT VALUES;
		CREATE FUNCTION document_test_clock.clock_timestamp() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$
			SELECT coalesce(fixed_at,pg_catalog.clock_timestamp()+clock_offset)
			FROM document_test_clock.value
		$$`); err != nil {
		t.Fatal(err)
	}
	config := pool.Config()
	if config.ConnConfig.RuntimeParams == nil {
		config.ConnConfig.RuntimeParams = map[string]string{}
	}
	config.ConnConfig.RuntimeParams["search_path"] = "document_test_clock,pg_catalog,public"
	clockPool, err := pgxpool.NewWithConfig(t.Context(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(clockPool.Close)
	clockDB := stdlib.OpenDB(*config.ConnConfig)
	t.Cleanup(func() { _ = clockDB.Close() })
	pool.Close()
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	return clockDB, clockPool
}

func setDocumentClockAhead(t *testing.T, db *sql.DB) {
	t.Helper()
	// Only this test's database clone is changed. Future stored timestamps reproduce
	// a backwards clock step between INSERT and UPDATE without changing the host clock.
	if _, err := db.ExecContext(t.Context(), `ALTER TABLE documents ALTER COLUMN updated_at SET DEFAULT '2100-01-01T00:00:00Z'`); err != nil {
		t.Fatal(err)
	}
}

func assertDocumentClockAhead(t *testing.T, db *sql.DB, id string) {
	t.Helper()
	var retained bool
	if err := db.QueryRowContext(t.Context(), `SELECT updated_at='2100-01-01T00:00:00Z' FROM documents WHERE id=$1`, id).Scan(&retained); err != nil || !retained {
		t.Fatalf("document %s retained timestamp=%t error=%v", id, retained, err)
	}
}
