package provider

import (
	"encoding/json"
	"slices"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

func TestCodexDirectLocalToolsKeepsDaemonToolsOutOfCodeMode(t *testing.T) {
	config := json.RawMessage(`{"mcpServers":{"computer":{"url":"http://127.0.0.1:1/c"},"browser":{"url":"http://127.0.0.1:1/b"},"wiki":{"url":"https://example.com/mcp"}}}`)
	got, err := codexDirectLocalTools(config, []string{"mcp__computer__click", "mcp__browser__browser_snapshot"})
	if err != nil {
		t.Fatal(err)
	}
	var parsed struct {
		Servers map[string]map[string]any `json:"mcpServers"`
	}
	if err := json.Unmarshal(got, &parsed); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"computer", "browser"} {
		if omit, _ := json.Marshal(parsed.Servers[name]["omit_tools_from"]); string(omit) != `["code_mode","deferred"]` {
			t.Fatalf("%s: %v", name, parsed.Servers[name])
		}
	}
	if disabled, _ := parsed.Servers["computer"]["disabled_tools"].([]any); !slices.Contains(disabled, any("hotkey")) || parsed.Servers["browser"]["disabled_tools"] != nil {
		t.Fatalf("desktop inputs must go through run_actions: %v", parsed.Servers)
	}
	if _, found := parsed.Servers["wiki"]["omit_tools_from"]; found {
		t.Fatalf("a remote server left code mode: %v", parsed.Servers["wiki"])
	}
}

func TestCodexDirectToolsNeedAVerifiedCodex(t *testing.T) {
	for version, want := range map[string]bool{"codex-cli 0.163.0": true, "0.164.0": true, "0.162.9": false, "": false} {
		if native.CodexSupportsDirectTools(version) != want {
			t.Fatalf("%q: want %v", version, want)
		}
	}
}
