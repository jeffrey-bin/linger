package config

import (
	"testing"
	"time"
)

func TestShutdownBudgetConfiguration(t *testing.T) {
	cfg := Default()
	if cfg.ShutdownTimeout != 20*time.Second || cfg.ShutdownHTTPTimeout != 10*time.Second {
		t.Fatal("unexpected shutdown defaults")
	}
	cfg.DatabaseURL = "postgres://test/test"
	cfg.ShutdownHTTPTimeout = cfg.ShutdownTimeout
	if err := validate(&cfg); err == nil {
		t.Fatal("budget leaves no cleanup time")
	}
}
