package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/assignment"
	lingercontext "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/context"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/registration"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
	localworkspace "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/workspace"
)

type fakeStore struct{ value transport.Identity }

func TestWelcomeDoesNotConfirmReconciliation(t *testing.T) {
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	release := make(chan struct{})
	stream := &fakeStream{commands: []protocol.Command{{Type: "runner.welcome", ConnectionEpoch: 1}}, wait: release}
	daemon, err := newTestDaemon(t, Options{ComputerID: "readiness-device", ControlPlane: fakeControlPlane{stream: stream}, IdentityStore: fakeStore{value: device}, OperationResolver: fakeOperationResolver{}})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- daemon.runConnection(context.Background(), device) }()
	waitForGatewayState(t, daemon, "connected")
	ready := daemon.Reconciled()
	close(release)
	<-done
	if ready {
		t.Fatal("welcome alone confirmed reconciliation")
	}
}

func (s fakeStore) LoadOrCreate(context.Context) (transport.Identity, error) { return s.value, nil }

func TestReconciliationReceiptIsFencedAndReset(t *testing.T) {
	for _, epoch := range []uint64{1, 2} {
		t.Run(fmt.Sprint(epoch), func(t *testing.T) {
			device, err := transport.GenerateIdentity()
			if err != nil {
				t.Fatal(err)
			}
			stream := &fakeStream{commands: []protocol.Command{
				{Type: "runner.welcome", ConnectionEpoch: 1},
				{Type: "runner.reconciled", RunnerID: "readiness-device", ConnectionEpoch: epoch},
			}}
			daemon, err := newTestDaemon(t, Options{ComputerID: "readiness-device", ControlPlane: fakeControlPlane{stream: stream}, IdentityStore: fakeStore{value: device}, OperationResolver: fakeOperationResolver{}})
			if err != nil {
				t.Fatal(err)
			}
			_ = daemon.runConnection(context.Background(), device)
			if daemon.Reconciled() != (epoch == 1) {
				t.Fatal("receipt fencing mismatch")
			}
			daemon.setGatewayState("connecting")
			if daemon.Reconciled() {
				t.Fatal("previous connection readiness survived reconnect")
			}
		})
	}
}

type fakeStream struct {
	mu         sync.Mutex
	commands   []protocol.Command
	events     []protocol.Event
	wait       <-chan struct{}
	receiveErr error
	// idle, when set, holds the end of the stream until queued Context work has
	// finished, because a connection drops commands it has not dispatched yet.
	idle func() bool
	// beforeCommand, when set, runs before a queued command is delivered; an error ends the stream.
	beforeCommand func(protocol.Command) error
}

func (s *fakeStream) Receive(context.Context) (protocol.Command, error) {
	if len(s.commands) == 0 {
		if s.wait != nil {
			<-s.wait
		}
		if s.receiveErr != nil {
			return protocol.Command{}, s.receiveErr
		}
		s.awaitIdle()
		return protocol.Command{}, io.EOF
	}
	command := s.commands[0]
	s.commands = s.commands[1:]
	if s.beforeCommand != nil {
		if err := s.beforeCommand(command); err != nil {
			return protocol.Command{}, err
		}
	}
	return command, nil
}

func (s *fakeStream) awaitIdle() {
	if s.idle == nil {
		return
	}
	deadline := time.Now().Add(5 * time.Second)
	for !s.idle() && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
}

func (s *fakeStream) Send(_ context.Context, event protocol.Event) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events = append(s.events, event)
	return nil
}

func (s *fakeStream) Close() error { return nil }

type fakeControlPlane struct{ stream *fakeStream }

func (p fakeControlPlane) Connect(context.Context, transport.Hello) (transport.Stream, error) {
	return p.stream, nil
}

type sequenceControlPlane struct {
	mu        sync.Mutex
	streams   []*fakeStream
	calls     int
	hellos    []transport.Hello
	onConnect func(int)
}

func (p *sequenceControlPlane) Connect(_ context.Context, hello transport.Hello) (transport.Stream, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls++
	p.hellos = append(p.hellos, hello)
	if p.onConnect != nil {
		p.onConnect(p.calls)
	}
	if len(p.streams) == 0 {
		return nil, io.EOF
	}
	stream := p.streams[0]
	p.streams = p.streams[1:]
	return stream, nil
}

type authenticationControlPlane struct{ calls int }

func (p *authenticationControlPlane) Connect(context.Context, transport.Hello) (transport.Stream, error) {
	p.calls++
	return nil, &transport.AuthenticationError{StatusCode: 401}
}

type fakeBackend struct{ session *native.Run }

func (b fakeBackend) Start(context.Context, string, native.RunSpec) (*native.Run, error) {
	return b.session, nil
}

type callbackBackend struct {
	execute func(context.Context, string, native.RunSpec) (*native.Run, error)
}

func (b callbackBackend) Start(ctx context.Context, prompt string, options native.RunSpec) (*native.Run, error) {
	return b.execute(ctx, prompt, options)
}

type mcpOperationResolver struct{ relays json.RawMessage }

func (r mcpOperationResolver) Resolve(context.Context, protocol.Command, json.RawMessage) (provider.OperationSpec, error) {
	return provider.OperationSpec{
		OperationKind: "run.start", Provider: "codex", ExecutablePath: "/bin/codex",
		WorkingDirectory: os.TempDir(), Prompt: "hello", MCPRelays: r.relays,
	}, nil
}

type fakeOperationResolver struct{}

func (fakeOperationResolver) Resolve(_ context.Context, command protocol.Command, request json.RawMessage) (provider.OperationSpec, error) {
	var semantic struct {
		Kind  string `json:"kind"`
		Input struct {
			Text string `json:"text"`
		} `json:"input"`
	}
	if err := json.Unmarshal(request, &semantic); err != nil {
		return provider.OperationSpec{}, err
	}
	return provider.OperationSpec{
		OperationKind: semantic.Kind, Provider: command.RuntimeType,
		ExecutablePath: "/bin/codex", WorkingDirectory: os.TempDir(), Prompt: semantic.Input.Text,
	}, nil
}

func (fakeOperationResolver) ValidateAgentRunner(context.Context, protocol.Command, json.RawMessage) error {
	return nil
}

type failingOperationResolver struct{ err error }

func (r failingOperationResolver) Resolve(context.Context, protocol.Command, json.RawMessage) (provider.OperationSpec, error) {
	return provider.OperationSpec{}, r.err
}

type blockingOperationResolver struct {
	started chan struct{}
	release <-chan struct{}
	// Start re-resolves after MCP preparation, so the first call alone signals.
	startedOnce sync.Once
}

func (r *blockingOperationResolver) Resolve(ctx context.Context, command protocol.Command, request json.RawMessage) (provider.OperationSpec, error) {
	r.startedOnce.Do(func() { close(r.started) })
	select {
	case <-ctx.Done():
		return provider.OperationSpec{}, context.Cause(ctx)
	case <-r.release:
		return fakeOperationResolver{}.Resolve(ctx, command, request)
	}
}

func (*blockingOperationResolver) ValidateAgentRunner(context.Context, protocol.Command, json.RawMessage) error {
	return nil
}

type failingCompleteLedger struct {
	OperationLedgerStore
	err error
}

func (l failingCompleteLedger) Complete(context.Context, OperationIdentity, protocol.Event) (protocol.Event, error) {
	return protocol.Event{}, l.err
}

type cancellationBackend struct {
	cleaned chan struct{}
}

func (b cancellationBackend) Start(ctx context.Context, _ string, _ native.RunSpec) (*native.Run, error) {
	messages := make(chan native.Event)
	results := make(chan native.Outcome, 1)
	go func() {
		<-ctx.Done()
		close(b.cleaned)
		close(messages)
		results <- native.Outcome{Status: "aborted", Error: ctx.Err().Error()}
		close(results)
	}()
	return &native.Run{Events: messages, Outcome: results}, nil
}

type heldBackend struct {
	release <-chan struct{}
}

func (b heldBackend) Start(context.Context, string, native.RunSpec) (*native.Run, error) {
	messages := make(chan native.Event)
	results := make(chan native.Outcome, 1)
	go func() {
		<-b.release
		close(messages)
		results <- native.Outcome{Status: "completed", SessionID: "thread-held"}
		close(results)
	}()
	return &native.Run{Events: messages, Outcome: results}, nil
}

type shutdownBackend struct {
	cancelled          chan struct{}
	release            <-chan struct{}
	cleanupUnconfirmed bool
}

func TestDaemonEnforcesCapacityAndOneOperationPerContext(t *testing.T) {
	tests := []struct {
		name        string
		capacity    *int
		secondAgent string
		message     string
	}{
		{name: "computer capacity", capacity: intPointer(1), secondAgent: "agent-2", message: "capacity is exhausted"},
		{name: "context serial execution", secondAgent: "agent-1", message: "already has an active Operation"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			release := make(chan struct{})
			started := make(chan struct{}, 2)
			d, err := newTestDaemon(t, Options{
				ComputerID: "computer-1", Capacity: test.capacity,
				ControlPlane: fakeControlPlane{stream: &fakeStream{}}, IdentityStore: fakeStore{},
				OperationResolver: fakeOperationResolver{},
				Executor: provider.Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
					started <- struct{}{}
					return heldBackend{release: release}, nil
				}},
			})
			if err != nil {
				t.Fatal(err)
			}
			stream := &fakeStream{}
			first := daemonOperationStart("operation-1", "agent-1")
			if err := d.handleOperationStart(context.Background(), stream, first); err != nil {
				t.Fatal(err)
			}
			second := daemonOperationStart("operation-2", test.secondAgent)
			if err := d.handleOperationStart(context.Background(), stream, second); err != nil {
				t.Fatal(err)
			}
			// Start is asynchronous: the first Operation starts after acceptance, and
			// the second was rejected synchronously, so no second start may follow.
			awaitProviderStarts(t, started, 1)
			if len(started) != 0 {
				t.Fatalf("backend starts=%d, want 1", 1+len(started))
			}
			failed := false
			for _, event := range stream.snapshotEvents() {
				if event.OperationID == second.OperationID && event.Type == protocol.EventOperationFailed && strings.Contains(string(event.Payload), test.message) {
					failed = true
					// The Remote Provider retries only on this exact wire contract.
					var payload struct {
						Code      string `json:"code"`
						Retryable bool   `json:"retryable"`
					}
					if err := json.Unmarshal(event.Payload, &payload); err != nil || payload.Code != "OPERATION_CAPACITY_BUSY" || !payload.Retryable || event.Stage != "operation_admission" {
						t.Fatalf("admission busy contract = %s stage=%q err=%v", event.Payload, event.Stage, err)
					}
				}
			}
			if !failed {
				t.Fatalf("second Operation was not rejected: %+v", stream.snapshotEvents())
			}
			close(release)
			d.WaitForOperations()
		})
	}
}

func TestDaemonAllowsSameAgentAcrossContexts(t *testing.T) {
	release := make(chan struct{})
	started := make(chan struct{}, 2)
	d, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", Capacity: intPointer(2),
		ControlPlane: fakeControlPlane{stream: &fakeStream{}}, IdentityStore: fakeStore{},
		OperationResolver: fakeOperationResolver{},
		Executor: provider.Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
			started <- struct{}{}
			return heldBackend{release: release}, nil
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { close(release); d.WaitForOperations() }()
	stream := &fakeStream{}
	for i, key := range []string{"room:first", "task:second"} {
		command := daemonOperationStart(fmt.Sprintf("operation-%d", i), "agent-1")
		command.ExecutionContextKey = key
		if err := d.handleOperationStart(context.Background(), stream, command); err != nil {
			t.Fatal(err)
		}
	}
	awaitProviderStarts(t, started, 2)
}

func TestDaemonDoesNotFenceNextAdmissionAfterPriorTerminalCommit(t *testing.T) {
	release := make(chan struct{})
	started := make(chan struct{}, 1)
	d, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", Capacity: intPointer(1),
		ControlPlane: fakeControlPlane{stream: &fakeStream{}}, IdentityStore: fakeStore{},
		OperationResolver: fakeOperationResolver{},
		Executor: provider.Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
			started <- struct{}{}
			return heldBackend{release: release}, nil
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	d.activeOperations["operation-terminal-delivery"] = &activeOperation{
		identity: OperationIdentity{AgentID: "agent-1"}, terminalCommitted: true,
	}
	if err := d.handleOperationStart(context.Background(), &fakeStream{}, daemonOperationStart("operation-next", "agent-1")); err != nil {
		t.Fatal(err)
	}
	awaitProviderStarts(t, started, 1)
	close(release)
	d.WaitForOperations()
}

func TestDaemonDrainWaitsForProviderCleanupAndTerminalPersistence(t *testing.T) {
	testDaemonDrainCleanup(t, false)
}

func TestDaemonDoesNotReportCancelledWhenProviderCleanupIsUnconfirmed(t *testing.T) {
	testDaemonDrainCleanup(t, true)
}

func testDaemonDrainCleanup(t *testing.T, cleanupUnconfirmed bool) {
	t.Helper()
	cancelled := make(chan struct{})
	release := make(chan struct{})
	started := make(chan struct{}, 1)
	d, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: &fakeStream{}}, IdentityStore: fakeStore{},
		OperationResolver: fakeOperationResolver{},
		Executor: provider.Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
			started <- struct{}{}
			return shutdownBackend{cancelled: cancelled, release: release, cleanupUnconfirmed: cleanupUnconfirmed}, nil
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	stream := &fakeStream{}
	d.operationStream = stream
	start := daemonOperationStart("operation-shutdown", "agent-1")
	if err := d.handleOperationStart(context.Background(), stream, start); err != nil {
		t.Fatal(err)
	}
	awaitProviderStarts(t, started, 1)
	done := make(chan struct{})
	go func() {
		d.Drain()
		d.WaitForOperations()
		close(done)
	}()
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("Provider was not cancelled during drain")
	}
	select {
	case <-done:
		t.Fatal("drain completed before Provider cleanup")
	default:
	}
	if active := d.ActiveOperationCount(); active != 1 {
		t.Fatalf("active Operations during cleanup=%d, want 1", active)
	}
	close(release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("drain did not complete after Provider cleanup")
	}
	if active := d.ActiveOperationCount(); active != 0 {
		t.Fatalf("active Operations after terminal=%d, want 0", active)
	}
	events := stream.snapshotEvents()
	wantTerminal := protocol.EventOperationCancelled
	if cleanupUnconfirmed {
		wantTerminal = protocol.EventOperationFailed
	}
	if len(events) < 2 || events[len(events)-1].Type != wantTerminal {
		t.Fatalf("terminal was not delivered before slot release: %+v", events)
	}
	if cleanupUnconfirmed {
		var failure struct {
			Code string `json:"code"`
		}
		if err := json.Unmarshal(events[len(events)-1].Payload, &failure); err != nil {
			t.Fatal(err)
		}
		if failure.Code != "RUNTIME_CLEANUP_UNCONFIRMED" {
			t.Fatalf("cleanup failure identity was lost: %s", failure.Code)
		}
	}
}

func TestAgentRunnerRemoveWaitsForActiveOperationTerminal(t *testing.T) {
	cancelled := make(chan struct{})
	release := make(chan struct{})
	started := make(chan struct{}, 1)
	d, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: &fakeStream{}}, IdentityStore: fakeStore{},
		OperationResolver: fakeOperationResolver{},
		Executor: provider.Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
			started <- struct{}{}
			return shutdownBackend{cancelled: cancelled, release: release}, nil
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	stream := &fakeStream{}
	d.operationStream = stream
	ensure := daemonAgentRunnerCommand(protocol.CommandAgentRunnerEnsure, 1)
	if err := d.handleAgentRunnerCommand(context.Background(), stream, ensure); err != nil {
		t.Fatal(err)
	}
	start := daemonOperationStart("operation-remove", "agent-1")
	if err := d.handleOperationStart(context.Background(), stream, start); err != nil {
		t.Fatal(err)
	}
	awaitProviderStarts(t, started, 1)
	done := make(chan error, 1)
	go func() {
		done <- d.handleAgentRunnerCommand(
			context.Background(),
			stream,
			daemonAgentRunnerCommand(protocol.CommandAgentRunnerRemove, 2),
		)
	}()
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("removal did not cancel the active Operation")
	}
	select {
	case err := <-done:
		t.Fatalf("removal acknowledged before Operation terminal: %v", err)
	default:
	}
	close(release)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("removal did not acknowledge after Operation terminal")
	}
	d.WaitForOperations()
	events := stream.snapshotEvents()
	terminalIndex, removedIndex := -1, -1
	for index, event := range events {
		if event.OperationID == start.OperationID && event.Type == protocol.EventOperationCancelled {
			terminalIndex = index
		}
		if event.Type == protocol.EventAgentRunnerRemoved {
			removedIndex = index
		}
	}
	if terminalIndex < 0 || removedIndex <= terminalIndex {
		t.Fatalf("removal/terminal event order=%+v", events)
	}
}

func TestAgentRunnerRemoveSerializesWithOperationAdmission(t *testing.T) {
	resolverStarted := make(chan struct{})
	resolverRelease := make(chan struct{})
	providerCancelled := make(chan struct{})
	providerRelease := make(chan struct{})
	var providerStarts atomic.Int32
	d, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: &fakeStream{}}, IdentityStore: fakeStore{},
		OperationResolver: &blockingOperationResolver{started: resolverStarted, release: resolverRelease},
		Executor: provider.Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
			providerStarts.Add(1)
			return shutdownBackend{cancelled: providerCancelled, release: providerRelease}, nil
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	stream := &fakeStream{}
	d.operationStream = stream
	if err := d.handleAgentRunnerCommand(context.Background(), stream, daemonAgentRunnerCommand(protocol.CommandAgentRunnerEnsure, 1)); err != nil {
		t.Fatal(err)
	}
	// If the Operation reaches Start before removal cancels it, removal waits for
	// this Provider's cleanup. Release the Provider once it is cancelled.
	testDone := make(chan struct{})
	defer close(testDone)
	go func() {
		select {
		case <-providerCancelled:
		case <-testDone:
			return
		}
		close(providerRelease)
	}()
	startDone := make(chan error, 1)
	go func() {
		startDone <- d.handleOperationStart(context.Background(), stream, daemonOperationStart("operation-racing-remove", "agent-1"))
	}()
	select {
	case <-resolverStarted:
	case <-time.After(time.Second):
		t.Fatal("Operation admission did not reach the resolver")
	}
	removeDone := make(chan error, 1)
	go func() {
		removeDone <- d.handleAgentRunnerCommand(context.Background(), stream, daemonAgentRunnerCommand(protocol.CommandAgentRunnerRemove, 2))
	}()
	select {
	case err := <-removeDone:
		t.Fatalf("removal bypassed in-flight Operation admission: %v", err)
	case <-time.After(30 * time.Millisecond):
	}
	close(resolverRelease)
	if err := <-startDone; err != nil {
		t.Fatal(err)
	}
	// Removal runs after admission. Whether the Operation reached Start first is
	// decided under admissionMu, so the test does not wait for Start here.
	select {
	case err := <-removeDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("removal did not acknowledge")
	}
	// (a) the Operation has a committed terminal, (b) no entry remains for the Agent.
	terminals := 0
	for _, event := range stream.snapshotEvents() {
		if event.OperationID == "operation-racing-remove" && event.Type == protocol.EventOperationCancelled {
			terminals++
		}
	}
	if terminals != 1 {
		t.Fatalf("cancelled terminals=%d before removal returned, want 1; events=%+v", terminals, stream.snapshotEvents())
	}
	if active := d.ActiveOperationCount(); active != 0 {
		t.Fatalf("active Operations after removal=%d, want 0", active)
	}
	// (c) either the Provider never started, or its cleanup finished before removal returned.
	if providerStarts.Load() > 0 {
		select {
		case <-providerCancelled:
		default:
			t.Fatal("Provider started and removal returned before its cleanup")
		}
	}
	// Nothing may start the Provider after removal returned.
	before := providerStarts.Load()
	time.Sleep(50 * time.Millisecond)
	if after := providerStarts.Load(); after != before {
		t.Fatalf("Provider started after removal returned: starts %d -> %d", before, after)
	}
	d.WaitForOperations()
}

func TestTerminalLedgerFailureDrainsDaemonAndRetainsAdmissionFence(t *testing.T) {
	messages := make(chan native.Event)
	results := make(chan native.Outcome, 1)
	close(messages)
	results <- native.Outcome{Status: "completed", Output: "ok", SessionID: "thread-1"}
	close(results)
	wantErr := errors.New("disk is unavailable")
	d, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: &fakeStream{}}, IdentityStore: fakeStore{},
		OperationResolver: fakeOperationResolver{},
		Ledger:            failingCompleteLedger{OperationLedgerStore: newTestLedger(t), err: wantErr},
		Executor: provider.Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
			return fakeBackend{session: &native.Run{Events: messages, Outcome: results}}, nil
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	stream := &fakeStream{}
	d.operationStream = stream
	if err := d.handleOperationStart(context.Background(), stream, daemonOperationStart("operation-ledger-failure", "agent-1")); err != nil {
		t.Fatal(err)
	}
	d.WaitForOperations()
	if !errors.Is(d.fatalError(), wantErr) {
		t.Fatalf("fatal error = %v, want %v", d.fatalError(), wantErr)
	}
	if active := d.ActiveOperationCount(); active != 1 {
		t.Fatalf("active Operations after terminal persistence failure=%d, want 1", active)
	}
	if err := d.handleOperationStart(context.Background(), stream, daemonOperationStart("operation-after-ledger-failure", "agent-2")); err == nil || !strings.Contains(err.Error(), "draining") {
		t.Fatalf("post-failure admission error = %v, want draining", err)
	}
}

// readyTestContextView applies an empty ready Context View for the command's
// Context and returns the reference an Operation input must carry.
func daemonOperationStart(operationID, agentID string) protocol.Command {
	return protocol.Command{
		Type: protocol.CommandOperationStart, CommandID: "start-" + operationID, ProtocolVersion: "1.2",
		TenantID: "tenant-1", RunnerID: "computer-1", RegistrationID: "registration-1", AssignmentRevision: 1,
		AgentID: agentID, OperationID: operationID, ConnectionEpoch: 1, RunnerRevision: 1,
		Generation: 1, ExecutionLeaseID: "lease-" + operationID, WorkspaceGrantID: "grant-1", RuntimeType: "codex",
		OperationKind: "run.start", ExecutionContextKey: "context-" + agentID, RuntimeInstanceID: "runtime-" + agentID, ContextViewRef: testContextViewRef,
		Payload: json.RawMessage(`{"kind":"run.start","runtime":{"type":"codex"},"input":{"type":"text","text":"hello"}}`),
	}
}

func daemonAgentRunnerCommand(commandType string, revision uint64) protocol.Command {
	return protocol.Command{
		Type: commandType, CommandID: commandType, ProtocolVersion: "1.2",
		TenantID: "tenant-1", RunnerID: "computer-1", RegistrationID: "registration-1",
		AssignmentRevision: 1, AgentID: "agent-1", ConnectionEpoch: 1, RunnerRevision: revision,
		Payload: json.RawMessage(`{"runtime":{"type":"codex"},"workspace_grant_id":"grant-1"}`),
	}
}

func intPointer(value int) *int { return &value }

func (b shutdownBackend) Start(ctx context.Context, _ string, _ native.RunSpec) (*native.Run, error) {
	messages := make(chan native.Event)
	results := make(chan native.Outcome, 1)
	go func() {
		<-ctx.Done()
		close(b.cancelled)
		<-b.release
		close(messages)
		if b.cleanupUnconfirmed {
			results <- native.Outcome{Status: "failed", Error: "codex cleanup unconfirmed: method not found", ExitUnconfirmed: true}
		} else {
			results <- native.Outcome{Status: "aborted", Error: ctx.Err().Error()}
		}
		close(results)
	}()
	return &native.Run{Events: messages, Outcome: results}, nil
}

type steerBackend struct {
	steered chan native.SteerRequest
	result  chan native.Outcome
}

func (b steerBackend) Start(context.Context, string, native.RunSpec) (*native.Run, error) {
	messages := make(chan native.Event)
	return &native.Run{
		Events:  messages,
		Outcome: b.result,
		Steer: func(_ context.Context, request native.SteerRequest) (native.SteerAck, error) {
			b.steered <- request
			return native.SteerAck{TurnID: request.ExpectedTurnID}, nil
		},
	}, nil
}

func TestDaemonExecutesOperationAndEmitsTerminal(t *testing.T) {
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	messages := make(chan native.Event)
	results := make(chan native.Outcome, 1)
	close(messages)
	results <- native.Outcome{Status: "completed", Output: "ok", SessionID: "thread-1"}
	close(results)
	payload, err := json.Marshal(map[string]any{
		"kind": "run.start", "runtime": map[string]any{"type": "codex"},
		"input": map[string]any{"type": "text", "text": "hello"},
	})
	if err != nil {
		t.Fatal(err)
	}
	stream := &fakeStream{commands: []protocol.Command{
		{Type: "runner.welcome", ConnectionEpoch: 7},
		{Type: protocol.CommandRegistrationSnapshot, CommandID: "registration-snapshot-1", ConnectionEpoch: 7,
			Payload: mustJSON([]transport.RuntimeRegistration{{
				RegistrationID: "reg-1",
				Observation: transport.RegistrationObservation{
					TenantID: "tenant-1", OwnerActorID: "owner-1", ProviderType: "codex",
					Status: "online", Revision: 1, Capabilities: []string{"turn"},
				},
			}})},
		{Type: protocol.CommandOperationStart, CommandID: "cmd-123",
			ProtocolVersion: "1.2", TenantID: "tenant-1", RunnerID: "computer-1", RegistrationID: "reg-1", AssignmentRevision: 1,
			AgentID: "agent-1", OperationID: "op-1", ConnectionEpoch: 7, Payload: payload,
			RunnerRevision: 1, Generation: 1, ExecutionLeaseID: "lease-1", WorkspaceGrantID: "grant-1", RuntimeType: "codex", ExecutionContextKey: "context-1", RuntimeInstanceID: "runtime-1", ContextViewRef: testContextViewRef,
		},
	}}
	daemon, err := newTestDaemon(t, Options{
		ComputerID:        "computer-1",
		OperationResolver: fakeOperationResolver{},
		ControlPlane:      fakeControlPlane{stream: stream},
		IdentityStore:     fakeStore{value: device},
		Executor: provider.Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
			return fakeBackend{session: &native.Run{Events: messages, Outcome: results}}, nil
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	daemon.daemonID = device.DaemonID
	err = daemon.runConnection(context.Background(), device)
	if !errors.Is(err, io.EOF) {
		t.Fatalf("Run() error = %v, want EOF from fake stream", err)
	}
	waitForEvents(t, stream, 5)
	events := stream.snapshotEvents()
	if len(events) != 5 {
		t.Fatalf("events = %d, want hello, registration, accepted, final delta, terminal", len(events))
	}
	if events[1].Type != protocol.EventRuntimeObserved || events[2].Type != protocol.EventOperationAccepted ||
		events[3].Type != protocol.EventOperationEvent || events[4].Type != protocol.EventOperationCompleted ||
		!strings.Contains(string(events[3].Payload), `"delta":"ok"`) {
		t.Fatalf("unexpected events: %+v", events)
	}
	if events[4].OperationID != "op-1" || events[4].RegistrationID != "reg-1" {
		t.Fatalf("terminal identity = %+v", events[4])
	}
}

func TestDaemonProxiesLocalMCPAfterOperationAcceptance(t *testing.T) {
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	upstreamHeaders := make(chan http.Header, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		upstreamHeaders <- request.Header.Clone()
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{}}`))
	}))
	defer upstream.Close()
	token := strings.Repeat("secret", 6)
	relays := mustJSON([]map[string]any{{
		"name": "teamhub", "relay_url": upstream.URL, "relay_token": token,
		"tool_names": []string{"materialize_artifact"}, "expires_at": time.Now().Add(time.Minute),
	}})
	release := make(chan struct{})
	stream := &fakeStream{wait: release, commands: []protocol.Command{
		{Type: "runner.welcome", ConnectionEpoch: 7},
		{Type: "runner.reconciled", ConnectionEpoch: 7, RunnerID: "computer-1"},
		{Type: protocol.CommandOperationStart, CommandID: "mcp-start", ProtocolVersion: "1.2",
			TenantID: "tenant-1", RunnerID: "computer-1", RegistrationID: "reg-1", AssignmentRevision: 1,
			AgentID: "agent-1", OperationID: "operation-mcp", ConnectionEpoch: 7, RunnerRevision: 1,
			Generation: 1, ExecutionLeaseID: "lease-mcp", WorkspaceGrantID: "grant-1", RuntimeType: "codex",
			ExecutionContextKey: "context-1", RuntimeInstanceID: "runtime-1", ContextViewRef: testContextViewRef, Payload: json.RawMessage(`{"kind":"run.start"}`)},
	}}
	localURL := make(chan string, 1)
	daemon, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: stream},
		IdentityStore: fakeStore{value: device}, OperationResolver: mcpOperationResolver{relays: relays},
		Executor: provider.Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
			return callbackBackend{execute: func(ctx context.Context, _ string, options native.RunSpec) (*native.Run, error) {
				if events := stream.snapshotEvents(); len(events) < 2 || events[1].Type != protocol.EventOperationAccepted {
					return nil, errors.New("Provider started before Operation acceptance")
				}
				if strings.Contains(string(options.MCPServers), token) {
					return nil, errors.New("Provider MCP config leaked Relay token")
				}
				var config struct {
					Servers map[string]struct {
						URL string `json:"url"`
					} `json:"mcpServers"`
				}
				if err := json.Unmarshal(options.MCPServers, &config); err != nil || config.Servers["teamhub"].URL == "" {
					return nil, errors.New("Provider MCP config is invalid")
				}
				localURL <- config.Servers["teamhub"].URL
				request, _ := http.NewRequestWithContext(ctx, http.MethodPost, config.Servers["teamhub"].URL, strings.NewReader("{}"))
				request.Header.Set("Content-Type", "application/json")
				response, err := http.DefaultClient.Do(request)
				if err != nil {
					return nil, err
				}
				_ = response.Body.Close()
				messages := make(chan native.Event)
				results := make(chan native.Outcome, 1)
				close(messages)
				results <- native.Outcome{Status: "completed", Output: "ok", SessionID: "thread-1"}
				close(results)
				return &native.Run{Events: messages, Outcome: results}, nil
			}}, nil
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	daemon.daemonID = device.DaemonID
	done := make(chan error, 1)
	go func() { done <- daemon.runConnection(context.Background(), device) }()
	waitForEvents(t, stream, 3)
	close(release)
	if err := <-done; !errors.Is(err, io.EOF) {
		t.Fatal(err)
	}
	headers := <-upstreamHeaders
	if headers.Get("Authorization") != "Bearer "+token || headers.Get("X-Linger-Operation-Id") != "operation-mcp" || headers.Get("X-Linger-Execution-Lease-Id") != "lease-mcp" {
		t.Fatalf("Relay headers=%v", headers)
	}
	url := <-localURL
	deadline := time.Now().Add(time.Second)
	for {
		response, err := http.Get(url)
		if err != nil {
			break
		}
		_ = response.Body.Close()
		if time.Now().After(deadline) {
			t.Fatal("Local MCP proxy remained reachable after Operation terminal")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestDaemonPreStartFailureUsesGatewayErrorShape(t *testing.T) {
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	start := protocol.Command{
		Type: protocol.CommandOperationStart, CommandID: "start-failure", ProtocolVersion: "1.2",
		TenantID: "tenant-1", RunnerID: "computer-1", RegistrationID: "reg-1", AssignmentRevision: 1,
		AgentID: "agent-1", OperationID: "op-failure", ConnectionEpoch: 7, RunnerRevision: 1,
		Generation: 1, ExecutionLeaseID: "lease-1", WorkspaceGrantID: "grant-1", RuntimeType: "claude",
		ExecutionContextKey: "context-1", RuntimeInstanceID: "runtime-1", ContextViewRef: testContextViewRef, Payload: json.RawMessage(`{"kind":"run.start","runtime":{"type":"claude"},"input":{"type":"text","text":"hello"}}`),
	}
	stream := &fakeStream{commands: []protocol.Command{{Type: "runner.welcome", ConnectionEpoch: 7}, start}}
	daemon, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: stream},
		IdentityStore: fakeStore{value: device}, OperationResolver: failingOperationResolver{err: errors.New("Runtime binding failed")},
	})
	if err != nil {
		t.Fatal(err)
	}
	daemon.daemonID = device.DaemonID
	if err := daemon.runConnection(context.Background(), device); !errors.Is(err, io.EOF) {
		t.Fatalf("runConnection() error = %v", err)
	}
	events := stream.snapshotEvents()
	failed := events[len(events)-1]
	if failed.Type != protocol.EventOperationFailed || failed.Sequence != 1 {
		t.Fatalf("pre-start failure = %+v", failed)
	}
	var payload struct {
		Code      string `json:"code"`
		Message   string `json:"message"`
		Retryable bool   `json:"retryable"`
	}
	if err := json.Unmarshal(failed.Payload, &payload); err != nil || payload.Code != "RUNTIME_EXECUTION_FAILED" || payload.Message != "Runtime binding failed" || payload.Retryable {
		t.Fatalf("pre-start failure payload = %+v err=%v", payload, err)
	}
}

// A start this Computer refuses names why, so the Agent Service can tell the
// Room the Computer cannot run the Agent instead of a generic failure.
func TestDaemonRefusedStartNamesTheComputerCondition(t *testing.T) {
	for name, test := range map[string]struct {
		setup func(*Daemon)
		code  string
	}{
		"Runner stopped":      {setup: func(d *Daemon) { d.locallyStopped["agent-1"] = true }, code: "RUNNER_STOPPED"},
		"Runtime not enabled": {setup: func(d *Daemon) { d.enabledRuntimes = []string{"codex"} }, code: "RUNTIME_NOT_ENABLED"},
	} {
		t.Run(name, func(t *testing.T) {
			device, err := transport.GenerateIdentity()
			if err != nil {
				t.Fatal(err)
			}
			start := protocol.Command{
				Type: protocol.CommandOperationStart, CommandID: "start-refused", ProtocolVersion: "1.2",
				TenantID: "tenant-1", RunnerID: "computer-1", RegistrationID: "reg-1", AssignmentRevision: 1,
				AgentID: "agent-1", OperationID: "op-refused", ConnectionEpoch: 7, RunnerRevision: 1,
				Generation: 1, ExecutionLeaseID: "lease-1", WorkspaceGrantID: "grant-1", RuntimeType: "claude",
				ExecutionContextKey: "context-1", RuntimeInstanceID: "runtime-1", ContextViewRef: testContextViewRef, Payload: json.RawMessage(`{"kind":"run.start","runtime":{"type":"claude"},"input":{"type":"text","text":"hello"}}`),
			}
			stream := &fakeStream{commands: []protocol.Command{{Type: "runner.welcome", ConnectionEpoch: 7}, start}}
			daemon, err := newTestDaemon(t, Options{
				ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: stream},
				IdentityStore: fakeStore{value: device}, OperationResolver: fakeOperationResolver{},
			})
			if err != nil {
				t.Fatal(err)
			}
			daemon.daemonID = device.DaemonID
			test.setup(daemon)
			if err := daemon.runConnection(context.Background(), device); !errors.Is(err, io.EOF) {
				t.Fatalf("runConnection() error = %v", err)
			}
			events := stream.snapshotEvents()
			failed := events[len(events)-1]
			var payload struct {
				Code string `json:"code"`
			}
			if failed.Type != protocol.EventOperationFailed || json.Unmarshal(failed.Payload, &payload) != nil || payload.Code != test.code {
				t.Fatalf("refused start = %+v payload=%+v", failed, payload)
			}
		})
	}
}

func TestTerminalPayloadUsesProviderCompatibleSessionShapes(t *testing.T) {
	decode := func(spec provider.OperationSpec, result provider.Result) map[string]any {
		t.Helper()
		var value map[string]any
		if err := json.Unmarshal(terminalPayload(spec, result), &value); err != nil {
			t.Fatal(err)
		}
		return value["session"].(map[string]any)
	}
	for _, runtimeType := range []string{"claude", "pi"} {
		claudeReady := decode(provider.OperationSpec{OperationKind: "run.start", Provider: runtimeType, CreateProviderSessionID: "claude-session"}, provider.Result{Status: "completed", SessionID: "claude-session"})
		if claudeReady["provider"] != runtimeType || claudeReady["sessionId"] != "claude-session" || claudeReady["lingerMaterialized"] != true {
			t.Fatalf("Claude materialized session=%+v", claudeReady)
		}
	}
	codex := decode(provider.OperationSpec{OperationKind: "run.start", Provider: "codex"}, provider.Result{Status: "completed", SessionID: "thread", TurnID: "turn"})
	if len(codex) != 1 || codex["threadId"] != "thread" {
		t.Fatalf("Codex session=%+v", codex)
	}
}

func TestDaemonCancelsRunningOperationAfterProviderCleanup(t *testing.T) {
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	cleaned := make(chan struct{})
	request := json.RawMessage(`{"kind":"run.start","runtime":{"type":"codex"},"input":{"type":"text","text":"hello"}}`)
	start := protocol.Command{
		Type: protocol.CommandOperationStart, CommandID: "start-1", ProtocolVersion: "1.2",
		TenantID: "tenant-1", RunnerID: "computer-1", RegistrationID: "reg-1", AssignmentRevision: 1,
		AgentID: "agent-1", OperationID: "op-cancel", ConnectionEpoch: 7, RunnerRevision: 1,
		Generation: 1, ExecutionLeaseID: "lease-1", WorkspaceGrantID: "grant-1", RuntimeType: "codex",
		ExecutionContextKey: "context-1", RuntimeInstanceID: "runtime-1", ContextViewRef: testContextViewRef, Payload: request,
	}
	cancel := start
	cancel.Type = protocol.CommandOperationCancel
	cancel.CommandID = "cancel-1"
	cancel.Payload = json.RawMessage(`{"reason":"user requested cancellation"}`)
	stream := &fakeStream{commands: []protocol.Command{
		{Type: "runner.welcome", ConnectionEpoch: 7}, start, cancel,
	}}
	daemon, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: stream},
		IdentityStore: fakeStore{value: device}, OperationResolver: fakeOperationResolver{},
		Executor: provider.Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
			return cancellationBackend{cleaned: cleaned}, nil
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	stream.beforeCommand = gateInputUntilStarted(daemon)
	daemon.daemonID = device.DaemonID
	if err := daemon.runConnection(context.Background(), device); !errors.Is(err, io.EOF) {
		t.Fatalf("Run() error = %v, want EOF", err)
	}
	waitForEvents(t, stream, 3)
	select {
	case <-cleaned:
	default:
		t.Fatal("Operation became terminal before Provider cleanup completed")
	}
	events := stream.snapshotEvents()
	terminal := events[len(events)-1]
	if terminal.Type != protocol.EventOperationCancelled || terminal.Sequence != 2 {
		t.Fatalf("cancellation terminal = %+v", terminal)
	}
}

func TestDaemonAppliesOperationInputAndRecordsAcknowledgement(t *testing.T) {
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	steered := make(chan native.SteerRequest, 1)
	results := make(chan native.Outcome, 1)
	start := protocol.Command{
		Type: protocol.CommandOperationStart, CommandID: "start-input", ProtocolVersion: "1.2",
		TenantID: "tenant-1", RunnerID: "computer-1", RegistrationID: "reg-1", AssignmentRevision: 1,
		AgentID: "agent-1", OperationID: "op-input", ConnectionEpoch: 7, RunnerRevision: 1,
		Generation: 1, ExecutionLeaseID: "lease-1", WorkspaceGrantID: "grant-1", RuntimeType: "codex",
		ExecutionContextKey: "context-1", RuntimeInstanceID: "runtime-1", ContextViewRef: testContextViewRef, Payload: json.RawMessage(`{"kind":"run.start","runtime":{"type":"codex"},"input":{"type":"text","text":"hello"}}`),
	}
	views, viewRef := readyTestContextView(t, start)
	start.ContextViewRef = viewRef
	input := start
	input.Type = protocol.CommandOperationInput
	input.CommandID = "input-1"
	input.ExpectedTurnID = "turn-1"
	input.Input = json.RawMessage(`{"type":"text","text":"focus on tests"}`)
	input.InputContextViewRef = viewRef
	stream := &fakeStream{commands: []protocol.Command{
		{Type: "runner.welcome", ConnectionEpoch: 7}, start, input,
	}}
	daemon, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: stream},
		IdentityStore: fakeStore{value: device}, OperationResolver: fakeOperationResolver{}, ContextViews: views,
		Executor: provider.Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
			return steerBackend{steered: steered, result: results}, nil
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	stream.beforeCommand = gateInputUntilStarted(daemon)
	daemon.daemonID = device.DaemonID
	if err := daemon.runConnection(context.Background(), device); !errors.Is(err, io.EOF) {
		t.Fatalf("runConnection() error = %v, want EOF", err)
	}
	select {
	case request := <-steered:
		if request.ExpectedTurnID != "turn-1" || request.Input != "focus on tests" {
			t.Fatalf("steer request = %+v", request)
		}
	case <-time.After(time.Second):
		t.Fatal("Provider did not receive operation input")
	}
	waitForEvents(t, stream, 3)
	events := stream.snapshotEvents()
	ack := events[len(events)-1]
	if ack.Type != protocol.EventOperationInputAck || ack.CommandID != "input-1" || ack.Sequence != 2 {
		t.Fatalf("input acknowledgement = %+v", ack)
	}
	var payload struct {
		TurnID string `json:"turn_id"`
	}
	if err := json.Unmarshal(ack.Payload, &payload); err != nil || payload.TurnID != "turn-1" {
		t.Fatalf("input acknowledgement payload = %s err=%v", ack.Payload, err)
	}
	results <- native.Outcome{Status: "completed", Output: "ok", SessionID: "thread-1"}
	close(results)
}

func TestDaemonReplaysOperationInputOutcomeWithoutSteeringTwice(t *testing.T) {
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	steered := make(chan native.SteerRequest, 2)
	results := make(chan native.Outcome, 1)
	start := protocol.Command{
		Type: protocol.CommandOperationStart, CommandID: "start-input-replay", ProtocolVersion: "1.2",
		TenantID: "tenant-1", RunnerID: "computer-1", RegistrationID: "reg-1", AssignmentRevision: 1,
		AgentID: "agent-1", OperationID: "op-input-replay", ConnectionEpoch: 7, RunnerRevision: 1,
		Generation: 1, ExecutionLeaseID: "lease-1", WorkspaceGrantID: "grant-1", RuntimeType: "codex",
		ExecutionContextKey: "context-1", RuntimeInstanceID: "runtime-1", ContextViewRef: testContextViewRef, Payload: json.RawMessage(`{"kind":"run.start","runtime":{"type":"codex"},"input":{"type":"text","text":"hello"}}`),
	}
	views, viewRef := readyTestContextView(t, start)
	start.ContextViewRef = viewRef
	input := start
	input.Type = protocol.CommandOperationInput
	input.CommandID = "input-replay-1"
	input.ExpectedTurnID = "turn-1"
	input.Input = json.RawMessage(`{"type":"text","text":"focus on tests"}`)
	input.InputContextViewRef = viewRef
	stream := &fakeStream{commands: []protocol.Command{
		{Type: "runner.welcome", ConnectionEpoch: 7}, start, input,
	}}
	daemon, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: stream},
		IdentityStore: fakeStore{value: device}, OperationResolver: fakeOperationResolver{}, ContextViews: views,
		Executor: provider.Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
			return steerBackend{steered: steered, result: results}, nil
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	stream.beforeCommand = gateInputUntilStarted(daemon)
	daemon.daemonID = device.DaemonID
	if err := daemon.runConnection(context.Background(), device); !errors.Is(err, io.EOF) {
		t.Fatalf("runConnection() error = %v, want EOF", err)
	}
	waitForEvents(t, stream, 3)
	if err := daemon.handleOperationInput(context.Background(), stream, input); err != nil {
		t.Fatal(err)
	}
	if calls := len(steered); calls != 1 {
		t.Fatalf("Provider steer calls = %d, want 1", calls)
	}
	waitForEvents(t, stream, 4)
	events := stream.snapshotEvents()
	first, replay := events[len(events)-2], events[len(events)-1]
	if first.Type != protocol.EventOperationInputAck || replay.Type != first.Type ||
		replay.CommandID != first.CommandID || replay.Sequence != first.Sequence ||
		string(replay.Payload) != string(first.Payload) || first.Sequence != 2 {
		t.Fatalf("input outcomes = first %+v replay %+v", first, replay)
	}
	results <- native.Outcome{Status: "completed", SessionID: "thread-1"}
	close(results)
}

func TestDaemonRejectsOperationInputWithUnknownContextViewBeforeProvider(t *testing.T) {
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	steered := make(chan native.SteerRequest, 1)
	results := make(chan native.Outcome, 1)
	start := protocol.Command{
		Type: protocol.CommandOperationStart, CommandID: "start-input-context", ProtocolVersion: "1.2",
		TenantID: "tenant-1", RunnerID: "computer-1", RegistrationID: "reg-1", AssignmentRevision: 1,
		AgentID: "agent-1", OperationID: "op-input-context", ConnectionEpoch: 7, RunnerRevision: 1,
		Generation: 1, ExecutionLeaseID: "lease-1", WorkspaceGrantID: "grant-1", RuntimeType: "codex",
		ExecutionContextKey: "context-1", RuntimeInstanceID: "runtime-1", ContextViewRef: testContextViewRef,
		Payload: json.RawMessage(`{"kind":"run.start","runtime":{"type":"codex"},"input":{"type":"text","text":"hello"}}`),
	}
	views, viewRef := readyTestContextView(t, start)
	start.ContextViewRef = viewRef
	input := start
	input.Type = protocol.CommandOperationInput
	input.CommandID = "input-context-1"
	input.ExpectedTurnID = "turn-1"
	input.Input = json.RawMessage(`{"type":"text","text":"focus"}`)
	input.InputContextViewRef = mustJSON(lingercontext.ViewRef{ViewDigest: strings.Repeat("b", 64)})
	stream := &fakeStream{commands: []protocol.Command{{Type: "runner.welcome", ConnectionEpoch: 7}, start, input}}
	daemon, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: stream}, ContextViews: views,
		IdentityStore: fakeStore{value: device}, OperationResolver: fakeOperationResolver{},
		Executor: provider.Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
			return steerBackend{steered: steered, result: results}, nil
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	daemon.daemonID = device.DaemonID
	if err := daemon.runConnection(context.Background(), device); !errors.Is(err, io.EOF) {
		t.Fatalf("runConnection() error = %v, want EOF", err)
	}
	if calls := len(steered); calls != 0 {
		t.Fatalf("Provider steer calls = %d, want 0", calls)
	}
	waitForEvents(t, stream, 3)
	events := stream.snapshotEvents()
	rejected := events[len(events)-1]
	if rejected.Type != protocol.EventOperationInputRejected || rejected.Sequence != 2 {
		t.Fatalf("input rejection = %+v", rejected)
	}
	results <- native.Outcome{Status: "completed", SessionID: "thread-1"}
	close(results)
}

func TestDaemonAcceptsRetainedOperationInputAfterConnectionEpochChanges(t *testing.T) {
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	steered := make(chan native.SteerRequest, 1)
	results := make(chan native.Outcome, 1)
	start := protocol.Command{
		Type: protocol.CommandOperationStart, CommandID: "start-input-reconnect", ProtocolVersion: "1.2",
		TenantID: "tenant-1", RunnerID: "computer-1", RegistrationID: "reg-1", AssignmentRevision: 1,
		AgentID: "agent-1", OperationID: "op-input-reconnect", ConnectionEpoch: 1, RunnerRevision: 1,
		Generation: 1, ExecutionLeaseID: "lease-1", WorkspaceGrantID: "grant-1", RuntimeType: "codex",
		ExecutionContextKey: "context-1", RuntimeInstanceID: "runtime-1", ContextViewRef: testContextViewRef, Payload: json.RawMessage(`{"kind":"run.start","runtime":{"type":"codex"},"input":{"type":"text","text":"hello"}}`),
	}
	views, viewRef := readyTestContextView(t, start)
	start.ContextViewRef = viewRef
	first := &fakeStream{commands: []protocol.Command{{Type: "runner.welcome", ConnectionEpoch: 1}, start}}
	daemon, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: first},
		IdentityStore: fakeStore{value: device}, OperationResolver: fakeOperationResolver{}, ContextViews: views,
		Executor: provider.Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
			return steerBackend{steered: steered, result: results}, nil
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	daemon.daemonID = device.DaemonID
	if err := daemon.runConnection(context.Background(), device); !errors.Is(err, io.EOF) {
		t.Fatalf("first connection error = %v", err)
	}
	input := start
	input.Type = protocol.CommandOperationInput
	input.CommandID = "input-after-reconnect"
	input.ExpectedTurnID = "turn-1"
	input.Input = json.RawMessage(`{"type":"text","text":"focus"}`)
	input.InputContextViewRef = viewRef
	second := &fakeStream{commands: []protocol.Command{{Type: "runner.welcome", ConnectionEpoch: 2}, input}}
	second.beforeCommand = gateInputUntilStarted(daemon)
	daemon.controlPlane = fakeControlPlane{stream: second}
	if err := daemon.runConnection(context.Background(), device); !errors.Is(err, io.EOF) {
		t.Fatalf("second connection error = %v, want EOF", err)
	}
	waitForEvents(t, second, 2)
	if calls := len(steered); calls != 1 {
		t.Fatalf("Provider steer calls = %d, want 1", calls)
	}
	events := second.snapshotEvents()
	if events[len(events)-1].Type != protocol.EventOperationInputAck {
		t.Fatalf("reconnected input events = %+v", events)
	}
	results <- native.Outcome{Status: "completed", SessionID: "thread-1"}
	close(results)
}

func TestDaemonReplaysOnlyEventsAfterLastAckOnWelcome(t *testing.T) {
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	ledger := newTestLedger(t)
	identity := OperationIdentity{
		TenantID: "tenant-1", RunnerID: "computer-1", RegistrationID: "reg-1", AssignmentRevision: 2,
		AgentID: "agent-1", OperationID: "op-replay", ConnectionEpoch: 4, RunnerRevision: 3,
		Generation: 1, ExecutionLeaseID: "lease-1", WorkspaceGrantID: "grant-1", RuntimeType: "codex",
	}
	if _, err := ledger.Begin(context.Background(), identity); err != nil {
		t.Fatal(err)
	}
	if _, err := ledger.Append(context.Background(), identity, protocol.Event{Type: protocol.EventOperationAccepted, OperationID: identity.OperationID}); err != nil {
		t.Fatal(err)
	}
	terminal, err := ledger.Complete(context.Background(), identity, protocol.Event{Type: protocol.EventOperationCompleted, OperationID: identity.OperationID})
	if err != nil {
		t.Fatal(err)
	}
	if err := ledger.Acknowledge(context.Background(), identity, 1); err != nil {
		t.Fatal(err)
	}
	stream := &fakeStream{commands: []protocol.Command{{
		Type: "runner.welcome", ConnectionEpoch: 9, ReconcileOperationIDs: []string{identity.OperationID},
	}}}
	daemon, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: stream},
		IdentityStore: fakeStore{value: device}, OperationResolver: fakeOperationResolver{}, Ledger: ledger,
	})
	if err != nil {
		t.Fatal(err)
	}
	daemon.daemonID = device.DaemonID
	if err := daemon.runConnection(context.Background(), device); !errors.Is(err, io.EOF) {
		t.Fatalf("Run() error = %v, want EOF", err)
	}
	events := stream.snapshotEvents()
	if len(events) != 2 || events[1].Sequence != terminal.Sequence || events[1].Type != terminal.Type {
		t.Fatalf("replayed events = %+v", events)
	}
}

func TestDaemonReconnectsAfterTransientDisconnect(t *testing.T) {
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	controlPlane := &sequenceControlPlane{streams: []*fakeStream{
		{commands: []protocol.Command{{Type: "runner.welcome", ConnectionEpoch: 1}}},
		{commands: []protocol.Command{{Type: "runner.welcome", ConnectionEpoch: 2}}},
	}}
	controlPlane.onConnect = func(attempt int) {
		if attempt == 2 {
			cancel()
		}
	}
	daemon, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: controlPlane,
		IdentityStore: fakeStore{value: device}, OperationResolver: fakeOperationResolver{},
		RetryDelay: func(int) time.Duration { return 0 },
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := daemon.Run(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Run() error = %v, want context cancellation", err)
	}
	if controlPlane.calls != 2 {
		t.Fatalf("connections = %d, want 2", controlPlane.calls)
	}
}

func TestDefaultRetryDelayJittersWithinExponentialWindow(t *testing.T) {
	delay := defaultRetryDelay(nil)
	for attempt, ceiling := range []time.Duration{
		time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second,
		16 * time.Second, 32 * time.Second, 32 * time.Second,
	} {
		seen := make(map[time.Duration]struct{})
		for range 64 {
			got := delay(attempt)
			if got < ceiling/2 || got > ceiling {
				t.Fatalf("delay(%d) = %v, want within [%v, %v]", attempt, got, ceiling/2, ceiling)
			}
			seen[got] = struct{}{}
		}
		if len(seen) == 1 {
			t.Fatalf("delay(%d) returned one value for 64 calls, want jitter", attempt)
		}
	}
}

func TestDaemonRestartsBackoffOnlyAfterStableConnection(t *testing.T) {
	for _, test := range []struct {
		name   string
		stable time.Duration
		want   []int
	}{
		{name: "stable session restarts at the shortest delay", stable: 0, want: []int{0, 0}},
		{name: "short-lived session keeps backing off", stable: time.Hour, want: []int{0, 1}},
	} {
		t.Run(test.name, func(t *testing.T) {
			device, err := transport.GenerateIdentity()
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			controlPlane := &sequenceControlPlane{streams: []*fakeStream{
				{commands: []protocol.Command{{Type: "runner.welcome", ConnectionEpoch: 1}}},
				{commands: []protocol.Command{{Type: "runner.welcome", ConnectionEpoch: 2}}},
			}}
			controlPlane.onConnect = func(call int) {
				if call == 3 {
					cancel()
				}
			}
			var attempts []int
			daemon, err := newTestDaemon(t, Options{
				ComputerID: "computer-1", ControlPlane: controlPlane,
				IdentityStore: fakeStore{value: device}, OperationResolver: fakeOperationResolver{},
				RetryDelay: func(attempt int) time.Duration {
					attempts = append(attempts, attempt)
					return 0
				},
			})
			if err != nil {
				t.Fatal(err)
			}
			daemon.stableConnection = test.stable
			if err := daemon.Run(ctx); !errors.Is(err, context.Canceled) {
				t.Fatalf("Run() error = %v, want context cancellation", err)
			}
			if !slices.Equal(attempts, test.want) {
				t.Fatalf("retry attempts = %v, want %v", attempts, test.want)
			}
		})
	}
}

func TestDaemonRedialsQuicklyAfterGatewayRestart(t *testing.T) {
	restart := &websocket.CloseError{Code: websocket.CloseGoingAway, Text: "Agent Service shutting down"}
	welcome := protocol.Command{Type: "runner.welcome", ConnectionEpoch: 1}
	for _, test := range []struct {
		name    string
		streams []*fakeStream
		want    []int
	}{
		{
			name:    "restart close keeps refused dials at the shortest delay",
			streams: []*fakeStream{{commands: []protocol.Command{welcome}, receiveErr: restart}},
			want:    []int{0, 0, 0, 0},
		},
		{
			name:    "ordinary disconnect keeps escalating",
			streams: []*fakeStream{{commands: []protocol.Command{welcome}}},
			want:    []int{0, 1, 2, 3},
		},
		{
			name:    "refused dials without a restart keep escalating",
			streams: nil,
			want:    []int{0, 1, 2, 3},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			device, err := transport.GenerateIdentity()
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			controlPlane := &sequenceControlPlane{streams: test.streams}
			controlPlane.onConnect = func(call int) {
				if call == 5 {
					cancel()
				}
			}
			var attempts []int
			daemon, err := newTestDaemon(t, Options{
				ComputerID: "computer-1", ControlPlane: controlPlane,
				IdentityStore: fakeStore{value: device}, OperationResolver: fakeOperationResolver{},
				RetryDelay: func(attempt int) time.Duration {
					attempts = append(attempts, attempt)
					return 0
				},
			})
			if err != nil {
				t.Fatal(err)
			}
			if err := daemon.Run(ctx); !errors.Is(err, context.Canceled) {
				t.Fatalf("Run() error = %v, want context cancellation", err)
			}
			if !slices.Equal(attempts, test.want) {
				t.Fatalf("retry attempts = %v, want %v", attempts, test.want)
			}
		})
	}
}

func TestDaemonResumesBackoffAfterGatewayRestartWindow(t *testing.T) {
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	clock := time.Unix(1_800_000_000, 0)
	controlPlane := &sequenceControlPlane{streams: []*fakeStream{{
		commands:   []protocol.Command{{Type: "runner.welcome", ConnectionEpoch: 1}},
		receiveErr: &websocket.CloseError{Code: websocket.CloseServiceRestart},
	}}}
	controlPlane.onConnect = func(call int) {
		if call == 5 {
			cancel()
		}
	}
	var attempts []int
	daemon, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: controlPlane,
		IdentityStore: fakeStore{value: device}, OperationResolver: fakeOperationResolver{},
		RetryDelay: func(attempt int) time.Duration {
			attempts = append(attempts, attempt)
			// Each refused dial takes a minute of wall-clock time.
			clock = clock.Add(time.Minute)
			return 0
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	daemon.now = func() time.Time { return clock }
	if err := daemon.Run(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Run() error = %v, want context cancellation", err)
	}
	// Window starts at t0 (close), dials at t0 and t0+1m stay quick; t0+2m is past the window.
	if want := []int{0, 0, 2, 3}; !slices.Equal(attempts, want) {
		t.Fatalf("retry attempts = %v, want %v", attempts, want)
	}
}

func TestDaemonPublishesMonotonicRuntimeDiagnosticUpdates(t *testing.T) {
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	release := make(chan struct{})
	stream := &fakeStream{
		commands: []protocol.Command{{Type: "runner.welcome", ConnectionEpoch: 7}},
		wait:     release,
	}
	daemon, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: stream},
		IdentityStore: fakeStore{value: device}, OperationResolver: fakeOperationResolver{},
		Runtimes: []string{"codex"}, RuntimeDiagnostics: json.RawMessage(`[{"type":"codex","status":"authentication_required","protocol":"app-server","checked_at":"2026-09-01T00:00:00Z","error":{"code":"RUNTIME_AUTHENTICATION_REQUIRED","message":"login required"}}]`),
	})
	if err != nil {
		t.Fatal(err)
	}
	daemon.daemonID = device.DaemonID
	done := make(chan error, 1)
	go func() { done <- daemon.runConnection(context.Background(), device) }()
	waitForEvents(t, stream, 1)
	if err := daemon.UpdateRuntimeInventory(context.Background(), []string{"codex"}, json.RawMessage(`[{"type":"codex","status":"ready","protocol":"app-server","checked_at":"2026-09-01T00:00:15Z"}]`), nil); err != nil {
		t.Fatal(err)
	}
	waitForEvents(t, stream, 2)
	event := stream.snapshotEvents()[1]
	if event.Type != protocol.EventRuntimeDiagnostics || event.Revision != 2 || string(event.Payload) == "" {
		t.Fatalf("Runtime diagnostic event = %+v", event)
	}
	close(release)
	if err := <-done; !errors.Is(err, io.EOF) {
		t.Fatalf("runConnection() error = %v", err)
	}
}

func TestDaemonDoesNotRetryAuthenticationFailure(t *testing.T) {
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	controlPlane := &authenticationControlPlane{}
	daemon, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: controlPlane,
		IdentityStore: fakeStore{value: device}, OperationResolver: fakeOperationResolver{},
		RetryDelay: func(int) time.Duration { return 0 },
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- daemon.Run(ctx) }()
	waitForGatewayState(t, daemon, "authentication-failed")
	if controlPlane.calls != 1 {
		t.Fatalf("authentication attempts = %d, want 1", controlPlane.calls)
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("Run() error = %v, want context cancellation", err)
	}
}

func TestDaemonRetainsUpgradeRequiredStatus(t *testing.T) {
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	stream := &fakeStream{receiveErr: &transport.UpgradeRequiredError{Reason: "upgrade_required: protocol"}}
	daemon, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: stream},
		IdentityStore: fakeStore{value: device}, OperationResolver: fakeOperationResolver{},
		RetryDelay: func(int) time.Duration { return 0 },
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- daemon.Run(ctx) }()
	waitForGatewayState(t, daemon, "upgrade-required")
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("Run() error = %v, want context cancellation", err)
	}
}

func TestDaemonDisconnectDoesNotCancelRunningOperation(t *testing.T) {
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cleaned := make(chan struct{})
	start := protocol.Command{
		Type: protocol.CommandOperationStart, CommandID: "start-reconnect", ProtocolVersion: "1.2",
		TenantID: "tenant-1", RunnerID: "computer-1", RegistrationID: "reg-1", AssignmentRevision: 1,
		AgentID: "agent-1", OperationID: "op-reconnect", ConnectionEpoch: 1, RunnerRevision: 1,
		Generation: 1, ExecutionLeaseID: "lease-1", WorkspaceGrantID: "grant-1", RuntimeType: "codex", OperationKind: "run.start",
		ExecutionContextKey: "context-1", RuntimeInstanceID: "runtime-1", ContextViewRef: testContextViewRef, Payload: json.RawMessage(`{"kind":"run.start","runtime":{"type":"codex"},"input":{"type":"text","text":"hello"}}`),
	}
	controlPlane := &sequenceControlPlane{streams: []*fakeStream{
		{commands: []protocol.Command{{Type: "runner.welcome", ConnectionEpoch: 1}, start}},
		{commands: []protocol.Command{{Type: "runner.welcome", ConnectionEpoch: 2, ReconcileOperationIDs: []string{start.OperationID}}}},
	}}
	controlPlane.onConnect = func(attempt int) {
		if attempt != 2 {
			return
		}
		select {
		case <-cleaned:
			t.Error("transient disconnect cancelled the running Provider")
		default:
		}
		cancel()
	}
	daemon, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: controlPlane,
		IdentityStore: fakeStore{value: device}, OperationResolver: fakeOperationResolver{},
		RetryDelay: func(int) time.Duration { return 0 },
		Executor: provider.Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
			return cancellationBackend{cleaned: cleaned}, nil
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := daemon.Run(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Run() error = %v, want context cancellation", err)
	}
	if controlPlane.calls != 2 {
		t.Fatalf("connections = %d, want 2", controlPlane.calls)
	}
	var active []map[string]any
	if len(controlPlane.hellos) != 2 || json.Unmarshal(controlPlane.hellos[1].ActiveOperations, &active) != nil || len(active) != 1 || active[0]["operation_id"] != start.OperationID || active[0]["kind"] != "run.start" {
		t.Fatalf("reconnect active Operations=%s", controlPlane.hellos[1].ActiveOperations)
	}
}

func TestDaemonReconnectReplaysRunningStartAndDeliversCompletionOnNewStream(t *testing.T) {
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	results := make(chan native.Outcome, 1)
	start := protocol.Command{
		Type: protocol.CommandOperationStart, CommandID: "start-reconnect-replay", ProtocolVersion: "1.2",
		TenantID: "tenant-1", RunnerID: "computer-1", RegistrationID: "reg-1", AssignmentRevision: 1,
		AgentID: "agent-1", OperationID: "op-reconnect-replay", ConnectionEpoch: 1, RunnerRevision: 1,
		Generation: 1, ExecutionLeaseID: "lease-1", WorkspaceGrantID: "grant-1", RuntimeType: "codex",
		ExecutionContextKey: "context-1", RuntimeInstanceID: "runtime-1", ContextViewRef: testContextViewRef, Payload: json.RawMessage(`{"kind":"run.start","runtime":{"type":"codex"},"input":{"type":"text","text":"hello"}}`),
	}
	first := &fakeStream{commands: []protocol.Command{{Type: "runner.welcome", ConnectionEpoch: 1}, start}}
	daemon, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: first},
		IdentityStore: fakeStore{value: device}, OperationResolver: fakeOperationResolver{},
		Executor: provider.Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
			messages := make(chan native.Event)
			close(messages)
			return fakeBackend{session: &native.Run{Events: messages, Outcome: results}}, nil
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	daemon.daemonID = device.DaemonID
	if err := daemon.runConnection(context.Background(), device); !errors.Is(err, io.EOF) {
		t.Fatalf("first connection error = %v", err)
	}
	waitForEvents(t, first, 2)

	release := make(chan struct{})
	second := &fakeStream{commands: []protocol.Command{
		{Type: "runner.welcome", ConnectionEpoch: 2, ReconcileOperationIDs: []string{start.OperationID}},
		start,
	}, wait: release}
	daemon.controlPlane = fakeControlPlane{stream: second}
	done := make(chan error, 1)
	go func() { done <- daemon.runConnection(context.Background(), device) }()
	// Both welcome and duplicate start replay the unacknowledged acceptance.
	waitForEvents(t, second, 3)
	results <- native.Outcome{Status: "completed", Output: "ok", SessionID: "thread-1"}
	close(results)
	waitForEvents(t, second, 5)
	close(release)
	if err := <-done; !errors.Is(err, io.EOF) {
		t.Fatalf("second connection error = %v", err)
	}
	events := second.snapshotEvents()
	if events[1].Type != protocol.EventOperationAccepted || events[2].Type != protocol.EventOperationAccepted || events[2].Sequence != events[1].Sequence ||
		events[3].Type != protocol.EventOperationEvent || events[4].Type != protocol.EventOperationCompleted || !strings.Contains(string(events[3].Payload), `"delta":"ok"`) {
		t.Fatalf("reconnected events = %+v", events)
	}
	for _, event := range events {
		if event.Type == protocol.EventOperationFailed {
			t.Fatalf("replayed running Operation failed: %+v", event)
		}
	}
}

func TestDaemonPersistsAndAcknowledgesAgentRunnerLifecycle(t *testing.T) {
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	assignments := newTestAssignments(t)
	ensure := protocol.Command{
		Type: protocol.CommandAgentRunnerEnsure, CommandID: "ensure-runner-1", ProtocolVersion: "1.2",
		RunnerID: "computer-1", TenantID: "tenant-1", AgentID: "agent-1",
		RegistrationID: "registration-1", AssignmentRevision: 2,
		ConnectionEpoch: 7, RunnerRevision: 1,
		Payload: json.RawMessage(`{"runtime":{"type":"codex"},"workspace_grant_id":"grant-1"}`),
	}
	stream := &fakeStream{commands: []protocol.Command{
		{Type: "runner.welcome", ConnectionEpoch: 7}, ensure,
	}}
	daemon, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: stream},
		IdentityStore: fakeStore{value: device}, OperationResolver: fakeOperationResolver{},
		Assignments: assignments,
	})
	if err != nil {
		t.Fatal(err)
	}
	daemon.daemonID = device.DaemonID
	if err := daemon.runConnection(context.Background(), device); !errors.Is(err, io.EOF) {
		t.Fatalf("runConnection() error = %v", err)
	}
	events := stream.snapshotEvents()
	if len(events) != 2 || events[1].Type != protocol.EventAgentRunnerReady || events[1].RegistrationID != "registration-1" {
		t.Fatalf("Agent Runner events = %+v", events)
	}
	records, err := assignments.List(context.Background())
	if err != nil || len(records) != 1 || records[0].State != "ready" || records[0].AssignmentRevision != 2 {
		t.Fatalf("Agent Runner records = %+v err=%v", records, err)
	}
}

func TestDaemonInspectsCodexHistoryThroughTheCurrentContextView(t *testing.T) {
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	state := t.TempDir()
	views, ref := readyTestContextView(t, protocol.Command{
		TenantID: "tenant-1", RunnerID: "computer-1", AgentID: "agent-1", WorkspaceGrantID: "grant-1",
		ExecutionContextKey: "context-1", RuntimeInstanceID: "runtime-1",
	})
	var view lingercontext.ViewRef
	if err := json.Unmarshal(ref, &view); err != nil {
		t.Fatal(err)
	}
	runtimeRoot := filepath.Join(state, "runtime-homes")
	home, err := localworkspace.RuntimeHomePath(runtimeRoot, localworkspace.RuntimeHomeIdentity{
		TenantID: "tenant-1", OwnerActorID: "owner-1", AgentID: "agent-1",
		ScopeID: "context-1", ProviderType: "codex",
	})
	if err != nil {
		t.Fatal(err)
	}
	sessions := filepath.Join(home, "sessions", "2026", "08", "24")
	if err := os.MkdirAll(sessions, 0o700); err != nil {
		t.Fatal(err)
	}
	rollout := strings.Join([]string{
		`{"timestamp":"2026-08-24T12:00:00Z","type":"session_meta","payload":{"id":"thread-debug","base_instructions":"inspect safely"}}`,
		`{"timestamp":"2026-08-24T12:00:01Z","type":"event_msg","payload":{"type":"agent_message","message":"done"}}`,
		"",
	}, "\n")
	if err := os.WriteFile(filepath.Join(sessions, "rollout-thread-debug.jsonl"), []byte(rollout), 0o600); err != nil {
		t.Fatal(err)
	}
	registrations := newTestRegistrations(t)
	if _, err := registrations.Apply(context.Background(), registration.Observation{
		RegistrationID: "registration-1", Key: registration.Key{
			DaemonID: device.DaemonID, TenantID: "tenant-1", OwnerActorID: "owner-1", ProviderType: "codex",
		}, Status: registration.StatusOnline, Revision: 1,
	}); err != nil {
		t.Fatal(err)
	}
	command := protocol.Command{
		Type: protocol.CommandDebugInspect, CommandID: "debug-1", ProtocolVersion: "1.1",
		RunnerID: "computer-1", TenantID: "tenant-1", AgentID: "agent-1",
		RegistrationID: "registration-1", AssignmentRevision: 2, ConnectionEpoch: 7,
		RunnerRevision: 1, WorkspaceGrantID: "grant-1", ExecutionContextKey: "context-1",
		RuntimeInstanceID: "runtime-1", ViewDigest: view.ViewDigest,
		Payload: mustJSON(map[string]any{"request": map[string]any{
			"kind": "history", "runtime": map[string]any{"type": "codex"},
			"session": map[string]any{"threadId": "thread-debug"}, "limit": 1,
		}}),
	}
	stream := &fakeStream{commands: []protocol.Command{{Type: "runner.welcome", ConnectionEpoch: 7}, command}}
	daemon, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: stream},
		IdentityStore: fakeStore{value: device}, OperationResolver: fakeOperationResolver{},
		ContextViews: views, Registrations: registrations, RuntimeHomeRoot: runtimeRoot, Runtimes: []string{"codex"},
	})
	if err != nil {
		t.Fatal(err)
	}
	daemon.daemonID = device.DaemonID
	if err := daemon.runConnection(context.Background(), device); !errors.Is(err, io.EOF) {
		t.Fatalf("runConnection() error = %v", err)
	}
	events := stream.snapshotEvents()
	if len(events) != 2 || events[1].Type != protocol.EventDebugInspected || events[1].ViewDigest != view.ViewDigest {
		t.Fatalf("Debug events = %+v", events)
	}
	var result struct {
		Status   string `json:"status"`
		Snapshot struct {
			SessionID string `json:"thread_id"`
		} `json:"snapshot"`
		Records []struct {
			Ordinal int `json:"ordinal"`
		} `json:"records"`
	}
	if err := json.Unmarshal(events[1].Payload, &result); err != nil || result.Status != "available" || result.Snapshot.SessionID != "thread-debug" || len(result.Records) != 1 || result.Records[0].Ordinal != 1 {
		t.Fatalf("Debug history = %s err=%v", events[1].Payload, err)
	}
	// A read racing a View change fails only this inspection. A read with
	// the current View still returns the same native Session.
	command.ViewDigest = strings.Repeat("c", 64)
	stale := &fakeStream{}
	if err := daemon.handleDebugInspect(context.Background(), stale, command); err != nil {
		t.Fatal(err)
	}
	if len(stale.snapshotEvents()) != 1 || !strings.Contains(string(stale.snapshotEvents()[0].Payload), `"reason":"context_view_conflict"`) {
		t.Fatal("a stale View did not return a bounded inspection failure")
	}
	command.ViewDigest = view.ViewDigest
	fresh := &fakeStream{}
	if err := daemon.handleDebugInspect(context.Background(), fresh, command); err != nil {
		t.Fatal(err)
	}
	if len(fresh.snapshotEvents()) != 1 || !strings.Contains(string(fresh.snapshotEvents()[0].Payload), `"status":"available"`) {
		t.Fatal("the current View did not restore history inspection")
	}
	// Persisted Session inspection does not require a live Context View.
	_, err = daemon.assignments.Apply(context.Background(), assignment.Command{
		Type: protocol.CommandAgentRunnerEnsure, CommandID: "history-assignment", RunnerID: command.RunnerID,
		TenantID: command.TenantID, AgentID: command.AgentID, RegistrationID: command.RegistrationID,
		AssignmentRevision: command.AssignmentRevision, RunnerRevision: command.RunnerRevision,
		WorkspaceGrantID: command.WorkspaceGrantID, Runtime: json.RawMessage(`{"type":"codex"}`),
	}, 0)
	if err != nil {
		t.Fatal(err)
	}
	daemon.contextViews = nil
	command.ViewDigest = ""
	command.Payload = json.RawMessage(`{"detached_history":true,"request":{"kind":"history","runtime":{"type":"codex"},"session":{"threadId":"thread-debug"},"limit":1}}`)
	detached := &fakeStream{}
	if err := daemon.handleDebugInspect(context.Background(), detached, command); err != nil {
		t.Fatal(err)
	}
	if len(detached.snapshotEvents()) != 1 || !strings.Contains(string(detached.snapshotEvents()[0].Payload), `"status":"available"`) {
		t.Fatal("detached History did not read native Session")
	}
	command.AssignmentRevision++
	denied := &fakeStream{}
	if err := daemon.handleDebugInspect(context.Background(), denied, command); err != nil {
		t.Fatal(err)
	}
	if len(denied.snapshotEvents()) != 1 || !strings.Contains(string(denied.snapshotEvents()[0].Payload), `"status":"unavailable"`) {
		t.Fatal("stale Assignment authorized detached History")
	}
	command.AssignmentRevision--

	// A cold Context gives the Agent Service no Runner identity to send. The
	// Daemon authorizes the read from its own ready Assignment instead.
	identity := struct {
		registrationID     string
		assignmentRevision uint64
		runnerRevision     uint64
	}{command.RegistrationID, command.AssignmentRevision, command.RunnerRevision}
	command.RegistrationID = ""
	command.AssignmentRevision = 0
	command.RunnerRevision = 0
	unidentified := &fakeStream{}
	if err := daemon.handleDebugInspect(context.Background(), unidentified, command); err != nil {
		t.Fatal(err)
	}
	if len(unidentified.snapshotEvents()) != 1 || !strings.Contains(string(unidentified.snapshotEvents()[0].Payload), `"status":"available"`) {
		t.Fatalf("detached History without Runner identity = %s", unidentified.snapshotEvents()[0].Payload)
	}

	// Placement still has to match: an Agent without a ready Assignment on this
	// grant cannot read History just by omitting the identity.
	grant := command.WorkspaceGrantID
	command.WorkspaceGrantID = "grant-unauthorized"
	unauthorized := &fakeStream{}
	if err := daemon.handleDebugInspect(context.Background(), unauthorized, command); err != nil {
		t.Fatal(err)
	}
	if len(unauthorized.snapshotEvents()) != 1 || !strings.Contains(string(unauthorized.snapshotEvents()[0].Payload), `"status":"unavailable"`) {
		t.Fatal("unmatched placement authorized detached History")
	}
	command.WorkspaceGrantID = grant
	command.RegistrationID = identity.registrationID
	command.AssignmentRevision = identity.assignmentRevision
	command.RunnerRevision = identity.runnerRevision
}

// awaitProviderStarts waits for n Provider starts. Start runs off the admission
// lock after operation.accepted, so tests must not assume it has happened yet.
func awaitProviderStarts(t *testing.T, started <-chan struct{}, n int) {
	t.Helper()
	for range n {
		select {
		case <-started:
		case <-time.After(2 * time.Second):
			t.Fatal("Provider start was not observed")
		}
	}
}

// operationExecutionPending reports whether an admitted Operation has not yet
// reached Provider start. Start runs after operation.accepted.
func operationExecutionPending(d *Daemon) bool {
	d.activeMu.Lock()
	defer d.activeMu.Unlock()
	for _, active := range d.activeOperations {
		if active.execution == nil {
			return true
		}
	}
	return false
}

// awaitOperationStarted waits for the Provider start of every admitted Operation.
func awaitOperationStarted(t *testing.T, d *Daemon) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for operationExecutionPending(d) {
		if time.Now().After(deadline) {
			t.Fatal("Operation did not start its Provider")
		}
		time.Sleep(time.Millisecond)
	}
}

// gateInputUntilStarted holds operation.input and operation.cancel until the
// queued start was admitted and its Provider has started, as a real Agent sends
// them only after run.started.
func gateInputUntilStarted(d *Daemon) func(protocol.Command) error {
	return func(command protocol.Command) error {
		if command.Type != protocol.CommandOperationInput && command.Type != protocol.CommandOperationCancel {
			return nil
		}
		deadline := time.Now().Add(2 * time.Second)
		for !dispatchIdle(d)() || operationExecutionPending(d) {
			if time.Now().After(deadline) {
				return errors.New("Operation did not start its Provider before input")
			}
			time.Sleep(time.Millisecond)
		}
		return nil
	}
}

func waitForEvents(t *testing.T, stream *fakeStream, count int) {
	waitForEventsWithin(t, stream, count, 2*time.Second)
}

func waitForEventsWithin(t *testing.T, stream *fakeStream, count int, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for len(stream.snapshotEvents()) < count && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if got := len(stream.snapshotEvents()); got < count {
		t.Fatalf("events = %d, want at least %d", got, count)
	}
}

func waitForGatewayState(t *testing.T, daemon *Daemon, state string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for daemon.GatewayState() != state && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if current := daemon.GatewayState(); current != state {
		t.Fatalf("Gateway state = %q, want %q", current, state)
	}
}

func (s *fakeStream) snapshotEvents() []protocol.Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]protocol.Event(nil), s.events...)
}

func TestStartFromBeforeThisProcessIsReportedInterruptedNotExecuted(t *testing.T) {
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	start := protocol.Command{Type: protocol.CommandOperationStart, CommandID: "cloud-before-dispatch", ProtocolVersion: "1.2", TenantID: "tenant-1", RunnerID: "computer-1", RegistrationID: "reg-1", AssignmentRevision: 1, AgentID: "agent-1", OperationID: "never-dispatched", ConnectionEpoch: 1, RunnerRevision: 1, Generation: 1, ExecutionLeaseID: "lease-1", WorkspaceGrantID: "grant-1", RuntimeType: "codex", ExecutionContextKey: "context-1", RuntimeInstanceID: "runtime-1", ContextViewRef: testContextViewRef, Payload: json.RawMessage(`{"kind":"run.start","runtime":{"type":"codex"},"input":{"type":"text","text":"once"}}`)}
	stream := &fakeStream{commands: []protocol.Command{{Type: "runner.welcome", ConnectionEpoch: 2}, start, start}}
	daemon, err := newTestDaemon(t, Options{ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: stream}, IdentityStore: fakeStore{value: device}, OperationResolver: fakeOperationResolver{}, Executor: provider.Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
		t.Error("a start sent to an earlier Daemon process executed")
		return nil, errors.New("must not execute")
	}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := daemon.runConnection(t.Context(), device); !errors.Is(err, io.EOF) {
		t.Fatalf("connection: %v", err)
	}
	events := stream.snapshotEvents()
	if len(events) != 3 {
		t.Fatalf("events: %+v", events)
	}
	for _, event := range events[1:] {
		if event.Type != protocol.EventOperationFailed || event.Sequence != 1 || !strings.Contains(string(event.Payload), `"code":"DAEMON_RESTARTED"`) || !strings.Contains(string(event.Payload), `"retryable":false`) {
			t.Fatalf("unexpected receipt: %+v", event)
		}
	}
}

func TestTerminalPayloadFailureDiagnostics(t *testing.T) {
	spec := provider.OperationSpec{Provider: "codex", OperationKind: "run.start"}
	result := provider.Result{Status: "failed"}
	if err := json.Unmarshal([]byte(`{"code":"httpConnectionFailed","statusCode":429,"exitCode":3,"signal":"SIGSEGV"}`), &result.Diagnostics); err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(terminalPayload(spec, result), &payload); err != nil {
		t.Fatal(err)
	}
	diagnostics, ok := payload["diagnostics"].(map[string]any)
	if !ok || diagnostics["code"] != "httpConnectionFailed" || diagnostics["statusCode"] != float64(429) || diagnostics["exitCode"] != float64(3) || diagnostics["signal"] != "SIGSEGV" {
		t.Fatalf("payload=%+v", payload)
	}
	failure := payload["failure"].(map[string]any)
	if len(failure) != 2 || failure["code"] != "rate_limited" {
		t.Fatalf("public failure must follow the diagnostics: %+v", failure)
	}
	for _, tc := range []struct {
		name   string
		result provider.Result
	}{
		{"success", provider.Result{Status: "completed", Diagnostics: result.Diagnostics}},
		{"cleanup", provider.Result{Status: "failed", CleanupUnconfirmed: true, Diagnostics: result.Diagnostics}},
		{"absent", provider.Result{Status: "failed"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var value map[string]any
			if err := json.Unmarshal(terminalPayload(spec, tc.result), &value); err != nil {
				t.Fatal(err)
			}
			if _, exists := value["diagnostics"]; exists {
				t.Fatalf("unexpected diagnostics: %+v", value)
			}
		})
	}
	if err := json.Unmarshal([]byte(`{"code":"raw private text","statusCode":999,"exitCode":2147483648,"signal":"killed"}`), &result.Diagnostics); err != nil {
		t.Fatal(err)
	}
	var invalid map[string]any
	if err := json.Unmarshal(terminalPayload(spec, result), &invalid); err != nil {
		t.Fatal(err)
	}
	if _, exists := invalid["diagnostics"]; exists {
		t.Fatalf("invalid diagnostics must be omitted: %+v", invalid)
	}
}

func TestTerminalPayloadExternalCodexSignal(t *testing.T) {
	spec := provider.OperationSpec{Provider: "codex", OperationKind: "run.start"}
	result := provider.Result{Status: "failed", Error: "codex process exited: private stderr"}
	result.Diagnostics.Signal = "SIGTERM"
	for _, unconfirmed := range []bool{false, true} {
		result.CleanupUnconfirmed = unconfirmed
		var payload map[string]any
		if err := json.Unmarshal(terminalPayload(spec, result), &payload); err != nil {
			t.Fatal(err)
		}
		if unconfirmed {
			if payload["code"] != "RUNTIME_CLEANUP_UNCONFIRMED" || payload["diagnostics"] != nil || payload["failure"] != nil {
				t.Fatalf("cleanup uncertainty must win: %+v", payload)
			}
			continue
		}
		if payload["code"] != "RUNTIME_EXECUTION_FAILED" || payload["message"] != "codex process exited" {
			t.Fatalf("expected controlled execution failure: %+v", payload)
		}
		diagnostics := payload["diagnostics"].(map[string]any)
		if len(diagnostics) != 1 || diagnostics["signal"] != "SIGTERM" {
			t.Fatalf("signal only: %+v", diagnostics)
		}
		failure := payload["failure"].(map[string]any)
		if len(failure) != 2 || failure["code"] != "execution_failed" {
			t.Fatalf("public classification: %+v", failure)
		}
	}
}
