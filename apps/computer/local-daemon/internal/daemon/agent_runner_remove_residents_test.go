//go:build unix

package daemon

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	lingercontext "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/context"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

const parkedClaudeScript = `#!/bin/sh
printf '%s\n' "$$" > "$FAKE_DIR/pid"
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*)
      printf '{"type":"control_response","response":{"subtype":"success","request_id":"linger-session-restore","response":{}}}\n'
      continue ;;
  esac
  uuid=$(printf '%s' "$line" | sed 's/.*"uuid":"\([^"]*\)".*/\1/')
  printf '{"type":"user","isReplay":true,"uuid":"%s","session_id":"12345678-1234-4234-8234-123456789012"}\n' "$uuid"
  printf '{"type":"result","subtype":"success","is_error":false,"session_id":"12345678-1234-4234-8234-123456789012","result":"done","terminal_reason":"completed","user_message_uuid":"%s"}\n' "$uuid"
done
`

// parkedCodexScript answers each request and completes each turn, so the process
// parks after its turn and records its pid under CODEX_HOME.
const parkedCodexScript = `#!/bin/sh
if [ "$1" = --version ]; then printf 'codex-cli 0.100.0\n'; exit 0; fi
printf '%s\n' "$$" > "$CODEX_HOME/pid"
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  method=$(printf '%s' "$line" | sed -n 's/.*"method":"\([^"]*\)".*/\1/p')
  [ -n "$id" ] || continue
  case "$method" in
    config/read) printf '{"jsonrpc":"2.0","id":%s,"result":{"config":{"features":{"memories":false,"memory_tool":false}}}}\n' "$id" ;;
    thread/start|thread/resume) printf '{"jsonrpc":"2.0","id":%s,"result":{"thread":{"id":"thr-daemon"}}}\n' "$id" ;;
    turn/start)
      printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id"
      printf '{"jsonrpc":"2.0","method":"turn/started","params":{"threadId":"thr-daemon","turn":{"id":"turn-1"}}}\n'
      printf '{"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"thr-daemon","turn":{"id":"turn-1","status":"completed"}}}\n' ;;
    *) printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id" ;;
  esac
done
`

// parkClaudeFor runs one turn on a Claude process of the Context and Agent, which
// leaves the process parked, and returns its pid.
func parkClaudeFor(t *testing.T, contextKey, agentID string) int {
	t.Helper()
	root := t.TempDir()
	executable := filepath.Join(root, "claude")
	if err := os.WriteFile(executable, []byte(parkedClaudeScript), 0o755); err != nil {
		t.Fatal(err)
	}
	backend, err := native.Open("claude", native.Profile{
		Program: executable, Logger: slog.Default(), ContextKey: contextKey, AgentID: agentID,
		Env: map[string]string{"LINGER_CLAUDE_SESSION_ROOT": filepath.Join(root, "sessions"), "FAKE_DIR": root},
	})
	if err != nil {
		t.Fatal(err)
	}
	session, err := backend.Start(t.Context(), "hello", native.RunSpec{
		Dir: root, ClaudePolicy: &native.ClaudeToolPolicy{}, AssignSessionID: "12345678-1234-4234-8234-123456789012",
	})
	if err != nil {
		t.Fatal(err)
	}
	for range session.Events {
	}
	if result := <-session.Outcome; result.Status != "completed" {
		t.Fatalf("turn = %+v", result)
	}
	data, err := os.ReadFile(filepath.Join(root, "pid"))
	if err != nil {
		t.Fatal(err)
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(data)))
	return pid
}

func parkCodexFor(t *testing.T, contextKey, agentID string) int {
	t.Helper()
	root := t.TempDir()
	executable := filepath.Join(root, "codex")
	if err := os.WriteFile(executable, []byte(parkedCodexScript), 0o755); err != nil {
		t.Fatal(err)
	}
	home := filepath.Join(root, "codex-home")
	if err := os.MkdirAll(filepath.Join(home, "sessions"), 0o700); err != nil {
		t.Fatal(err)
	}
	backend, err := native.Open("codex", native.Profile{
		Program: executable, Logger: slog.Default(), ContextKey: contextKey, AgentID: agentID,
		CodexToolVersion: "cached-test-version", Env: map[string]string{"CODEX_HOME": home},
	})
	if err != nil {
		t.Fatal(err)
	}
	session, err := backend.Start(t.Context(), "hello", native.RunSpec{Dir: root, Budget: 5 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	for range session.Events {
	}
	if result := <-session.Outcome; result.Status != "completed" {
		t.Fatalf("turn = %+v", result)
	}
	data, err := os.ReadFile(filepath.Join(home, "pid"))
	if err != nil {
		t.Fatal(err)
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(data)))
	return pid
}

func newRemoveTestDaemon(t *testing.T, stream *fakeStream) *Daemon {
	t.Helper()
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	state := t.TempDir()
	views, err := lingercontext.OpenViewStore(filepath.Join(state, "context.sqlite"), filepath.Join(state, "views"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = views.Close() })
	d, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: stream}, IdentityStore: fakeStore{value: device},
		OperationResolver: fakeOperationResolver{}, ContextViews: views,
	})
	if err != nil {
		t.Fatal(err)
	}
	d.daemonID = device.DaemonID
	return d
}

// Agent removal stops the removed Agent's Claude and Codex residents, and
// another Agent's residents stay parked.
func TestAgentRunnerRemoveStopsOnlyThatAgentsParkedResidents(t *testing.T) {
	t.Cleanup(func() { _, _ = native.StopAllParkedResidents() })
	removed := parkClaudeFor(t, "context-a1", "agent-1")
	removedCodex := parkCodexFor(t, "context-a1", "agent-1")
	kept := parkClaudeFor(t, "context-b1", "agent-2")
	keptCodex := parkCodexFor(t, "context-b1", "agent-2")
	stream := &fakeStream{}
	d := newRemoveTestDaemon(t, stream)
	ctx := context.Background()
	if err := d.handleAgentRunnerCommand(ctx, stream, daemonAgentRunnerCommand(protocol.CommandAgentRunnerEnsure, 1)); err != nil {
		t.Fatal(err)
	}
	if err := d.handleAgentRunnerCommand(ctx, stream, daemonAgentRunnerCommand(protocol.CommandAgentRunnerRemove, 2)); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for _, pid := range []int{removed, removedCodex} {
		for syscall.Kill(pid, 0) == nil {
			if time.Now().After(deadline) {
				t.Fatalf("removed Agent's parked resident %d is still running", pid)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	if syscall.Kill(kept, 0) != nil || syscall.Kill(keptCodex, 0) != nil {
		t.Fatal("another Agent's parked resident was stopped")
	}
}
