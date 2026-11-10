package provider

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

func TestCodexAuthenticationColdStartWithinLinuxBudget(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux authentication budget regression")
	}
	executable, environment := codexAuthProbeFixture(t, `/bin/sleep 6
echo '{"id":2,"result":{"account":null,"requiresOpenaiAuth":false}}'`)
	current := DiscoveryResult{Diagnostics: []RuntimeDiagnostic{{Type: "codex", Status: "ready", ExecutablePath: executable}}}
	started := time.Now()
	result, err := RefreshRuntimeAuthentication(t.Context(), current, DiscoveryOptions{Environment: environment})
	elapsed := time.Since(started)
	if err != nil {
		t.Fatal(err)
	}
	if elapsed <= 5*time.Second || elapsed >= 15*time.Second {
		t.Fatalf("probe duration = %v, want between 5s and 15s", elapsed)
	}
	if diagnostic := result.Diagnostics[0]; diagnostic.Status != "ready" || diagnostic.Error != nil {
		t.Fatalf("delayed authentication = %+v", diagnostic)
	}
	if installation, present := result.Installations["codex"]; !present || installation.Status != "ready" {
		t.Fatalf("delayed Codex missing from ready installations: %+v", result.Installations)
	}
}

func TestDiscoverCodexColdInitializeWithinLinuxBudget(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux discovery budget regression with POSIX fixtures")
	}
	for _, scenario := range []struct {
		name              string
		timeout, deadline time.Duration
		want              string
		launches          string
	}{
		{"default budget", 0, 0, "ready", "initialize\ninitialize\ninitialize\n"},
		{"short caller timeout", 200 * time.Millisecond, 0, "error", "initialize\n"},
		{"short parent deadline", 0, 200 * time.Millisecond, "error", "initialize\n"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			root := t.TempDir()
			executable := filepath.Join(root, "codex")
			trace := filepath.Join(root, "launches")
			script := `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'codex-cli 0.144.1'; exit 0; fi
read initialize
echo initialize >> "$LAUNCH_TRACE"
/bin/sleep 8
echo '{"id":1,"result":{"userAgent":"test"}}'
if read initialized && read account; then
  case "$account" in
    *'"method":"model/list"'*) echo '{"id":2,"result":{"data":[{"id":"gpt-test"}],"nextCursor":null}}' ;;
    *) echo '{"id":2,"result":{"account":null,"requiresOpenaiAuth":false}}' ;;
  esac
fi
`
			if err := os.WriteFile(executable, []byte(script), 0o700); err != nil {
				t.Fatal(err)
			}
			ctx := t.Context()
			if scenario.deadline > 0 {
				var cancel context.CancelFunc
				ctx, cancel = context.WithTimeout(ctx, scenario.deadline)
				defer cancel()
			}
			started := time.Now()
			result, err := Discover(ctx, DiscoveryOptions{
				ConfiguredPaths: map[string]string{"codex": executable}, Timeout: scenario.timeout,
				Environment: map[string]string{"PATH": root, "HOME": root, "CODEX_HOME": root, "LAUNCH_TRACE": trace},
			})
			diagnostic := result.Diagnostics[0]
			if err != nil || diagnostic.Status != scenario.want {
				t.Fatalf("discovery = %+v, err = %v", diagnostic, err)
			}
			if scenario.want == "ready" {
				if diagnostic.Error != nil || result.Installations["codex"].Status != "ready" {
					t.Fatalf("slow initialize did not produce a ready installation: %+v", result)
				}
			} else if diagnostic.Error == nil || diagnostic.Error.Code != "RUNTIME_DIAGNOSTIC_FAILED" || !strings.Contains(diagnostic.Error.Message, "deadline") || time.Since(started) > 5*time.Second {
				t.Fatalf("short discovery deadline not preserved: %+v, elapsed = %v", diagnostic, time.Since(started))
			}
			launches, err := os.ReadFile(trace)
			if err != nil || string(launches) != scenario.launches {
				t.Fatalf("probe launches = %q, want %q without retries, err = %v", launches, scenario.launches, err)
			}
		})
	}
}

func TestCodexAuthenticationFailureDiagnostics(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux authentication budget regression with POSIX fixtures")
	}
	const (
		timeoutMessage = "Codex authentication probe timed out or was canceled"
		processMessage = "Codex authentication probe process or RPC failed"
		formatMessage  = "Codex authentication probe returned an invalid response"
	)
	for _, scenario := range []struct {
		name, script, message string
		timeout, deadline     time.Duration
		minimum               time.Duration
	}{
		{"timeout at Linux cap", `/bin/sleep 30`, timeoutMessage, 30 * time.Second, 0, 15 * time.Second},
		{"short caller timeout", `/bin/sleep 30`, timeoutMessage, 200 * time.Millisecond, 0, 200 * time.Millisecond},
		{"short parent deadline", `/bin/sleep 30`, timeoutMessage, 15 * time.Second, 200 * time.Millisecond, 200 * time.Millisecond},
		{"process exit", `exit 7`, processMessage, time.Second, 0, 0},
		{"RPC error", `echo '{"id":2,"error":{"code":-1,"message":"fixture-auth-token"}}'`, processMessage, time.Second, 0, 0},
		{"malformed JSON", `echo 'not-json-fixture-auth-token'`, formatMessage, time.Second, 0, 0},
		{"empty response", `exit 0`, formatMessage, time.Second, 0, 0},
		{"invalid result", `echo '{"id":2,"result":"fixture-auth-token"}'`, formatMessage, time.Second, 0, 0},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			executable, environment := codexAuthProbeFixture(t, scenario.script)
			ctx := t.Context()
			if scenario.deadline > 0 {
				var cancel context.CancelFunc
				ctx, cancel = context.WithTimeout(ctx, scenario.deadline)
				defer cancel()
			}
			started := time.Now()
			outcome := probeCodexAuthentication(ctx, executable, environment, scenario.timeout)
			elapsed := time.Since(started)
			if elapsed < scenario.minimum || elapsed > scenario.minimum+5*time.Second {
				t.Fatalf("probe duration = %v, want %v plus cleanup budget", elapsed, scenario.minimum)
			}
			want := runtimeProbeOutcome{Status: "error", Code: "RUNTIME_DIAGNOSTIC_FAILED", Message: scenario.message}
			if outcome != want {
				t.Fatalf("authentication diagnostic = %+v, want %+v", outcome, want)
			}
		})
	}
}

func TestCodexAuthenticationStartFailureAndCancellation(t *testing.T) {
	for _, canceled := range []bool{false, true} {
		ctx, cancel := context.WithCancel(t.Context())
		if canceled {
			cancel()
		}
		outcome := probeCodexAuthentication(ctx, filepath.Join(t.TempDir(), "missing-secret-executable"), nil, time.Second)
		cancel()
		message := "Codex authentication probe process or RPC failed"
		if canceled {
			message = "Codex authentication probe timed out or was canceled"
		}
		if outcome.Status != "error" || outcome.Code != "RUNTIME_DIAGNOSTIC_FAILED" || outcome.Message != message {
			t.Fatalf("canceled=%v: authentication diagnostic = %+v, want %q", canceled, outcome, message)
		}
	}
}

func codexAuthProbeFixture(t *testing.T, accountScript string) (string, map[string]string) {
	t.Helper()
	root := t.TempDir()
	executable := filepath.Join(root, "codex")
	trace := filepath.Join(root, "launches")
	script := `#!/bin/sh
echo launch >> "$LAUNCH_TRACE"
echo fixture-stderr-secret >&2
echo '{"method":"notice","params":{"token":"fixture-auth-token"}}'
read initialize
echo '{"id":1,"result":{"userAgent":"test"}}'
read initialized
read account
` + accountScript + "\n"
	if err := os.WriteFile(executable, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		launches, err := os.ReadFile(trace)
		if err != nil || string(launches) != "launch\n" {
			t.Errorf("expected one probe without retries, launch trace = %q, err = %v", launches, err)
		}
	})
	return executable, map[string]string{"HOME": root, "CODEX_HOME": root, "LAUNCH_TRACE": trace}
}

func TestCodexManagedProbeDisablesGoalsOnSupportedVersions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX script")
	}
	for _, version := range []string{"0.100.0", "0.125.0", "0.128.0", "0.150.1"} {
		t.Run(version, func(t *testing.T) {
			root := t.TempDir()
			executable := filepath.Join(root, "codex")
			trace := filepath.Join(root, "launches")
			script := `#!/bin/sh
printf '%s\n' "$*" >> "$LAUNCH_TRACE"
[ "$*" = "$EXPECTED_ARGS" ] || exit 2
read initialize
echo '{"id":1,"result":{"userAgent":"test"}}'
if read initialized && read account; then
 echo '{"id":2,"result":{"account":null,"requiresOpenaiAuth":false}}'
fi
`
			if err := os.WriteFile(executable, []byte(script), 0o700); err != nil {
				t.Fatal(err)
			}
			expected := "app-server --disable plugins --listen stdio:// --config features.memories=false --config features.memory_tool=false --config features.apps=false --config features.image_generation=false"
			if version == "0.128.0" {
				expected = "app-server --disable plugins --disable goals --listen stdio:// --config features.memories=false --config features.memory_tool=false --config features.apps=false --config features.image_generation=false"
			}
			if version == "0.150.1" {
				expected = "app-server --disable plugins --disable goals --listen stdio:// --config tool_output_token_limit=12000 --config features.memories=false --config features.memory_tool=false --config features.apps=false --config features.image_generation=false"
			}
			expected += " --config project_root_markers=[] --config skills.bundled.enabled=false"
			environment := map[string]string{"HOME": root, "CODEX_HOME": root, "EXPECTED_ARGS": expected, "LAUNCH_TRACE": trace}
			outcome := probeRuntime(t.Context(), "codex", executable, environment, 5*time.Second, version)
			if outcome.Status != "ready" {
				t.Fatalf("protocol/authentication probe = %+v", outcome)
			}
			current := DiscoveryResult{Diagnostics: []RuntimeDiagnostic{{Type: "codex", Status: "ready", ExecutablePath: executable, Version: version}}}
			refreshed, err := RefreshRuntimeAuthentication(t.Context(), current, DiscoveryOptions{Environment: environment, Timeout: 5 * time.Second})
			if err != nil || refreshed.Diagnostics[0].Status != "ready" {
				t.Fatalf("authentication refresh = %+v, %v", refreshed, err)
			}
			launches, err := os.ReadFile(trace)
			if err != nil || strings.TrimSpace(string(launches)) != strings.Join([]string{expected, expected, expected}, "\n") {
				t.Fatalf("probe launches = %q, %v", launches, err)
			}
		})
	}
}

func TestCodexAuthenticationUsesActiveProviderAccountState(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX script")
	}
	for _, scenario := range []struct {
		name, response, want string
	}{
		{"custom provider without OpenAI login", `{"account":null,"requiresOpenaiAuth":false}`, "ready"},
		{"OpenAI API key", `{"account":{"type":"apiKey"},"requiresOpenaiAuth":true}`, "ready"},
		{"ChatGPT", `{"account":{"type":"chatgpt"},"requiresOpenaiAuth":true}`, "ready"},
		{"missing OpenAI login", `{"account":null,"requiresOpenaiAuth":true}`, "authentication_required"},
		{"missing provider flag", `{"account":null}`, "error"},
		{"invalid provider flag", `{"account":null,"requiresOpenaiAuth":"false"}`, "error"},
		{"invalid account", `{"account":"secret","requiresOpenaiAuth":true}`, "error"},
		{"missing account", `{"requiresOpenaiAuth":true}`, "error"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			root := t.TempDir()
			executable := filepath.Join(root, "codex")
			script := `#!/bin/sh
if [ "$1 $2" = "login status" ]; then echo "Not logged in"; exit 1; fi
[ "$1 $2 $3 $4 $5" = "app-server --disable plugins --listen stdio://" ] || exit 2
read initialize
echo '{"id":1,"result":{"userAgent":"test"}}'
read initialized
case "$initialized" in *'"method":"initialized"'*) ;; *) exit 3 ;; esac
read account
case "$account" in *'"method":"account/read"'*) ;; *) exit 4 ;; esac
printf '{"id":2,"result":%s}\n' "$ACCOUNT_RESULT"
`
			if err := os.WriteFile(executable, []byte(script), 0o700); err != nil {
				t.Fatal(err)
			}
			result := probeCodexAuthentication(context.Background(), executable, map[string]string{
				"HOME": root, "CODEX_HOME": root, "ACCOUNT_RESULT": scenario.response,
			}, 5*time.Second)
			if result.Status != scenario.want {
				t.Fatalf("got %+v, want %s", result, scenario.want)
			}
			if scenario.want == "error" && (result.Code != "RUNTIME_DIAGNOSTIC_FAILED" || result.Message != "Codex authentication probe returned an invalid response") {
				t.Fatalf("invalid account response diagnostic = %+v", result)
			}
		})
	}
}

func TestNativeCodexAuthenticationWithoutAuthFile(t *testing.T) {
	executable := os.Getenv("LINGER_CODEX_COMPAT_EXECUTABLE")
	if executable == "" {
		t.Skip("requires an explicitly selected native Codex executable")
	}
	version, err := native.ProbeVersion(t.Context(), native.Invocation{Program: executable})
	if err != nil {
		t.Fatal(err)
	}
	for _, custom := range []bool{false, true} {
		root := t.TempDir()
		if custom {
			config := "model_provider = \"custom\"\n[model_providers.custom]\nname = \"custom\"\nbase_url = \"http://127.0.0.1:9/v1\"\nwire_api = \"responses\"\nrequires_openai_auth = false\nexperimental_bearer_token = \"fixture-not-a-real-key\"\n"
			if err := os.WriteFile(filepath.Join(root, "config.toml"), []byte(config), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		result := probeCodexAuthenticationVersion(context.Background(), executable, map[string]string{
			"HOME": root, "CODEX_HOME": root, "PATH": os.Getenv("PATH"),
		}, 5*time.Second, version)
		want := "authentication_required"
		if custom {
			want = "ready"
		}
		if result.Status != want {
			t.Fatalf("custom=%v: got %+v, want %s", custom, result, want)
		}
		if _, err := os.Stat(filepath.Join(root, "auth.json")); !os.IsNotExist(err) {
			t.Fatalf("probe created auth.json or could not verify its absence: %v", err)
		}
	}
}

func TestNativeClaudeAuthenticationDoesNotCallModel(t *testing.T) {
	executable := os.Getenv("LINGER_CLAUDE_COMPAT_EXECUTABLE")
	if executable == "" {
		t.Skip("requires an explicitly selected native Claude executable")
	}
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodHead || request.URL.Path != "/api/hello" {
			requests.Add(1)
		}
		writer.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()
	root := t.TempDir()
	outcome := probeRuntime(context.Background(), "claude", executable, map[string]string{
		"HOME": root, "CLAUDE_CONFIG_DIR": root, "PATH": os.Getenv("PATH"),
		"ANTHROPIC_API_KEY": "fixture-not-a-real-key", "ANTHROPIC_BASE_URL": server.URL,
		"DISABLE_TELEMETRY": "1", "DISABLE_ERROR_REPORTING": "1", "DISABLE_AUTOUPDATER": "1",
	}, 5*time.Second, "")
	if outcome.Status != "ready" {
		t.Fatalf("Claude local authentication = %+v", outcome)
	}
	if requests.Load() != 0 {
		t.Fatalf("authentication probe made %d model requests", requests.Load())
	}
}
