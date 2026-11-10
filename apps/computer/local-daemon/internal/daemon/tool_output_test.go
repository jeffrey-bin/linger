package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

func TestDaemonRecordsBoundedToolOutputBeforeReplay(t *testing.T) {
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	ledger := NewMemoryLedger()
	// JSON escaping, multibyte characters and envelope overhead all count toward
	// the wire budget; the provider's original output must remain untouched.
	output := strings.Repeat("€✓🙂\"\\\n<", 500_000)
	messages := make(chan native.Event, 1)
	messages <- native.Event{Kind: native.EventToolOutput, InvocationID: "call-large", ToolName: "exec_command", Output: output}
	close(messages)
	results := make(chan native.Outcome, 1)
	results <- native.Outcome{Status: "completed", Output: "ok", SessionID: "thread-1"}
	close(results)
	start := protocol.Command{
		Type: protocol.CommandOperationStart, CommandID: "start-large-output", ProtocolVersion: "1.2",
		TenantID: "tenant-1", RunnerID: "computer-1", RegistrationID: "reg-1", AssignmentRevision: 1,
		AgentID: "agent-1", OperationID: "op-large-output", ConnectionEpoch: 1, RunnerRevision: 1,
		Generation: 1, ExecutionLeaseID: "lease-1", WorkspaceGrantID: "grant-1", RuntimeType: "codex",
		ExecutionContextKey: "context-1", RuntimeInstanceID: "runtime-1", ContextViewRef: testContextViewRef, Payload: json.RawMessage(`{"kind":"run.start","runtime":{"type":"codex"},"input":{"type":"text","text":"hello"}}`),
	}
	release := make(chan struct{})
	stream := &fakeStream{
		commands: []protocol.Command{{Type: "runner.welcome", ConnectionEpoch: 1}, start},
		wait:     release,
	}
	d, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: stream},
		IdentityStore: fakeStore{value: device}, OperationResolver: fakeOperationResolver{}, Ledger: ledger,
		Executor: provider.Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
			return fakeBackend{session: &native.Run{Events: messages, Outcome: results}}, nil
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	d.daemonID = device.DaemonID
	done := make(chan error, 1)
	go func() { done <- d.runConnection(context.Background(), device) }()
	// Bounding a multi-megabyte unicode payload is CPU-heavy; keep the fake
	// connection open until the bounded events exist, then allow EOF.
	waitForEventsWithin(t, stream, 5, 20*time.Second)
	close(release)
	if err := <-done; !errors.Is(err, io.EOF) {
		t.Fatal(err)
	}
	events := stream.snapshotEvents()
	var toolEvent protocol.Event
	for _, event := range events {
		var payload struct {
			Type   string `json:"type"`
			Output string `json:"output"`
		}
		if json.Unmarshal(event.Payload, &payload) == nil && payload.Type == "tool.returned" {
			toolEvent = event
			if len(event.Payload) >= 4*1024*1024 || !utf8.ValidString(payload.Output) || !strings.Contains(payload.Output, "[Tool output truncated") {
				t.Fatalf("tool output was not bounded before persistence: payload_bytes=%d", len(event.Payload))
			}
		}
	}
	if toolEvent.Sequence != 2 || events[len(events)-1].Type != protocol.EventOperationCompleted {
		t.Fatal("output handling changed execution completion or event order")
	}
	if err := ledger.Acknowledge(context.Background(), operationIdentity(start), 1); err != nil {
		t.Fatal(err)
	}
	replay, err := ledger.Replay(context.Background(), []string{start.OperationID})
	if err != nil {
		t.Fatal(err)
	}
	if len(replay) != 3 || replay[0].Sequence != 2 || !bytes.Equal(replay[0].Payload, toolEvent.Payload) || replay[2].Type != protocol.EventOperationCompleted {
		t.Fatal("reconnect did not replay the exact bounded output followed by completion")
	}
}
