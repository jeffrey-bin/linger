//go:build integration_migration_history
// +build integration_migration_history

package integration_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pressly/goose/v3"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/platform/migrations"
)

const baselineMigrationFile = "00852_baseline.sql"

// baselineMigrationDirectory holds only the schema baseline, so forward
// fixtures can be added next to it without touching later real migrations.
func baselineMigrationDirectory(t *testing.T) string {
	t.Helper()
	directory := t.TempDir()
	content, err := os.ReadFile(filepath.Join(teamHubMigrationDirectory(t), baselineMigrationFile))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, baselineMigrationFile), content, 0600); err != nil {
		t.Fatal(err)
	}
	return directory
}

func TestFreshPostgresMigration(t *testing.T) {
	databaseURL := newMigratedDatabase(t)
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	rows, err := pool.Query(context.Background(), `
		select schemaname, tablename
		from pg_tables
		where schemaname in ('public', 'memory_index', 'memory_source') and tablename <> 'goose_db_version'
		order by 1, 2
	`)
	if err != nil {
		t.Fatalf("list application tables: %v", err)
	}
	var tables []pgx.Identifier
	for rows.Next() {
		var schema, table string
		if err := rows.Scan(&schema, &table); err != nil {
			t.Fatal(err)
		}
		tables = append(tables, pgx.Identifier{schema, table})
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	rows.Close()
	if len(tables) == 0 {
		t.Fatal("fresh migration created no application tables")
	}
	// Built-in Skills are installed at startup, so pure migration writes no rows.
	for _, table := range tables {
		var count int
		if err := pool.QueryRow(context.Background(), "select count(*) from "+table.Sanitize()).Scan(&count); err != nil {
			t.Fatalf("count %s: %v", table.Sanitize(), err)
		}
		if count != 0 {
			t.Fatalf("pure migration left %d rows in %s", count, table.Sanitize())
		}
	}
}

func TestFreshBaselineRollsBackAndAllowsForwardMigrations(t *testing.T) {
	databaseURL := newEmptyDatabase(t, "baseline_atomic")
	db := openMigrationTestDatabase(t, databaseURL)
	// Database lifecycle tooling can own unrelated metadata before TeamHub is
	// installed, as the real Document E2E harness does with its control sentinel.
	if _, err := db.ExecContext(t.Context(), "CREATE TABLE installation_sentinel(value text); INSERT INTO installation_sentinel VALUES('keep')"); err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	filename := filepath.Join(directory, baselineMigrationFile)
	if err := os.WriteFile(filename, []byte("-- +goose Up\nCREATE TABLE partial_baseline(id int);\nSELECT missing_baseline_function();\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := migrations.UpFrom(t.Context(), databaseURL, directory); err == nil {
		t.Fatal("invalid baseline succeeded")
	}
	var exists bool
	if err := db.QueryRowContext(t.Context(), "SELECT to_regclass('public.partial_baseline') IS NOT NULL").Scan(&exists); err != nil || exists {
		t.Fatalf("partial schema committed=%v error=%v", exists, err)
	}
	baseline, err := os.ReadFile(filepath.Join(teamHubMigrationDirectory(t), baselineMigrationFile))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filename, baseline, 0600); err != nil {
		t.Fatal(err)
	}
	if err := migrations.UpFrom(t.Context(), databaseURL, directory); err != nil {
		t.Fatal(err)
	}
	if err := goose.DownContext(t.Context(), db, directory); err == nil || !strings.Contains(err.Error(), "forward-only") {
		t.Fatalf("baseline Down error=%v", err)
	}
	if err := os.WriteFile(filepath.Join(directory, "00853_forward.sql"), []byte("-- +goose Up\nALTER TABLE accounts ADD COLUMN next_value text;\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := migrations.UpFrom(t.Context(), databaseURL, directory); err != nil {
		t.Fatal(err)
	}
	version, err := goose.GetDBVersionContext(t.Context(), db)
	if err != nil || version != 853 {
		t.Fatalf("forward version=%d error=%v", version, err)
	}
	// A migration introduced below an applied version must still fail.
	if err := os.WriteFile(filepath.Join(directory, "00857_forward.sql"), []byte("-- +goose Up\nCREATE TABLE public_future_probe(id int);\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := migrations.UpFrom(t.Context(), databaseURL, directory); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "00854_late.sql"), []byte("-- +goose Up\nCREATE TABLE public_missing_probe(id int);\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := migrations.UpFrom(t.Context(), databaseURL, directory); err == nil || !strings.Contains(err.Error(), "missing") {
		t.Fatalf("late migration error=%v", err)
	}
	var sentinel string
	if err := db.QueryRowContext(t.Context(), "SELECT value FROM installation_sentinel").Scan(&sentinel); err != nil || sentinel != "keep" {
		t.Fatalf("installation metadata changed: %q %v", sentinel, err)
	}
	t.Run("existing TeamHub schema is not overwritten", func(t *testing.T) {
		sourceURL := newEmptyDatabase(t, "unversioned")
		source := openMigrationTestDatabase(t, sourceURL)
		if _, err := source.ExecContext(t.Context(), "CREATE TABLE accounts(id text); INSERT INTO accounts VALUES('keep')"); err != nil {
			t.Fatal(err)
		}
		if err := migrations.UpFrom(t.Context(), sourceURL, baselineMigrationDirectory(t)); err == nil || !strings.Contains(err.Error(), "needs an empty database") {
			t.Fatalf("baseline over an existing schema error=%v", err)
		}
		var id string
		if err := source.QueryRowContext(t.Context(), "SELECT id FROM accounts").Scan(&id); err != nil || id != "keep" {
			t.Fatalf("existing data changed: %q %v", id, err)
		}
		if err := source.QueryRowContext(t.Context(), "SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='memory_index')").Scan(&exists); err != nil || exists {
			t.Fatalf("failed install left partial schema: %v %v", exists, err)
		}
		var count int
		if err := source.QueryRowContext(t.Context(), "SELECT count(*) FROM goose_db_version WHERE version_id=852").Scan(&count); err != nil || count != 0 {
			t.Fatalf("failed install recorded baseline: %d %v", count, err)
		}
	})
}
