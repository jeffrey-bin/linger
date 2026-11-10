// Package database provides isolated PostgreSQL fixtures for business integration packages.
package database

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5"
)

// ControlConfig rejects any database outside the managed, sentinel-bound test run.
func ControlConfig(ctx context.Context) (*pgx.ConnConfig, error) {
	controlURL := os.Getenv("TEST_DATABASE_URL")
	if controlURL == "" {
		return nil, errors.New("TEST_DATABASE_URL is required")
	}
	runToken := os.Getenv("TEAMHUB_TEST_RUN_TOKEN")
	if runToken == "" {
		return nil, errors.New("TEAMHUB_TEST_RUN_TOKEN is required with TEST_DATABASE_URL")
	}
	controlConfig, err := pgx.ParseConfig(controlURL)
	if err != nil {
		return nil, fmt.Errorf("parse test control database URL: %w", err)
	}
	if controlConfig.Database != "teamhub_test_control" {
		return nil, fmt.Errorf("refusing non-test control database %q", controlConfig.Database)
	}
	control, err := pgx.ConnectConfig(ctx, controlConfig)
	if err != nil {
		return nil, fmt.Errorf("connect test control database: %w", err)
	}
	defer control.Close(context.Background())
	var storedToken string
	if err := control.QueryRow(ctx, "select run_token from teamhub_test_sentinel").Scan(&storedToken); err != nil {
		return nil, fmt.Errorf("test control database sentinel is missing: %w", err)
	}
	if storedToken != runToken {
		return nil, errors.New("test control database sentinel does not match this test run")
	}
	return controlConfig, nil
}
