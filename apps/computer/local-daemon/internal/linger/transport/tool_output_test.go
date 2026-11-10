package transport

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
)

func TestBoundToolOutput(t *testing.T) {
	for _, tc := range []struct {
		name      string
		output    string
		truncated bool
	}{
		{"incident output remains intact", strings.Repeat("x", 311_431), false},
		{"large escaped output remains intact", strings.Repeat("€✓🙂\"\\\n<", 100_000), false},
		{"envelope counts toward limit", strings.Repeat("x", MaxFrameBytes), true},
		{"UTF-8 and JSON escaping count toward limit", strings.Repeat("€✓🙂\"\\\n<", 500_000), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			original := toolOutputEvent(t, tc.output)
			originalPayload := bytes.Clone(original.Payload)
			bounded, err := BoundToolOutput(original)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(original.Payload, originalPayload) {
				t.Fatal("mutated caller-owned event")
			}
			var payload struct {
				Output string `json:"output"`
			}
			if err := json.Unmarshal(bounded.Payload, &payload); err != nil {
				t.Fatal(err)
			}
			if !tc.truncated {
				if !bytes.Equal(bounded.Payload, originalPayload) || payload.Output != tc.output {
					t.Fatal("changed output that fits the frame budget")
				}
			} else {
				prefix, marker, found := strings.Cut(payload.Output, "\n[Tool output truncated")
				if !found || !strings.HasPrefix(tc.output, prefix) || len(prefix) == 0 || !utf8.ValidString(payload.Output) || !strings.Contains(marker, "4 MiB") {
					t.Fatal("truncation did not preserve a valid prefix and explicit marker")
				}
			}
			// The ledger assigns seq after bounding. Even its widest representation
			// must leave the actual transport frame sendable.
			bounded.Sequence = ^uint64(0)
			wire, err := replyMap(bounded)
			if err != nil {
				t.Fatal(err)
			}
			encoded, err := json.Marshal(wire)
			if err != nil || len(encoded) > MaxFrameBytes {
				t.Fatalf("wire frame exceeds budget: bytes=%d err=%v", len(encoded), err)
			}
			if tc.truncated && len(encoded) < MaxFrameBytes-32 {
				t.Fatalf("discarded output unnecessarily: frame_bytes=%d", len(encoded))
			}
			again, err := BoundToolOutput(bounded)
			if err != nil || !bytes.Equal(again.Payload, bounded.Payload) {
				t.Fatal("bounding an already bounded event changed its payload")
			}
		})
	}
}

func TestBoundToolOutputLeavesOtherPayloadsUntouched(t *testing.T) {
	for _, payload := range []string{
		`{"type":"tool.called","call_id":"call-1","tool_name":"exec_command","input":"hello"}`,
		`{"type":"tool.returned","call_id":"call-1","tool_name":"exec_command","output":{"text":"hello"},"is_error":false}`,
		`{"type":"tool.returned","call_id":"call-1","tool_name":"exec_command","output":null,"is_error":false}`,
		`{"type":"text.delta","text":"hello"}`,
	} {
		event := protocol.Event{Type: protocol.EventOperationEvent, Payload: json.RawMessage(payload)}
		bounded, err := BoundToolOutput(event)
		if err != nil || !bytes.Equal(event.Payload, bounded.Payload) {
			t.Fatal("changed unrelated or structured output")
		}
	}
}

func TestBoundToolOutputRejectsUnsendableMetadata(t *testing.T) {
	event := toolOutputEvent(t, "hello")
	event.ExecutionContextKey = strings.Repeat("x", MaxFrameBytes)
	if _, err := BoundToolOutput(event); err == nil {
		t.Fatal("accepted metadata that leaves no space for bounded output")
	}
}

func toolOutputEvent(t *testing.T, output string) protocol.Event {
	t.Helper()
	payload, err := json.Marshal(map[string]any{
		"type": "tool.returned", "call_id": "call-1", "tool_name": "exec_command", "output": output, "is_error": false,
	})
	if err != nil {
		t.Fatal(err)
	}
	return protocol.Event{
		Type: protocol.EventOperationEvent, ProtocolVersion: "2",
		TenantID: "tenant-1", RunnerID: "computer-1", AgentID: "agent-1", OperationID: "operation-1",
		RegistrationID: "registration-1", AssignmentRevision: 1, ConnectionEpoch: 1, RunnerRevision: 1,
		Generation: 1, ExecutionLeaseID: "lease-1", WorkspaceGrantID: "grant-1", RuntimeType: "codex",
		ExecutionContextKey: "meta:agent-1", RuntimeInstanceID: "meta:agent-1", HostAccess: "trusted",
		ContextViewRef: json.RawMessage(`{"view_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`),
		Payload:        payload,
	}
}
