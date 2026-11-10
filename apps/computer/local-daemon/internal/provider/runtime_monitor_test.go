package provider

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
	"time"
)

func TestRuntimeMonitorBoundsTransientAuthenticationProbeFailures(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX script")
	}
	for _, scenario := range []struct {
		name     string
		failures string
		exitCode string
		output   string
		busy     bool
		want     []string
	}{
		{name: "one transient failure", failures: "1", exitCode: "2", output: "probe unavailable", want: nil},
		{name: "sustained probe failure", failures: "9", exitCode: "2", output: "probe unavailable", want: []string{"error", "ready"}},
		{name: "actual logout", failures: "9", exitCode: "1", output: "Not logged in", want: []string{"authentication_required", "ready"}},
		{name: "sustained probe failure while busy", failures: "9", exitCode: "2", output: "probe unavailable", busy: true, want: nil},
		{name: "actual logout while busy", failures: "9", exitCode: "1", output: "Not logged in", busy: true, want: []string{"authentication_required", "ready"}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			root := t.TempDir()
			codex := filepath.Join(root, "codex")
			script := `#!/bin/sh
attempt=0
if [ -f "$ATTEMPT_FILE" ]; then read attempt < "$ATTEMPT_FILE"; fi
attempt=$((attempt + 1))
echo "$attempt" > "$ATTEMPT_FILE"
if [ "$attempt" -le "$FAILURES" ] && [ "$PROBE_EXIT" != "1" ]; then echo "$PROBE_OUTPUT"; exit "$PROBE_EXIT"; fi
read initialize
echo '{"id":1,"result":{"userAgent":"test"}}'
read initialized
read account
if [ "$attempt" -le "$FAILURES" ]; then
  echo '{"id":2,"result":{"account":null,"requiresOpenaiAuth":true}}'
else
  echo '{"id":2,"result":{"account":{"type":"chatgpt"},"requiresOpenaiAuth":true}}'
fi
`
			if err := os.WriteFile(codex, []byte(script), 0o700); err != nil {
				t.Fatal(err)
			}
			primeTestExecutable(t, codex, "ATTEMPT_FILE="+filepath.Join(root, "prime-attempt"))
			initial := DiscoveryResult{Diagnostics: []RuntimeDiagnostic{{
				Type: "codex", Status: "ready", Protocol: "app-server", ExecutablePath: codex,
			}}}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			var states []string
			err := MonitorRuntimeDiagnostics(ctx, RuntimeMonitorOptions{
				Initial: initial, RefreshInterval: 10 * time.Millisecond, FullRefreshEveryTicks: 4,
				Discovery: DiscoveryOptions{Timeout: 10 * time.Second, Environment: map[string]string{
					"HOME": root, "ATTEMPT_FILE": filepath.Join(root, "attempt"), "FAILURES": scenario.failures,
					"PROBE_EXIT": scenario.exitCode, "PROBE_OUTPUT": scenario.output,
				}},
				Discover: func(context.Context, DiscoveryOptions) (DiscoveryResult, error) {
					cancel()
					return initial, nil
				},
				RuntimeBusy: func() bool { return scenario.busy },
				OnChanged: func(result DiscoveryResult) error {
					states = append(states, result.Diagnostics[0].Status)
					return nil
				},
			})
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("monitor did not complete the refresh cycle: %v", err)
			}
			if !reflect.DeepEqual(states, scenario.want) {
				t.Fatalf("published states = %v, want %v", states, scenario.want)
			}
		})
	}
}

func TestRuntimeMonitorRecoversCodexAuthenticationWithoutRestart(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX script")
	}
	root := t.TempDir()
	codex := filepath.Join(root, "codex")
	loginMarker := filepath.Join(root, "logged-in")
	protocolCount := filepath.Join(root, "protocol-count")
	script := `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 0.100.0"; exit 0; fi
echo called >> "$PROTOCOL_COUNT"
read line
echo '{"jsonrpc":"2.0","id":1,"result":{"userAgent":"codex-test"}}'
if read initialized && read account; then
  case "$account" in
    *'"method":"model/list"'*)
      echo '{"id":2,"result":{"data":[{"id":"fixture-model","model":"fixture-model","displayName":"Fixture model","isDefault":true,"supportedReasoningEfforts":[]}]}}'
      exit 0 ;;
  esac
  if [ -f "$LOGIN_MARKER" ]; then
    echo '{"id":2,"result":{"account":{"type":"chatgpt"},"requiresOpenaiAuth":true}}'
  else
    echo '{"id":2,"result":{"account":null,"requiresOpenaiAuth":true}}'
  fi
fi
`
	if err := os.WriteFile(codex, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	discovery := DiscoveryOptions{
		ConfiguredPaths: map[string]string{"codex": codex},
		Environment: map[string]string{
			"PATH": root, "HOME": root, "LOGIN_MARKER": loginMarker, "PROTOCOL_COUNT": protocolCount,
		},
		Timeout: 10 * time.Second,
	}
	initial, err := Discover(context.Background(), discovery)
	if err != nil || initial.Diagnostics[0].Status != "authentication_required" {
		t.Fatalf("initial discovery = %+v err=%v", initial, err)
	}
	if err := os.WriteFile(loginMarker, []byte("ready"), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	changed := make(chan DiscoveryResult, 1)
	err = MonitorRuntimeDiagnostics(ctx, RuntimeMonitorOptions{
		Initial: initial, Discovery: discovery, RefreshInterval: 10 * time.Millisecond,
		FullRefreshEveryTicks: 100,
		OnChanged: func(result DiscoveryResult) error {
			changed <- result
			cancel()
			return nil
		},
	})
	if err != nil && !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	select {
	case result := <-changed:
		if result.Diagnostics[0].Status != "ready" {
			t.Fatalf("refreshed discovery = %+v", result)
		}
	case <-time.After(time.Second):
		t.Fatal("Runtime authentication recovery was not published")
	}
	data, err := os.ReadFile(protocolCount)
	if err != nil || string(data) != "called\ncalled\ncalled\ncalled\n" {
		t.Fatalf("protocol probes = %q err=%v, want initial handshake, account, catalog, and refreshed account", data, err)
	}
}

func TestRuntimeMonitorPublishesCatalogFailureImmediately(t *testing.T) {
	initial := DiscoveryResult{Diagnostics: []RuntimeDiagnostic{{Type: "codex", Status: "ready", Models: []RuntimeModel{{ID: "deepseek-v4.1-flash"}}}}}
	invalid := DiscoveryResult{Diagnostics: []RuntimeDiagnostic{{Type: "codex", Status: "error", Models: []RuntimeModel{}, ModelCatalogError: "Configured Codex model catalog is missing or unreadable", Error: &DiagnosticError{Code: "RUNTIME_DIAGNOSTIC_FAILED"}}}}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	calls := 0
	var published DiscoveryResult
	err := MonitorRuntimeDiagnostics(ctx, RuntimeMonitorOptions{
		Initial: initial, RefreshInterval: time.Millisecond, FullRefreshEveryTicks: 1,
		Discover: func(context.Context, DiscoveryOptions) (DiscoveryResult, error) {
			calls++
			return invalid, nil
		},
		OnChanged: func(result DiscoveryResult) error {
			published = result
			cancel()
			return nil
		},
	})
	if !errors.Is(err, context.Canceled) || calls != 1 || len(published.Diagnostics) != 1 || published.Diagnostics[0].Status != "error" || len(published.Diagnostics[0].Models) != 0 {
		t.Fatalf("catalog failure retained stale ready models: calls=%d result=%+v err=%v", calls, published, err)
	}
}

func TestRuntimeMonitorSkipsFullRefreshWhileOperationsAreActive(t *testing.T) {
	initial := DiscoveryResult{Diagnostics: []RuntimeDiagnostic{{
		Type: "codex", Status: "ready", Protocol: "app-server", Version: "codex-test",
	}}}
	fullRefreshes := 0
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	err := MonitorRuntimeDiagnostics(ctx, RuntimeMonitorOptions{
		Initial: initial, RefreshInterval: 5 * time.Millisecond, FullRefreshEveryTicks: 1,
		FullRefreshAllowed: func() bool { return false },
		Discover: func(context.Context, DiscoveryOptions) (DiscoveryResult, error) {
			fullRefreshes++
			return initial, nil
		},
		OnChanged: func(DiscoveryResult) error { return nil },
	})
	if err != nil && !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	if fullRefreshes != 0 {
		t.Fatalf("full refreshes = %d, want none while operations are active", fullRefreshes)
	}
}

// A long-running provider blocks full discovery; an authentication transport
// failure must still recover from its cached, previously verified executable.
func TestRuntimeMonitorRecoversFailedAuthenticationWhileOperationIsActive(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX script")
	}
	root := t.TempDir()
	codex := filepath.Join(root, "codex")
	attemptFile := filepath.Join(root, "attempt")
	script := `#!/bin/sh
attempt=0
if [ -f "$ATTEMPT_FILE" ]; then read attempt < "$ATTEMPT_FILE"; fi
attempt=$((attempt + 1))
echo "$attempt" > "$ATTEMPT_FILE"
if [ "$attempt" -le 2 ]; then exit 2; fi
read initialize
echo '{"id":1,"result":{"userAgent":"test"}}'
read initialized
read account
echo '{"id":2,"result":{"account":{"type":"chatgpt"},"requiresOpenaiAuth":true}}'
`
	if err := os.WriteFile(codex, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	primeTestExecutable(t, codex, "ATTEMPT_FILE="+filepath.Join(root, "prime-attempt"))
	initial := DiscoveryResult{Diagnostics: []RuntimeDiagnostic{{Type: "codex", Status: "ready", Protocol: "app-server", Version: "0.100.0", ExecutablePath: codex}}}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	fullRefreshes := 0
	var states []string
	err := MonitorRuntimeDiagnostics(ctx, RuntimeMonitorOptions{
		Initial: initial, RefreshInterval: 10 * time.Millisecond, FullRefreshEveryTicks: 4,
		FullRefreshAllowed: func() bool { return false },
		Discovery:          DiscoveryOptions{Timeout: 10 * time.Second, Environment: map[string]string{"HOME": root, "ATTEMPT_FILE": attemptFile}},
		Discover:           func(context.Context, DiscoveryOptions) (DiscoveryResult, error) { fullRefreshes++; return initial, nil },
		OnChanged: func(result DiscoveryResult) error {
			states = append(states, result.Diagnostics[0].Status)
			if result.Diagnostics[0].Status == "ready" {
				cancel()
			}
			return nil
		},
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("monitor: %v", err)
	}
	if !reflect.DeepEqual(states, []string{"error", "ready"}) {
		t.Fatalf("states=%v", states)
	}
	if fullRefreshes != 0 {
		t.Fatalf("full refresh during operation: %d", fullRefreshes)
	}
	data, err := os.ReadFile(attemptFile)
	if err != nil || string(data) != "3\n" {
		t.Fatalf("attempts=%q err=%v", data, err)
	}
}

func TestAuthenticationRecoveryDoesNotReprobeIncompatibleRuntime(t *testing.T) {
	initial := DiscoveryResult{Diagnostics: []RuntimeDiagnostic{{Type: "codex", Status: "incompatible", ExecutablePath: "/absent", Error: &DiagnosticError{Code: "RUNTIME_INCOMPATIBLE"}}}}
	result, err := refreshRuntimeAuthentication(context.Background(), initial, DiscoveryOptions{}, true)
	if err != nil || result.Diagnostics[0].Status != "incompatible" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
}

func TestAuthenticationRecoveryDoesNotSkipFailedVersionProbe(t *testing.T) {
	initial := DiscoveryResult{Diagnostics: []RuntimeDiagnostic{{Type: "codex", Status: "error", Version: "0.100.0", ExecutablePath: "/absent", Error: &DiagnosticError{Code: "RUNTIME_DIAGNOSTIC_FAILED"}}}}
	result, err := refreshRuntimeAuthentication(context.Background(), initial, DiscoveryOptions{}, true)
	if err != nil || result.Diagnostics[0].Status != "error" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
}

// macOS assesses a newly written executable on its first exec, which can take
// seconds under load. Pay that once outside the budget under test; the env
// keeps the fixture's side effects away from the files it asserts on.
func primeTestExecutable(t *testing.T, path string, env ...string) {
	t.Helper()
	command := exec.Command(path)
	command.Env = env
	_ = command.Run()
}
