package workspace

import (
	"context"
	"errors"
	"maps"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/pelletier/go-toml/v2"
)

func TestCodexProbeEnvironmentPreservesSelectedProviderAndPrivateLifetime(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	if err := os.Mkdir(source, 0o700); err != nil {
		t.Fatal(err)
	}
	config := "model_provider = \"selected\"\nmodel_catalog_json = \"models.json\"\n[model_providers.selected]\nbase_url = \"http://127.0.0.1:9/v1\"\nrequires_openai_auth = true\n"
	for name, body := range map[string]string{
		"config.toml": config,
		"auth.json":   `{"auth_mode":"apikey","OPENAI_API_KEY":"SYNTHETIC-NOT-A-CREDENTIAL"}`,
		"models.json": `{"models":[{"slug":"selected-model"}]}`,
	} {
		if err := os.WriteFile(filepath.Join(source, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	environment := map[string]string{"HOME": root, "CODEX_HOME": source, "PATH": "/selected/bin"}
	before := maps.Clone(environment)
	prepared, release, err := CodexProbeEnvironment(context.Background(), environment, "0.150.1", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(release)
	if !maps.Equal(environment, before) || prepared["HOME"] != root || prepared["PATH"] != environment["PATH"] || prepared["CODEX_HOME"] == source {
		t.Fatalf("probe changed the caller's selection: %+v", prepared)
	}
	home := prepared["CODEX_HOME"]
	info, err := os.Stat(home)
	if err != nil || (runtime.GOOS != "windows" && info.Mode().Perm() != 0o700) {
		t.Fatalf("probe home is not private: %v, %v", info, err)
	}
	data, err := os.ReadFile(filepath.Join(home, "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	var settings map[string]any
	if err := toml.Unmarshal(data, &settings); err != nil {
		t.Fatal(err)
	}
	if settings["model_provider"] != "selected" {
		t.Fatal("probe lost selected provider")
	}
	catalog, ok := settings["model_catalog_json"].(string)
	if !ok || !filepath.IsAbs(catalog) {
		t.Fatal("relative catalog was not projected")
	}
	if actual, err := os.ReadFile(catalog); err != nil || string(actual) != `{"models":[{"slug":"selected-model"}]}` {
		t.Fatal("probe changed the selected catalog")
	}
	original, err := os.Stat(filepath.Join(source, "auth.json"))
	if err != nil {
		t.Fatal(err)
	}
	projected, err := os.Stat(filepath.Join(home, "auth.json"))
	if err != nil || (runtime.GOOS != "windows" && !os.SameFile(original, projected)) {
		t.Fatal("probe did not retain the existing authentication reference")
	}
	release()
	if _, err := os.Stat(filepath.Dir(home)); !os.IsNotExist(err) {
		t.Fatalf("probe root survived release: %v", err)
	}
	if actual, err := os.ReadFile(filepath.Join(source, "config.toml")); err != nil || string(actual) != config {
		t.Fatal("probe changed source configuration")
	}
}

func TestCodexProbeEnvironmentCleansPreparationFailureAndHonorsCancellation(t *testing.T) {
	root := t.TempDir()
	t.Setenv("TMPDIR", root)
	t.Setenv("TMP", root)
	t.Setenv("TEMP", root)
	source := t.TempDir()
	if err := os.WriteFile(filepath.Join(source, "config.toml"), []byte("[malformed"), 0o600); err != nil {
		t.Fatal(err)
	}
	environment := map[string]string{"HOME": source, "CODEX_HOME": source}
	prepared, release, err := CodexProbeEnvironment(context.Background(), environment, "0.150.1", nil)
	if err == nil || prepared != nil || release != nil {
		t.Fatal("malformed selected configuration was accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := CodexProbeEnvironment(ctx, environment, "0.150.1", nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled probe preparation = %v", err)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() && strings.HasPrefix(entry.Name(), "linger-codex-probe-") {
			t.Fatal("failed preparation leaked its private root")
		}
	}
}
