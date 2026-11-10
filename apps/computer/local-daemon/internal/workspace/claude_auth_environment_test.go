package workspace

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestClaudeAuthEnvironmentOnlyInheritsAllowedSettings(t *testing.T) {
	stubClaudeKeychain(t, "")
	source := t.TempDir()
	allowed := map[string]string{
		"ANTHROPIC_API_KEY": "fixture-key", "ANTHROPIC_AUTH_TOKEN": "fixture-token",
		"ANTHROPIC_BASE_URL": "https://fixture.invalid", "ANTHROPIC_MODEL": "fixture-model",
	}
	for _, family := range []string{"HAIKU", "SONNET", "OPUS", "FABLE"} {
		allowed["ANTHROPIC_DEFAULT_"+family+"_MODEL"] = family + "-model"
		allowed["ANTHROPIC_DEFAULT_"+family+"_MODEL_NAME"] = family + " display"
	}
	values := make(map[string]any)
	for name, value := range allowed {
		values[name] = value
	}
	for _, name := range []string{"HOME", "CLAUDE_CONFIG_DIR", "LINGER_COMPUTER_TOKEN", "TEAMHUB_SERVICE_TOKEN", "CLAUDE_CODE_EFFORT_LEVEL", "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS", "NODE_OPTIONS", "ANTHROPIC_CUSTOM_UNKNOWN"} {
		values[name] = "must-not-inherit"
	}
	content, err := json.Marshal(map[string]any{"env": values, "hooks": map[string]any{"PreToolUse": "ignored"}, "permissions": map[string]any{"allow": []string{"Bash"}}, "enabledPlugins": map[string]bool{"fixture": true}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "settings.json"), content, 0o600); err != nil {
		t.Fatal(err)
	}
	environment := map[string]string{"ANTHROPIC_API_KEY": "explicit", "ANTHROPIC_AUTH_TOKEN": "", "HOME": "original-home"}
	if err := inheritClaudeAuthEnvironment(source, environment); err != nil {
		t.Fatal(err)
	}
	allowed["ANTHROPIC_API_KEY"] = "explicit"
	allowed["ANTHROPIC_AUTH_TOKEN"] = ""
	allowed["HOME"] = "original-home"
	if !reflect.DeepEqual(environment, allowed) {
		t.Fatal("authentication environment differs from explicit allowlist")
	}
}

func TestClaudeAuthEnvironmentMissingSettingsAndEnvAreCompatible(t *testing.T) {
	stubClaudeKeychain(t, "")
	source := t.TempDir()
	environment := map[string]string{"HOME": "retained"}
	if err := inheritClaudeAuthEnvironment(source, environment); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "settings.json"), []byte(`{"hooks":{}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := inheritClaudeAuthEnvironment(source, environment); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(environment, map[string]string{"HOME": "retained"}) {
		t.Fatal("missing authentication mutated environment")
	}
}

func TestClaudeAuthEnvironmentInvalidSettingsFailWithoutPartialMutation(t *testing.T) {
	stubClaudeKeychain(t, "")
	for _, content := range []string{
		`{`, `null`, `[]`, `{"env":null}`, `{"env":[]}`,
		`{"env":{"ANTHROPIC_API_KEY":"secret-fixture","ANTHROPIC_MODEL":42}}`,
		`{"env":{"ANTHROPIC_API_KEY":null}}`,
		strings.Repeat(" ", 1024*1024+1),
	} {
		source := t.TempDir()
		if err := os.WriteFile(filepath.Join(source, "settings.json"), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		environment := map[string]string{"ANTHROPIC_MODEL": "explicit"}
		err := inheritClaudeAuthEnvironment(source, environment)
		if err == nil {
			t.Fatal("invalid local settings accepted")
		}
		if strings.Contains(err.Error(), "secret-fixture") {
			t.Fatal("error exposed settings content")
		}
		if !reflect.DeepEqual(environment, map[string]string{"ANTHROPIC_MODEL": "explicit"}) {
			t.Fatal("invalid settings partially mutated environment")
		}
	}
}

func TestConfigureClaudeContextHomePrefersExplicitAuthSettings(t *testing.T) {
	stubClaudeKeychain(t, "")
	source, home, workspace := t.TempDir(), t.TempDir(), t.TempDir()
	credentials := []byte(`{"fixture":"oauth"}`)
	if err := os.WriteFile(filepath.Join(source, ".credentials.json"), credentials, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "settings.json"), []byte(`{"env":{"ANTHROPIC_AUTH_TOKEN":"fixture-token"},"hooks":{"PreToolUse":"ignored"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	environment := map[string]string{"CLAUDE_CONFIG_DIR": source}
	if _, err := ConfigureClaudeContextHome(home, workspace, environment, nil); err != nil {
		t.Fatal(err)
	}
	if environment["ANTHROPIC_AUTH_TOKEN"] != "fixture-token" || environment["CLAUDE_CONFIG_DIR"] != filepath.Join(home, ".claude") {
		t.Fatal("isolated config or auth environment missing")
	}
	if _, err := os.Stat(filepath.Join(home, ".claude", ".credentials.json")); !os.IsNotExist(err) {
		t.Fatal("explicit auth inherited an unrelated OAuth login")
	}
	if _, err := os.Stat(filepath.Join(home, ".claude", "settings.json")); !os.IsNotExist(err) {
		t.Fatal("local settings were copied wholesale")
	}
}
