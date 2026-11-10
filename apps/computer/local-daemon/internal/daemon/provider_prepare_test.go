package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/assignment"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/mcpproxy"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

// providerPrepareBackend records provider executions. A SessionOnly execution
// may block until release, so tests can hold a prepare in flight.
type providerPrepareBackend struct {
	mu       sync.Mutex
	options  []native.RunSpec
	started  chan struct{}
	once     sync.Once
	release  chan struct{}
	failWith error
}

func (b *providerPrepareBackend) Start(ctx context.Context, _ string, options native.RunSpec) (*native.Run, error) {
	b.mu.Lock()
	b.options = append(b.options, options)
	b.mu.Unlock()
	if options.PrepareOnly && b.started != nil {
		b.once.Do(func() { close(b.started) })
	}
	if options.PrepareOnly && b.release != nil {
		select {
		case <-b.release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if options.PrepareOnly && b.failWith != nil {
		return nil, b.failWith
	}
	messages := make(chan native.Event)
	close(messages)
	results := make(chan native.Outcome, 1)
	results <- native.Outcome{Status: "completed", SessionID: "thread-1"}
	close(results)
	return &native.Run{Events: messages, Outcome: results}, nil
}

func (b *providerPrepareBackend) executions() []native.RunSpec {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]native.RunSpec(nil), b.options...)
}

// noResumeResolver resolves the spec of a Codex Context that has no thread yet.
type noResumeResolver struct{}

func (noResumeResolver) Resolve(context.Context, protocol.Command, json.RawMessage) (provider.OperationSpec, error) {
	return provider.OperationSpec{
		OperationKind: "run.start", Provider: "codex", ExecutablePath: "/bin/codex",
		WorkingDirectory: "/tmp", CodexVersion: "0.155.1",
	}, nil
}

func providerPrepareFixture(t *testing.T, backend *providerPrepareBackend) (*Daemon, *fakeStream) {
	t.Helper()
	stream := &fakeStream{}
	d, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: stream}, IdentityStore: fakeStore{},
		OperationResolver: prepareOperationResolver{workingDirectory: t.TempDir()},
		Executor: provider.Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
			return backend, nil
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return d, stream
}

func providerPrepareCommand(prepareID string) protocol.Command {
	command := prepareCommand("provider-prepare")
	command.Type = protocol.CommandProviderPrepare
	command.CommandID = "command-" + prepareID
	command.OperationID, command.OperationKind = "", ""
	command.ExecutionLeaseID, command.Generation = "", 0
	command.Payload = mustJSON(map[string]any{
		"prepare_id": prepareID,
		"runtime":    map[string]any{"type": "codex"},
		"session":    map[string]any{"threadId": "thread-1"},
	})
	return command
}

func providerPreparedEvents(stream *fakeStream) []map[string]any {
	stream.mu.Lock()
	defer stream.mu.Unlock()
	var result []map[string]any
	for _, event := range stream.events {
		if event.Type != protocol.EventProviderPrepared {
			continue
		}
		var payload map[string]any
		_ = json.Unmarshal(event.Payload, &payload)
		result = append(result, payload)
	}
	return result
}

func waitForProviderPrepared(t *testing.T, stream *fakeStream, prepareID string) map[string]any {
	t.Helper()
	watchdog := time.After(5 * time.Second)
	for {
		for _, payload := range providerPreparedEvents(stream) {
			if payload["prepare_id"] == prepareID {
				return payload
			}
		}
		select {
		case <-watchdog:
			t.Fatalf("no provider.prepared for %s", prepareID)
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func TestProviderPrepareUnsupportedRuntimeIsNotEligibleWithoutSpawn(t *testing.T) {
	backend := &providerPrepareBackend{}
	d, stream := providerPrepareFixture(t, backend)
	command := providerPrepareCommand("prepare-pi")
	command.RuntimeType = "pi"
	if err := d.handleProviderPrepare(context.Background(), stream, command); err != nil {
		t.Fatal(err)
	}
	payload := waitForProviderPrepared(t, stream, "prepare-pi")
	if payload["outcome"] != "not_eligible" || payload["reason"] == nil {
		t.Fatalf("payload=%v, want not_eligible with a reason", payload)
	}
	if got := len(backend.executions()); got != 0 {
		t.Fatalf("provider executions=%d, want none", got)
	}
}

func TestProviderPrepareWithoutThreadStartsTheCodexContextsFirstThread(t *testing.T) {
	backend := &providerPrepareBackend{}
	d, stream := providerPrepareFixture(t, backend)
	d.operationResolver = noResumeResolver{}
	if err := d.handleProviderPrepare(context.Background(), stream, providerPrepareCommand("prepare-first-run")); err != nil {
		t.Fatal(err)
	}
	if payload := waitForProviderPrepared(t, stream, "prepare-first-run"); payload["outcome"] == "not_eligible" {
		t.Fatalf("payload=%v, want a prepare", payload)
	}
	executions := backend.executions()
	if len(executions) != 1 || !executions[0].PrepareOnly || executions[0].ResumeID != "" {
		t.Fatalf("provider executions=%+v, want one prepare without a thread", executions)
	}
}

func TestProviderPrepareDrainingOrStoppedAgentIsNotEligibleWithoutSpawn(t *testing.T) {
	for name, setup := range map[string]func(*Daemon){
		"draining":        func(d *Daemon) { d.draining = true },
		"locally stopped": func(d *Daemon) { d.locallyStopped["agent-1"] = true },
	} {
		t.Run(name, func(t *testing.T) {
			backend := &providerPrepareBackend{}
			d, stream := providerPrepareFixture(t, backend)
			setup(d)
			if err := d.handleProviderPrepare(context.Background(), stream, providerPrepareCommand("prepare-"+name)); err != nil {
				t.Fatal(err)
			}
			if payload := waitForProviderPrepared(t, stream, "prepare-"+name); payload["outcome"] != "not_eligible" {
				t.Fatalf("payload=%v, want not_eligible", payload)
			}
			if got := len(backend.executions()); got != 0 {
				t.Fatalf("provider executions=%d, want none", got)
			}
		})
	}
}

func TestProviderPrepareSingleFlightAnswersSecondPrepareAlreadyReady(t *testing.T) {
	backend := &providerPrepareBackend{started: make(chan struct{}), release: make(chan struct{})}
	d, stream := providerPrepareFixture(t, backend)
	if err := d.handleProviderPrepare(context.Background(), stream, providerPrepareCommand("prepare-a")); err != nil {
		t.Fatal(err)
	}
	<-backend.started
	if err := d.handleProviderPrepare(context.Background(), stream, providerPrepareCommand("prepare-b")); err != nil {
		t.Fatal(err)
	}
	if payload := waitForProviderPrepared(t, stream, "prepare-b"); payload["outcome"] != "already_ready" {
		t.Fatalf("second concurrent prepare payload=%v, want already_ready", payload)
	}
	// The same id while it is still in flight gets no second receipt; its own
	// prepare answers it.
	if err := d.handleProviderPrepare(context.Background(), stream, providerPrepareCommand("prepare-a")); err != nil {
		t.Fatal(err)
	}
	close(backend.release)
	d.WaitForOperations()
	if got := len(backend.executions()); got != 1 {
		t.Fatalf("provider executions=%d, want one for the Context", got)
	}
	if got := len(providerPreparedEvents(stream)); got != 2 {
		t.Fatalf("receipts=%v, want one per distinct prepare id", providerPreparedEvents(stream))
	}
}

func TestProviderPrepareStopsForAgentStopAndDrain(t *testing.T) {
	for name, stop := range map[string]func(*Daemon){
		"agent stop": func(d *Daemon) {
			d.cancelProviderPrepares(providerPrepareForAgent("agent-1"), "agent_runner_stop")
		},
		"drain":           func(d *Daemon) { d.Drain() },
		"connection loss": func(d *Daemon) { d.cancelProviderPrepares(providerPrepareAll, "connection_lost") },
	} {
		t.Run(name, func(t *testing.T) {
			backend := &providerPrepareBackend{started: make(chan struct{}), release: make(chan struct{})}
			d, stream := providerPrepareFixture(t, backend)
			if err := d.handleProviderPrepare(context.Background(), stream, providerPrepareCommand("prepare-"+name)); err != nil {
				t.Fatal(err)
			}
			<-backend.started
			stop(d)
			if payload := waitForProviderPrepared(t, stream, "prepare-"+name); payload["outcome"] != "canceled" {
				t.Fatalf("payload=%v, want canceled", payload)
			}
			d.WaitForOperations()
			d.providerPrepareMu.Lock()
			remaining := len(d.providerPrepares)
			d.providerPrepareMu.Unlock()
			if remaining != 0 {
				t.Fatalf("%s left %d prepare entries", name, remaining)
			}
		})
	}
}

func TestProviderPrepareStartJoinWaitsForInFlightPrepare(t *testing.T) {
	backend := &providerPrepareBackend{started: make(chan struct{}), release: make(chan struct{})}
	d, stream := providerPrepareFixture(t, backend)
	if err := d.handleProviderPrepare(context.Background(), stream, providerPrepareCommand("prepare-join")); err != nil {
		t.Fatal(err)
	}
	<-backend.started
	joined := make(chan struct{})
	go func() {
		d.joinProviderPrepare(context.Background(), protocol.Command{ExecutionContextKey: "context-1", OperationID: "operation-1"})
		close(joined)
	}()
	select {
	case <-joined:
		t.Fatal("start joined before the in-flight prepare finished")
	case <-time.After(50 * time.Millisecond):
	}
	close(backend.release)
	select {
	case <-joined:
	case <-time.After(5 * time.Second):
		t.Fatal("start did not resume after the prepare finished")
	}
}

func TestProviderPrepareFailureNeverFailsJoinedStart(t *testing.T) {
	backend := &providerPrepareBackend{started: make(chan struct{}), release: make(chan struct{}), failWith: errors.New("resume failed")}
	d, stream := providerPrepareFixture(t, backend)
	if err := d.handleProviderPrepare(context.Background(), stream, providerPrepareCommand("prepare-fail")); err != nil {
		t.Fatal(err)
	}
	<-backend.started
	close(backend.release)
	d.joinProviderPrepare(context.Background(), protocol.Command{ExecutionContextKey: "context-1", OperationID: "operation-1"})
	if payload := waitForProviderPrepared(t, stream, "prepare-fail"); payload["outcome"] != "failed" {
		t.Fatalf("payload=%v, want failed", payload)
	}
	d.providerPrepareMu.Lock()
	remaining := len(d.providerPrepares)
	d.providerPrepareMu.Unlock()
	if remaining != 0 {
		t.Fatalf("failed prepare left %d entries", remaining)
	}
}

// A joined start must not hold the connection receive loop: while its prepare
// is still in flight, the loop has to keep handling frames for other work.
func TestProviderPrepareJoinedStartDoesNotBlockReceiveLoop(t *testing.T) {
	backend := &providerPrepareBackend{started: make(chan struct{}), release: make(chan struct{})}
	d, stream := providerPrepareFixture(t, backend)
	if _, err := d.assignments.Apply(t.Context(), assignment.Command{
		Type: protocol.CommandAgentRunnerEnsure, CommandID: "fixture-assignment", RunnerID: "computer-1",
		TenantID: "tenant-1", AgentID: "agent-1", RegistrationID: "registration-1", AssignmentRevision: 1,
		RunnerRevision: 3, WorkspaceGrantID: "grant-1", Runtime: json.RawMessage(`{"type":"codex"}`),
	}, 1); err != nil {
		t.Fatal(err)
	}
	d.openMCPProxies = func(context.Context, json.RawMessage, mcpproxy.OperationIdentity) (*mcpproxy.Set, error) {
		return &mcpproxy.Set{}, nil
	}
	if err := d.handleProviderPrepare(context.Background(), stream, providerPrepareCommand("prepare-loop")); err != nil {
		t.Fatal(err)
	}
	<-backend.started

	start := startFromPrepare(prepareCommand("operation-loop"))
	start.ExecutionContextKey = "context-1"
	startReturned := make(chan error, 1)
	go func() { startReturned <- d.handleOperationStart(context.Background(), stream, start) }()
	select {
	case err := <-startReturned:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("operation.start blocked the receive loop while its prepare was in flight")
	}

	// Another Operation's cancel is still handled on the same loop.
	other := prepareCommand("operation-other")
	cancelled := make(chan error, 1)
	go func() { cancelled <- d.handleOperationCancel(other) }()
	select {
	case err := <-cancelled:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("operation.cancel was blocked behind the joined start")
	}

	close(backend.release)
	d.WaitForOperations()
	if got := backend.executions(); len(got) != 2 || !got[0].PrepareOnly || got[1].PrepareOnly {
		t.Fatalf("executions=%d, want one prepare then one start", len(got))
	}
}
