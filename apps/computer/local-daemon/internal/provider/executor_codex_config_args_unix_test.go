//go:build !windows

package provider

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/pelletier/go-toml/v2"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

// #249: every Codex launch carries the sandbox and shell-environment `-c`
// overrides, and repeated operations on one Runtime home never rewrite the
// copied config.toml.
func TestExecutorCodexLaunchCarriesConfigArgsAndKeepsConfigStable(t *testing.T) {
	// The intentionally narrow child PATH does not contain sed on macOS.
	sedPath, err := exec.LookPath("sed")
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	shared := filepath.Join(root, ".codex")
	if err := os.MkdirAll(shared, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(shared, "config.toml"), []byte("sandbox_mode = \"read-only\"\n[shell_environment_policy.set]\nOTHER = \"kept\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(root, "codex-fixture")
	if err := os.WriteFile(script, []byte(`#!/bin/sh
printf '%s\n' "$*" > "$CODEX_HOME/argv"
while read -r line; do
 id=$(printf '%s' "$line" | "$LINGER_TEST_SED" -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
 method=$(printf '%s' "$line" | "$LINGER_TEST_SED" -n 's/.*"method":"\([^"]*\)".*/\1/p')
 [ -n "$id" ] || continue
 result='{}'
 case "$method" in
 config/read) result='{"config":{"features":{"memories":false,"memory_tool":false}}}' ;;
 thread/start|thread/resume) result='{"thread":{"id":"thread-cfg"}}' ;;
 turn/start)
   printf '{"jsonrpc":"2.0","id":%s,"result":{"turn":{"id":"turn-cfg"}}}\n' "$id"
   printf '{"jsonrpc":"2.0","method":"turn/started","params":{"threadId":"thread-cfg","turn":{"id":"turn-cfg"}}}\n'
   printf '{"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"thread-cfg","turn":{"id":"turn-cfg","status":"completed"}}}\n'
   continue ;;
 esac
 printf '{"jsonrpc":"2.0","id":%s,"result":%s}\n' "$id" "$result"
done
`), 0o700); err != nil {
		t.Fatal(err)
	}
	var captured []native.Profile
	executor := Executor{
		RuntimeHomeRoot: filepath.Join(root, "runtime-homes"), TempBase: filepath.Join(root, "temp"),
		NewBackend: func(provider string, cfg native.Profile) (native.Runtime, error) {
			captured = append(captured, cfg)
			return native.Open(provider, cfg)
		},
	}
	t.Cleanup(func() {
		for _, cfg := range captured {
			_, _ = native.StopCodexHomeForMaintenance(cfg.Env["CODEX_HOME"])
		}
	})
	env := func() map[string]string {
		return map[string]string{"HOME": root, "CODEX_HOME": shared, "TEAMHUB_CONFIG": "/private/teamhub.json", "TEAMHUB_PROFILE": "runtime", "PATH": "/trusted:/bin", "LINGER_TEST_SED": sedPath}
	}
	var configs [][]byte
	for run := 0; run < 2; run++ {
		spec := OperationSpec{
			Provider: "codex", ExecutablePath: script, WorkingDirectory: root, Environment: env(),
			TenantID: "t", OwnerActorID: "o", AgentID: "a", ScopeID: "s",
			OperationKind: "run.start", Prompt: "hello", CodexVersion: "0.155.1", Timeout: 10 * time.Second,
		}
		execution, err := executor.Start(t.Context(), spec, func(context.Context, protocol.Event) error { return nil })
		if err != nil {
			t.Fatal(err)
		}
		select {
		case result := <-execution.Result:
			if result.Status != "completed" {
				t.Fatalf("run %d failed: %+v", run, result)
			}
		case <-time.After(15 * time.Second):
			t.Fatal("fixture operation did not finish")
		}
		home := captured[run].Env["CODEX_HOME"]
		want := []string{
			"-c", `sandbox_mode="danger-full-access"`,
			"-c", `shell_environment_policy.set.TEAMHUB_CONFIG="/private/teamhub.json"`,
			"-c", `shell_environment_policy.set.TEAMHUB_PROFILE="runtime"`,
			"-c", `shell_environment_policy.set.PATH="/trusted:/bin"`,
		}
		if !slices.Equal(captured[run].CodexConfigArgs, want) {
			t.Fatalf("Config.CodexConfigArgs = %q, want %q", captured[run].CodexConfigArgs, want)
		}
		argv, err := os.ReadFile(filepath.Join(home, "argv"))
		if err != nil {
			t.Fatal(err)
		}
		for i := 1; i < len(want); i += 2 {
			if !strings.Contains(string(argv), want[i]) {
				t.Fatalf("codex argv missing %s: %s", want[i], argv)
			}
		}
		data, err := os.ReadFile(filepath.Join(home, "config.toml"))
		if err != nil {
			t.Fatal(err)
		}
		var parsed map[string]any
		if err := toml.Unmarshal(data, &parsed); err != nil || strings.Contains(string(data), "linger-managed") && strings.Count(string(data), "sandbox_mode") > 1 {
			t.Fatalf("config.toml invalid or duplicated: %v\n%s", err, data)
		}
		configs = append(configs, data)
		if _, err := native.StopCodexHomeForMaintenance(home); err != nil {
			t.Fatal(err)
		}
	}
	if string(configs[0]) != string(configs[1]) {
		t.Fatalf("config.toml changed between operations:\n%s\n---\n%s", configs[0], configs[1])
	}
	if strings.Contains(string(configs[0]), "TEAMHUB") || strings.Count(string(configs[0]), "sandbox_mode") != 1 {
		t.Fatalf("daemon leaked settings into config.toml:\n%s", configs[0])
	}
}
