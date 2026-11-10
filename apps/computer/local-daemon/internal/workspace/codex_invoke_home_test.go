package workspace

import (
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"

	"github.com/pelletier/go-toml/v2"
)

func TestCodexInvokeHomeKeepsOnlyProviderSelectionAndLinksAuthentication(t *testing.T) {
	home, opts := projectionFixture(t)
	projectionWrite(t, filepath.Join(opts.SharedHome, "config.toml"), `model = "fixture-model"
model_provider = "custom"
model_reasoning_effort = "xhigh"
approval_policy = "never"
sandbox_mode = "danger-full-access"
instructions = "Use the user's private instructions."
features = { multi_agent = true }
[model_providers.custom]
base_url = "https://models.example.invalid/v1"
requires_openai_auth = true
[profiles.fast]
model = "fixture-fast"
approval_policy = "never"
[profiles.fast.mcp_servers.secret]
command = "secret-server"
[mcp_servers.secret]
command = "secret-server"
[hooks]
pre = "hook"
[skills]
enabled = true
[plugins."browser@openai-bundled"]
enabled = true
`)
	for _, name := range []string{"AGENTS.md", "instructions.md", "AGENTS.override.md"} {
		projectionWrite(t, filepath.Join(opts.SharedHome, name), "private instructions")
	}
	projectionWrite(t, filepath.Join(opts.SharedHome, "auth.json"), `{"tokens":{}}`)

	result, err := PrepareCodexInvokeHome(home, opts.SharedHome, "", CodexModelsCachePeers{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Model != "fixture-model" || result.AuthenticationMissing {
		t.Fatalf("result = %+v", result)
	}
	var settings map[string]any
	if err := toml.Unmarshal([]byte(projectionRead(t, filepath.Join(home, "config.toml"))), &settings); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"model":          "fixture-model",
		"model_provider": "custom",
		"model_providers": map[string]any{"custom": map[string]any{
			"base_url": "https://models.example.invalid/v1", "requires_openai_auth": true,
		}},
		"profiles": map[string]any{"fast": map[string]any{"model": "fixture-fast"}},
	}
	if !reflect.DeepEqual(settings, want) {
		t.Fatalf("config.toml = %#v", settings)
	}
	entries, err := os.ReadDir(home)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	if !reflect.DeepEqual(names, []string{"auth.json", "config.toml"}) {
		t.Fatalf("home entries = %v", names)
	}
	if runtime.GOOS != "windows" {
		target, err := os.Readlink(filepath.Join(home, "auth.json"))
		if err != nil || target != filepath.Join(opts.SharedHome, "auth.json") {
			t.Fatalf("auth.json link = %q, %v", target, err)
		}
	}
}

func TestCodexInvokeHomeReportsMissingAuthentication(t *testing.T) {
	home, opts := projectionFixture(t)
	result, err := PrepareCodexInvokeHome(home, opts.SharedHome, "", CodexModelsCachePeers{})
	if err != nil {
		t.Fatal(err)
	}
	if !result.AuthenticationMissing || result.Model != "" {
		t.Fatalf("result = %+v", result)
	}

	// A provider that does not use the OpenAI sign-in needs no auth.json.
	other := filepath.Join(t.TempDir(), "home")
	projectionWrite(t, filepath.Join(opts.SharedHome, "config.toml"), `model_provider = "local"
[model_providers.local]
base_url = "http://127.0.0.1:1234/v1"
requires_openai_auth = false
`)
	result, err = PrepareCodexInvokeHome(other, opts.SharedHome, "", CodexModelsCachePeers{})
	if err != nil || result.AuthenticationMissing {
		t.Fatalf("result = %+v, %v", result, err)
	}
}

func TestCodexInvokeHomeRejectsTheSourceAsTarget(t *testing.T) {
	_, opts := projectionFixture(t)
	if _, err := PrepareCodexInvokeHome(opts.SharedHome, opts.SharedHome, "", CodexModelsCachePeers{}); err == nil {
		t.Fatal("the source home was accepted as the target")
	}
	if _, err := PrepareCodexInvokeHome("relative", opts.SharedHome, "", CodexModelsCachePeers{}); err == nil {
		t.Fatal("a relative target was accepted")
	}
}
