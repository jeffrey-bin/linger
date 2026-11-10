package main

import (
	"context"
	"flag"
	"log/slog"
	"os"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
)

func main() {
	// Only the Connected Apps browser verification sets this, to reach its
	// disposable Composio adapter; deployments use the Composio API.
	composioBaseURL := flag.String("composio-base-url", "", "Composio API origin of a disposable test adapter")
	flag.Parse()
	signals, stop := shutdownSignals()
	defer stop()
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)
	cfg, err := config.Load()
	if err != nil {
		logger.Error("load configuration", "error", err)
		os.Exit(1) //nolint:gocritic // the process exits; releasing the signal context and timers first is unnecessary
	}
	cfg.ExternalApps.ComposioBaseURL = *composioBaseURL
	os.Exit(serve(signals, cfg, logger, func(ctx context.Context) (shutdownApplication, error) {
		application, err := app.New(ctx, cfg, app.Deps{})
		if err != nil {
			return nil, err
		}
		if err := application.StartWorkers(ctx, skippedWorkers(os.Getenv)...); err != nil {
			application.Close()
			return nil, err
		}
		return application, nil
	}))
}

// TEAMHUB_SKIP_STARTUP_SKILL_RECONCILIATION=1 skips built-in Skill and Agent
// template installation and the startup package audit. Only processes that never
// read built-in Skills use it: mirrord debugging and the Room Document E2E harness.
func skippedWorkers(environment func(string) string) []app.Worker {
	if environment("TEAMHUB_SKIP_STARTUP_SKILL_RECONCILIATION") == "1" {
		return []app.Worker{app.SkillInstall, app.SkillPackageProbe}
	}
	return nil
}
