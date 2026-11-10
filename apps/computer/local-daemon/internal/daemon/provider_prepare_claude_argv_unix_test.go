//go:build !windows

package daemon

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	lingercontext "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/context"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/registration"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/permission"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

// claudeArgvScript records each spawn's argv, one argument per line, then
// answers the initialize request so the Claude session stays open.
const claudeArgvScript = `#!/bin/sh
{ for arg in "$@"; do printf '%s\n' "$arg"; done; echo ---; } >> "$ARGV_LOG"
while IFS= read -r line; do
 case "$line" in
 *'"subtype":"initialize"'*)
   rid=$(printf '%s' "$line" | "$LINGER_TEST_SED" 's/.*"request_id":"\([^"]*\)".*/\1/')
   printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{}}}\n' "$rid" ;;
 esac
done
`

// claudePermissionScript asks can_use_tool about one MCP tool the run does not
// authorize and one it does once the run's user message arrives, then records
// the Daemon's decisions.
const claudePermissionScript = `#!/bin/sh
{ for arg in "$@"; do printf '%s\n' "$arg"; done; echo ---; } >> "$ARGV_LOG"
while IFS= read -r line; do
 case "$line" in
 *'"subtype":"initialize"'*)
   rid=$(printf '%s' "$line" | "$LINGER_TEST_SED" 's/.*"request_id":"\([^"]*\)".*/\1/')
   printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{}}}\n' "$rid" ;;
 *'"type":"user"'*)
   printf '{"type":"control_request","request_id":"req-unlisted","request":{"subtype":"can_use_tool","tool_name":"mcp__x__unlisted","input":{},"tool_use_id":"tool-unlisted"}}\n'
   printf '{"type":"control_request","request_id":"req-listed","request":{"subtype":"can_use_tool","tool_name":"mcp__linger_teamhub_collaboration__send_message","input":{},"tool_use_id":"tool-listed"}}\n' ;;
 *'"request_id":"req-'*)
   printf '%s\n' "$line" >> "$DECISION_LOG" ;;
 esac
done
`

// claudeRig is a real Daemon, resolver and Executor for one Claude Context,
// with a fake Claude CLI that records its argv.
type claudeRig struct {
	daemon   *Daemon
	resolver lingercontext.ExecutionResolver
	stream   *fakeStream
	argvLog  string
	root     string
}

func newClaudeRig(t *testing.T, script string) claudeRig {
	t.Helper()
	root := t.TempDir()
	executable := filepath.Join(root, "claude")
	argvLog := filepath.Join(root, "argv")
	if err := os.WriteFile(executable, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	sed, err := exec.LookPath("sed")
	if err != nil {
		t.Fatal(err)
	}
	environment := map[string]string{
		"HOME": root, "PATH": "/usr/bin:/bin", "ARGV_LOG": argvLog, "LINGER_TEST_SED": sed,
		"DECISION_LOG": filepath.Join(root, "decisions"),
	}
	// A bundled TeamHub CLI manifest makes the review allow rules non-empty, so
	// the managed settings show the review the run and pre-start both carry.
	cliDirectory := filepath.Join(root, "cli")
	if err := os.MkdirAll(cliDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	manifest := `{"schema_version":2,"commands":[{"command":["task","list"],"approval":"allow"}]}`
	if err := os.WriteFile(filepath.Join(cliDirectory, permission.TeamHubCommandManifestFile), []byte(manifest), 0o600); err != nil {
		t.Fatal(err)
	}
	resolver := lingercontext.ExecutionResolver{
		TeamHubCLIBin: cliDirectory,
		Providers: map[string]lingercontext.ProviderInstallation{
			"claude": {Type: "claude", ExecutablePath: executable, Environment: environment},
		},
		WorkspaceGrants: map[string]lingercontext.WorkspaceGrant{
			"grant-1": {GrantID: "grant-1", TenantID: "tenant-1", Path: root},
		},
		Views: claudeArgvViews{root: root},
		Registrations: map[string]lingercontext.RegistrationBinding{
			"registration-1": {RegistrationID: "registration-1", TenantID: "tenant-1", OwnerActorID: "owner-1", ProviderType: "claude", Status: registration.StatusOnline},
		},
	}
	stream := &fakeStream{}
	d, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: stream}, IdentityStore: fakeStore{},
		OperationResolver: resolver,
		Executor:          provider.Executor{RuntimeHomeRoot: filepath.Join(root, "runtime-homes"), TempBase: filepath.Join(root, "temp")},
	})
	if err != nil {
		t.Fatal(err)
	}
	d.operationStream = stream
	t.Cleanup(func() {
		d.cancelProviderPrepares(providerPrepareAll, "test_cleanup")
		_, _ = native.StopParkedResidentsForContext("context-1")
		d.WaitForOperations()
	})
	return claudeRig{daemon: d, resolver: resolver, stream: stream, argvLog: argvLog, root: root}
}

const claudeTestSession = "12345678-1234-4234-8234-123456789012"

// startReviewedRun starts a reviewed run.start the way the start path does: the
// real resolver, the run's run ids and relay descriptors, and the trusted local
// tools the start path binds. The returned cancel stops the Claude process.
func (rig claudeRig) startReviewedRun(t *testing.T, permissionReview bool) (*provider.Execution, context.CancelFunc) {
	t.Helper()
	relays := json.RawMessage(`[{"name":"linger_teamhub_collaboration","relay_url":"http://127.0.0.1:1","relay_token":"relay-secret","tool_names":["send_message"],"expires_at":"2100-01-01T00:00:00Z"}]`)
	command := prepareCommand("claude-run")
	command.RuntimeType, command.ExecutionContextKey = "claude", "context-run"
	command.Payload = mustJSON(map[string]any{
		"kind": "run.start", "runtime": map[string]string{"type": "claude"},
		"session": map[string]string{"session_id": claudeTestSession}, "input": map[string]string{"type": "text", "text": "hello"},
		"run_context":   map[string]any{"execution_run_ref": "run-1", "human_interactions": true, "permission_review": permissionReview},
		"run_resources": map[string]json.RawMessage{"mcp_servers": relays},
	})
	spec, err := rig.resolver.Resolve(t.Context(), command, command.Payload)
	if err != nil {
		t.Fatal(err)
	}
	spec = bindOperationSpec(command, spec)
	spec.TrustedLocalMCPTools = []string{"mcp__computer__click"}
	spec.Prompt = "hello"
	ctx, cancel := context.WithCancel(t.Context())
	execution, err := rig.daemon.executor.Start(ctx, spec, func(context.Context, protocol.Event) error { return nil })
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	return execution, cancel
}

// A Claude pre-start must spawn the same argv as the reviewed run.start it
// precedes. Both specs come from the real ExecutionResolver and Executor; only
// the Claude CLI is fake.
func TestClaudePrepareArgvMatchesReviewedRunStart(t *testing.T) {
	rig := newClaudeRig(t, claudeArgvScript)
	execution, cancelRun := rig.startReviewedRun(t, true)
	eventually(t, "run to spawn Claude", func() bool { return claudeLaunches(rig.argvLog) == 1 })
	cancelRun()
	<-execution.Result
	runArgv := claudeLaunchArgv(t, rig.argvLog, 0)

	// The presence pre-start carries only the run's authorization flags: no run
	// ids, no relays and no input.
	prepare := providerPrepareCommand("prepare-claude")
	prepare.RuntimeType, prepare.ExecutionContextKey = "claude", "context-1"
	prepare.Payload = mustJSON(map[string]any{
		"prepare_id": "prepare-claude", "runtime": map[string]string{"type": "claude"},
		"session":     map[string]string{"session_id": claudeTestSession},
		"run_context": map[string]bool{"human_interactions": true, "permission_review": true},
	})
	if err := rig.daemon.handleProviderPrepare(t.Context(), rig.stream, prepare); err != nil {
		t.Fatal(err)
	}
	if payload := waitForProviderPrepared(t, rig.stream, "prepare-claude"); payload["outcome"] != "ready" {
		t.Fatalf("prepare payload=%v, want ready", payload)
	}
	prepareArgv := claudeLaunchArgv(t, rig.argvLog, 1)

	if !slices.Contains(runArgv, "--managed-settings") || !slices.Contains(runArgv, "--tools") {
		t.Fatalf("run argv lacks policy flags: %q", runArgv)
	}
	// Only the per-spawn MCP config path may differ.
	if !slices.Equal(withoutMCPConfig(prepareArgv), withoutMCPConfig(runArgv)) {
		t.Fatalf("prepare argv differs from the reviewed run's argv\nprepare: %q\nrun:     %q", prepareArgv, runArgv)
	}
}

// --tools does not filter MCP tools, so an MCP tool is authorized only by
// can_use_tool. Without a permission reviewer, can_use_tool answers from the
// policy: the unlisted MCP tool is denied and the listed one allowed.
func TestClaudeRunDeniesUnlistedMCPToolThroughCanUseTool(t *testing.T) {
	rig := newClaudeRig(t, claudePermissionScript)
	execution, cancelRun := rig.startReviewedRun(t, false)
	eventually(t, "run to spawn Claude", func() bool { return claudeLaunches(rig.argvLog) == 1 })
	argv := claudeLaunchArgv(t, rig.argvLog, 0)
	defer func() {
		cancelRun()
		<-execution.Result
	}()

	if mode := argv[slices.Index(argv, "--permission-mode")+1]; mode != "acceptEdits" {
		t.Fatalf("permission mode=%q, want acceptEdits", mode)
	}
	if prompt := argv[slices.Index(argv, "--permission-prompt-tool")+1]; prompt != "stdio" {
		t.Fatalf("permission prompt tool=%q, want stdio", prompt)
	}
	if tools := argv[slices.Index(argv, "--tools")+1]; strings.Contains(tools, "mcp__") {
		t.Fatalf("--tools lists MCP tools: %q", tools)
	}
	eventually(t, "Daemon decisions for both MCP requests", func() bool {
		data, err := os.ReadFile(filepath.Join(rig.root, "decisions"))
		return err == nil && strings.Count(string(data), "\n") == 2
	})
	data, err := os.ReadFile(filepath.Join(rig.root, "decisions"))
	if err != nil {
		t.Fatal(err)
	}
	decisions := strings.Split(strings.TrimSpace(string(data)), "\n")
	if !strings.Contains(decisions[0], "req-unlisted") || !strings.Contains(decisions[0], `"behavior":"deny"`) {
		t.Fatalf("unlisted MCP tool decision=%s, want deny", decisions[0])
	}
	if !strings.Contains(decisions[1], "req-listed") || !strings.Contains(decisions[1], `"behavior":"allow"`) {
		t.Fatalf("listed MCP tool decision=%s, want allow", decisions[1])
	}
}

// claudeArgvViews resolves every Context to the Operation working directory
// and carries no Skill mappings.
type claudeArgvViews struct{ root string }

func (v claudeArgvViews) ValidatedView(context.Context, string, json.RawMessage) (lingercontext.ViewRecord, error) {
	return lingercontext.ViewRecord{WorkspacePath: v.root}, nil
}

func claudeLaunches(path string) int {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	return strings.Count(string(data), "---\n")
}

// claudeLaunchArgv returns the argv of the index-th recorded Claude spawn.
func claudeLaunchArgv(t *testing.T, path string, index int) []string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	spawns := strings.Split(strings.TrimSuffix(string(data), "---\n"), "---\n")
	if len(spawns) <= index {
		t.Fatalf("Claude spawns=%d, want index %d", len(spawns), index)
	}
	return strings.Split(strings.TrimSuffix(spawns[index], "\n"), "\n")
}

func withoutMCPConfig(argv []string) []string {
	var result []string
	for i := 0; i < len(argv); i++ {
		if argv[i] == "--mcp-config" {
			i++
			continue
		}
		result = append(result, argv[i])
	}
	return result
}
