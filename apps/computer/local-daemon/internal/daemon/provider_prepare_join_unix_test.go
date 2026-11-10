//go:build !windows

package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/mcpproxy"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

// joinProviderFixture runs the real provider.Executor with a runtime home root and
// a fake Codex app-server or Claude CLI. Every spawn appends to launchLog.
// Codex thread/resume blocks until the release file exists, so a test decides
// when an in-flight prepare finishes. The fake Claude answers initialize only.
type joinProviderFixture struct {
	daemon    *Daemon
	stream    *fakeStream
	launchLog string
	release   string
	pidFile   string
	spec      provider.OperationSpec
}

type joinProviderResolver struct{ spec provider.OperationSpec }

func (r joinProviderResolver) Resolve(context.Context, protocol.Command, json.RawMessage) (provider.OperationSpec, error) {
	return r.spec, nil
}

// joinClaudeSession is the conversation a Claude prepare creates.
const joinClaudeSession = "12345678-1234-4234-8234-123456789012"

func newJoinProviderFixture(t *testing.T, runtime string) joinProviderFixture {
	t.Helper()
	root := t.TempDir()
	sed, err := exec.LookPath("sed")
	if err != nil {
		t.Fatal(err)
	}
	sleep, err := exec.LookPath("sleep")
	if err != nil {
		t.Fatal(err)
	}
	fixture := joinProviderFixture{launchLog: filepath.Join(root, "launches"), release: filepath.Join(root, "release"), pidFile: filepath.Join(root, "pid")}
	script := filepath.Join(root, runtime)
	fake := joinCodexScript
	if runtime == "claude" {
		fake = joinClaudeScript
	}
	if err := os.WriteFile(script, []byte(fake), 0o700); err != nil {
		t.Fatal(err)
	}
	environment := map[string]string{
		"HOME": root, "CODEX_HOME": filepath.Join(root, ".codex"), "PATH": "/usr/bin:/bin",
		"LAUNCH_LOG": fixture.launchLog, "RELEASE_GATE": fixture.release, "PID_FILE": fixture.pidFile,
		"LINGER_TEST_SED": sed, "LINGER_TEST_SLEEP": sleep,
	}
	spec := provider.OperationSpec{
		OperationKind: "run.start", Provider: runtime, ExecutablePath: script, WorkingDirectory: root,
		CodexVersion: "0.0.0-test", Environment: environment,
		TenantID: "tenant-1", OwnerActorID: "owner-1", AgentID: "agent-1", ScopeID: "context-1",
		Timeout: 30 * time.Second,
	}
	if runtime == "claude" {
		spec.CreateProviderSessionID = joinClaudeSession
	} else {
		spec.ResumeSessionID = "thread-1"
	}
	stream := &fakeStream{}
	d, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: stream}, IdentityStore: fakeStore{},
		OperationResolver: joinProviderResolver{spec: spec},
		Executor:          provider.Executor{RuntimeHomeRoot: filepath.Join(root, "runtime-homes"), TempBase: filepath.Join(root, "temp")},
	})
	if err != nil {
		t.Fatal(err)
	}
	d.operationStream = stream
	fixture.daemon, fixture.stream, fixture.spec = d, stream, spec
	t.Cleanup(func() {
		// Unblock any resume still gated, then stop what the test left parked.
		_ = os.WriteFile(fixture.release, nil, 0o600)
		d.cancelProviderPrepares(providerPrepareAll, "test_cleanup")
		// A run leaves its process parked in the process-wide table, which later tests would see.
		_, _ = native.StopParkedResidentsForContext("context-1")
		d.WaitForOperations()
	})
	return fixture
}

const joinCodexScript = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 0.0.0-test"; exit 0; fi
echo x >> "$LAUNCH_LOG"
echo $$ > "$PID_FILE"
while read -r line; do
 id=$(printf '%s' "$line" | "$LINGER_TEST_SED" -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
 method=$(printf '%s' "$line" | "$LINGER_TEST_SED" -n 's/.*"method":"\([^"]*\)".*/\1/p')
 [ -n "$id" ] || continue
 printf '%s\n' "$method" >> "$LAUNCH_LOG.methods"
 result='{}'
 case "$method" in
 config/read) result='{"config":{"features":{"memories":false,"memory_tool":false}}}' ;;
 thread/start|thread/resume)
   while [ ! -f "$RELEASE_GATE" ]; do "$LINGER_TEST_SLEEP" 0.05; done
   result='{"thread":{"id":"thread-1"}}' ;;
 turn/start)
   printf '{"jsonrpc":"2.0","id":%s,"result":{"turn":{"id":"turn-1"}}}\n' "$id"
   printf '{"jsonrpc":"2.0","method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1"}}}\n'
   printf '{"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed"}}}\n'
   continue ;;
 esac
 printf '{"jsonrpc":"2.0","id":%s,"result":%s}\n' "$id" "$result"
done
`

const joinClaudeScript = `#!/bin/sh
echo x >> "$LAUNCH_LOG"
while IFS= read -r line; do
 case "$line" in
 *'"subtype":"initialize"'*)
   rid=$(printf '%s' "$line" | "$LINGER_TEST_SED" 's/.*"request_id":"\([^"]*\)".*/\1/')
   printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{}}}\n' "$rid" ;;
 esac
done
`

func (f joinProviderFixture) launches(t *testing.T) int {
	t.Helper()
	data, err := os.ReadFile(f.launchLog)
	if os.IsNotExist(err) {
		return 0
	}
	if err != nil {
		t.Fatal(err)
	}
	return strings.Count(string(data), "x")
}

func (f joinProviderFixture) waitForLaunch(t *testing.T) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for f.launches(t) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("prepare did not spawn the Codex process")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (f joinProviderFixture) terminals() []protocol.Event {
	var result []protocol.Event
	for _, event := range f.stream.snapshotEvents() {
		switch event.Type {
		case protocol.EventOperationCompleted, protocol.EventOperationFailed, protocol.EventOperationCancelled:
			result = append(result, event)
		}
	}
	return result
}

func (f joinProviderFixture) waitForTerminal(t *testing.T) protocol.Event {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for {
		if terminals := f.terminals(); len(terminals) > 0 {
			return terminals[len(terminals)-1]
		}
		if time.Now().After(deadline) {
			t.Fatal("operation did not reach a terminal event")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// A start that arrives while its Context's prepare holds the Codex home claim
// must join the prepare, then adopt the parked process. No second spawn may
// happen, and the start must not fail on the claim.
func TestProviderPrepareJoinedStartAdoptsPreparedProcessWithRealRuntimeHome(t *testing.T) {
	fixture := newJoinProviderFixture(t, "codex")
	d := fixture.daemon
	d.openMCPProxies = mcpproxy.Open
	spec := fixture.spec
	spec.MCPRelays = json.RawMessage(`[]`)
	d.operationResolver = joinProviderResolver{spec: spec}
	if err := d.handleProviderPrepare(context.Background(), fixture.stream, providerPrepareCommand("prepare-real")); err != nil {
		t.Fatal(err)
	}
	fixture.waitForLaunch(t)

	start := startFromPrepare(prepareCommand("operation-real"))
	start.ExecutionContextKey = "context-1"
	startReturned := make(chan error, 1)
	go func() { startReturned <- d.handleOperationStart(context.Background(), fixture.stream, start) }()
	select {
	case err := <-startReturned:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("operation.start blocked the receive loop while its prepare was in flight")
	}
	if err := os.WriteFile(fixture.release, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	terminal := fixture.waitForTerminal(t)
	if terminal.Type != protocol.EventOperationCompleted {
		t.Fatalf("terminal=%s payload=%s, want operation.completed", terminal.Type, terminal.Payload)
	}
	if payload := waitForProviderPrepared(t, fixture.stream, "prepare-real"); payload["outcome"] != "ready" {
		t.Fatalf("prepare payload=%v, want ready", payload)
	}
	d.WaitForOperations()
	if got := fixture.launches(t); got != 1 {
		t.Fatalf("Codex spawns=%d, want one shared by the prepare and its start", got)
	}
	methods, err := os.ReadFile(fixture.launchLog + ".methods")
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Count(string(methods), "thread/resume\n"); got != 1 {
		t.Fatalf("thread resumes=%d, want only the prepare's resume; methods=%s", got, methods)
	}
	// The run parked the resident; a presence prepare after it must not touch it.
	if err := d.handleProviderPrepare(context.Background(), fixture.stream, providerPrepareCommand("prepare-after-run")); err != nil {
		t.Fatal(err)
	}
	if payload := waitForProviderPrepared(t, fixture.stream, "prepare-after-run"); payload["outcome"] != "already_ready" {
		t.Fatalf("prepare after run payload=%v, want already_ready", payload)
	}
	if got := fixture.launches(t); got != 1 {
		t.Fatalf("Codex spawns=%d after prepare on a parked resident, want still one", got)
	}
	// A parked process that died must not answer already_ready: the next prepare respawns.
	pid, err := os.ReadFile(fixture.pidFile)
	if err != nil {
		t.Fatal(err)
	}
	processID, err := strconv.Atoi(strings.TrimSpace(string(pid)))
	if err != nil {
		t.Fatal(err)
	}
	if err := syscall.Kill(processID, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	// The native table notices the death once the reader sees EOF; until then a
	// prepare may still answer already_ready.
	outcome := ""
	for attempt := 0; attempt < 100 && outcome != "ready"; attempt++ {
		id := fmt.Sprintf("prepare-after-death-%d", attempt)
		if err := d.handleProviderPrepare(context.Background(), fixture.stream, providerPrepareCommand(id)); err != nil {
			t.Fatal(err)
		}
		outcome, _ = waitForProviderPrepared(t, fixture.stream, id)["outcome"].(string)
		if outcome == "already_ready" {
			time.Sleep(20 * time.Millisecond)
		}
	}
	if outcome != "ready" {
		t.Fatalf("prepare after parked death outcome=%s, want ready", outcome)
	}
	if got := fixture.launches(t); got != 2 {
		t.Fatalf("Codex spawns=%d after parked death, want a fresh one", got)
	}
	for _, event := range fixture.stream.snapshotEvents() {
		if strings.Contains(string(event.Payload), "already in use") {
			t.Fatalf("start failed on the runtime home claim: %s", event.Payload)
		}
	}
}

// Canceling a start while it waits for its prepare yields one cancelled
// terminal and starts no provider process; the prepared process stays parked
// for the Context's next Run.
func TestProviderPrepareJoinedStartCancelWhileJoiningEmitsOneTerminal(t *testing.T) {
	fixture := newJoinProviderFixture(t, "codex")
	d := fixture.daemon
	if err := d.handleProviderPrepare(context.Background(), fixture.stream, providerPrepareCommand("prepare-cancel-join")); err != nil {
		t.Fatal(err)
	}
	fixture.waitForLaunch(t)

	start := startFromPrepare(prepareCommand("operation-cancel-join"))
	start.ExecutionContextKey = "context-1"
	if err := d.handleOperationStart(context.Background(), fixture.stream, start); err != nil {
		t.Fatal(err)
	}
	cancel := start
	cancel.Type = protocol.CommandOperationCancel
	cancel.CommandID = "cancel-operation-cancel-join"
	cancel.Payload = nil
	if err := d.handleOperationCancel(cancel); err != nil {
		t.Fatal(err)
	}
	if terminal := fixture.waitForTerminal(t); terminal.Type != protocol.EventOperationCancelled {
		t.Fatalf("terminal=%s payload=%s, want operation.cancelled", terminal.Type, terminal.Payload)
	}

	// Cancellation belongs to the joined Run, not the independent prepare.
	// Release the fixture only after observing cancellation, then prove the
	// prepare parks successfully instead of waiting for its timeout at teardown.
	if err := os.WriteFile(fixture.release, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if payload := waitForProviderPrepared(t, fixture.stream, "prepare-cancel-join"); payload["outcome"] != "ready" {
		t.Fatalf("prepare payload=%v, want ready after joined Run cancellation", payload)
	}
	d.WaitForOperations()
	if !native.ContextHasParkedResident("context-1") {
		t.Fatal("joined Run cancellation did not preserve the prepared process")
	}
	if count := len(fixture.terminals()); count != 1 {
		t.Fatalf("operation terminals=%d, want exactly one", count)
	}
	if got := fixture.launches(t); got != 1 {
		t.Fatalf("Codex spawns=%d, want only the prepare's spawn", got)
	}
	d.providerPrepareMu.Lock()
	remaining := len(d.providerPrepares)
	d.providerPrepareMu.Unlock()
	if remaining != 0 {
		t.Fatalf("canceled join left %d prepare entries", remaining)
	}
}

// Every hint is a fresh prepare. Once a compatible process is parked, a
// later prepare answers already_ready and starts nothing.
func TestProviderPrepareRepeatedHintsReuseTheParkedProcess(t *testing.T) {
	for _, runtime := range []string{"codex", "claude"} {
		t.Run(runtime, func(t *testing.T) {
			fixture := newJoinProviderFixture(t, runtime)
			d := fixture.daemon
			if err := os.WriteFile(fixture.release, nil, 0o600); err != nil {
				t.Fatal(err)
			}
			prepare := func(prepareID string) string {
				command := providerPrepareCommand(prepareID)
				command.RuntimeType = runtime
				if err := d.handleProviderPrepare(context.Background(), fixture.stream, command); err != nil {
					t.Fatal(err)
				}
				outcome, _ := waitForProviderPrepared(t, fixture.stream, prepareID)["outcome"].(string)
				return outcome
			}
			if outcome := prepare("prepare-1"); outcome != "ready" {
				t.Fatalf("first prepare = %s", outcome)
			}
			for _, id := range []string{"prepare-2", "prepare-3"} {
				if outcome := prepare(id); outcome != "already_ready" {
					t.Fatalf("%s = %s, want already_ready", id, outcome)
				}
			}
			if got := fixture.launches(t); got != 1 {
				t.Fatalf("spawns=%d, want one", got)
			}
			// Only the first prepare ran an Operation; the others found the
			// parked process without resolving or projecting again.
			logs, _ := filepath.Glob(filepath.Join(filepath.Dir(fixture.launchLog), "runtime-homes", "*", "*", "runner-diagnostics.log"))
			starts := 0
			for _, path := range logs {
				data, _ := os.ReadFile(path)
				starts += strings.Count(string(data), `"runtime.operation.start"`)
			}
			if starts != 1 {
				t.Fatalf("Operations started=%d in %v, want one", starts, logs)
			}
			d.WaitForOperations()
		})
	}
}

// recordingExecBackend keeps the ExecOptions each Codex Execute receives, so a
// test compares what a reviewed prepare and its reviewed run hand the Runtime.
type recordingExecBackend struct {
	native.Runtime
	record func(native.RunSpec)
}

func (b recordingExecBackend) Start(ctx context.Context, prompt string, options native.RunSpec) (*native.Run, error) {
	b.record(options)
	return b.Runtime.Start(ctx, prompt, options)
}

// A reviewed Codex prepare must carry the same permission hook and MCP prompt
// configuration as the reviewed run it precedes, so the parked thread matches.
func TestProviderPrepareCodexCarriesReviewedRunHook(t *testing.T) {
	fixture := newJoinProviderFixture(t, "codex")
	d := fixture.daemon
	spec := fixture.spec
	spec.OperationKind, spec.PermissionReview, spec.CodexVersion = "run.start", true, "0.163.0"
	spec.Prompt, spec.ScopeID = "hello", "context-1"
	d.operationResolver = joinProviderResolver{spec: spec}
	var mu sync.Mutex
	var options []native.RunSpec
	d.executor.NewBackend = func(provider string, cfg native.Profile) (native.Runtime, error) {
		backend, err := native.Open(provider, cfg)
		if err != nil {
			return nil, err
		}
		return recordingExecBackend{Runtime: backend, record: func(o native.RunSpec) {
			mu.Lock()
			defer mu.Unlock()
			options = append(options, o)
		}}, nil
	}
	if err := os.WriteFile(fixture.release, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	execution, err := d.executor.Start(t.Context(), spec, func(context.Context, protocol.Event) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	<-execution.Result
	// The run leaves its resident parked; clear it so the prepare spawns its own.
	if _, err := native.StopParkedResidentsForContext("context-1"); err != nil {
		t.Fatal(err)
	}
	if err := d.handleProviderPrepare(t.Context(), fixture.stream, providerPrepareCommand("prepare-review")); err != nil {
		t.Fatal(err)
	}
	waitForProviderPrepared(t, fixture.stream, "prepare-review")
	mu.Lock()
	defer mu.Unlock()
	if len(options) != 2 {
		t.Fatalf("Codex executions=%d, want the run and the prepare", len(options))
	}
	run, prepare := options[0], options[1]
	if run.CodexPermissionHook == nil || prepare.CodexPermissionHook == nil {
		t.Fatalf("permission hook run=%v prepare=%v, want both", run.CodexPermissionHook != nil, prepare.CodexPermissionHook != nil)
	}
	if !reflect.DeepEqual(run.CodexPermissionHook.Config, prepare.CodexPermissionHook.Config) {
		t.Fatalf("prepare hook config differs from the reviewed run's")
	}
	// A prepare carries no Run attachments; the Runtime treats no MCP set as
	// the empty Daemon-owned one.
	if len(prepare.MCPServers) != 0 {
		t.Fatalf("provider prepare must carry no MCP set: %s", prepare.MCPServers)
	}
}

// joinPrepareThenRun parks a Codex prepare, waits pause, then runs the
// Context's first Operation, and returns the spawns and thread resumes.
func joinPrepareThenRun(t *testing.T, fixture joinProviderFixture, pause time.Duration) (spawns, resumes int) {
	t.Helper()
	d := fixture.daemon
	if err := os.WriteFile(fixture.release, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := d.handleProviderPrepare(context.Background(), fixture.stream, providerPrepareCommand("prepare-first")); err != nil {
		t.Fatal(err)
	}
	if payload := waitForProviderPrepared(t, fixture.stream, "prepare-first"); payload["outcome"] != "ready" {
		t.Fatalf("prepare payload=%v, want ready", payload)
	}
	time.Sleep(pause)
	start := startFromPrepare(prepareCommand("operation-first"))
	start.ExecutionContextKey = "context-1"
	if err := d.handleOperationStart(context.Background(), fixture.stream, start); err != nil {
		t.Fatal(err)
	}
	if terminal := fixture.waitForTerminal(t); terminal.Type != protocol.EventOperationCompleted {
		t.Fatalf("terminal=%s payload=%s, want operation.completed", terminal.Type, terminal.Payload)
	}
	d.WaitForOperations()
	methods, err := os.ReadFile(fixture.launchLog + ".methods")
	if err != nil {
		t.Fatal(err)
	}
	return fixture.launches(t), strings.Count(string(methods), "thread/resume\n")
}

// A Run whose Context has no MCP servers and no local tools still owns the
// Daemon's MCP namespace, as its prepare does, so adopting the prepared
// thread needs no second resume.
func TestProviderPrepareAdoptedByRunWithoutMCPProxies(t *testing.T) {
	fixture := newJoinProviderFixture(t, "codex")
	spawns, resumes := joinPrepareThenRun(t, fixture, 0)
	if spawns != 1 || resumes != 1 {
		t.Fatalf("spawns=%d resumes=%d, want one spawn and one resume", spawns, resumes)
	}
}

// A prepared process stays ready without any renewal, like a process a Run
// parked: no Web heartbeat decides its lifetime.
func TestProviderPreparedProcessOutlivesPresence(t *testing.T) {
	fixture := newJoinProviderFixture(t, "codex")
	spawns, resumes := joinPrepareThenRun(t, fixture, 300*time.Millisecond)
	if spawns != 1 || resumes != 1 {
		t.Fatalf("spawns=%d resumes=%d, want the prepared process adopted", spawns, resumes)
	}
}
