package database

import (
	"database/sql"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
)

// SQL opens the database/sql API on this test's existing private database.
// It owns its connections and closes before the per-test database is dropped.
func SQL(t *testing.T, pool *pgxpool.Pool) *sql.DB {
	t.Helper()
	db := stdlib.OpenDB(*pool.Config().ConnConfig)
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Errorf("close SQL fixture: %v", err)
		}
	})
	return db
}
