package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/clicredential"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

type workspaceResolver struct {
	workspace string
}

func (r workspaceResolver) Resolve(_ context.Context, command protocol.Command, request json.RawMessage) (provider.OperationSpec, error) {
	var semantic struct {
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(request, &semantic); err != nil {
		return provider.OperationSpec{}, err
	}
	return provider.OperationSpec{
		OperationKind: semantic.Kind, Provider: command.RuntimeType,
		ExecutablePath: "/bin/codex", WorkingDirectory: r.workspace, Prompt: "hello",
		ResumeSessionID: "thread",
	}, nil
}

func (workspaceResolver) ValidateAgentRunner(context.Context, protocol.Command, json.RawMessage) error {
	return nil
}

// runContextProbe records the run.json bytes visible when the provider starts.
type runContextProbe struct {
	mu      sync.Mutex
	started int
	seen    []string
	path    string
}

func (p *runContextProbe) Start(context.Context, string, native.RunSpec) (*native.Run, error) {
	data, _ := os.ReadFile(p.path)
	p.mu.Lock()
	p.started++
	p.seen = append(p.seen, strings.TrimSpace(string(data)))
	p.mu.Unlock()
	messages := make(chan native.Event)
	results := make(chan native.Outcome, 1)
	close(messages)
	results <- native.Outcome{Status: "completed"}
	close(results)
	return &native.Run{Events: messages, Outcome: results}, nil
}

const cliRunTestToken = "th_agent_" + "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG"

// seededCLICredentials stores the Agent's credential for tenant-1 and agent-1.
func seededCLICredentials(t *testing.T) *clicredential.Store {
	t.Helper()
	store, err := clicredential.Open(filepath.Join(t.TempDir(), "agent-cli-credentials"))
	if err != nil {
		t.Fatal(err)
	}
	putCLICredential(t, store, cliRunTestToken)
	return store
}

func putCLICredential(t *testing.T, store *clicredential.Store, token string) {
	t.Helper()
	profile := clicredential.Profile{URL: "https://teamhub.example", TenantID: "tenant-1", AgentID: "agent-1"}
	if _, err := store.Put("tenant-1", "agent-1", profile, token, 1); err != nil {
		t.Fatal(err)
	}
}

// startOperation sends one operation payload with the seeded credentials.
func startOperation(t *testing.T, workspace, payload string, probe *runContextProbe) string {
	t.Helper()
	return startOperationWith(t, workspace, payload, probe, seededCLICredentials(t))
}

// startOperationWith sends one operation payload and returns the terminal event type.
func startOperationWith(t *testing.T, workspace, payload string, probe *runContextProbe, store *clicredential.Store) string {
	t.Helper()
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	start := protocol.Command{
		Type: protocol.CommandOperationStart, CommandID: "start", ProtocolVersion: "1.2",
		TenantID: "tenant-1", RunnerID: "computer-1", RegistrationID: "reg-1", AssignmentRevision: 1,
		AgentID: "agent-1", OperationID: fmt.Sprintf("op-%d", operationCounter.Add(1)), ConnectionEpoch: 7, RunnerRevision: 1,
		Generation: 1, ExecutionLeaseID: "lease-1", WorkspaceGrantID: "grant-1", RuntimeType: "codex",
		ExecutionContextKey: "context-1", RuntimeInstanceID: "runtime-1", ContextViewRef: testContextViewRef, Payload: json.RawMessage(payload),
	}
	stream := &fakeStream{commands: []protocol.Command{{Type: "runner.welcome", ConnectionEpoch: 7}, start}}
	daemon, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: stream},
		IdentityStore: fakeStore{value: device}, OperationResolver: workspaceResolver{workspace: workspace},
		CLICredentials: store,
		Executor: provider.Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
			return probe, nil
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	daemon.daemonID = device.DaemonID
	if err := daemon.runConnection(context.Background(), device); !errors.Is(err, io.EOF) {
		t.Fatalf("runConnection() error = %v", err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		events := stream.snapshotEvents()
		if len(events) > 0 {
			switch last := events[len(events)-1].Type; last {
			case protocol.EventOperationCompleted, protocol.EventOperationFailed, protocol.EventOperationCancelled:
				return last
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("operation did not reach a terminal event")
		}
		time.Sleep(time.Millisecond)
	}
}

var operationCounter atomic.Int64

func cliWorkspace(t *testing.T, withConfig bool) (string, *runContextProbe) {
	t.Helper()
	root := t.TempDir()
	directory := filepath.Join(root, ".teamhub", "cli")
	if withConfig {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(directory, "config.json"), []byte(`{"version":1}`), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return root, &runContextProbe{path: filepath.Join(directory, "run.json")}
}

func TestRunStartWritesRunContextBeforeProviderStart(t *testing.T) {
	root, probe := cliWorkspace(t, true)
	first := `{"kind":"run.start","runtime":{"type":"codex"},"input":{"type":"text","text":"hello"},"cli_run_context":{"run_id":"run_one","scope":{"kind":"room","id":"room-1"}}}`
	if got := startOperation(t, root, first, probe); got != protocol.EventOperationCompleted {
		t.Fatalf("terminal = %s", got)
	}
	second := `{"kind":"run.start","runtime":{"type":"codex"},"input":{"type":"text","text":"hello"},"cli_run_context":{"run_id":"run_two","scope":{"kind":"room","id":"room-1"}}}`
	startOperation(t, root, second, probe)
	third := `{"kind":"run.start","runtime":{"type":"codex"},"input":{"type":"text","text":"hello"}}`
	startOperation(t, root, third, probe)
	// A Run without a scope has no run.json at all.
	want := []string{`{"run_id":"run_one"}`, `{"run_id":"run_two"}`, ""}
	if strings.Join(probe.seen, "|") != strings.Join(want, "|") {
		t.Fatalf("run.json seen at provider start = %v, want %v", probe.seen, want)
	}
}

func TestRunStartWithoutScopeWritesNoCLIFiles(t *testing.T) {
	root, probe := cliWorkspace(t, false)
	startOperation(t, root, `{"kind":"run.start","runtime":{"type":"codex"},"cli_run_context":{"run_id":"run_one"}}`, probe)
	if probe.started != 1 {
		t.Fatalf("provider starts = %d", probe.started)
	}
	if _, err := os.Stat(filepath.Join(root, ".teamhub")); !os.IsNotExist(err) {
		t.Fatalf("unexpected .teamhub: %v", err)
	}
}

func TestRunStartWithoutScopeRemovesStaleCLIFiles(t *testing.T) {
	root, probe := cliWorkspace(t, true)
	if err := os.WriteFile(probe.path, []byte(`{"run_id":"stale"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	startOperation(t, root, `{"kind":"run.start","runtime":{"type":"codex"}}`, probe)
	for _, name := range []string{"config.json", "run.json"} {
		if _, err := os.Stat(filepath.Join(root, ".teamhub", "cli", name)); !os.IsNotExist(err) {
			t.Fatalf("%s survived a Run without scope: %v", name, err)
		}
	}
}

func TestRunStartWritesConfigPointingAtAgentCredential(t *testing.T) {
	root, probe := cliWorkspace(t, false)
	store := seededCLICredentials(t)
	payload := `{"kind":"run.start","runtime":{"type":"codex"},"cli_run_context":{"run_id":"run_one","scope":{"kind":"task","id":"task-1"}}}`
	if got := startOperationWith(t, root, payload, probe, store); got != protocol.EventOperationCompleted {
		t.Fatalf("terminal = %s", got)
	}
	data, err := os.ReadFile(filepath.Join(root, ".teamhub", "cli", "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		Profiles map[string]struct {
			TokenFile string `json:"token_file"`
			Scope     struct {
				Kind string `json:"kind"`
				ID   string `json:"id"`
			} `json:"scope"`
		} `json:"profiles"`
	}
	if err := json.Unmarshal(data, &config); err != nil {
		t.Fatal(err)
	}
	profile := config.Profiles["runtime"]
	installation, err := store.Lookup("tenant-1", "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	if profile.TokenFile != installation.CredentialPath || profile.Scope.Kind != "task" || profile.Scope.ID != "task-1" {
		t.Fatalf("config profile = %+v", profile)
	}
	token, err := os.ReadFile(profile.TokenFile)
	if err != nil || string(token) != cliRunTestToken+"\n" {
		t.Fatalf("token_file content = %q, %v", token, err)
	}
}

func TestRunStartWithoutInstalledCredentialFailsBeforeProviderStart(t *testing.T) {
	root, probe := cliWorkspace(t, false)
	empty, err := clicredential.Open(filepath.Join(t.TempDir(), "agent-cli-credentials"))
	if err != nil {
		t.Fatal(err)
	}
	payload := `{"kind":"run.start","runtime":{"type":"codex"},"cli_run_context":{"scope":{"kind":"room","id":"room-1"}}}`
	if got := startOperationWith(t, root, payload, probe, empty); got != protocol.EventOperationFailed {
		t.Fatalf("terminal = %s", got)
	}
	if probe.started != 0 {
		t.Fatal("provider started without the TeamHub CLI credential")
	}
	if _, err := os.Stat(filepath.Join(root, ".teamhub", "cli", "config.json")); !os.IsNotExist(err) {
		t.Fatalf("config written without a credential: %v", err)
	}
}

func TestRunStartRotationKeepsTokenFileAndServesNewToken(t *testing.T) {
	root, probe := cliWorkspace(t, false)
	store := seededCLICredentials(t)
	payload := `{"kind":"run.start","runtime":{"type":"codex"},"cli_run_context":{"scope":{"kind":"room","id":"room-1"}}}`
	startOperationWith(t, root, payload, probe, store)
	installation, err := store.Lookup("tenant-1", "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	rotated := "th_agent_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefg"
	if _, err := store.Put("tenant-1", "agent-1", clicredential.Profile{URL: "https://teamhub.example", TenantID: "tenant-1", AgentID: "agent-1"}, rotated, 2); err != nil {
		t.Fatal(err)
	}
	startOperationWith(t, root, payload, probe, store)
	data, err := os.ReadFile(installation.CredentialPath)
	if err != nil || string(data) != rotated+"\n" {
		t.Fatalf("token file after rotation = %q, %v", data, err)
	}
}

func TestRunStartRejectsInvalidRunContextBeforeProviderStart(t *testing.T) {
	for name, payload := range map[string]string{
		"non-object": `{"kind":"run.start","runtime":{"type":"codex"},"cli_run_context":[1]}`,
		"oversized":  `{"kind":"run.start","runtime":{"type":"codex"},"cli_run_context":{"pad":"` + strings.Repeat("x", 16*1024) + `"}}`,
	} {
		t.Run(name, func(t *testing.T) {
			root, probe := cliWorkspace(t, true)
			if got := startOperation(t, root, payload, probe); got != protocol.EventOperationFailed {
				t.Fatalf("terminal = %s", got)
			}
			if probe.started != 0 {
				t.Fatal("provider started despite an invalid cli_run_context")
			}
			if _, err := os.Stat(probe.path); !os.IsNotExist(err) {
				t.Fatalf("run.json written: %v", err)
			}
		})
	}
}

func TestSessionResumeDoesNotTouchRunContext(t *testing.T) {
	root, probe := cliWorkspace(t, true)
	if err := os.WriteFile(probe.path, []byte(`{"run_id":"keep"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	startOperation(t, root, `{"kind":"session.resume","runtime":{"type":"codex"},"session":{"thread_id":"thread"},"cli_run_context":{"run_id":"other"}}`, probe)
	data, _ := os.ReadFile(probe.path)
	if string(data) != `{"run_id":"keep"}` {
		t.Fatalf("session.resume rewrote run.json: %s", data)
	}
}
