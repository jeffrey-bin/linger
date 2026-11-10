package main

import (
	"context"
	"log/slog"
	"os"
	"strconv"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/demodata"
)

// demoPassword is the password SeedIdentities gives alice@example.com.
const demoPassword = "teamhub-dev-alice" //nolint:gosec // G101: published local development password, not a secret

func main() {
	if len(os.Args) == 2 && os.Args[1] == "e2e-identity" {
		e2eIdentityMain()
		return
	}
	enabled, err := developmentSeedEnabled(os.Getenv("TEAMHUB_SEED_DEVELOPMENT_DATA"))
	if err != nil {
		slog.Error("read TEAMHUB_SEED_DEVELOPMENT_DATA", "error", err)
		os.Exit(1)
	}
	if !enabled {
		slog.Info("Playground development data seed is disabled")
		return
	}
	identitiesOnly, err := strconv.ParseBool(envOr("TEAMHUB_DEMO_IDENTITIES_ONLY", "false"))
	if err != nil {
		slog.Error("read TEAMHUB_DEMO_IDENTITIES_ONLY", "error", err)
		os.Exit(1)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	if err := demodata.SeedIdentities(ctx, os.Getenv("TEAMHUB_DATABASE_URL")); err != nil {
		slog.Error("seed development identities", "error", err)
		os.Exit(1) //nolint:gocritic // the process exits; releasing the signal context and timers first is unnecessary
	}
	if identitiesOnly {
		slog.Info("Development identities ready")
		return
	}
	err = demodata.Bootstrap(ctx, demodata.Config{
		BaseURL:  envOr("TEAMHUB_API_URL", "http://127.0.0.1:8080"),
		Email:    envOr("TEAMHUB_DEMO_EMAIL", "alice@example.com"),
		Password: demoPassword,
	})
	if err != nil {
		slog.Error("seed Playground development data", "error", err)
		os.Exit(1)
	}
	slog.Info("Playground development data ready")
}

func developmentSeedEnabled(value string) (bool, error) {
	if value == "" {
		return false, nil
	}
	return strconv.ParseBool(value)
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
