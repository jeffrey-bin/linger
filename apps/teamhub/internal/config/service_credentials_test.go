package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

const testSecretSeed = "test-seed-0123456789abcdef0123456789"

// TestServiceCredentialMatchesSharedVectors checks the vectors every
// TypeScript copy also asserts, so all four derivations agree.
func TestServiceCredentialMatchesSharedVectors(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "contracts", "fixtures", "service-credentials", "vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Salt    string `json:"salt"`
		Length  int    `json:"length"`
		Vectors []struct {
			Seed       string `json:"seed"`
			Label      string `json:"label"`
			Credential string `json:"credential"`
		} `json:"vectors"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Salt != serviceCredentialSalt || fixture.Length != 32 || len(fixture.Vectors) == 0 {
		t.Fatalf("unexpected vector fixture: salt=%q length=%d vectors=%d", fixture.Salt, fixture.Length, len(fixture.Vectors))
	}
	for _, vector := range fixture.Vectors {
		if got := ServiceCredential(vector.Seed, vector.Label); got != vector.Credential {
			t.Errorf("ServiceCredential(%q, %q) = %q, want %q", vector.Seed, vector.Label, got, vector.Credential)
		}
	}
}

func TestLoadRejectsDevelopmentSeedOnPublicOrigin(t *testing.T) {
	clearTeamHubEnvironment(t)
	t.Setenv("TEAMHUB_DATABASE_URL", "postgres://environment.example/teamhub")
	t.Setenv("LINGER_SECRET_SEED", developmentSecretSeed)
	for _, origin := range []string{"http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"} {
		t.Setenv("WEB_PUBLIC_ORIGIN", origin)
		if _, err := Load(); err != nil {
			t.Fatalf("development seed rejected for loopback origin %s: %v", origin, err)
		}
	}
	for _, origin := range []string{"https://team.example.com", "http://10.0.0.5:3000"} {
		t.Setenv("WEB_PUBLIC_ORIGIN", origin)
		if _, err := Load(); err == nil {
			t.Fatalf("development seed accepted for public origin %s", origin)
		}
	}

	t.Setenv("LINGER_SECRET_SEED", testSecretSeed)
	if _, err := Load(); err != nil {
		t.Fatalf("private seed rejected for public origin: %v", err)
	}
}

func TestLoadDerivesServiceCredentialsFromSecretSeed(t *testing.T) {
	clearTeamHubEnvironment(t)
	t.Setenv("TEAMHUB_DATABASE_URL", "postgres://environment.example/teamhub")
	t.Setenv("LINGER_SECRET_SEED", testSecretSeed)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.NodeServicesInternalToken != ServiceCredential(testSecretSeed, "node-services-internal") ||
		cfg.TeamHubInternalToken != ServiceCredential(testSecretSeed, "teamhub-internal") ||
		cfg.DocumentConnectionTokenKey != ServiceCredential(testSecretSeed, "document-connection-token") ||
		cfg.AgentRunTokenSecret != ServiceCredential(testSecretSeed, "agent-run-token") ||
		cfg.Voice.RuntimeToken != ServiceCredential(testSecretSeed, "voice-runtime") ||
		cfg.SigningKey != ServiceCredential(testSecretSeed, "teamhub-signing") {
		t.Fatal("service credentials were not derived from the secret seed")
	}
	if cfg.NodeServicesURL != "http://127.0.0.1:4319" || cfg.RoomDocument.RuntimeURL != "http://127.0.0.1:4321" {
		t.Fatalf("derived credentials did not enable single-host links: node-services=%q document=%q",
			cfg.NodeServicesURL, cfg.RoomDocument.RuntimeURL)
	}

	t.Setenv("LINGER_SECRET_SEED", "too-short")
	if _, err := Load(); err == nil {
		t.Fatal("a short secret seed was accepted")
	}
}
