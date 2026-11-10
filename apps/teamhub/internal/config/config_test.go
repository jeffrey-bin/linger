package config

import (
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
)

var teamhubEnvironment = []string{
	"TEAMHUB_PERMISSION_REVIEW",
	"TEAMHUB_TRUSTED_PROXIES",
	"TEAMHUB_HTTP_ADDRESS",
	"TEAMHUB_DATABASE_URL",
	"TEAMHUB_DOCUMENT_RUNTIME_URL",
	"TEAMHUB_NODE_SERVICES_URL",
	"AGENT_RUNNER_PUBLIC_GATEWAY_URL",
	"LINGER_SECRET_SEED",
	"TEAMHUB_ARTIFACT_STORAGE_ROOT",
	"TEAMHUB_DOCUMENT_PREVIEW_PUBLIC_ORIGIN",
	"COMPOSIO_API_KEY",
	"TEAMHUB_COMPOSIO_ENVIRONMENT_KEY",
	"WEB_PUBLIC_ORIGIN",
	"SONIOX_API_KEY",
	"LIVEKIT_URL",
	"LIVEKIT_API_URL",
	"LIVEKIT_API_KEY",
	"LIVEKIT_API_SECRET",
}

func TestLoadMigrationDefaults(t *testing.T) {
	clearTeamHubEnvironment(t)
	t.Setenv("TEAMHUB_DATABASE_URL", "postgres://environment.example/teamhub")

	cfg, err := LoadMigration()
	if err != nil {
		t.Fatalf("LoadMigration() error = %v", err)
	}
	if cfg.DatabaseURL != "postgres://environment.example/teamhub" {
		t.Fatalf("DatabaseURL = %q", cfg.DatabaseURL)
	}
}

func TestLoadMigrationRequiresDatabaseURL(t *testing.T) {
	clearTeamHubEnvironment(t)
	if _, err := LoadMigration(); err == nil {
		t.Fatal("LoadMigration() error = nil, want missing database URL")
	}
}

func TestLoadDefaultsAndEnvironmentCompatibility(t *testing.T) {
	clearTeamHubEnvironment(t)
	t.Setenv("TEAMHUB_DATABASE_URL", "postgres://environment.example/teamhub")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}

	if cfg.DatabaseURL != "postgres://environment.example/teamhub" || cfg.HTTPAddress != "127.0.0.1:8080" {
		t.Fatalf("unexpected base config: %+v", cfg)
	}
	if cfg.SessionTTL != 30*24*time.Hour || cfg.CookieSecure {
		t.Fatalf("unexpected session defaults: %+v", cfg)
	}
	if cfg.SSEHeartbeatInterval != 15*time.Second || cfg.SSEQueueCapacity != 64 || cfg.SSEReplayBatchSize != 200 {
		t.Fatalf("unexpected SSE defaults: %+v", cfg)
	}
	if cfg.ArtifactStorageRoot != ".local/teamhub/artifacts" || cfg.ArtifactMaxBytes != 50<<20 || cfg.DocumentPreviewPublicOrigin != "http://localhost:8080" {
		t.Fatalf("unexpected artifact defaults: %+v", cfg)
	}
	if cfg.CaptureMaxBytes != 1<<30 {
		t.Fatalf("unexpected Capture default: %+v", cfg)
	}
	if cfg.ExternalApps.MaxRetryAfter != 10*time.Second {
		t.Fatalf("unexpected external source defaults: %+v", cfg)
	}
	if cfg.ExternalApps.AppImportProviderCallBudget != 100 {
		t.Fatalf("unexpected app import defaults: %+v", cfg)
	}
	if cfg.ExternalApps.ComposioEnvironmentKey != "default" {
		t.Fatalf("unexpected Composio environment key default: %q", cfg.ExternalApps.ComposioEnvironmentKey)
	}
	if cfg.PublicWebURL != "http://localhost:3000" || cfg.CookieSecure {
		t.Fatalf("unexpected public URL default: %q secure=%v", cfg.PublicWebURL, cfg.CookieSecure)
	}
	if cfg.NodeServicesURL != "" {
		t.Fatalf("Node Services URL defaulted without a secret seed: %q", cfg.NodeServicesURL)
	}
	if !reflect.DeepEqual(cfg.CORSAllowedOrigins, []string{"http://localhost:3000", "http://127.0.0.1:3000"}) {
		t.Fatalf("unexpected default CORS origins: %v", cfg.CORSAllowedOrigins)
	}
}

func TestLoadDerivesCookieSecureAndCORSFromPublicURL(t *testing.T) {
	clearTeamHubEnvironment(t)
	t.Setenv("TEAMHUB_DATABASE_URL", "postgres://environment.example/teamhub")
	t.Setenv("WEB_PUBLIC_ORIGIN", "https://App.Example.test/")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PublicWebURL != "https://app.example.test" || !cfg.CookieSecure || !reflect.DeepEqual(cfg.CORSAllowedOrigins, []string{"https://app.example.test"}) {
		t.Fatalf("unexpected derived settings: %+v", cfg)
	}
}

func TestLoadAddsLoopbackCORSVariants(t *testing.T) {
	for _, publicURL := range []string{"http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"} {
		t.Run(publicURL, func(t *testing.T) {
			clearTeamHubEnvironment(t)
			t.Setenv("TEAMHUB_DATABASE_URL", "postgres://environment.example/teamhub")
			t.Setenv("WEB_PUBLIC_ORIGIN", publicURL)
			cfg, err := Load()
			if err != nil {
				t.Fatal(err)
			}
			if cfg.CookieSecure {
				t.Fatal("http public URL must not set secure cookies")
			}
			for _, want := range []string{publicURL, "http://localhost:3000", "http://127.0.0.1:3000"} {
				if !slices.Contains(cfg.CORSAllowedOrigins, want) {
					t.Fatalf("CORS origins %v missing %s", cfg.CORSAllowedOrigins, want)
				}
			}
			seen := map[string]bool{}
			for _, origin := range cfg.CORSAllowedOrigins {
				if seen[origin] {
					t.Fatalf("duplicate CORS origin %s in %v", origin, cfg.CORSAllowedOrigins)
				}
				seen[origin] = true
			}
		})
	}
}

func TestLoadRejectsInvalidPublicURL(t *testing.T) {
	for _, value := range []string{"https://app.example.test/path", "https://user:pw@app.example.test", "https://app.example.test?x=1", "ftp://app.example.test", "app.example.test"} {
		t.Run(value, func(t *testing.T) {
			clearTeamHubEnvironment(t)
			t.Setenv("TEAMHUB_DATABASE_URL", "postgres://environment.example/teamhub")
			t.Setenv("WEB_PUBLIC_ORIGIN", value)
			if _, err := Load(); err == nil || !strings.Contains(err.Error(), "WEB_PUBLIC_ORIGIN") {
				t.Fatalf("Load error = %v", err)
			}
		})
	}
}

func TestLoadSonioxKeyTurnsVoiceMediaOnWithSecretSeed(t *testing.T) {
	clearTeamHubEnvironment(t)
	t.Setenv("TEAMHUB_DATABASE_URL", "postgres://environment.example/teamhub")
	t.Setenv("SONIOX_API_KEY", "soniox-secret")
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "LINGER_SECRET_SEED") {
		t.Fatalf("Soniox without a seed error = %v", err)
	}
	t.Setenv("LINGER_SECRET_SEED", testSecretSeed)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Voice.SonioxAPIKey != "soniox-secret" || cfg.Voice.RuntimeToken != ServiceCredential(testSecretSeed, "voice-runtime") {
		t.Fatalf("unexpected voice config: %+v", cfg)
	}
	if cfg.Voice.LiveKitURL != "ws://127.0.0.1:17880" || cfg.Voice.LiveKitAPIURL != "http://127.0.0.1:17880" || cfg.Voice.LiveKitAPIKey != "devkey" || cfg.Voice.LiveKitAPISecret != "devsecret-livekit-voice-local-only-32-bytes" {
		t.Fatalf("unexpected LiveKit defaults: %+v", cfg)
	}
}

func TestLoadLiveKitEnvironment(t *testing.T) {
	clearTeamHubEnvironment(t)
	t.Setenv("TEAMHUB_DATABASE_URL", "postgres://environment.example/teamhub")
	t.Setenv("LIVEKIT_URL", "wss://livekit.example.test")
	t.Setenv("LIVEKIT_API_KEY", "key")
	t.Setenv("LIVEKIT_API_SECRET", "secret")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Voice.LiveKitURL != "wss://livekit.example.test" || cfg.Voice.LiveKitAPIURL != "https://livekit.example.test" || cfg.Voice.LiveKitAPIKey != "key" || cfg.Voice.LiveKitAPISecret != "secret" {
		t.Fatalf("unexpected LiveKit config: %+v", cfg)
	}
	for _, value := range []string{"https://livekit.example.test", "wss://user:pass@livekit.example.test", "wss://livekit.example.test/rtc", "wss://livekit.example.test?x=1", "livekit.example.test"} {
		t.Setenv("LIVEKIT_URL", value)
		if _, err := Load(); err == nil || !strings.Contains(err.Error(), "LIVEKIT_URL") {
			t.Fatalf("LIVEKIT_URL %q error = %v", value, err)
		}
	}
}

func TestLoadLiveKitAPIURLOverridesTheBrowserOrigin(t *testing.T) {
	clearTeamHubEnvironment(t)
	t.Setenv("TEAMHUB_DATABASE_URL", "postgres://environment.example/teamhub")
	t.Setenv("LIVEKIT_API_URL", "http://livekit:7880")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Voice.LiveKitURL != "ws://127.0.0.1:17880" || cfg.Voice.LiveKitAPIURL != "http://livekit:7880" {
		t.Fatalf("unexpected LiveKit addresses: %+v", cfg.Voice)
	}
	for _, value := range []string{"ws://livekit:7880", "http://livekit:7880/twirp", "livekit:7880"} {
		t.Setenv("LIVEKIT_API_URL", value)
		if _, err := Load(); err == nil || !strings.Contains(err.Error(), "LIVEKIT_API_URL") {
			t.Fatalf("LIVEKIT_API_URL %q error = %v", value, err)
		}
	}
}

func TestLoadRunnerGatewayTurnsEnrollmentOnWithSecretSeed(t *testing.T) {
	clearTeamHubEnvironment(t)
	t.Setenv("TEAMHUB_DATABASE_URL", "postgres://environment.example/teamhub")
	t.Setenv("AGENT_RUNNER_PUBLIC_GATEWAY_URL", " wss://agent.example.test/v1/runner-gateway ")
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "LINGER_SECRET_SEED") {
		t.Fatalf("Runner Gateway without a seed error = %v", err)
	}
	t.Setenv("LINGER_SECRET_SEED", testSecretSeed)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.RunnerGatewayURL != "wss://agent.example.test/v1/runner-gateway" || cfg.RunnerSigningKey != ServiceCredential(testSecretSeed, "runner-signing") {
		t.Fatalf("unexpected Runner Gateway config: %q %q", cfg.RunnerGatewayURL, cfg.RunnerSigningKey)
	}
	t.Setenv("AGENT_RUNNER_PUBLIC_GATEWAY_URL", "https://agent.example.test/v1/runner-gateway")
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "AGENT_RUNNER_PUBLIC_GATEWAY_URL") {
		t.Fatalf("non-WebSocket Runner Gateway error = %v", err)
	}
}

func TestLoadRejectsNodeServicesURLWithPath(t *testing.T) {
	clearTeamHubEnvironment(t)
	t.Setenv("TEAMHUB_DATABASE_URL", "postgres://environment.example/teamhub")
	t.Setenv("LINGER_SECRET_SEED", testSecretSeed)
	t.Setenv("TEAMHUB_NODE_SERVICES_URL", "https://node-services.example.test/mcp")
	if _, err := Load(); err == nil {
		t.Fatal("Load accepted a Node Services URL with a path")
	}
}

func TestLoadAllExistingEnvironmentOverrides(t *testing.T) {
	clearTeamHubEnvironment(t)
	values := map[string]string{
		"TEAMHUB_HTTP_ADDRESS":                   "127.0.0.1:9091",
		"TEAMHUB_DATABASE_URL":                   "postgres://environment.example/teamhub",
		"TEAMHUB_NODE_SERVICES_URL":              "https://node-services.environment.test/",
		"LINGER_SECRET_SEED":                     testSecretSeed,
		"WEB_PUBLIC_ORIGIN":                      "https://teamhub.environment.test",
		"TEAMHUB_ARTIFACT_STORAGE_ROOT":          "environment-artifacts",
		"TEAMHUB_DOCUMENT_PREVIEW_PUBLIC_ORIGIN": "https://preview.environment.test",
		"COMPOSIO_API_KEY":                       "test-composio-key",
		"TEAMHUB_COMPOSIO_ENVIRONMENT_KEY":       "ci",
	}
	for name, value := range values {
		t.Setenv(name, value)
	}

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.HTTPAddress != "127.0.0.1:9091" || cfg.DatabaseURL != values["TEAMHUB_DATABASE_URL"] {
		t.Fatalf("unexpected core environment config: %+v", cfg)
	}
	if !cfg.CookieSecure || cfg.DocumentPreviewPublicOrigin != "https://preview.environment.test" {
		t.Fatalf("unexpected HTTP environment config: %+v", cfg)
	}

	if cfg.NodeServicesURL != "https://node-services.environment.test" || cfg.AgentRunTokenSecret != ServiceCredential(testSecretSeed, "agent-run-token") || cfg.PublicWebURL != "https://teamhub.environment.test" || cfg.NodeServicesInternalToken != ServiceCredential(testSecretSeed, "node-services-internal") || cfg.TeamHubInternalToken != ServiceCredential(testSecretSeed, "teamhub-internal") || cfg.ArtifactStorageRoot != "environment-artifacts" {
		t.Fatalf("unexpected service environment config: %+v", cfg)
	}
	if cfg.ExternalApps.ComposioAPIKey != "test-composio-key" || cfg.ExternalApps.ComposioEnvironmentKey != "ci" {
		t.Fatalf("unexpected Composio environment config: %+v", cfg)
	}
	if !reflect.DeepEqual(cfg.CORSAllowedOrigins, []string{"https://teamhub.environment.test"}) {
		t.Fatalf("unexpected CORS environment config: %+v", cfg)
	}
}

func TestLoadDefaultsServiceURLsWhenOnlyTheSeedIsSet(t *testing.T) {
	clearTeamHubEnvironment(t)
	t.Setenv("TEAMHUB_DATABASE_URL", "postgres://environment.example/teamhub")
	t.Setenv("LINGER_SECRET_SEED", testSecretSeed)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.NodeServicesURL != "http://127.0.0.1:4319" || cfg.RoomDocument.RuntimeURL != "http://127.0.0.1:4321" {
		t.Fatalf("unexpected single-host service URLs: node-services=%q document=%q",
			cfg.NodeServicesURL, cfg.RoomDocument.RuntimeURL)
	}

	t.Setenv("TEAMHUB_NODE_SERVICES_URL", "https://node-services.example.test")
	cfg, err = Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.NodeServicesURL != "https://node-services.example.test" {
		t.Fatalf("explicit Node Services URL was replaced by the default: %q", cfg.NodeServicesURL)
	}
}

func TestLoadRejectsInvalidConfiguration(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
	}{
		{name: "database required"},
		{name: "Node Services URL requires secret environment", env: map[string]string{"TEAMHUB_DATABASE_URL": "postgres://example", "TEAMHUB_NODE_SERVICES_URL": "https://node-services.example.test"}},
		{name: "Node Services URL cannot contain path", env: map[string]string{"TEAMHUB_DATABASE_URL": "postgres://example", "TEAMHUB_NODE_SERVICES_URL": "https://node-services.example.test/v1", "LINGER_SECRET_SEED": testSecretSeed}},
		{name: "Document preview URL must be an origin", env: map[string]string{"TEAMHUB_DATABASE_URL": "postgres://example", "TEAMHUB_DOCUMENT_PREVIEW_PUBLIC_ORIGIN": "https://preview.example.test/private"}},
		{name: "public URL must be an origin", env: map[string]string{"TEAMHUB_DATABASE_URL": "postgres://example", "WEB_PUBLIC_ORIGIN": "https://user@app.example.test/path"}},
		{name: "Artifact storage root required", env: map[string]string{"TEAMHUB_DATABASE_URL": "postgres://example", "TEAMHUB_ARTIFACT_STORAGE_ROOT": " "}},
		{name: "invalid Composio environment key", env: map[string]string{"TEAMHUB_DATABASE_URL": "postgres://example", "TEAMHUB_COMPOSIO_ENVIRONMENT_KEY": "Shared:Env"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			clearTeamHubEnvironment(t)
			for name, value := range tt.env {
				t.Setenv(name, value)
			}
			if _, err := Load(); err == nil {
				t.Fatal("Load accepted invalid configuration")
			}
		})
	}
}

func TestParseCORSAllowedOrigins(t *testing.T) {
	origins, err := ParseCORSAllowedOrigins(" https://APP.example.com,https://app.example.com/,http://localhost:3000 ")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"https://app.example.com", "http://localhost:3000"}
	if !reflect.DeepEqual(origins, want) {
		t.Fatalf("origins=%v want=%v", origins, want)
	}
	for _, value := range []string{"*", "https://app.example.com/path", "https://user:pass@app.example.com", "https://app.example.com?x=1"} {
		if _, err := ParseCORSAllowedOrigins(value); err == nil {
			t.Fatalf("ParseCORSAllowedOrigins(%q) unexpectedly succeeded", value)
		}
	}
}

func clearTeamHubEnvironment(t *testing.T) {
	t.Helper()
	for _, name := range teamhubEnvironment {
		t.Setenv(name, "")
	}
}

func TestTrustedProxyConfiguration(t *testing.T) {
	clearTeamHubEnvironment(t)
	t.Setenv("TEAMHUB_DATABASE_URL", "postgres://fixture.example/teamhub")
	t.Setenv("TEAMHUB_TRUSTED_PROXIES", "10.0.0.0/8,::1/128")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(cfg.TrustedProxies, []string{"10.0.0.0/8", "::1/128"}) {
		t.Fatalf("trusted proxies: %v", cfg.TrustedProxies)
	}
	t.Setenv("TEAMHUB_TRUSTED_PROXIES", "not-a-cidr")
	if _, err := Load(); err == nil {
		t.Fatal("invalid trusted proxy accepted")
	}
}

func TestPermissionReviewConfiguration(t *testing.T) {
	clearTeamHubEnvironment(t)
	t.Setenv("TEAMHUB_DATABASE_URL", "postgres://environment.example/teamhub")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PermissionReview.Enabled {
		t.Fatal("the permission judge must be opt-in")
	}
	t.Setenv("TEAMHUB_PERMISSION_REVIEW", "yes")
	if _, err = Load(); err == nil || !strings.Contains(err.Error(), "true or false") {
		t.Fatalf("a non-boolean switch must fail: %v", err)
	}
	t.Setenv("TEAMHUB_PERMISSION_REVIEW", "true")
	if _, err = Load(); err == nil {
		t.Fatal("the review requires the Agent Service link")
	}
	t.Setenv("LINGER_SECRET_SEED", testSecretSeed)
	cfg, err = Load()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.PermissionReview.Enabled || cfg.NodeServicesURL == "" {
		t.Fatalf("permission review not enabled via %q", cfg.NodeServicesURL)
	}
	t.Setenv("TEAMHUB_PERMISSION_REVIEW", "false")
	if cfg, err = Load(); err != nil || cfg.PermissionReview.Enabled {
		t.Fatalf("false must keep the review off: enabled=%v err=%v", cfg.PermissionReview.Enabled, err)
	}
}

// ForTest is the defaults plus the values tests need, then the caller's edits.
func TestForTestStartsFromDefaults(t *testing.T) {
	cfg := ForTest(func(cfg *Config) { cfg.DatabaseURL = "postgres://test.example/teamhub" })
	if cfg.DatabaseURL != "postgres://test.example/teamhub" || cfg.SessionTTL != DefaultSessionTTL ||
		cfg.Jobs.SoftStopTimeout != Default().Jobs.SoftStopTimeout {
		t.Fatalf("ForTest dropped a default or an edit: %+v", cfg)
	}
	if cfg.ArtifactStorageRoot == Default().ArtifactStorageRoot || cfg.DocumentPreviewPublicOrigin != "http://localhost:8080" ||
		cfg.Jobs.PollInterval >= Default().Jobs.PollInterval {
		t.Fatalf("ForTest root=%q origin=%q poll=%s", cfg.ArtifactStorageRoot, cfg.DocumentPreviewPublicOrigin, cfg.Jobs.PollInterval)
	}
}
