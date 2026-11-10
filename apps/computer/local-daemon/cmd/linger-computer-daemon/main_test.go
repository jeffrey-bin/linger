package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/computerconfig"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/assignment"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
)

// Extend the transient protocol failure regression through the real discovery
// and registration projection used by the daemon, including auth failures.
func TestRuntimeMonitorPreservesCodexRegistrationUntilFailureThreshold(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses POSIX scripts and symlinks")
	}
	for _, failure := range []struct{ probe, status string }{{"protocol", "incompatible"}, {"auth", "error"}} {
		t.Run(failure.probe, func(t *testing.T) {
			root := t.TempDir()
			entry, original, replacement := filepath.Join(root, "codex"), filepath.Join(root, "codex-old"), filepath.Join(root, "codex-new")
			stateFile := filepath.Join(root, "probe-state")
			script := `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'codex-cli 0.144.1'; exit 0; fi
read probe_state < "$PROBE_STATE"
if [ "$probe_state" = "protocol" ]; then exit 2; fi
read initialize
echo '{"id":1,"result":{"userAgent":"test"}}'
if read initialized && read account; then
  case "$account" in
    *'"method":"model/list"'*) echo '{"id":2,"result":{"data":[{"id":"gpt-test"}],"nextCursor":null}}'; exit 0 ;;
  esac
  if [ "$probe_state" = "auth" ]; then exit 2; fi
  echo '{"id":2,"result":{"account":null,"requiresOpenaiAuth":false}}'
fi
`
			for _, executable := range []string{original, replacement} {
				if err := os.WriteFile(executable, []byte(script), 0o700); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.Symlink(original, entry); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(stateFile, []byte("ready\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			environment := map[string]string{"PATH": root, "HOME": root, "CODEX_HOME": root, "PROBE_STATE": stateFile}
			// The first shell fixture launch can include serialized process
			// startup under the full multi-package Computer gate. Warm both
			// candidate executables outside the one-second discovery budget;
			// this is fixture setup, not a retry or a production timeout change.
			for _, executable := range []string{original, replacement} {
				ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
				command := exec.CommandContext(ctx, executable, "--version")
				command.Env = make([]string, 0, len(environment))
				for key, value := range environment {
					command.Env = append(command.Env, key+"="+value)
				}
				output, err := command.CombinedOutput()
				cancel()
				if err != nil || strings.TrimSpace(string(output)) != "codex-cli 0.144.1" {
					t.Fatalf("prepare Codex fixture %s: %v, output=%q", executable, err, output)
				}
			}
			options := provider.DiscoveryOptions{
				ConfiguredPaths: map[string]string{"codex": entry}, Timeout: time.Second,
				Environment: environment,
			}
			published, err := provider.Discover(t.Context(), options)
			if err != nil || published.Diagnostics[0].Status != "ready" || published.Diagnostics[0].Error != nil {
				t.Fatalf("initial discovery was not verified ready: %+v, %v", published, err)
			}
			computer := computerconfig.Config{Owners: []computerconfig.Owner{{TenantID: "tenant", OwnerActorID: "owner"}}}
			revision := uint64(1)
			observations := runtimeObservations(computer, published.Diagnostics, revision)
			assertPublished := func(want string) {
				t.Helper()
				wantRegistration := "unavailable"
				if want == "ready" {
					wantRegistration = "online"
				}
				if published.Diagnostics[0].Status != want || observations[0].Status != wantRegistration || observations[0].Revision != revision {
					t.Fatalf("diagnostics/registration = %+v / %+v, want %s / %s at revision %d", published.Diagnostics[0], observations[0], want, wantRegistration, revision)
				}
				_, installed := published.Installations["codex"]
				if installed != (want == "ready") {
					t.Fatalf("Codex installation retained across %s: %+v", want, published.Installations)
				}
			}
			assertPublished("ready")
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			completed := errors.New("sequence complete")
			calls := 0
			err = provider.MonitorRuntimeDiagnostics(ctx, provider.RuntimeMonitorOptions{
				Initial: published, Discovery: options, RefreshInterval: time.Millisecond, FullRefreshEveryTicks: 1,
				Discover: func(ctx context.Context, options provider.DiscoveryOptions) (provider.DiscoveryResult, error) {
					calls++
					if calls > 6 {
						t.Fatalf("replacement failure was not published: %+v", published)
					}
					// Failure, success, failure, failure proves success resets the
					// counter. Recovery then executable replacement must fail at once.
					assertPublished([]string{"ready", "ready", "ready", "ready", failure.status, "ready"}[calls-1])
					state := failure.probe
					if calls == 2 || calls == 5 {
						state = "ready"
					}
					if calls == 6 {
						if err := os.Remove(entry); err != nil {
							t.Fatal(err)
						}
						if err := os.Symlink(replacement, entry); err != nil {
							t.Fatal(err)
						}
					}
					if err := os.WriteFile(stateFile, []byte(state+"\n"), 0o600); err != nil {
						t.Fatal(err)
					}
					return provider.Discover(ctx, options)
				},
				OnChanged: func(next provider.DiscoveryResult) error {
					if calls < 4 {
						t.Fatalf("single failure revoked online registration at refresh %d: %+v", calls, next)
					}
					published = next
					revision++
					observations = runtimeObservations(computer, next.Diagnostics, revision)
					if calls == 6 {
						assertPublished(failure.status)
						expected, err := filepath.EvalSymlinks(replacement)
						if err != nil || published.Diagnostics[0].ExecutablePath != expected {
							t.Fatalf("replacement borrowed old ready: %+v, %v", published, err)
						}
						return completed
					}
					return nil
				},
			})
			if !errors.Is(err, completed) || calls != 6 || revision != 4 {
				t.Fatalf("monitor sequence incomplete: calls=%d revision=%d err=%v", calls, revision, err)
			}
		})
	}
}

func TestPausedRunnerResultUsesLifecycleState(t *testing.T) {
	result := pausedRunnerResult(assignment.Record{
		RunnerID: "computer-1", TenantID: "tenant-1", AgentID: "agent-1", RunnerRevision: 3,
	})
	if result["state"] != "paused" || result["agent_id"] != "agent-1" || result["runner_revision"] != uint64(3) {
		t.Fatalf("paused Runner result = %#v", result)
	}
}

func TestRuntimeProviderEnvironmentUsesConfiguredCodexAuthHome(t *testing.T) {
	authHome := filepath.Join(t.TempDir(), ".codex")
	got := runtimeProviderEnvironment(map[string]string{
		"CODEX_HOME":           "/ambient/.codex",
		"LINGER_GATEWAY_TOKEN": "gateway-token",
	}, "gateway-token", filepath.Join(authHome, "auth.json"))
	if got["CODEX_HOME"] != authHome {
		t.Fatalf("CODEX_HOME = %q, want configured auth parent", got["CODEX_HOME"])
	}
	if _, exists := got["LINGER_GATEWAY_TOKEN"]; exists {
		t.Fatal("Gateway token reached Provider environment")
	}
}

func TestBoundComputerServiceCommandCannotSelectAnotherConfig(t *testing.T) {
	config := filepath.Join(t.TempDir(), "computer.json")
	bundle := t.TempDir()
	daemon := filepath.Join(bundle, "daemon", "linger-computer-daemon")
	cli := filepath.Join(bundle, "cli", "linger-computer")
	if runtime.GOOS == "windows" {
		cli += ".exe"
	}
	for _, file := range []string{daemon, cli} {
		if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, nil, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	stable := []string{cli, "--config", config}
	stableEncoded, _ := json.Marshal(stable)
	if got, err := boundServiceCommand(string(stableEncoded), config, daemon); err != nil || !slices.Equal(got, stable) {
		t.Fatalf("bound CLI: %v %v", got, err)
	}
	if _, err := boundServiceCommand(string(stableEncoded), config+".other", daemon); err == nil {
		t.Fatal("bound CLI accepted another Computer config")
	}
	// A handoff from an older release names a CLI this bundle does not ship.
	stale, _ := json.Marshal([]string{filepath.Join(bundle, "runtime", "bin", "node"), filepath.Join(bundle, "cli", "linger-computer.js"), "--config", config})
	if got, err := boundServiceCommand(string(stale), config, daemon); err != nil || !slices.Equal(got, stable) {
		t.Fatalf("stale handoff command was not rebound to the bundle CLI: %v %v", got, err)
	}
	if _, err := boundServiceCommand(string(stale), config, filepath.Join(t.TempDir(), "linger-computer-daemon")); err == nil {
		t.Fatal("missing program accepted outside an installed bundle")
	}
	if _, err := boundServiceCommand(`{"command":"evil"}`, config, daemon); err == nil {
		t.Fatal("invalid command accepted")
	}
}

func TestProviderInstallationsPreserveTerminalExecutionPath(t *testing.T) {
	environment := map[string]string{"PATH": "daemon-path", "HOME": "/home/user"}
	discovered := provider.DiscoveryResult{Installations: map[string]provider.RuntimeDiagnostic{"pi": {Type: "pi", ExecutablePath: "/mise/pi", EntryPath: "/mise/latest/pi", ExecutionPath: "terminal-node:daemon-path"}}}
	installations, _ := providerInstallations(discovered, environment)
	if installations["pi"].Environment["PATH"] != "terminal-node:daemon-path" || environment["PATH"] != "daemon-path" {
		t.Fatalf("terminal execution environment was lost or caller mutated: %+v", installations["pi"])
	}
}

func TestProviderInstallationsKeepDiscoveredContextWindows(t *testing.T) {
	discovered := provider.DiscoveryResult{Installations: map[string]provider.RuntimeDiagnostic{"codex": {
		Type: "codex", ExecutablePath: "/bin/codex",
		Models: []provider.RuntimeModel{{ID: "local", ContextWindow: 64896}, {ID: "unknown"}},
	}}}
	installations, _ := providerInstallations(discovered, nil)
	if windows := installations["codex"].ContextWindows; len(windows) != 1 || windows["local"] != 64896 {
		t.Fatalf("context windows = %v", windows)
	}
}
