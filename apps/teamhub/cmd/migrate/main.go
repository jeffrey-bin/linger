package main

import (
	"context"
	"log/slog"
	"os"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/platform/migrations"
)

func main() {
	cfg, err := config.LoadMigration()
	if err != nil {
		slog.Error("load config", "error", err)
		os.Exit(1)
	}
	if err := migrations.Up(context.Background(), cfg.DatabaseURL); err != nil {
		slog.Error("migrate", "error", err)
		os.Exit(1)
	}
	slog.Info("database migrations complete")
}
