// Package migrations runs database migrations serially and verifies that a fresh database can be initialized.
package migrations

import (
	"context"
	"fmt"
	"io/fs"
	"os"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	migrationfiles "github.com/simplexai-labs/linger/apps/teamhub/migrations"
)

// Up runs the database migrations compiled into the binary, serially.
func Up(ctx context.Context, databaseURL string) error {
	return up(ctx, databaseURL, migrationfiles.Files)
}

// UpFrom runs database migrations serially from the given absolute directory; tests use it to replay part of the migration history.
func UpFrom(ctx context.Context, databaseURL, directory string) error {
	return up(ctx, databaseURL, os.DirFS(directory))
}

func up(ctx context.Context, databaseURL string, migrationFiles fs.FS) error {
	config, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		return fmt.Errorf("parse database URL: %w", err)
	}
	db := stdlib.OpenDB(*config)
	defer db.Close()
	if err := db.PingContext(ctx); err != nil {
		return fmt.Errorf("connect for migration: %w", err)
	}
	// The PostgreSQL session advisory lock belongs to the connection that acquired it; the same dedicated
	// connection must be kept during migration and unlock on that connection, and must not be returned to the pool before trying to release.
	lockConnection, err := db.Conn(ctx)
	if err != nil {
		return fmt.Errorf("acquire migration connection: %w", err)
	}
	defer lockConnection.Close()
	if _, err := lockConnection.ExecContext(ctx, "select pg_advisory_lock(hashtext('teamhub_migrations'))"); err != nil {
		return fmt.Errorf("lock migrations: %w", err)
	}
	// Even when the call context is canceled, unlocking is still attempted; closing the dedicated connection is the fallback that releases the session lock.
	defer lockConnection.ExecContext(context.Background(), "select pg_advisory_unlock(hashtext('teamhub_migrations'))")
	provider, err := goose.NewProvider(goose.DialectPostgres, db, migrationFiles)
	if err != nil {
		return fmt.Errorf("prepare public migrations: %w", err)
	}
	if _, err := provider.Up(ctx); err != nil {
		return fmt.Errorf("apply migrations: %w", err)
	}
	return nil
}
