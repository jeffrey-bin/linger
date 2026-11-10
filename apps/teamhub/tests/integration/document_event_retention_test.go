package integration_test

import (
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
)

func TestDocumentEventRetentionPreservesReferencesAndSequences(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := t.Context()
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	cfg := config.ForTest(func(c *config.Config) {
		c.ArtifactStorageRoot = integrationArtifactRoot(t)
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
	})
	exec := func(sql string, arguments ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, arguments...); err != nil {
			t.Fatal(err)
		}
	}
	count := func(sql string, arguments ...any) int64 {
		t.Helper()
		var value int64
		if err := pool.QueryRow(ctx, sql, arguments...).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	const emptyDocument = "document_event_retention_empty"
	const mixedDocument = "document_event_retention_mixed"
	const nextEvent = "document_event_retention_next"
	const recentEvent = "document_event_retention_29_days"
	const insertEventSQL = `INSERT INTO document_events(
		id,tenant_id,document_id,event_type,actor_id,resource_kind,resource_id,projection_version,occurred_at
	) VALUES($1,$2,$3,'document.draft_updated','actor_acme_alice','autosave_batch',$1,1,
		now()-($4::integer*interval '1 day')) ON CONFLICT (id) DO NOTHING`

	// Seed with River stopped so every seeded event reaches the same retention
	// pass.
	prepared, err := newIntegrationApp(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(prepared.Close)
	for _, documentID := range []string{emptyDocument, mixedDocument} {
		exec(`INSERT INTO documents(
			id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,creator_actor_kind,status
		) VALUES($1,$2,'Event retention','blocknote','actor_acme_alice','human','actor_acme_alice','human','active')`,
			documentID, acmeTenant)
	}
	for _, event := range []struct {
		id, documentID string
		daysOld        int
	}{
		{"document_event_retention_old_first", emptyDocument, 31},
		{"document_event_retention_old_last", emptyDocument, 31},
		{"document_event_retention_mixed_old", mixedDocument, 31},
		{recentEvent, mixedDocument, 29},
		{"document_event_retention_fresh", mixedDocument, 0},
	} {
		exec(insertEventSQL, event.id, acmeTenant, event.documentID, event.daysOld)
	}
	beforeSequence := count(`SELECT last_sequence FROM document_event_sequences WHERE document_id=$1`, emptyDocument)
	if beforeSequence != 2 {
		t.Fatalf("expired Document sequence = %d, want 2", beforeSequence)
	}
	prepared.Close()

	swept, err := newIntegrationApp(ctx, cfg, starting(app.JobQueue))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(swept.Close)
	deadline := time.Now().Add(30 * time.Second)
	for {
		var state, jobErrors string
		err := pool.QueryRow(ctx, `SELECT state::text,coalesce(errors::text,'') FROM river_job
			WHERE kind='maintenance.retention' ORDER BY id DESC LIMIT 1`).Scan(&state, &jobErrors)
		if err == nil && state == "completed" {
			break
		}
		if err == nil && jobErrors != "" {
			t.Fatalf("retention job state=%s errors=%s", state, jobErrors)
		}
		if time.Now().After(deadline) {
			t.Fatalf("retention job did not complete: state=%q err=%v", state, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	// The timer is a hang guard; completion and the committed rows are the
	// assertions, with no latency requirement.
	for _, check := range []struct {
		name, sql string
		args      []any
		want      int64
	}{
		{"all expired events, including the Document's last one", `SELECT count(*) FROM document_events WHERE document_id=$1`, []any{emptyDocument}, 0},
		{"expired event on a still active Document", `SELECT count(*) FROM document_events WHERE id='document_event_retention_mixed_old'`, nil, 0},
		{"29-day and fresh events", `SELECT count(*) FROM document_events WHERE document_id=$1`, []any{mixedDocument}, 2},
		{"Document survives event retention", `SELECT count(*) FROM documents WHERE id=$1`, []any{emptyDocument}, 1},
		{"counter survives event retention", `SELECT last_sequence FROM document_event_sequences WHERE document_id=$1`, []any{emptyDocument}, beforeSequence},
	} {
		if got := count(check.sql, check.args...); got != check.want {
			t.Errorf("%s: got %d, want %d", check.name, got, check.want)
		}
	}

	exec(insertEventSQL, nextEvent, acmeTenant, emptyDocument, 0)
	if got := count(`SELECT sequence FROM document_events WHERE id=$1`, nextEvent); got != beforeSequence+1 {
		t.Fatalf("sequence after deleting every old event = %d, want %d", got, beforeSequence+1)
	}
	exec(insertEventSQL, nextEvent, acmeTenant, emptyDocument, 0)
	if got := count(`SELECT last_sequence FROM document_event_sequences WHERE document_id=$1`, emptyDocument); got != beforeSequence+1 {
		t.Fatalf("duplicate replay advanced sequence to %d, want %d", got, beforeSequence+1)
	}

	// Use one connection across guarded transactions and their following
	// statements, so a leaked setting cannot hide behind a different backend.
	connection, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Release()
	for _, statement := range []string{
		`DELETE FROM document_events WHERE id=$1`,
		`UPDATE document_events SET projection_version=projection_version+1 WHERE id=$1`,
	} {
		if _, err := connection.Exec(ctx, statement, nextEvent); err == nil || !strings.Contains(err.Error(), "Document event audit evidence is immutable") {
			t.Fatalf("unguarded mutation error = %v, want immutable event rejection", err)
		}
	}
	tx, err := connection.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('teamhub.document_retention','on',true)`); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	_, updateErr := tx.Exec(ctx, `UPDATE document_events SET projection_version=projection_version+1 WHERE id=$1`, nextEvent)
	_ = tx.Rollback(ctx)
	if updateErr == nil || !strings.Contains(updateErr.Error(), "Document event audit evidence is immutable") {
		t.Fatalf("guarded UPDATE error = %v, want immutable event rejection", updateErr)
	}
	tx, err = connection.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('teamhub.document_retention','on',true)`); err != nil {
		t.Fatal(err)
	}
	if tag, err := tx.Exec(ctx, `DELETE FROM document_events WHERE id=$1`, nextEvent); err != nil || tag.RowsAffected() != 1 {
		t.Fatalf("guarded DELETE affected %d rows, error=%v", tag.RowsAffected(), err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var guardEnabled bool
	if err := connection.QueryRow(ctx, `SELECT coalesce(current_setting('teamhub.document_retention',true),'')='on'`).Scan(&guardEnabled); err != nil {
		t.Fatal(err)
	}
	if guardEnabled {
		t.Fatal("Document retention guard leaked beyond its transaction")
	}
	if _, err := connection.Exec(ctx, `DELETE FROM document_events WHERE id=$1`, recentEvent); err == nil || !strings.Contains(err.Error(), "Document event audit evidence is immutable") {
		t.Fatalf("DELETE after guarded transaction error = %v, want immutable event rejection", err)
	}
}
