package workspace

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/pelletier/go-toml/v2"
)

func projectionFixture(t *testing.T) (string, CodexHomeOptions) {
	t.Helper()
	parent := t.TempDir()
	source := filepath.Join(parent, "personal")
	if err := os.Mkdir(source, 0700); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(parent, "context"), CodexHomeOptions{SharedHome: source, UserHome: parent}
}
func projectionWrite(t *testing.T, path, value string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(value), 0600); err != nil {
		t.Fatal(err)
	}
}
func projectionRead(t *testing.T, path string) string {
	t.Helper()
	value, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(value)
}
func preparedSettings(t *testing.T, home string, opts CodexHomeOptions) map[string]any {
	t.Helper()
	if _, err := PrepareCodexHome(home, opts, nil); err != nil {
		t.Fatal(err)
	}
	var settings map[string]any
	if err := toml.Unmarshal([]byte(projectionRead(t, filepath.Join(home, "config.toml"))), &settings); err != nil {
		t.Fatal(err)
	}
	return settings
}
func TestProjectionUsesConfigTreeAndRetainsOnlyLocalSessionState(t *testing.T) {
	home, opts := projectionFixture(t)
	original := `model='fixture-model'
features={multi_agent=true, other=true}
[profiles.selected.features]
multi_agent=true
[[skills.config]]
name='uninstalled-plugin:skill'
enabled=false
`
	projectionWrite(t, filepath.Join(opts.SharedHome, "config.toml"), original)
	projectionWrite(t, filepath.Join(opts.SharedHome, "sessions", "foreign"), "private history")
	settings := preparedSettings(t, home, opts)
	if flags := settings["features"].(map[string]any); flags["multi_agent"] != true || flags["other"] != true {
		t.Fatal(flags)
	}
	profile := settings["profiles"].(map[string]any)["selected"].(map[string]any)
	if profile["features"].(map[string]any)["multi_agent"] != true {
		t.Fatal("profile lost the user's multi_agent feature")
	}
	if _, err := os.Stat(filepath.Join(home, "sessions", "foreign")); !os.IsNotExist(err) {
		t.Fatal("imported source history")
	}
	projectionWrite(t, filepath.Join(home, "sessions", "local"), "context transcript")
	next := preparedSettings(t, home, opts)
	if !reflect.DeepEqual(next, settings) {
		t.Fatal("projection accumulated edits")
	}
	if projectionRead(t, filepath.Join(home, "sessions", "local")) != "context transcript" {
		t.Fatal("lost local transcript")
	}
	if projectionRead(t, filepath.Join(opts.SharedHome, "config.toml")) != original {
		t.Fatal("source configuration changed")
	}
}
func TestProjectionRefreshesReferencesAndInvalidatesOnlyUnboundCache(t *testing.T) {
	home, opts := projectionFixture(t)
	catalog := filepath.Join(t.TempDir(), "catalog.json")
	projectionWrite(t, catalog, `{"models":[]}`)
	config := "model_catalog_json='" + filepath.ToSlash(catalog) + "'\nmodel_instructions_file='nested/rules.md'\n"
	projectionWrite(t, filepath.Join(opts.SharedHome, "config.toml"), config)
	projectionWrite(t, filepath.Join(opts.SharedHome, "nested", "rules.md"), "first instructions")
	projectionWrite(t, filepath.Join(opts.SharedHome, "models_cache.json"), "unbound user cache")
	settings := preparedSettings(t, home, opts)
	projected := settings["model_instructions_file"].(string)
	if !strings.HasPrefix(projected, filepath.Join(home, projectionAssets)+string(filepath.Separator)) {
		t.Fatal(projected)
	}
	if projectionRead(t, projected) != "first instructions" {
		t.Fatal("missing reference")
	}
	cache := filepath.Join(home, "models_cache.json")
	if _, err := os.Stat(cache); !os.IsNotExist(err) {
		t.Fatal("imported unbound cache")
	}
	projectionWrite(t, cache, "provider refresh")
	preparedSettings(t, home, opts)
	if projectionRead(t, cache) != "provider refresh" {
		t.Fatal("discarded bound cache")
	}
	projectionWrite(t, catalog, `{"models":[{"id":"changed"}]}`)
	preparedSettings(t, home, opts)
	if _, err := os.Stat(cache); !os.IsNotExist(err) {
		t.Fatal("reused cache after absolute catalog changed")
	}
	projectionWrite(t, filepath.Join(opts.SharedHome, "config.toml"), "model='new-provider'\n")
	preparedSettings(t, home, opts)
	if _, err := os.Stat(projected); !os.IsNotExist(err) {
		t.Fatal("retired instructions still stored")
	}
}
func TestProjectionFailsBeforeLaunchOnInvalidConfiguration(t *testing.T) {
	for _, config := range []string{"broken=[", "model_instructions_file='../outside'", "model_catalog_json='missing'"} {
		t.Run(config, func(t *testing.T) {
			home, opts := projectionFixture(t)
			projectionWrite(t, filepath.Join(opts.SharedHome, "config.toml"), config)
			projection, err := PrepareCodexHome(home, opts, nil)
			if args := projection.Args; err == nil || args != nil {
				t.Fatalf("unsafe launch admitted: %v %v", args, err)
			}
		})
	}
}
func TestProjectionDoesNotWriteThroughHomeOrDestinationLinks(t *testing.T) {
	home, opts := projectionFixture(t)
	elsewhere := t.TempDir()
	projectionWrite(t, filepath.Join(elsewhere, "config.toml"), "untouched")
	if err := os.Symlink(elsewhere, home); err != nil {
		t.Skipf("link privilege unavailable: %v", err)
	}
	if _, err := PrepareCodexHome(home, opts, nil); err == nil {
		t.Fatal("accepted linked home")
	}
	if err := os.Remove(home); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(home, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(elsewhere, "config.toml"), filepath.Join(home, "config.toml")); err != nil {
		t.Fatal(err)
	}
	preparedSettings(t, home, opts)
	if projectionRead(t, filepath.Join(elsewhere, "config.toml")) != "untouched" {
		t.Fatal("wrote through destination link")
	}
	if err := os.RemoveAll(filepath.Join(home, projectionAssets)); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(elsewhere, filepath.Join(home, projectionAssets)); err != nil {
		t.Fatal(err)
	}
	if _, err := PrepareCodexHome(home, opts, nil); err == nil {
		t.Fatal("accepted linked asset directory")
	}
}
func TestProjectionRemovesMissingAuthentication(t *testing.T) {
	home, opts := projectionFixture(t)
	auth := filepath.Join(opts.SharedHome, "auth.json")
	projectionWrite(t, auth, `{"synthetic":"credential"}`)
	preparedSettings(t, home, opts)
	if projectionRead(t, filepath.Join(home, "auth.json")) != projectionRead(t, auth) {
		t.Fatal("auth projection differs")
	}
	if err := os.Remove(auth); err != nil {
		t.Fatal(err)
	}
	preparedSettings(t, home, opts)
	if _, err := os.Lstat(filepath.Join(home, "auth.json")); !os.IsNotExist(err) {
		t.Fatal("retained stale auth")
	}
}

func TestCodexAuthRequiredForCustomProviders(t *testing.T) {
	custom := func(entry map[string]any) map[string]any {
		return map[string]any{
			"model_provider":  "ccswitch",
			"model_providers": map[string]any{"ccswitch": entry},
		}
	}
	cases := []struct {
		name     string
		settings map[string]any
		args     []string
		want     bool
	}{
		{"custom provider without requires flag", custom(map[string]any{"base_url": "x"}), nil, false},
		{"custom provider requires flag false", custom(map[string]any{"requires_openai_auth": false}), nil, false},
		{"custom provider requires flag true", custom(map[string]any{"requires_openai_auth": true}), nil, true},
		{"custom provider requires flag non-bool", custom(map[string]any{"requires_openai_auth": "false"}), nil, true},
		{"openai provider", map[string]any{"model_provider": "openai"}, nil, true},
		{"missing provider table", map[string]any{"model_provider": "ccswitch"}, nil, true},
		{"root profile may switch provider", map[string]any{
			"model_provider":  "ccswitch",
			"profile":         "work",
			"model_providers": map[string]any{"ccswitch": map[string]any{}},
		}, nil, true},
		{"config override arg", custom(map[string]any{}), []string{"-c", "model_provider=x"}, true},
		{"profile arg", custom(map[string]any{}), []string{"--profile", "x"}, true},
		{"short profile arg", custom(map[string]any{}), []string{"-p"}, true},
		{"no model provider", map[string]any{}, nil, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := codexAuthRequired(tc.settings, tc.args); got != tc.want {
				t.Fatalf("codexAuthRequired() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestProjectionSkipsAuthenticationForCustomNoAuthProvider(t *testing.T) {
	home, opts := projectionFixture(t)
	auth := filepath.Join(opts.SharedHome, "auth.json")
	projectionWrite(t, auth, `{"synthetic":"credential"}`)
	config := filepath.Join(opts.SharedHome, "config.toml")
	preparedSettings(t, home, opts)
	if projectionRead(t, filepath.Join(home, "auth.json")) != projectionRead(t, auth) {
		t.Fatal("default config did not project auth.json")
	}
	projectionWrite(t, config, `
model_provider = "ccswitch"

[model_providers.ccswitch]
base_url = "http://127.0.0.1:9"
requires_openai_auth = false
`)
	// The previously projected link must be removed when the provider changes.
	preparedSettings(t, home, opts)
	if _, err := os.Lstat(filepath.Join(home, "auth.json")); !os.IsNotExist(err) {
		t.Fatal("custom no-auth provider kept projected auth.json")
	}
	projectionWrite(t, config, `
model_provider = "ccswitch"

[model_providers.ccswitch]
base_url = "http://127.0.0.1:9"
requires_openai_auth = true
`)
	preparedSettings(t, home, opts)
	if projectionRead(t, filepath.Join(home, "auth.json")) != projectionRead(t, auth) {
		t.Fatal("provider requiring OpenAI auth did not project auth.json")
	}
	if projectionRead(t, auth) != `{"synthetic":"credential"}` {
		t.Fatal("source auth.json was modified")
	}
}
