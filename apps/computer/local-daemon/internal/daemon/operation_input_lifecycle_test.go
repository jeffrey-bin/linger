package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

type delayedInputBackend struct {
	started  chan struct{}
	release  chan struct{}
	complete chan struct{}
	messages chan native.Event
	calls    atomic.Int32
}

type inputOutcomeFailureLedger struct{ OperationLedgerStore }

func (ledger inputOutcomeFailureLedger) CompleteInput(context.Context, OperationIdentity, protocol.Command, protocol.Event) (protocol.Event, error) {
	return protocol.Event{}, errors.New("fixture input outcome persistence failed")
}

type pausedInputLedger struct {
	OperationLedgerStore
	write   string
	entered chan struct{}
	release chan struct{}
}

func (ledger *pausedInputLedger) pause(write string) {
	if ledger.write == write {
		close(ledger.entered)
		<-ledger.release
	}
}

func (ledger *pausedInputLedger) BeginInput(ctx context.Context, identity OperationIdentity, command protocol.Command) (BeginInputResult, error) {
	ledger.pause("begin")
	return ledger.OperationLedgerStore.BeginInput(ctx, identity, command)
}

func (ledger *pausedInputLedger) CompleteInput(ctx context.Context, identity OperationIdentity, command protocol.Command, event protocol.Event) (protocol.Event, error) {
	ledger.pause("reject")
	return ledger.OperationLedgerStore.CompleteInput(ctx, identity, command, event)
}

func (ledger *pausedInputLedger) Complete(ctx context.Context, identity OperationIdentity, event protocol.Event) (protocol.Event, error) {
	ledger.pause("terminal")
	return ledger.OperationLedgerStore.Complete(ctx, identity, event)
}

func TestOperationInputLedgerWriteDoesNotBlockLocalStop(t *testing.T) {
	for _, write := range []string{"begin", "reject", "terminal"} {
		t.Run(write, func(t *testing.T) {
			d, _, start, input, backend := delayedInputFixture(t)
			backend.complete = make(chan struct{})
			ledger := &pausedInputLedger{OperationLedgerStore: d.ledger, write: write, entered: make(chan struct{}), release: make(chan struct{})}
			d.ledger = ledger
			defer close(ledger.release)
			if err := d.handleOperationStart(t.Context(), &fakeStream{}, start); err != nil {
				t.Fatal(err)
			}
			// Input needs a running Provider; waiting here also keeps Start from
			// resetting the execution the reject case clears below.
			awaitOperationStarted(t, d)
			inputDone := make(chan error, 1)
			if write == "terminal" {
				close(backend.complete)
			} else {
				if write == "reject" {
					d.activeMu.Lock()
					d.activeOperations[start.OperationID].execution = nil
					d.activeMu.Unlock()
				}
				go func() { inputDone <- d.handleOperationInput(t.Context(), &fakeStream{}, input) }()
			}
			select {
			case <-ledger.entered:
			case <-time.After(2 * time.Second):
				t.Fatal("ledger fixture did not reach its write barrier")
			}
			stopped := make(chan error, 1)
			go func() {
				if count := d.ActiveOperationCount(); count != 1 {
					stopped <- errors.New("active operation disappeared before the write committed")
					return
				}
				stop := start
				stop.Type = protocol.CommandOperationCancel
				stopped <- d.handleOperationCancel(stop)
			}()
			select {
			case err := <-stopped:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(time.Second):
				t.Fatal("ledger I/O held the global active lock and blocked local Stop")
			}
		})
	}
}

func TestOperationInputRecordFailureStopsTheDaemonWithoutATerminal(t *testing.T) {
	d, _, start, input, backend := delayedInputFixture(t)
	backend.complete = make(chan struct{})
	d.ledger = inputOutcomeFailureLedger{d.ledger}
	stream := &fakeStream{}
	if err := d.activateStreamAndReplay(t.Context(), stream, nil); err != nil {
		t.Fatal(err)
	}
	if err := d.handleOperationStart(t.Context(), stream, start); err != nil {
		t.Fatal(err)
	}
	awaitOperationStarted(t, d)
	if err := d.handleOperationInput(t.Context(), stream, input); err != nil {
		t.Fatal(err)
	}
	waitInputStarted(t, backend)
	close(backend.release)
	d.WaitForOperations()
	retained, err := d.ledger.Replay(t.Context(), []string{start.OperationID})
	if err != nil || len(retained) != 1 || retained[0].Type != protocol.EventOperationAccepted || d.fatalError() == nil {
		t.Fatalf("a failed input record must not let a terminal overtake it: events=%+v err=%v fatal=%v", retained, err, d.fatalError())
	}
	active, err := d.ledger.Active(t.Context())
	var inventory []map[string]any
	if err != nil || json.Unmarshal(active, &inventory) != nil || len(inventory) != 1 {
		t.Fatalf("the Operation stopped being active: active=%s err=%v", active, err)
	}
	if backend.calls.Load() != 1 {
		t.Fatalf("input was delivered again: calls=%d", backend.calls.Load())
	}
}

func (backend *delayedInputBackend) Start(ctx context.Context, _ string, _ native.RunSpec) (*native.Run, error) {
	messages := backend.messages
	if messages == nil {
		messages = make(chan native.Event)
		close(messages)
	}
	results := make(chan native.Outcome, 1)
	go func() {
		select {
		case <-ctx.Done():
			results <- native.Outcome{Status: "aborted", SessionID: "thread-1"}
		case <-backend.complete:
			results <- native.Outcome{Status: "completed", SessionID: "thread-1"}
		}
		if backend.messages != nil {
			close(messages)
		}
		close(results)
	}()
	return &native.Run{
		Events: messages, Outcome: results,
		Steer: func(_ context.Context, request native.SteerRequest) (native.SteerAck, error) {
			if backend.calls.Add(1) == 1 {
				close(backend.started)
			}
			select {
			case <-backend.release:
				if backend.complete != nil {
					close(backend.complete)
				}
				return native.SteerAck{TurnID: request.ExpectedTurnID}, nil
			case <-ctx.Done():
				return native.SteerAck{}, &native.SteerError{Effect: "uncertain", Reason: "transport", Message: "fixture confirmation interrupted"}
			}
		},
	}, nil
}

func TestOperationInputOutcomePrecedesImmediateTerminal(t *testing.T) {
	d, _, start, input, backend := delayedInputFixture(t)
	backend.complete = make(chan struct{})
	stream := &fakeStream{}
	if err := d.activateStreamAndReplay(t.Context(), stream, nil); err != nil {
		t.Fatal(err)
	}
	if err := d.handleOperationStart(t.Context(), stream, start); err != nil {
		t.Fatal(err)
	}
	awaitOperationStarted(t, d)
	if err := d.handleOperationInput(t.Context(), stream, input); err != nil {
		t.Fatal(err)
	}
	waitInputStarted(t, backend)
	close(backend.release)
	d.WaitForOperations()
	retained, err := d.ledger.Replay(t.Context(), []string{start.OperationID})
	if err != nil || len(retained) != 3 || retained[1].Type != protocol.EventOperationInputAck || retained[2].Type != protocol.EventOperationCompleted {
		t.Fatalf("confirmation was lost at terminal commitment: events=%+v err=%v", retained, err)
	}
	for index, event := range stream.snapshotEvents() {
		if event.Sequence != uint64(index+1) {
			t.Fatalf("wire outcome order changed: %+v", stream.snapshotEvents())
		}
	}
	if d.fatalError() != nil {
		t.Fatalf("terminal raced input persistence: %v", d.fatalError())
	}
}

func delayedInputFixture(t *testing.T) (*Daemon, transport.Identity, protocol.Command, protocol.Command, *delayedInputBackend) {
	t.Helper()
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	ledger := NewMemoryLedger()
	backend := &delayedInputBackend{started: make(chan struct{}), release: make(chan struct{})}
	d, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: &fakeStream{}},
		IdentityStore: fakeStore{value: device}, OperationResolver: fakeOperationResolver{}, Ledger: ledger,
		Executor: provider.Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) { return backend, nil }},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Drain(); d.WaitForOperations() })
	d.daemonID = device.DaemonID
	start := protocol.Command{
		Type: protocol.CommandOperationStart, CommandID: "start-input-wait", ProtocolVersion: "1.2",
		TenantID: "tenant-1", RunnerID: "computer-1", RegistrationID: "reg-1", AssignmentRevision: 1,
		AgentID: "agent-1", OperationID: "op-input-wait", ConnectionEpoch: 7, RunnerRevision: 1,
		Generation: 1, ExecutionLeaseID: "lease-1", WorkspaceGrantID: "grant-1", RuntimeType: "claude", HostAccess: "trusted",
		ExecutionContextKey: "context-1", RuntimeInstanceID: "runtime-1", ContextViewRef: testContextViewRef, Payload: json.RawMessage(`{"kind":"run.start","runtime":{"type":"claude"},"input":{"type":"text","text":"hello"}}`),
	}
	views, viewRef := readyTestContextView(t, start)
	start.ContextViewRef = viewRef
	d.contextViews = views
	input := start
	input.Type, input.CommandID, input.ExpectedTurnID = protocol.CommandOperationInput, "input-wait", "turn-1"
	input.Input = json.RawMessage(`{"type":"text","text":"follow up"}`)
	input.InputContextViewRef = viewRef
	return d, device, start, input, backend
}

func waitInputStarted(t *testing.T, backend *delayedInputBackend) {
	t.Helper()
	select {
	case <-backend.started:
	case <-time.After(2 * time.Second):
		t.Fatal("Provider did not claim the input")
	}
}

func TestOperationInputWaitDoesNotBlockGatewayCancel(t *testing.T) {
	d, device, start, input, backend := delayedInputFixture(t)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	stream := &fakeStream{commands: []protocol.Command{{Type: "runner.welcome", ConnectionEpoch: 7}, start, input}, wait: backend.started}
	stream.beforeCommand = gateInputUntilStarted(d)
	d.controlPlane = fakeControlPlane{stream: stream}
	connected := make(chan error, 1)
	go func() { connected <- d.runConnection(ctx, device) }()
	waitInputStarted(t, backend)
	select {
	case err := <-connected:
		if !errors.Is(err, io.EOF) {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("confirmation wait blocked the Gateway receive loop")
	}
	stop := start
	stop.Type = protocol.CommandOperationCancel
	second := &fakeStream{commands: []protocol.Command{{Type: "runner.welcome", ConnectionEpoch: 8}, stop}}
	d.controlPlane = fakeControlPlane{stream: second}
	if err := d.runConnection(ctx, device); !errors.Is(err, io.EOF) {
		t.Fatal(err)
	}
	d.WaitForOperations()
	retained, err := d.ledger.Replay(t.Context(), []string{start.OperationID})
	if err != nil || len(retained) != 3 || retained[1].Type != protocol.EventOperationInputRejected || retained[2].Type != protocol.EventOperationCancelled {
		t.Fatalf("input outcome must precede cancellation: events=%+v err=%v", retained, err)
	}
	for index, event := range retained {
		if event.Sequence != uint64(index+1) {
			t.Fatalf("sequence gap: %+v", retained)
		}
	}
	if d.fatalError() != nil {
		t.Fatalf("cancel caused fatal ledger failure: %v", d.fatalError())
	}
}

func TestOperationInputPendingReplayJoinsOriginalSubmission(t *testing.T) {
	d, device, start, input, backend := delayedInputFixture(t)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	first := &fakeStream{commands: []protocol.Command{{Type: "runner.welcome", ConnectionEpoch: 7}, start, input}, wait: backend.started}
	first.beforeCommand = gateInputUntilStarted(d)
	d.controlPlane = fakeControlPlane{stream: first}
	connected := make(chan error, 1)
	go func() { connected <- d.runConnection(ctx, device) }()
	waitInputStarted(t, backend)
	select {
	case err := <-connected:
		if !errors.Is(err, io.EOF) {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("pending input prevented reconnect")
	}
	second := &fakeStream{commands: []protocol.Command{{Type: "runner.welcome", ConnectionEpoch: 8}, input, input}}
	d.controlPlane = fakeControlPlane{stream: second}
	if err := d.runConnection(ctx, device); !errors.Is(err, io.EOF) {
		t.Fatal(err)
	}
	if len(second.snapshotEvents()) != 1 || backend.calls.Load() != 1 {
		t.Fatalf("pending replay invented an outcome or repeated delivery: events=%+v calls=%d", second.snapshotEvents(), backend.calls.Load())
	}
	close(backend.release)
	waitForEvents(t, second, 2)
	if err := d.handleOperationInput(ctx, second, input); err != nil {
		t.Fatal(err)
	}
	events := second.snapshotEvents()
	if len(events) != 3 || events[1].Type != protocol.EventOperationInputAck || events[2].Sequence != events[1].Sequence || string(events[2].Payload) != string(events[1].Payload) || backend.calls.Load() != 1 {
		t.Fatalf("receipt replay did not preserve the original outcome: %+v", events)
	}
}

func TestOperationInputConcurrentCommandIsRejectedWithoutDisconnect(t *testing.T) {
	d, device, start, input, backend := delayedInputFixture(t)
	first := &fakeStream{commands: []protocol.Command{{Type: "runner.welcome", ConnectionEpoch: 7}, start, input}, wait: backend.started}
	first.beforeCommand = gateInputUntilStarted(d)
	d.controlPlane = fakeControlPlane{stream: first}
	if err := d.runConnection(t.Context(), device); !errors.Is(err, io.EOF) {
		t.Fatal(err)
	}
	secondInput := input
	secondInput.CommandID = "different-input"
	secondInput.Input = json.RawMessage(`{"type":"text","text":"queue for next run"}`)
	stop := start
	stop.Type = protocol.CommandOperationCancel
	second := &fakeStream{commands: []protocol.Command{{Type: "runner.welcome", ConnectionEpoch: 8}, input, secondInput, secondInput, stop}}
	d.controlPlane = fakeControlPlane{stream: second}
	if err := d.runConnection(t.Context(), device); !errors.Is(err, io.EOF) {
		t.Fatalf("a different pending input disconnected the Gateway before Stop: %v", err)
	}
	d.WaitForOperations()
	var receipts []protocol.Event
	for _, event := range second.snapshotEvents() {
		if event.CommandID == secondInput.CommandID {
			receipts = append(receipts, event)
		}
	}
	if len(receipts) != 2 || receipts[0].Type != protocol.EventOperationInputRejected || receipts[0].Sequence != 2 || receipts[1].Sequence != receipts[0].Sequence || string(receipts[1].Payload) != string(receipts[0].Payload) {
		t.Fatalf("busy input did not replay its single recorded rejection: %+v", receipts)
	}
	var rejection struct{ Effect, Reason string }
	if err := json.Unmarshal(receipts[0].Payload, &rejection); err != nil || rejection.Effect != "definitely_not_applied" || rejection.Reason != "rejected" {
		t.Fatalf("busy input lost definite non-application: %s %v", receipts[0].Payload, err)
	}
	retained, err := d.ledger.Replay(t.Context(), []string{start.OperationID})
	if err != nil || len(retained) != 4 || retained[1].CommandID != secondInput.CommandID || retained[2].CommandID != input.CommandID || retained[3].Type != protocol.EventOperationCancelled || backend.calls.Load() != 1 || d.fatalError() != nil {
		t.Fatalf("busy rejection blocked cancellation or repeated Provider delivery: events=%+v err=%v calls=%d fatal=%v", retained, err, backend.calls.Load(), d.fatalError())
	}
}

type pausedRejectionStream struct {
	fakeStream
	commandID string
	entered   chan struct{}
	release   chan struct{}
}

func (stream *pausedRejectionStream) Send(ctx context.Context, event protocol.Event) error {
	if event.CommandID == stream.commandID && event.Type == protocol.EventOperationInputRejected {
		close(stream.entered)
		<-stream.release
	}
	return stream.fakeStream.Send(ctx, event)
}

func TestOperationInputBusyReceiptPrecedesConcurrentOutput(t *testing.T) {
	d, _, start, input, backend := delayedInputFixture(t)
	backend.complete = make(chan struct{})
	backend.messages = make(chan native.Event)
	secondInput := input
	secondInput.CommandID = "different-input"
	stream := &pausedRejectionStream{commandID: secondInput.CommandID, entered: make(chan struct{}), release: make(chan struct{})}
	t.Cleanup(func() {
		select {
		case <-stream.release:
		default:
			close(stream.release)
		}
	})
	if err := d.activateStreamAndReplay(t.Context(), stream, nil); err != nil {
		t.Fatal(err)
	}
	if err := d.handleOperationStart(t.Context(), stream, start); err != nil {
		t.Fatal(err)
	}
	awaitOperationStarted(t, d)
	if err := d.handleOperationInput(t.Context(), stream, input); err != nil {
		t.Fatal(err)
	}
	waitInputStarted(t, backend)
	busyDone := make(chan error, 1)
	go func() { busyDone <- d.handleOperationInput(t.Context(), stream, secondInput) }()
	select {
	case <-stream.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("busy receipt did not reach the send barrier")
	}
	backend.messages <- native.Event{Kind: native.EventText, Body: "output during confirmation"}
	close(stream.release)
	if err := <-busyDone; err != nil {
		t.Fatal(err)
	}
	close(backend.release)
	d.WaitForOperations()
	events := stream.snapshotEvents()
	if len(events) != 5 || events[1].CommandID != secondInput.CommandID || events[4].Type != protocol.EventOperationCompleted {
		t.Fatalf("concurrent output lost an input receipt or terminal: %+v", events)
	}
	for index, event := range events {
		if event.Sequence != uint64(index+1) {
			t.Fatalf("output overtook its durable busy receipt: %+v", events)
		}
	}
}

// A steer waits for the Runtime to show it, which can take until the next
// model request. An answer to a Runtime question meanwhile is a different
// input that the steer may itself wait for, so it is never refused as busy.
func TestOperationInputRuntimeResponseIsNotBusyBehindASteer(t *testing.T) {
	d, _, start, input, backend := delayedInputFixture(t)
	backend.complete = make(chan struct{})
	stream := &fakeStream{}
	if err := d.activateStreamAndReplay(t.Context(), stream, nil); err != nil {
		t.Fatal(err)
	}
	if err := d.handleOperationStart(t.Context(), stream, start); err != nil {
		t.Fatal(err)
	}
	awaitOperationStarted(t, d)
	if err := d.handleOperationInput(t.Context(), stream, input); err != nil {
		t.Fatal(err)
	}
	waitInputStarted(t, backend)
	answer := input
	answer.CommandID = "answer-question"
	answer.Input = json.RawMessage(`{"type":"text","text":"","runtime_response":{"request_id":"question-1","payload":{"answer":"yes"}}}`)
	if err := d.handleOperationInput(t.Context(), stream, answer); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	var outcome *protocol.Event
	for outcome == nil && time.Now().Before(deadline) {
		for _, event := range stream.snapshotEvents() {
			if event.CommandID == answer.CommandID {
				outcome = &event
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	if outcome == nil {
		t.Fatal("the answer got no outcome while the steer waited")
	}
	if strings.Contains(string(outcome.Payload), "Another input is awaiting") {
		t.Fatalf("the answer was refused as busy: %s", outcome.Payload)
	}
	close(backend.release)
	d.WaitForOperations()
	retained, err := d.ledger.Replay(t.Context(), []string{start.OperationID})
	if err != nil || retained[len(retained)-1].Type != protocol.EventOperationCompleted {
		t.Fatalf("events=%+v err=%v", retained, err)
	}
}
