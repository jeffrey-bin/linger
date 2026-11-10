package provider

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestDiscoverCodexUsesWritableProbeHomeFromReadOnlySource(t *testing.T) {
	options, source, trace := codexReadOnlyProbeFixture(t)
	before := codexProbeSourceSnapshot(t, source)
	result, err := Discover(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	row := result.Diagnostics[0]
	if row.Status != "ready" || len(row.Models) != 1 || row.Models[0].ID != "source-model" {
		t.Fatalf("read-only source diagnostic = %+v", row)
	}
	assertCodexProbeSourceAndCleanup(t, source, trace, before)
}

func TestRefreshCodexAuthenticationUsesWritableProbeHomeFromReadOnlySource(t *testing.T) {
	options, source, trace := codexReadOnlyProbeFixture(t)
	before := codexProbeSourceSnapshot(t, source)
	executable, err := filepath.EvalSymlinks(options.ConfiguredPaths["codex"])
	if err != nil {
		t.Fatal(err)
	}
	current := DiscoveryResult{Diagnostics: []RuntimeDiagnostic{{
		Type: "codex", Status: "ready", Protocol: "app-server", Version: "0.150.1",
		EntryPath: options.ConfiguredPaths["codex"], ExecutablePath: executable,
	}}}
	result, err := RefreshRuntimeAuthentication(context.Background(), current, options)
	if err != nil {
		t.Fatal(err)
	}
	if row := result.Diagnostics[0]; row.Status != "ready" {
		t.Fatalf("read-only source authentication = %+v", row)
	}
	assertCodexProbeSourceAndCleanup(t, source, trace, before)
}

func codexReadOnlyProbeFixture(t *testing.T) (DiscoveryOptions, string, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX process and read-only permissions")
	}
	root := t.TempDir()
	source := filepath.Join(root, "source")
	if err := os.Mkdir(source, 0o700); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"config.toml":  "model_provider = \"source-provider\"\nmodel_catalog_json = \"catalog.json\"\n[model_providers.source-provider]\nbase_url = \"http://127.0.0.1:9/v1\"\nwire_api = \"responses\"\nrequires_openai_auth = true\n",
		"auth.json":    `{"auth_mode":"apikey","OPENAI_API_KEY":"SYNTHETIC-NOT-A-CREDENTIAL"}`,
		"catalog.json": `{"data":[{"id":"source-model"}],"nextCursor":null}`,
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(source, name), []byte(body), 0o400); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Chmod(source, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(source, 0o700) })
	trace := filepath.Join(root, "trace")
	executable := filepath.Join(root, "codex")
	script := `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'codex-cli 0.150.1'; exit 0; fi
printf '%s\n' "$CODEX_HOME" >> "$PROBE_TRACE"
[ -r "$CODEX_HOME/auth.json" ] || exit 17
: > "$CODEX_HOME/probe-state" || exit 18
provider=false
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    *'source-provider'*) provider=true ;;
  esac
done < "$CODEX_HOME/config.toml"
[ "$provider" = true ] || exit 19
` + fakeCodexCatalogPath + `
read initialize
echo '{"id":1,"result":{"userAgent":"fixture"}}'
if read initialized && read request; then
  case "$request" in
    *'"method":"model/list"'*)
      printf '{"id":2,"result":'
      while IFS= read -r line || [ -n "$line" ]; do printf '%s' "$line"; done < "$catalog"
      echo '}' ;;
    *) echo '{"id":2,"result":{"account":{"type":"apiKey"},"requiresOpenaiAuth":true}}' ;;
  esac
fi
`
	if err := os.WriteFile(executable, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	return DiscoveryOptions{
		Runtimes: []string{"codex"}, ConfiguredPaths: map[string]string{"codex": executable},
		Environment: map[string]string{"PATH": root, "HOME": root, "CODEX_HOME": source, "PROBE_TRACE": trace},
		Timeout:     5 * time.Second,
	}, source, trace
}

func codexProbeSourceSnapshot(t *testing.T, source string) map[string]string {
	t.Helper()
	out := map[string]string{}
	for _, name := range []string{"config.toml", "auth.json", "catalog.json"} {
		body, err := os.ReadFile(filepath.Join(source, name))
		if err != nil {
			t.Fatal(err)
		}
		out[name] = string(body)
	}
	return out
}

func assertCodexProbeSourceAndCleanup(t *testing.T, source, trace string, before map[string]string) {
	t.Helper()
	for name, body := range before {
		p := filepath.Join(source, name)
		actual, err := os.ReadFile(p)
		if err != nil || string(actual) != body {
			t.Fatalf("source %s changed", name)
		}
		info, err := os.Stat(p)
		if err != nil || info.Mode().Perm() != 0o400 {
			t.Fatalf("source %s permissions changed", name)
		}
	}
	entries, err := os.ReadDir(source)
	if err != nil || len(entries) != len(before) {
		t.Fatalf("source profile gained state: %v, %v", entries, err)
	}
	data, err := os.ReadFile(trace)
	if err != nil {
		t.Fatal(err)
	}
	for _, home := range strings.Fields(string(data)) {
		if home == source {
			t.Fatal("native diagnostic used the source profile for writable state")
		}
		if _, err := os.Stat(home); !os.IsNotExist(err) {
			t.Fatalf("probe home survived child cleanup: %s, %v", home, err)
		}
	}
}
