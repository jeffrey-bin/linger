package daemon

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

func TestConflictingReconnectPreservesRunningOperation(t *testing.T) {
	ledger := NewMemoryLedger()
	release := make(chan struct{})
	starts := 0
	d, err := newTestDaemon(t, Options{ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: &fakeStream{}}, IdentityStore: fakeStore{}, Ledger: ledger, OperationResolver: fakeOperationResolver{},
		Executor: provider.Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
			starts++
			return heldBackend{release: release}, nil
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	var releaseOnce sync.Once
	finish := func() { releaseOnce.Do(func() { close(release) }); d.WaitForOperations() }
	defer finish()
	stream := &fakeStream{}
	d.operationStream = stream
	command := daemonOperationStart("operation-reconnect", "agent-1")
	if err := d.handleOperationStart(context.Background(), stream, command); err != nil {
		t.Fatal(err)
	}
	conflict := command
	conflict.Payload = json.RawMessage(`{"kind":"run.start","runtime":{"type":"codex"},"input":{"type":"text","text":"changed"}}`)
	if err := d.handleOperationStart(context.Background(), stream, conflict); err != nil {
		t.Fatal(err)
	}
	retained, err := ledger.Begin(context.Background(), operationIdentity(command))
	if err != nil || retained.Disposition != BeginRunning {
		t.Fatalf("conflicting replay changed running ledger: %+v %v", retained, err)
	}
	if err := d.handleOperationStart(context.Background(), stream, command); err != nil {
		t.Fatal(err)
	}
	awaitOperationStarted(t, d)
	if starts != 1 || d.ActiveOperationCount() != 1 {
		t.Fatalf("starts=%d active=%d", starts, d.ActiveOperationCount())
	}
	for _, event := range stream.snapshotEvents() {
		if event.Type == protocol.EventOperationFailed {
			t.Fatal("conflict failed original operation")
		}
	}
	finish()
	if d.ActiveOperationCount() != 0 {
		t.Fatal("completed execution retained its slot")
	}
	if err := d.handleOperationStart(context.Background(), stream, daemonOperationStart("operation-next", "agent-1")); err != nil {
		t.Fatal(err)
	}
	d.WaitForOperations()
	if starts != 2 {
		t.Fatalf("next operation was blocked: starts=%d", starts)
	}
}

func TestDebugInspectionFailureDoesNotDisconnect(t *testing.T) {
	{
		{
			device, err := transport.GenerateIdentity()
			if err != nil {
				t.Fatal(err)
			}
			command := daemonAgentRunnerCommand(protocol.CommandDebugInspect, 1)
			command.ViewDigest = strings.Repeat("c", 64)
			command.Payload = mustJSON(map[string]any{"request": map[string]any{"runtime": map[string]string{"type": "codex"}, "session": map[string]string{"threadId": "thread-1"}}})
			stream := &fakeStream{commands: []protocol.Command{{Type: "runner.welcome", ConnectionEpoch: 1}, command, {Type: "runner.reconciled", RunnerID: "computer-1", ConnectionEpoch: 1}}}
			d, err := newTestDaemon(t, Options{ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: stream}, IdentityStore: fakeStore{value: device}, OperationResolver: fakeOperationResolver{}})
			if err != nil {
				t.Fatal(err)
			}
			_ = d.runConnection(context.Background(), device)
			if !d.Reconciled() {
				t.Fatal("inspection failure disconnected before next command")
			}
			var found bool
			for _, event := range stream.snapshotEvents() {
				if event.Type == protocol.EventDebugInspected {
					found = true
					var result map[string]any
					if err := json.Unmarshal(event.Payload, &result); err != nil {
						t.Fatal(err)
					}
					if result["status"] != "unavailable" || event.ViewDigest != strings.Repeat("c", 64) {
						t.Fatalf("wrong failed inspection: %+v", event)
					}
				}
			}
			if !found {
				t.Fatal("missing unavailable inspection response")
			}
		}
	}
}
