package config

import (
	"crypto/hkdf"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/url"
	"os"
	"strings"
)

// SecretSeedMinLength is the shortest LINGER_SECRET_SEED accepted.
const SecretSeedMinLength = 32

const serviceCredentialSalt = "simplexai/service-credential/v1"

// developmentSecretSeed is the value .env.example and the root compose ship.
// Everyone has it, so credentials derived from it only protect loopback setups.
const developmentSecretSeed = "local-development-secret-seed-not-for-production"

// ServiceCredential derives one service link's credential from the secret
// seed. Every service derives the same value for the same label.
func ServiceCredential(seed, label string) string {
	key, err := hkdf.Key(sha256.New, []byte(seed), []byte(serviceCredentialSalt), label, 32)
	if err != nil {
		panic(err) // Only possible for an output longer than 255 hash blocks.
	}
	return base64.RawURLEncoding.EncodeToString(key)
}

// applyDerivedCredentials derives every service credential and TeamHub's own
// signing key from LINGER_SECRET_SEED. Without a seed every link
// stays off.
func applyDerivedCredentials(cfg *Config) error {
	seed := strings.TrimSpace(os.Getenv("LINGER_SECRET_SEED"))
	if seed == "" {
		return nil
	}
	if len(seed) < SecretSeedMinLength {
		return errors.New("LINGER_SECRET_SEED must be at least 32 characters")
	}
	for _, link := range []struct {
		credential *string
		label      string
	}{
		{&cfg.NodeServicesInternalToken, "node-services-internal"},
		{&cfg.TeamHubInternalToken, "teamhub-internal"},
		{&cfg.DocumentConnectionTokenKey, "document-connection-token"},
		{&cfg.AgentRunTokenSecret, "agent-run-token"},
		{&cfg.RunnerSigningKey, "runner-signing"},
		{&cfg.Voice.RuntimeToken, "voice-runtime"},
		{&cfg.SigningKey, "teamhub-signing"},
	} {
		*link.credential = ServiceCredential(seed, link.label)
	}
	if seed == developmentSecretSeed && !isLoopbackOrigin(cfg.PublicWebURL) {
		return errors.New("LINGER_SECRET_SEED is the public development seed; set a private seed when WEB_PUBLIC_ORIGIN is not localhost")
	}
	return nil
}

// isLoopbackOrigin reports whether origin points at this machine only. An
// unparsable origin is left to validate, which rejects it with its own error.
func isLoopbackOrigin(origin string) bool {
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" {
		return true
	}
	switch strings.ToLower(parsed.Hostname()) {
	case "localhost", "127.0.0.1", "::1":
		return true
	}
	return false
}
