package documents_test

import (
	"database/sql"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/tests/testsupport/database"
)

var databases database.Suite

func TestMain(m *testing.M) { os.Exit(databases.Run(m)) }

func newUnifiedDocumentDatabase(t *testing.T, seedSQL string, arguments ...any) (*sql.DB, *pgxpool.Pool) {
	t.Helper()
	pool := databases.Pool(t)
	if _, err := pool.Exec(t.Context(), seedSQL, append([]any{pgx.QueryExecModeSimpleProtocol}, arguments...)...); err != nil {
		t.Fatal(err)
	}
	return database.SQL(t, pool), pool
}
