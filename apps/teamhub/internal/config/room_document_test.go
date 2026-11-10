package config

import (
	"testing"
	"time"
)

func TestLoadRoomDocumentDefaults(t *testing.T) {
	clearTeamHubEnvironment(t)
	t.Setenv("TEAMHUB_DATABASE_URL", "postgres://environment.example/teamhub")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}

	want := RoomDocumentConfig{
		AssetUploadStagingRetention: 24 * time.Hour,
		AssetGCGrace:                24 * time.Hour,
	}
	if cfg.RoomDocument != want {
		t.Fatalf("RoomDocument=%+v want=%+v", cfg.RoomDocument, want)
	}
}

func TestLoadRoomDocumentEnvironmentOverrides(t *testing.T) {
	clearTeamHubEnvironment(t)
	t.Setenv("TEAMHUB_DATABASE_URL", "postgres://environment.example/teamhub")
	values := map[string]string{
		"TEAMHUB_DOCUMENT_RUNTIME_URL": "https://runtime.environment.test",
		"LINGER_SECRET_SEED":           testSecretSeed,
	}
	for name, value := range values {
		t.Setenv(name, value)
	}

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	want := defaultRoomDocumentConfig()
	want.RuntimeURL = "https://runtime.environment.test"
	if cfg.RoomDocument != want {
		t.Fatalf("RoomDocument=%+v want=%+v", cfg.RoomDocument, want)
	}
}

func TestLoadRejectsInvalidRoomDocumentRuntimeConfiguration(t *testing.T) {
	for name, environment := range map[string]map[string]string{
		"URL without seed": {
			"TEAMHUB_DOCUMENT_RUNTIME_URL": "https://runtime.example.test",
		},
		"URL with path": {
			"TEAMHUB_DOCUMENT_RUNTIME_URL": "https://runtime.example.test/internal",
			"LINGER_SECRET_SEED":           testSecretSeed,
		},
	} {
		t.Run(name, func(t *testing.T) {
			clearTeamHubEnvironment(t)
			t.Setenv("TEAMHUB_DATABASE_URL", "postgres://environment.example/teamhub")
			for key, value := range environment {
				t.Setenv(key, value)
			}
			if _, err := Load(); err == nil {
				t.Fatal("Load accepted invalid Document Runtime configuration")
			}
		})
	}
}
