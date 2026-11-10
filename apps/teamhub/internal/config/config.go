// Package config parses and validates TeamHub's environment variable configuration.
package config

import (
	"errors"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/secretbox"
)

// A Session expires DefaultSessionTTL after its last renewal unless SessionTTL
// says otherwise, and never later than SessionMaxLifetime after login.
const (
	DefaultSessionTTL  = 30 * 24 * time.Hour
	SessionMaxLifetime = 90 * 24 * time.Hour
)

// Config collects the parsed runtime configuration that service components use.
type Config struct {
	ShutdownTimeout      time.Duration
	ShutdownHTTPTimeout  time.Duration
	HTTPAddress          string
	DatabaseURL          string
	SessionTTL           time.Duration
	CookieName           string
	CookieSecure         bool
	SSEHeartbeatInterval time.Duration
	SSEQueueCapacity     int
	SSEReplayBatchSize   int
	// NodeServicesURL is the one origin of the Node Services process, whose
	// Agent Service, LLM Wiki, and Memory roles share a listener.
	NodeServicesURL string
	// NodeServicesInternalToken is the one credential TeamHub presents on
	// every node-services-internal call: Agent management, Memory, LLM Wiki
	// and the Document Runtime.
	NodeServicesInternalToken string
	// TeamHubInternalToken is the one credential TeamHub accepts from Node
	// Services on teamhub-internal routes; Voice Runtime keeps its own.
	TeamHubInternalToken string
	// DocumentConnectionTokenKey signs the connection tokens the Document
	// Runtime verifies when a collaboration connection opens.
	DocumentConnectionTokenKey string
	AgentRunTokenSecret        string
	// RunnerGatewayURL is the public Runner Gateway address an enrolled
	// Computer receives; enrollment is off while it is empty.
	RunnerGatewayURL string
	// RunnerSigningKey signs the Runner Gateway credential that enrollment
	// issues; Agent Service derives the same key to verify it.
	RunnerSigningKey            string
	TrustedProxies              []string
	CORSAllowedOrigins          []string
	ArtifactStorageRoot         string
	ArtifactMaxBytes            int64
	DocumentPreviewPublicOrigin string
	// SigningKey signs the short-lived capabilities TeamHub hands to browsers:
	// Document preview URLs and message attachment upload credentials.
	SigningKey                  string
	CaptureMaxBytes             int64
	SkillPackageMaxArchiveBytes int64
	PublicWebURL                string
	// The optional features: each is assembled from its own group, and one
	// whose configuration is missing is not built.
	ExternalApps     ExternalAppsConfig
	PermissionReview PermissionReviewConfig
	Voice            VoiceConfig
	RoomDocument     RoomDocumentConfig
	// Jobs paces background work. No environment variable sets it; tests
	// shorten it.
	Jobs JobsConfig
}

// JobsConfig paces River and the sweeps and retries tests wait on.
type JobsConfig struct {
	// PollInterval is how often River fetches available jobs.
	PollInterval time.Duration
	// SoftStopTimeout is how long Close waits for running jobs before River
	// cancels them.
	SoftStopTimeout time.Duration
	// RiverTestOnly starts River leader maintenance without its staggered
	// delay. Only tests set it.
	RiverTestOnly bool
	// DocumentCommentSweepInterval is the safety-net sweep for Document comment
	// input; events enqueue it themselves.
	DocumentCommentSweepInterval time.Duration
	// SkillPackageProbeRetry is the first retry of a failed startup Skill
	// Package storage probe; later retries double up to ten minutes.
	SkillPackageProbeRetry time.Duration
}

// ExternalAppsConfig configures connected apps through Composio. The API key
// may also be saved on the Apps page, so the feature is decided at use time.
type ExternalAppsConfig struct {
	ComposioEnvironmentKey      string // prefixes each Composio user ID; deployments sharing a Composio project need distinct keys
	ComposioBaseURL             string // empty is the Composio API; tests point it at a fake provider
	ComposioAPIKey              string
	SecretEncryptionKey         string // base64 32-byte key; encrypts the Composio API key saved in the product
	MaxRetryAfter               time.Duration
	AppImportProviderCallBudget int
}

// PermissionReviewConfig configures the Runtime tool permission judge.
type PermissionReviewConfig struct {
	// Enabled is TEAMHUB_PERMISSION_REVIEW; the judge runs on the sponsor's
	// Agent Runtime through the Agent Service.
	Enabled bool
}

// VoiceConfig configures voice media.
type VoiceConfig struct {
	// XaiAPIKey turns Live Voice Mode on over LiveKit, independently of Soniox.
	XaiAPIKey string
	// SonioxAPIKey turns transcription on: Recording, Voice Mode dictation and
	// Pocket Notes dictation over LiveKit, with Soniox archive recovery for
	// recordings.
	SonioxAPIKey string
	// LiveKitURL is the ws(s) origin browsers dial. LiveKitAPIURL is where
	// TeamHub calls the LiveKit API: LIVEKIT_API_URL when TeamHub reaches
	// LiveKit at another address (the root docker-compose.yml), otherwise the
	// http(s) twin of LiveKitURL, derived in validate. The defaults match the
	// LiveKit service of the root docker-compose.yml.
	LiveKitURL       string
	LiveKitAPIURL    string
	LiveKitAPIKey    string
	LiveKitAPISecret string
	RuntimeToken     string
}

// MigrationConfig contains only the inputs required by the migration runner.
type MigrationConfig struct {
	DatabaseURL string
}

// Load applies code defaults, then environment overrides.
func Load() (Config, error) {
	cfg := Default()
	applyEnvironment(&cfg)
	if err := applyPermissionReview(&cfg); err != nil {
		return Config{}, err
	}
	if err := applyDerivedCredentials(&cfg); err != nil {
		return Config{}, err
	}
	applyLocalServiceDefaults(&cfg)
	if err := validate(&cfg); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// DefaultComposioEnvironmentKey prefixes Composio user IDs when a deployment
// sets no TEAMHUB_COMPOSIO_ENVIRONMENT_KEY.
const DefaultComposioEnvironmentKey = "default"

// applyLocalServiceDefaults points each configured service link at the
// single-host default port when only its credential is set, so local and
// single-machine deployments need no address settings. Split deployments
// still override the URL through the environment.
func applyLocalServiceDefaults(cfg *Config) {
	defaults := []struct {
		url        *string
		credential string
		local      string
	}{
		{&cfg.NodeServicesURL, cfg.NodeServicesInternalToken, "http://127.0.0.1:4319"},
		{&cfg.RoomDocument.RuntimeURL, cfg.NodeServicesInternalToken, "http://127.0.0.1:4321"},
	}
	for _, link := range defaults {
		if *link.url == "" && link.credential != "" {
			*link.url = link.local
		}
	}
	if cfg.DocumentPreviewPublicOrigin == "" {
		cfg.DocumentPreviewPublicOrigin = LocalPreviewOrigin(cfg.HTTPAddress)
	}
}

// LocalPreviewOrigin is the single-host Document preview origin: TeamHub
// itself on its listening port. A deployment names a separate origin through
// TEAMHUB_DOCUMENT_PREVIEW_PUBLIC_ORIGIN.
func LocalPreviewOrigin(httpAddress string) string {
	_, port, err := net.SplitHostPort(httpAddress)
	if err != nil || port == "" {
		port = "8080"
	}
	return "http://localhost:" + port
}

// LoadMigration reads the migration runner's narrow environment contract.
// Runtime settings are intentionally ignored so they cannot block migrations.
func LoadMigration() (MigrationConfig, error) {
	cfg := MigrationConfig{DatabaseURL: os.Getenv("TEAMHUB_DATABASE_URL")}
	if cfg.DatabaseURL == "" {
		return MigrationConfig{}, errors.New("TEAMHUB_DATABASE_URL is required")
	}
	return cfg, nil
}

// Fixed limits and timeouts no deployment configures. They are not part of
// Config, so neither the environment nor a test can change them.
const (
	PersonalWikiDispatchConcurrency  = 4
	PersonalWikiGenerationTimeout    = 4 * time.Hour // one Wiki generation, across many OpenWiki batches
	ExternalSourceRequestTimeout     = 20 * time.Second
	ExternalSourceFetchConcurrency   = 4
	GmailImportMaxThreadBytes        = 1 << 20
	GmailImportMaxBodyBytes          = 256 << 10
	GmailImportMaxBatchBytes         = 10 << 20
	AppImportMaxFieldBytes           = 256 << 10
	AppImportMaxDocumentBytes        = 1 << 20
	AppImportMaxBatchBytes           = 10 << 20
	ProfileGenerationTimeout         = 2 * time.Minute
	SkillPackageMaxFiles             = 256
	SkillPackageMaxFileBytes         = 8 << 20
	SkillPackageMaxTotalBytes        = 32 << 20
	VoiceMediaCredentialTTL          = 10 * time.Minute
	VoiceMediaSegmentDurationSeconds = 2
	VoiceMediaStartTimeout           = 15 * time.Second
	VoiceMediaStopTimeout            = 30 * time.Second
	VoiceArchiveRecoveryConcurrency  = 4
)

// ForTest returns a complete configuration for tests: the defaults with the
// values Load would derive, a temporary artifact root and a fast River poll.
// Each edit then changes what the test needs; the database URL is the caller's.
func ForTest(edits ...func(*Config)) Config {
	cfg := Default()
	cfg.ArtifactStorageRoot = filepath.Join(os.TempDir(), "teamhub-artifacts")
	cfg.DocumentPreviewPublicOrigin = LocalPreviewOrigin(cfg.HTTPAddress)
	cfg.Jobs.PollInterval = 25 * time.Millisecond
	for _, edit := range edits {
		edit(&cfg)
	}
	return cfg
}

// Default returns the configuration Load starts from before reading the
// environment.
func Default() Config {
	// CookieSecure and CORS origins are derived from WEB_PUBLIC_ORIGIN in validate.
	return Config{
		HTTPAddress:                 "127.0.0.1:8080",
		ShutdownTimeout:             20 * time.Second,
		ShutdownHTTPTimeout:         10 * time.Second,
		CookieName:                  "teamhub_session",
		SessionTTL:                  DefaultSessionTTL,
		SSEHeartbeatInterval:        15 * time.Second,
		SSEQueueCapacity:            64,
		SSEReplayBatchSize:          200,
		ArtifactStorageRoot:         ".local/teamhub/artifacts",
		ArtifactMaxBytes:            50 << 20,
		CaptureMaxBytes:             1 << 30,
		SkillPackageMaxArchiveBytes: 16 << 20,
		PublicWebURL:                "http://localhost:3000",
		ExternalApps: ExternalAppsConfig{
			ComposioEnvironmentKey:      DefaultComposioEnvironmentKey,
			MaxRetryAfter:               10 * time.Second,
			AppImportProviderCallBudget: 100,
		},
		Voice: VoiceConfig{
			LiveKitURL:       "ws://127.0.0.1:17880",
			LiveKitAPIKey:    "devkey",
			LiveKitAPISecret: "devsecret-livekit-voice-local-only-32-bytes",
		},
		RoomDocument: defaultRoomDocumentConfig(),
		Jobs: JobsConfig{
			// Every job that becomes due is notified, so the fetch poll
			// only recovers a notification lost while River's LISTEN connection
			// was down.
			PollInterval:    time.Minute,
			SoftStopTimeout: 10 * time.Second,
			// Mentions and thread changes enqueue comment input, and each Run is
			// scheduled again at its 24-hour limit. The sweep fails Runs whose
			// Agent lost read access and repairs a lost event job.
			DocumentCommentSweepInterval: time.Minute,
			SkillPackageProbeRetry:       30 * time.Second,
		},
	}
}

func applyEnvironment(cfg *Config) {
	setNonemptyEnvironment(&cfg.HTTPAddress, "TEAMHUB_HTTP_ADDRESS")
	setNonemptyEnvironment(&cfg.DatabaseURL, "TEAMHUB_DATABASE_URL")
	setNonemptyEnvironment(&cfg.NodeServicesURL, "TEAMHUB_NODE_SERVICES_URL")
	setNonemptyEnvironment(&cfg.RunnerGatewayURL, "AGENT_RUNNER_PUBLIC_GATEWAY_URL")
	setNonemptyEnvironment(&cfg.ArtifactStorageRoot, "TEAMHUB_ARTIFACT_STORAGE_ROOT")
	setNonemptyEnvironment(&cfg.DocumentPreviewPublicOrigin, "TEAMHUB_DOCUMENT_PREVIEW_PUBLIC_ORIGIN")
	setNonemptyEnvironment(&cfg.PublicWebURL, "WEB_PUBLIC_ORIGIN")
	setNonemptyEnvironment(&cfg.ExternalApps.ComposioEnvironmentKey, "TEAMHUB_COMPOSIO_ENVIRONMENT_KEY")
	setNonemptyEnvironment(&cfg.ExternalApps.ComposioAPIKey, "COMPOSIO_API_KEY")
	setNonemptyEnvironment(&cfg.ExternalApps.SecretEncryptionKey, "TEAMHUB_SECRET_ENCRYPTION_KEY")
	setNonemptyEnvironment(&cfg.Voice.SonioxAPIKey, "SONIOX_API_KEY")
	setNonemptyEnvironment(&cfg.Voice.XaiAPIKey, "XAI_API_KEY")
	setNonemptyEnvironment(&cfg.Voice.LiveKitURL, "LIVEKIT_URL")
	setNonemptyEnvironment(&cfg.Voice.LiveKitAPIURL, "LIVEKIT_API_URL")
	setNonemptyEnvironment(&cfg.Voice.LiveKitAPIKey, "LIVEKIT_API_KEY")
	setNonemptyEnvironment(&cfg.Voice.LiveKitAPISecret, "LIVEKIT_API_SECRET")

	if value := os.Getenv("TEAMHUB_TRUSTED_PROXIES"); value != "" {
		cfg.TrustedProxies = strings.Split(value, ",")
	}
	applyRoomDocumentEnvironment(&cfg.RoomDocument)
}

func validate(cfg *Config) error {
	if err := validatePublicURL(cfg); err != nil {
		return err
	}
	for _, value := range cfg.TrustedProxies {
		if _, err := netip.ParsePrefix(strings.TrimSpace(value)); err != nil {
			return errors.New("TEAMHUB_TRUSTED_PROXIES must contain IP CIDRs")
		}
	}

	if (strings.TrimSpace(cfg.Voice.SonioxAPIKey) != "" || strings.TrimSpace(cfg.Voice.XaiAPIKey) != "") && strings.TrimSpace(cfg.Voice.RuntimeToken) == "" {
		return errors.New("LINGER_SECRET_SEED is required when SONIOX_API_KEY or XAI_API_KEY turns voice media on")
	}
	liveKitURL, err := url.Parse(cfg.Voice.LiveKitURL)
	if err != nil || liveKitURL.Host == "" || liveKitURL.User != nil || (liveKitURL.Path != "" && liveKitURL.Path != "/") || liveKitURL.RawQuery != "" || liveKitURL.Fragment != "" || (liveKitURL.Scheme != "ws" && liveKitURL.Scheme != "wss") {
		return errors.New("LIVEKIT_URL must be an absolute ws or wss origin without credentials, path, query, or fragment")
	}
	derivedAPIURL := strings.Replace(liveKitURL.Scheme, "ws", "http", 1) + "://" + liveKitURL.Host
	if cfg.Voice.LiveKitAPIURL == "" {
		cfg.Voice.LiveKitAPIURL = derivedAPIURL
	}
	liveKitAPIURL, err := url.Parse(cfg.Voice.LiveKitAPIURL)
	if err != nil || liveKitAPIURL.Host == "" || liveKitAPIURL.User != nil || (liveKitAPIURL.Path != "" && liveKitAPIURL.Path != "/") || liveKitAPIURL.RawQuery != "" || liveKitAPIURL.Fragment != "" || (liveKitAPIURL.Scheme != "http" && liveKitAPIURL.Scheme != "https") {
		return errors.New("LIVEKIT_API_URL must be an absolute http or https origin without credentials, path, query, or fragment")
	}
	if cfg.ShutdownTimeout <= 0 || cfg.ShutdownHTTPTimeout <= 0 || cfg.ShutdownHTTPTimeout >= cfg.ShutdownTimeout {
		return errors.New("shutdown timeout must exceed the positive HTTP timeout")
	}
	if cfg.DatabaseURL == "" {
		return errors.New("TEAMHUB_DATABASE_URL is required")
	}
	if cfg.NodeServicesURL != "" {
		if cfg.NodeServicesInternalToken == "" || cfg.TeamHubInternalToken == "" || cfg.AgentRunTokenSecret == "" {
			return errors.New("LINGER_SECRET_SEED is required when TEAMHUB_NODE_SERVICES_URL is set")
		}
		parsed, err := url.Parse(cfg.NodeServicesURL)
		if err != nil || parsed.Scheme == "" || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil || (parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" {
			return fmt.Errorf("TEAMHUB_NODE_SERVICES_URL must be an absolute HTTP origin without credentials, path, query, or fragment: %q", cfg.NodeServicesURL)
		}
		cfg.NodeServicesURL = strings.TrimRight(cfg.NodeServicesURL, "/")
	}
	cfg.RunnerGatewayURL = strings.TrimSpace(cfg.RunnerGatewayURL)
	if cfg.RunnerGatewayURL != "" {
		if cfg.RunnerSigningKey == "" {
			return errors.New("LINGER_SECRET_SEED is required when AGENT_RUNNER_PUBLIC_GATEWAY_URL is set")
		}
		gateway, err := url.Parse(cfg.RunnerGatewayURL)
		if err != nil || gateway.Host == "" || (gateway.Scheme != "ws" && gateway.Scheme != "wss") || gateway.User != nil || gateway.RawQuery != "" || gateway.Fragment != "" {
			return errors.New("AGENT_RUNNER_PUBLIC_GATEWAY_URL must be an absolute ws or wss URL without credentials, query, or fragment")
		}
	}
	if strings.TrimSpace(cfg.ArtifactStorageRoot) == "" {
		return errors.New("TEAMHUB_ARTIFACT_STORAGE_ROOT must not be empty")
	}
	previewOrigin, err := url.Parse(cfg.DocumentPreviewPublicOrigin)
	if err != nil || previewOrigin.Scheme == "" || previewOrigin.Host == "" || previewOrigin.User != nil || previewOrigin.Path != "" || previewOrigin.RawQuery != "" || previewOrigin.Fragment != "" || (previewOrigin.Scheme != "http" && previewOrigin.Scheme != "https") {
		return errors.New("TEAMHUB_DOCUMENT_PREVIEW_PUBLIC_ORIGIN must be an HTTP origin without credentials, path, query, or fragment")
	}
	cfg.DocumentPreviewPublicOrigin = strings.TrimRight(cfg.DocumentPreviewPublicOrigin, "/")
	if valid, _ := regexp.MatchString(`^[a-z0-9][a-z0-9_-]{0,63}$`, cfg.ExternalApps.ComposioEnvironmentKey); !valid {
		return errors.New("TEAMHUB_COMPOSIO_ENVIRONMENT_KEY must match ^[a-z0-9][a-z0-9_-]{0,63}$")
	}
	if cfg.ExternalApps.SecretEncryptionKey != "" {
		if _, err := secretbox.New(cfg.ExternalApps.SecretEncryptionKey); err != nil {
			return errors.New("TEAMHUB_SECRET_ENCRYPTION_KEY must be 32 bytes in standard base64")
		}
	}
	// The judge runs through the Agent Service, which owns the Runtime link.
	if cfg.PermissionReview.Enabled && (cfg.NodeServicesURL == "" || cfg.NodeServicesInternalToken == "") {
		return errors.New("TEAMHUB_PERMISSION_REVIEW requires the Agent Service link (LINGER_SECRET_SEED)")
	}
	if cfg.RoomDocument.RuntimeURL != "" && (cfg.NodeServicesInternalToken == "" || cfg.TeamHubInternalToken == "") {
		return errors.New("LINGER_SECRET_SEED is required when TEAMHUB_DOCUMENT_RUNTIME_URL is set")
	}
	return validateRoomDocument(&cfg.RoomDocument)
}

// validatePublicURL canonicalizes WEB_PUBLIC_ORIGIN and derives the settings
// that follow the product's external address.
func validatePublicURL(cfg *Config) error {
	parsed, err := url.Parse(cfg.PublicWebURL)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil || (parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" {
		return errors.New("WEB_PUBLIC_ORIGIN must be an absolute HTTP origin without credentials, path, query, or fragment")
	}
	scheme := strings.ToLower(parsed.Scheme)
	cfg.PublicWebURL = scheme + "://" + strings.ToLower(parsed.Host)
	cfg.CookieSecure = scheme == "https"
	cfg.CORSAllowedOrigins = []string{cfg.PublicWebURL}
	switch strings.ToLower(parsed.Hostname()) {
	case "localhost", "127.0.0.1", "::1":
		for _, host := range []string{"localhost", "127.0.0.1"} {
			origin := scheme + "://" + host
			if port := parsed.Port(); port != "" {
				origin += ":" + port
			}
			if !slices.Contains(cfg.CORSAllowedOrigins, origin) {
				cfg.CORSAllowedOrigins = append(cfg.CORSAllowedOrigins, origin)
			}
		}
	}
	return nil
}

// ParseCORSAllowedOrigins parses and normalizes the exact HTTP(S) origin allowlist.
// TeamHub cross-origin requests can carry credentials, so wildcards, URL credentials, paths, queries, and fragments are rejected.
func ParseCORSAllowedOrigins(value string) ([]string, error) {
	parts := strings.Split(value, ",")
	origins := make([]string, 0, len(parts))
	seen := make(map[string]struct{}, len(parts))
	for _, part := range parts {
		origin := strings.TrimSpace(part)
		parsed, err := url.Parse(origin)
		if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil || (parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" {
			return nil, fmt.Errorf("invalid CORS origin %q: must be an absolute http(s) origin without credentials, path, query, or fragment", origin)
		}
		canonical := strings.ToLower(parsed.Scheme) + "://" + strings.ToLower(parsed.Host)
		if _, ok := seen[canonical]; ok {
			continue
		}
		seen[canonical] = struct{}{}
		origins = append(origins, canonical)
	}
	return origins, nil
}

// applyPermissionReview reads TEAMHUB_PERMISSION_REVIEW; unset or empty keeps
// the review off.
func applyPermissionReview(cfg *Config) error {
	value := strings.TrimSpace(os.Getenv("TEAMHUB_PERMISSION_REVIEW"))
	if value == "" {
		return nil
	}
	enabled, err := strconv.ParseBool(value)
	if err != nil {
		return errors.New("TEAMHUB_PERMISSION_REVIEW must be true or false")
	}
	cfg.PermissionReview.Enabled = enabled
	return nil
}

func setNonemptyEnvironment(target *string, name string) {
	if value := os.Getenv(name); value != "" {
		*target = value
	}
}
