package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/demodata"
)

// e2eIdentityMain runs the e2e-identity subcommand: it creates the explicit
// E2E Account named by TEAMHUB_E2E_* and prints its identity as JSON.
func e2eIdentityMain() {
	config, err := configFromEnvironment(os.Getenv)
	if err != nil || os.Getenv("TEAMHUB_DATABASE_URL") == "" {
		fail()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	result, err := demodata.SeedE2EIdentity(ctx, os.Getenv("TEAMHUB_DATABASE_URL"), config)
	if err != nil {
		fail()
	}
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		fail()
	}
}

func configFromEnvironment(getenv func(string) string) (demodata.E2EIdentityConfig, error) {
	enabled, err := strconv.ParseBool(getenv("TEAMHUB_E2E_IDENTITY_ENABLED"))
	if err != nil {
		return demodata.E2EIdentityConfig{}, err
	}
	return demodata.E2EIdentityConfig{
		Enabled:     enabled,
		RunID:       getenv("TEAMHUB_E2E_RUN_ID"),
		Email:       getenv("TEAMHUB_E2E_EMAIL"),
		Password:    getenv("TEAMHUB_E2E_PASSWORD"),
		DisplayName: getenv("TEAMHUB_E2E_DISPLAY_NAME"),
	}, nil
}

func fail() {
	fmt.Fprintln(os.Stderr, "E2E identity bootstrap failed")
	os.Exit(1)
}
