//go:build unix

package provider

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

// The fake serves stream-json turns and stays parked. On TERM it waits, then
// records the token its Context login still holds right before it exits.
const claudeCredentialResidentScript = `#!/bin/sh
if [ "$1" = auth ]; then echo '{"loggedIn":true}'; exit 0; fi
printf '%s\n' "$$" >> "$FAKE_DIR/pids"
trap 'sleep 0.3; sed -n "s/.*\"accessToken\":\"\([^\"]*\)\".*/\1/p" "$CLAUDE_CONFIG_DIR/.credentials.json" >> "$FAKE_DIR/exits"; echo >> "$FAKE_DIR/exits"; exit 0' TERM
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*)
      printf '{"type":"control_response","response":{"subtype":"success","request_id":"linger-session-restore","response":{}}}\n'
      continue ;;
  esac
  uuid=$(printf '%s' "$line" | sed 's/.*"uuid":"\([^"]*\)".*/\1/')
  printf '{"type":"user","isReplay":true,"uuid":"%s","session_id":"%s"}\n' "$uuid" "$FAKE_SESSION"
  printf '{"type":"result","subtype":"success","is_error":false,"session_id":"%s","result":"done","terminal_reason":"completed","user_message_uuid":"%s"}\n' "$FAKE_SESSION" "$uuid"
done
while true; do sleep 0.1; done
`

func TestClaudeCredentialChangeStopsParkedResidentBeforeWriting(t *testing.T) {
	const session = "12345678-1234-4234-8234-123456789012"
	root := t.TempDir()
	executable := filepath.Join(root, "claude")
	source := filepath.Join(root, "source")
	homes := filepath.Join(root, "runtime-homes")
	workdir := filepath.Join(root, "work")
	for _, dir := range []string{source, workdir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	// Keychain access stays inside this test even on macOS.
	if err := os.WriteFile(filepath.Join(root, "security"), []byte("#!/bin/sh\nexit 44\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(executable, []byte(claudeCredentialResidentScript), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", root+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Cleanup(func() { _, _ = native.StopAllParkedResidents() })
	login := func(token string) {
		t.Helper()
		credential := `{"claudeAiOauth":{"accessToken":"` + token + `","expiresAt":4102448400000}}`
		if err := os.WriteFile(filepath.Join(source, ".credentials.json"), []byte(credential), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	lines := func(name string) []string {
		data, _ := os.ReadFile(filepath.Join(root, name))
		return strings.Fields(string(data))
	}
	alive := func(pid string) bool {
		value, err := strconv.Atoi(pid)
		return err == nil && syscall.Kill(value, 0) == nil
	}
	environment := map[string]string{
		"HOME": root, "CLAUDE_CONFIG_DIR": source, "PATH": os.Getenv("PATH"),
		"FAKE_DIR": root, "FAKE_SESSION": session,
	}
	executor := Executor{RuntimeHomeRoot: homes}
	run := func(create bool) {
		t.Helper()
		spec := OperationSpec{
			OperationKind: "run.start", Provider: "claude", ExecutablePath: executable,
			WorkingDirectory: workdir, Prompt: "hello", Environment: environment, Timeout: 10 * time.Second,
			TenantID: "tenant", OwnerActorID: "owner", AgentID: "agent", ScopeID: "context",
		}
		if create {
			spec.CreateProviderSessionID = session
		} else {
			spec.ResumeSessionID = session
		}
		execution, err := executor.Start(t.Context(), spec, func(context.Context, protocol.Event) error { return nil })
		if err != nil {
			t.Fatal(err)
		}
		select {
		case result := <-execution.Result:
			if result.Status != "completed" {
				t.Fatalf("Operation failed: %+v", result)
			}
		case <-time.After(15 * time.Second):
			t.Fatal("fixture Operation did not finish")
		}
	}

	login("fake-token-1")
	run(true)
	pids := lines("pids")
	if len(pids) != 1 || !alive(pids[0]) {
		t.Fatalf("first Operation did not park its process: %v", pids)
	}

	// Operation path: the next Operation's credential sync stops the parked
	// process before the new login reaches the Context home.
	login("fake-token-2")
	run(false)
	pids = lines("pids")
	if len(pids) != 2 || alive(pids[0]) {
		t.Fatalf("parked process survived the Operation credential change: %v", pids)
	}
	if exits := lines("exits"); len(exits) != 1 || exits[0] != "fake-token-1" {
		t.Fatalf("Operation wrote the new login before the parked process exited: %v", exits)
	}

	// Authentication check path: the periodic refresh retires the second
	// parked process before it adopts the next login.
	login("fake-token-3")
	options := DiscoveryOptions{RuntimeHomeRoot: homes, Timeout: 5 * time.Second, Environment: environment}
	current := DiscoveryResult{Diagnostics: []RuntimeDiagnostic{{Type: "claude", Status: "ready", ExecutablePath: executable}}}
	refreshed, err := RefreshRuntimeAuthentication(t.Context(), current, options)
	if err != nil || refreshed.Diagnostics[0].Status != "ready" {
		t.Fatalf("authentication refresh failed: %+v %v", refreshed, err)
	}
	if alive(pids[1]) {
		t.Fatal("parked process survived the authentication check credential change")
	}
	if exits := lines("exits"); len(exits) != 2 || exits[1] != "fake-token-2" {
		t.Fatalf("authentication check wrote the new login before the parked process exited: %v", exits)
	}
	configs, err := filepath.Glob(filepath.Join(homes, "claude", "*", ".claude", ".credentials.json"))
	if err != nil || len(configs) != 1 {
		t.Fatalf("Context homes = %v, %v", configs, err)
	}
	if adopted, err := os.ReadFile(configs[0]); err != nil || !strings.Contains(string(adopted), `"fake-token-3"`) {
		t.Fatal("authentication check did not adopt the new login")
	}
}
