package provider

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
)

const gatewayModelList = `{"object":"list","data":[
	{"id":"qwen","context_window":131072},
	{"id":"big","context_length":262144,"max_input_tokens":200000},
	{"id":"tiny","max_input_tokens":32768},
	{"id":"silent"},
	{"id":"odd","context_window":"131072"},
	{"id":"fraction","context_window":1.5e5},
	{"id":"huge","context_window":1000000000000}
]}`

func gatewayServer(t *testing.T, path, token string) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.Method != http.MethodGet || r.URL.Path != path {
			http.NotFound(w, r)
			return
		}
		if got := r.Header.Get("Authorization"); got != token {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(gatewayModelList))
	}))
	t.Cleanup(server.Close)
	return server, &hits
}

func writeGatewayFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func runtimeModels(ids ...string) []RuntimeModel {
	models := make([]RuntimeModel, 0, len(ids))
	for _, id := range ids {
		models = append(models, RuntimeModel{ID: id, Label: id, AllowedReasoningEffort: []string{}})
	}
	return models
}

// resolveContextLengths applies getModelLink the way discovery does.
func resolveContextLengths(t *testing.T, kind string, environment map[string]string, models []RuntimeModel) []RuntimeModel {
	t.Helper()
	getModelLink := newGetModelLink(t.Context(), kind, environment)
	for i := range models {
		link := getModelLink(models[i])
		models[i].Link, models[i].ContextWindow = link.link, link.window
	}
	return models
}

func assertLinks(t *testing.T, models []RuntimeModel, want map[string]string) {
	t.Helper()
	for _, model := range models {
		if model.Link != want[model.ID] {
			t.Fatalf("%s link = %q, want %q", model.ID, model.Link, want[model.ID])
		}
	}
}

func contextWindows(models []RuntimeModel) map[string]int {
	windows := map[string]int{}
	for _, model := range models {
		windows[model.ID] = model.ContextWindow
	}
	return windows
}

func assertContextWindows(t *testing.T, models []RuntimeModel, want map[string]int) {
	t.Helper()
	got := contextWindows(models)
	if len(got) != len(want) {
		t.Fatalf("context windows = %v, want %v", got, want)
	}
	for id, window := range want {
		if got[id] != window {
			t.Fatalf("context windows = %v, want %v", got, want)
		}
	}
}

func TestCodexContextWindowsComeFromTheCustomProviderGateway(t *testing.T) {
	server, _ := gatewayServer(t, "/v1/models", "Bearer env-secret")
	home := t.TempDir()
	writeGatewayFile(t, filepath.Join(home, "config.toml"), `
model_provider = "lab"
[model_providers.lab]
name = "Lab"
base_url = "`+server.URL+`/v1/"
env_key = "LAB_GATEWAY_KEY"
wire_api = "responses"
`)
	models := resolveContextLengths(t, "codex",
		map[string]string{"CODEX_HOME": home, "LAB_GATEWAY_KEY": "env-secret"},
		runtimeModels("qwen", "big", "tiny", "silent", "odd", "fraction", "huge", "unlisted"))
	assertContextWindows(t, models, map[string]int{
		"qwen": 131072, "big": 262144, "tiny": 32768,
		"silent": 0, "odd": 0, "fraction": 0, "huge": 0, "unlisted": 0,
	})
	assertLinks(t, models, map[string]string{
		"qwen": linkAPI, "big": linkAPI, "tiny": linkAPI,
		"silent": linkAPI, "odd": linkAPI, "fraction": linkAPI, "huge": linkAPI, "unlisted": linkAPI,
	})
}

func TestCodexProfileProviderAndBearerTokenChooseTheGateway(t *testing.T) {
	server, _ := gatewayServer(t, "/models", "Bearer inline-token")
	home := t.TempDir()
	writeGatewayFile(t, filepath.Join(home, "config.toml"), `
model_provider = "unused"
profile = "local"
[profiles.local]
model_provider = "lab"
[model_providers.lab]
base_url = "`+server.URL+`"
env_key = "LAB_GATEWAY_KEY"
experimental_bearer_token = "inline-token"
`)
	models := resolveContextLengths(t, "codex",
		map[string]string{"CODEX_HOME": home, "LAB_GATEWAY_KEY": "env-secret"}, runtimeModels("qwen"))
	assertContextWindows(t, models, map[string]int{"qwen": 131072})
}

func TestCodexSubscriptionLinkReadsOnlyItsOwnCatalog(t *testing.T) {
	_, hits := gatewayServer(t, "/models", "")
	home, user := t.TempDir(), t.TempDir()
	writeGatewayFile(t, filepath.Join(user, "catalog.json"),
		`{"models":[{"slug":"gpt-5.5","context_window":400000},{"slug":"odd","context_window":"1"}]}`)
	writeGatewayFile(t, filepath.Join(home, "config.toml"), `
model = "gpt-5.5"
model_catalog_json = "~/catalog.json"
`)
	models := resolveContextLengths(t, "codex", map[string]string{"CODEX_HOME": home, "HOME": user},
		runtimeModels("gpt-5.5", "odd", "gpt-5.6-sol"))
	assertContextWindows(t, models, map[string]int{"gpt-5.5": 400000, "odd": 0, "gpt-5.6-sol": 0})
	assertLinks(t, models, map[string]string{"gpt-5.5": linkSubscription, "odd": linkSubscription, "gpt-5.6-sol": linkSubscription})
	if hits.Load() != 0 {
		t.Fatalf("a subscription link listed gateway models %d times", hits.Load())
	}
}

func TestCodexSubscriptionWindowsComeFromTheModelsCacheItWrote(t *testing.T) {
	home := t.TempDir()
	writeGatewayFile(t, filepath.Join(home, "catalog.json"), `{"models":[{"slug":"gpt-5.5","context_window":400000}]}`)
	writeGatewayFile(t, filepath.Join(home, "config.toml"), `model_catalog_json = "catalog.json"`)
	writeGatewayFile(t, filepath.Join(home, "models_cache.json"), `{"fetched_at":"2026-11-09T09:00:00Z","models":[
		{"slug":"gpt-6.1-sol","context_window":500000,"max_context_window":872000},
		{"slug":"gpt-5.5","context_window":272000},
		{"slug":"odd","context_window":"1"}
	]}`)
	// The user's own catalog file decides a model it lists.
	models := resolveContextLengths(t, "codex", map[string]string{"CODEX_HOME": home},
		runtimeModels("gpt-6.1-sol", "gpt-5.5", "odd", "unlisted"))
	assertContextWindows(t, models, map[string]int{"gpt-6.1-sol": 500000, "gpt-5.5": 400000, "odd": 0, "unlisted": 0})
}

func TestCodexAPILinkFallsBackToItsCatalogWhenTheGatewayIsSilent(t *testing.T) {
	server, _ := gatewayServer(t, "/v1/models", "")
	home := t.TempDir()
	writeGatewayFile(t, filepath.Join(home, "assets", "catalog.json"),
		`{"models":[{"slug":"qwen","context_window":65536},{"slug":"silent","context_window":131072}]}`)
	writeGatewayFile(t, filepath.Join(home, "config.toml"), `
model_provider = "lab"
model_catalog_json = "assets/catalog.json"
[model_providers.lab]
base_url = "`+server.URL+`/v1"
`)
	models := resolveContextLengths(t, "codex", map[string]string{"CODEX_HOME": home}, runtimeModels("qwen", "silent"))
	assertContextWindows(t, models, map[string]int{"qwen": 131072, "silent": 131072})
}

func TestPiContextWindowsComeFromEachModelsProviderGateway(t *testing.T) {
	signed, signedHits := gatewayServer(t, "/v1/models", "Bearer pi-secret")
	unsigned, unsignedHits := gatewayServer(t, "/models", "")
	agentDir := t.TempDir()
	writeGatewayFile(t, filepath.Join(agentDir, "models.json"), `{"providers":{
		"local":{"baseUrl":"`+signed.URL+`/v1","api":"openai-completions","apiKey":"${PI_LOCAL_KEY}","models":[{"id":"qwen"}]},
		"literal":{"baseUrl":"`+unsigned.URL+`","apiKey":"!print-key"},
		"anthropic":{"apiKey":"ANTHROPIC_KEY"}
	}}`)
	// Pi declares a window for every model it lists; the API link's gateway
	// overrides it, and a subscription model keeps it.
	declared := runtimeModels("local/qwen", "local/big", "local/silent", "literal/tiny", "anthropic/claude", "openai/qwen")
	for i := range declared {
		declared[i].ContextWindow = 32768
	}
	declared[4].ContextWindow = 200000
	declared[5].ContextWindow = 0
	models := resolveContextLengths(t, "pi",
		map[string]string{"HOME": t.TempDir(), "PI_CODING_AGENT_DIR": agentDir, "PI_LOCAL_KEY": "pi-secret"}, declared)
	assertContextWindows(t, models, map[string]int{
		"local/qwen": 131072, "local/big": 262144, "local/silent": 32768, "literal/tiny": 32768,
		"anthropic/claude": 200000, "openai/qwen": 0,
	})
	assertLinks(t, models, map[string]string{
		"local/qwen": linkAPI, "local/big": linkAPI, "local/silent": linkAPI, "literal/tiny": linkAPI,
		"anthropic/claude": linkSubscription, "openai/qwen": linkSubscription,
	})
	if signedHits.Load() != 1 || unsignedHits.Load() != 1 {
		t.Fatalf("gateway lists = %d and %d, want one each", signedHits.Load(), unsignedHits.Load())
	}
}

func TestClaudeContextWindowsComeFromItsGateway(t *testing.T) {
	server, hits := gatewayServer(t, "/anthropic/v1/models", "Bearer claude-secret")
	config := t.TempDir()
	writeGatewayFile(t, filepath.Join(config, "settings.json"),
		`{"env":{"ANTHROPIC_BASE_URL":"`+server.URL+`/anthropic/","ANTHROPIC_AUTH_TOKEN":"claude-secret"}}`)
	// An alias is listed under the concrete model it runs, which may carry the
	// [1m] suffix Claude drops before it sends the name.
	models := runtimeModels("qwen", "default", "opus", "unlisted")
	models[1].resolved, models[2].resolved = "tiny[1m]", "big"
	models = resolveContextLengths(t, "claude", map[string]string{"CLAUDE_CONFIG_DIR": config}, models)
	assertContextWindows(t, models, map[string]int{"qwen": 131072, "default": 32768, "opus": 262144, "unlisted": 0})
	if hits.Load() != 1 {
		t.Fatalf("gateway lists = %d, want one", hits.Load())
	}
}

func TestClaudeAPIKeyIsSentAsClaudeSendsIt(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" || r.Header.Get("X-Api-Key") != "env-key" ||
			r.Header.Get("Anthropic-Version") == "" || r.Header.Get("Authorization") != "" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(gatewayModelList))
	}))
	t.Cleanup(server.Close)
	home := t.TempDir()
	// The environment's key wins over the one in the user's settings.
	writeGatewayFile(t, filepath.Join(home, ".claude", "settings.json"),
		`{"env":{"ANTHROPIC_BASE_URL":"`+server.URL+`","ANTHROPIC_API_KEY":"settings-key"}}`)
	models := resolveContextLengths(t, "claude", map[string]string{"HOME": home, "ANTHROPIC_API_KEY": "env-key"}, runtimeModels("tiny"))
	assertContextWindows(t, models, map[string]int{"tiny": 32768})
}

func TestClaudeWithoutAGatewayLeavesItsWindowsToClaude(t *testing.T) {
	home := t.TempDir()
	writeGatewayFile(t, filepath.Join(home, ".claude", "settings.json"), `{"env":{"ANTHROPIC_API_KEY":"vendor-key"}}`)
	models := resolveContextLengths(t, "claude", map[string]string{"HOME": home}, runtimeModels("claude-opus-5-5"))
	assertContextWindows(t, models, map[string]int{"claude-opus-5-5": 0})
}

// bifrostModelList is how Bifrost lists models: each under its provider, with
// the window in context_length, while requests name the model alone.
const bifrostModelList = `{"data":[
	{"id":"localmodels-llm/qwen-test","context_length":65536},
	{"id":"localmodels-llm/localmodels-agent","alias":"qwen-test","context_length":65536},
	{"id":"localmodels-llm/claude-localmodels-agent","alias":"qwen-test","context_length":65536},
	{"id":"a/shared","context_length":8192},
	{"id":"b/shared","context_length":16384},
	{"id":"own","context_length":4096},
	{"id":"p/own","context_length":262144},
	{"id":"silent"},
	{"id":"p/silent","context_length":32768}
]}`

func TestGatewayModelsListedUnderTheirProviderMatchTheBareID(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(bifrostModelList))
	}))
	t.Cleanup(server.Close)
	home := t.TempDir()
	writeGatewayFile(t, filepath.Join(home, "config.toml"), `
model_provider = "localmodels"
[model_providers.localmodels]
base_url = "`+server.URL+`/v1"
`)
	models := resolveContextLengths(t, "codex", map[string]string{"CODEX_HOME": home},
		runtimeModels("localmodels-agent", "claude-localmodels-agent", "qwen-test", "agent", "shared", "own", "silent"))
	// A model listed under its own id is that entry, stating a window or not;
	// a name two providers list, or only a longer one, stays unknown.
	assertContextWindows(t, models, map[string]int{
		"localmodels-agent": 65536, "claude-localmodels-agent": 65536, "qwen-test": 65536,
		"agent": 0, "shared": 0, "own": 4096, "silent": 0,
	})

	agentDir := t.TempDir()
	writeGatewayFile(t, filepath.Join(agentDir, "models.json"), `{"providers":{
		"localmodels":{"baseUrl":"`+server.URL+`/v1","api":"openai-completions","apiKey":"local","models":[{"id":"localmodels-agent"}]}
	}}`)
	models = resolveContextLengths(t, "pi",
		map[string]string{"HOME": t.TempDir(), "PI_CODING_AGENT_DIR": agentDir}, runtimeModels("localmodels/localmodels-agent"))
	assertContextWindows(t, models, map[string]int{"localmodels/localmodels-agent": 65536})
}

func TestUnavailableGatewayLeavesContextWindowsUnknown(t *testing.T) {
	server, _ := gatewayServer(t, "/v1/models", "Bearer right")
	home := t.TempDir()
	writeGatewayFile(t, filepath.Join(home, "config.toml"), `
model_provider = "lab"
[model_providers.lab]
base_url = "`+server.URL+`/v1"
experimental_bearer_token = "wrong"
`)
	models := resolveContextLengths(t, "codex", map[string]string{"CODEX_HOME": home}, runtimeModels("qwen"))
	assertContextWindows(t, models, map[string]int{"qwen": 0})
}

func TestClaudeGatewayLinkNeedsABaseURLAndAKeyForIt(t *testing.T) {
	settings := func(env string) map[string]string {
		configDir := t.TempDir()
		writeGatewayFile(t, filepath.Join(configDir, "settings.json"), `{"env":`+env+`}`)
		return map[string]string{"HOME": t.TempDir(), "CLAUDE_CONFIG_DIR": configDir}
	}
	// Nothing listens on port 1, so every window stays unknown.
	for name, test := range map[string]struct {
		environment map[string]string
		want        string
	}{
		"gateway token in settings": {settings(`{"ANTHROPIC_BASE_URL":"http://127.0.0.1:1/anthropic","ANTHROPIC_AUTH_TOKEN":"gateway-key"}`), linkAPI},
		"gateway key in settings":   {settings(`{"ANTHROPIC_BASE_URL":"http://127.0.0.1:1/anthropic","ANTHROPIC_API_KEY":"gateway-key"}`), linkAPI},
		"base URL alone signs in with the subscription": {
			settings(`{"ANTHROPIC_BASE_URL":"http://127.0.0.1:1/anthropic"}`), linkSubscription,
		},
		"vendor key without a gateway": {settings(`{"ANTHROPIC_API_KEY":"vendor-key"}`), linkSubscription},
		"the environment adds the key": {
			func() map[string]string {
				environment := settings(`{"ANTHROPIC_BASE_URL":"http://127.0.0.1:1/anthropic"}`)
				environment["ANTHROPIC_AUTH_TOKEN"] = "gateway-key"
				return environment
			}(),
			linkAPI,
		},
		"unreadable settings": {settings(`"not an object"`), linkSubscription},
	} {
		t.Run(name, func(t *testing.T) {
			models := resolveContextLengths(t, "claude", test.environment, runtimeModels("default", "localmodels-agent"))
			for _, model := range models {
				if model.Link != test.want || model.ContextWindow != 0 {
					t.Fatalf("%s = %s/%d, want %s", model.ID, model.Link, model.ContextWindow, test.want)
				}
			}
		})
	}
}

func TestPiConfigValueExpandsLikePi(t *testing.T) {
	environment := map[string]string{"KEY": "secret", "PREFIX": "sk"}
	for value, want := range map[string]string{
		"literal-key":    "literal-key",
		"$KEY":           "secret",
		"${KEY}":         "secret",
		"$PREFIX-${KEY}": "sk-secret",
		"KEY":            "KEY",
		"cost$$5":        "cost$5",
		"$!bang":         "!bang",
		"${not valid}":   "${not valid}",
		"${a $KEY}x":     "${a $KEY}x",
		"trailing$":      "trailing$",
		"$MISSING":       "",
		"!print-key":     "",
	} {
		if got := piConfigValue(value, environment); got != want {
			t.Errorf("piConfigValue(%q) = %q, want %q", value, got, want)
		}
	}
}
