//go:build integration_migration_history

package integration_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/platform/migrations"
)

func TestEmptyDatabaseAmbiguousCreateIsReclaimed(t *testing.T) {
	failure := errors.New("connection lost after empty CREATE")
	catalog := make(map[string]bool)
	control := &probeDatabaseControl{execute: func(_ context.Context, statement string) error {
		name := strings.Split(statement, "\"")[1]
		if strings.HasPrefix(statement, "create database") {
			catalog[name] = true
			return failure
		}
		delete(catalog, name)
		return nil
	}}
	suite := probeSuite(t, control)
	if _, err := suite.emptyDatabase(t.Context(), "migration"); !errors.Is(err, failure) {
		t.Errorf("empty CREATE error=%v, want original connection failure", err)
	}
	if err := suite.close(t.Context()); err != nil {
		t.Error(err)
	}
	if len(catalog) != 0 {
		t.Error("ambiguous empty CREATE left an untracked database")
	}
}

func (suite *testDatabaseSuite) emptyDatabase(ctx context.Context, purpose string) (string, error) {
	control, err := suite.testControlPool(ctx)
	if err != nil {
		return "", err
	}
	name, err := randomDatabaseName(purpose)
	if err != nil {
		return "", fmt.Errorf("name empty integration database: %w", err)
	}
	suite.registerDatabase(name)
	if err := createDatabase(ctx, control, name, ""); err != nil {
		return "", fmt.Errorf("create empty integration database: %w", err)
	}
	return databaseURL(testControlDatabaseURL(), name)
}

func newMigratedDatabase(t *testing.T) string {
	t.Helper()
	databaseURL := newEmptyDatabase(t, "migration")
	if err := migrations.UpFrom(t.Context(), databaseURL, teamHubMigrationDirectory(t)); err != nil {
		t.Fatalf("migrate isolated empty database: %v", err)
	}
	return databaseURL
}

func newEmptyDatabase(t *testing.T, purpose string) string {
	t.Helper()
	requireTestDatabase(t)
	databaseURL, err := integrationDatabaseSuite.emptyDatabase(t.Context(), purpose)
	if err != nil {
		t.Fatalf("create isolated empty database: %v", err)
	}
	registerDatabaseCleanup(t, databaseURL)
	return databaseURL
}

func openMigrationTestDatabase(t *testing.T, databaseURL string) *sql.DB {
	t.Helper()
	config, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		t.Fatalf("parse isolated migration-test database URL: %v", err)
	}
	db := stdlib.OpenDB(*config)
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Errorf("close isolated migration-test database: %v", err)
		}
	})
	return db
}
