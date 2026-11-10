//go:build unix

package transport

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

// The TypeScript consumer test validates these real native outcomes after the
// production Go wire serializer, rather than reconstructing the enum by hand.
func TestClaudeInputWireOutcomes(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Fatal(err)
	}
	cli := filepath.Join(t.TempDir(), "claude-fixture")
	script := `#!` + python + `
import json, sys
inputs = 0
for line in sys.stdin:
    frame = json.loads(line)
    if frame['type'] == 'control_request':
        print(json.dumps({'type': 'control_response', 'response': {'subtype': 'success', 'request_id': frame['request_id']}}), flush=True)
    elif frame['type'] == 'user':
        inputs += 1
        if inputs <= 2:
            print(json.dumps({'type': 'user', 'isReplay': True, 'uuid': frame['uuid'], 'session_id': 'fixture-session'}), flush=True)
`
	if err := os.WriteFile(cli, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	backend, err := native.Open("claude", native.Profile{Program: cli, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	session, err := backend.Start(ctx, "initial", native.RunSpec{
		ExposeTurnStarted: true,
		ClaudePolicy:      &native.ClaudeToolPolicy{},
	})
	if err != nil {
		t.Fatal(err)
	}
	var turn string
	select {
	case message := <-session.Events:
		turn = message.TurnID
	case <-ctx.Done():
		t.Fatal("initial native replay not observed")
	}
	if turn == "" {
		t.Fatal("missing run turn")
	}
	go func() {
		for range session.Events {
		}
	}()
	ack, err := session.Steer(ctx, native.SteerRequest{ExpectedTurnID: turn, Input: "confirmed"})
	if err != nil || ack.TurnID != turn {
		t.Fatalf("ACK target mismatch: %+v %v", ack, err)
	}
	confirmationCtx, stop := context.WithTimeout(ctx, 100*time.Millisecond)
	_, err = session.Steer(confirmationCtx, native.SteerRequest{ExpectedTurnID: turn, Input: "unconfirmed"})
	stop()
	var failure *native.SteerError
	if !errors.As(err, &failure) || failure.Effect != "uncertain" || failure.Reason != "transport" {
		t.Fatalf("invalid native failure: %v", err)
	}
	select {
	case result := <-session.Outcome:
		if result.Status != "failed" {
			t.Fatalf("unconfirmed input result=%+v", result)
		}
	case <-ctx.Done():
		t.Fatal("unconfirmed native query did not stop")
	}
	base := protocol.Event{
		ProtocolVersion: "2", TenantID: "tenant-1", RunnerID: "computer-1",
		AgentID: "agent-1", OperationID: "operation-1", RegistrationID: "registration-1", AssignmentRevision: 1,
		ConnectionEpoch: 1, RunnerRevision: 1, Generation: 1, ExecutionLeaseID: "lease-1",
		WorkspaceGrantID: "grant-1", RuntimeType: "claude", HostAccess: "trusted",
		ExecutionContextKey: "context-1", RuntimeInstanceID: "runtime-1",
		ContextViewRef: json.RawMessage(`{"view_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`),
	}
	base.Type, base.CommandID, base.Sequence = protocol.EventOperationInputAck, "input-1", 15
	base.Payload, _ = json.Marshal(map[string]any{"turn_id": ack.TurnID})
	confirmed, err := replyMap(base)
	if err != nil {
		t.Fatal(err)
	}
	base.Type, base.CommandID, base.Sequence = protocol.EventOperationInputRejected, "input-2", 16
	base.Payload, _ = json.Marshal(map[string]any{"expected_turn_id": turn, "actual_turn_id": failure.ActualTurnID, "effect": failure.Effect, "reason": failure.Reason, "message": failure.Message})
	rejected, err := replyMap(base)
	if err != nil {
		t.Fatal(err)
	}
	if target := os.Getenv("LINGER_CLAUDE_INPUT_WIRE_FIXTURE"); target != "" {
		encoded, err := json.Marshal([]any{confirmed, rejected})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, encoded, 0600); err != nil {
			t.Fatal(err)
		}
	}
}
