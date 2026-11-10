package daemon

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
)

// testContextViewRef is a Context View reference spelled with the spacing an
// Agent may send, which differs from the canonical JSON a retained input is
// stored as.
var testContextViewRef = json.RawMessage(`{"view_digest": "` + strings.Repeat("a", 64) + `"}`)

func ledgerIdentity(operationID string) OperationIdentity {
	return OperationIdentity{
		ProtocolVersion: "2", TenantID: "tenant", RunnerID: "computer", AgentID: "agent", RegistrationID: "registration", AssignmentRevision: 1,
		OperationID: operationID, ConnectionEpoch: 3, RunnerRevision: 2, Generation: 1, ExecutionLeaseID: "lease", WorkspaceGrantID: "grant", RuntimeType: "codex", OperationKind: "run.start",
		ExecutionContextKey: "context", RuntimeInstanceID: "runtime", ContextViewRef: string(testContextViewRef),
	}
}

func begunLedger(t *testing.T, operationID string) (*MemoryLedger, OperationIdentity) {
	t.Helper()
	ledger := NewMemoryLedger()
	identity := ledgerIdentity(operationID)
	if result, err := ledger.Begin(t.Context(), identity); err != nil || result.Disposition != BeginNew {
		t.Fatalf("begin=%+v err=%v", result, err)
	}
	return ledger, identity
}

func operationEventFromIdentity(identity OperationIdentity) protocol.Event {
	return protocol.Event{
		ProtocolVersion: identity.ProtocolVersion, HostAccess: identity.HostAccess,
		TenantID: identity.TenantID, RunnerID: identity.RunnerID,
		RegistrationID: identity.RegistrationID, AssignmentRevision: identity.AssignmentRevision,
		AgentID: identity.AgentID, OperationID: identity.OperationID,
		ConnectionEpoch: identity.ConnectionEpoch, RunnerRevision: identity.RunnerRevision,
		Generation: identity.Generation, ExecutionLeaseID: identity.ExecutionLeaseID,
		WorkspaceGrantID: identity.WorkspaceGrantID, RuntimeType: identity.RuntimeType,
		ExecutionContextKey: identity.ExecutionContextKey,
		RuntimeInstanceID:   identity.RuntimeInstanceID, ContextViewRef: json.RawMessage(identity.ContextViewRef),
	}
}

func retainedInputCommand(identity OperationIdentity) protocol.Command {
	return protocol.Command{
		Type: protocol.CommandOperationInput, CommandID: "pending-input", ProtocolVersion: identity.ProtocolVersion,
		TenantID: identity.TenantID, RunnerID: identity.RunnerID, AgentID: identity.AgentID,
		RegistrationID: identity.RegistrationID, AssignmentRevision: identity.AssignmentRevision,
		OperationID: identity.OperationID, ConnectionEpoch: identity.ConnectionEpoch, RunnerRevision: identity.RunnerRevision,
		Generation: identity.Generation, ExecutionLeaseID: identity.ExecutionLeaseID,
		WorkspaceGrantID: identity.WorkspaceGrantID, RuntimeType: identity.RuntimeType,
		ExecutionContextKey: identity.ExecutionContextKey, RuntimeInstanceID: identity.RuntimeInstanceID,
		ContextViewRef: json.RawMessage(identity.ContextViewRef), InputContextViewRef: json.RawMessage(identity.ContextViewRef),
		ExpectedTurnID: "retained-turn", Input: json.RawMessage(`{"type":"text","text":"steer"}`),
	}
}

func appendEvents(t *testing.T, ledger *MemoryLedger, identity OperationIdentity, count int) {
	t.Helper()
	for range count {
		if _, err := ledger.Append(t.Context(), identity, protocol.Event{Type: protocol.EventOperationEvent, OperationID: identity.OperationID}); err != nil {
			t.Fatal(err)
		}
	}
}

func TestLedgerResumesAnOperationByIDWithItsUnacknowledgedEventsInOrder(t *testing.T) {
	ledger, identity := begunLedger(t, "operation-1")
	appendEvents(t, ledger, identity, 3)
	if err := ledger.Acknowledge(t.Context(), identity, 1); err != nil {
		t.Fatal(err)
	}
	// A reconnect replays from the acknowledged watermark, in sequence order,
	// and the Provider keeps running: Begin reports the Operation as running.
	if result, err := ledger.Begin(t.Context(), identity); err != nil || result.Disposition != BeginRunning {
		t.Fatalf("resumed begin=%+v err=%v", result, err)
	}
	replayed, err := ledger.Replay(t.Context(), []string{identity.OperationID, "unknown-operation"})
	if err != nil || len(replayed) != 2 || replayed[0].Sequence != 2 || replayed[1].Sequence != 3 {
		t.Fatalf("replay=%+v err=%v", replayed, err)
	}
	terminal, err := ledger.Complete(t.Context(), identity, protocol.Event{Type: protocol.EventOperationCompleted})
	if err != nil || terminal.Sequence != 4 {
		t.Fatalf("terminal=%+v err=%v", terminal, err)
	}
	// A duplicate terminal keeps the first one.
	if again, err := ledger.Complete(t.Context(), identity, protocol.Event{Type: protocol.EventOperationFailed}); err != nil || again.Type != protocol.EventOperationCompleted || again.Sequence != 4 {
		t.Fatalf("second terminal=%+v err=%v", again, err)
	}
	if result, err := ledger.Begin(t.Context(), identity); err != nil || result.Disposition != BeginTerminal || result.Terminal.Sequence != 4 {
		t.Fatalf("terminal begin=%+v err=%v", result, err)
	}
	if err := ledger.Acknowledge(t.Context(), identity, 4); err != nil {
		t.Fatal(err)
	}
	if replayed, err := ledger.Replay(t.Context(), []string{identity.OperationID}); err != nil || len(replayed) != 0 {
		t.Fatalf("events after terminal ACK=%+v err=%v", replayed, err)
	}
	if err := ledger.Acknowledge(t.Context(), identity, 2); !errors.Is(err, ErrLedgerIdentityConflict) {
		t.Fatalf("backward ACK err=%v", err)
	}
}

func TestLedgerRejectsIdentityAndStartPayloadReuse(t *testing.T) {
	ledger := NewMemoryLedger()
	command := protocol.Command{
		Type: protocol.CommandOperationStart, CommandID: "start-1", ProtocolVersion: "2",
		TenantID: "tenant-1", RunnerID: "computer-1", RegistrationID: "registration-1",
		AgentID: "agent-1", OperationID: "operation-1", ConnectionEpoch: 2,
		RunnerRevision: 3, Generation: 1, ExecutionLeaseID: "lease-1",
		WorkspaceGrantID: "grant-1", RuntimeType: "codex",
		Payload: json.RawMessage(`{"kind":"run.start","input":{"type":"text","text":"first"}}`),
	}
	if _, err := ledger.Begin(t.Context(), operationIdentity(command)); err != nil {
		t.Fatal(err)
	}
	changedIdentity := operationIdentity(command)
	changedIdentity.RegistrationID = "registration-2"
	if _, err := ledger.Begin(t.Context(), changedIdentity); !errors.Is(err, ErrLedgerIdentityConflict) {
		t.Fatalf("identity reuse err=%v", err)
	}
	command.Payload = json.RawMessage(`{"kind":"run.start","input":{"type":"text","text":"changed"}}`)
	if _, err := ledger.Begin(t.Context(), operationIdentity(command)); !errors.Is(err, ErrLedgerIdentityConflict) {
		t.Fatalf("changed start payload err=%v", err)
	}
}

func TestLedgerForgetsAnAcknowledgedTerminalAfterRetention(t *testing.T) {
	ledger, identity := begunLedger(t, "operation-forget")
	terminal, err := ledger.Complete(t.Context(), identity, protocol.Event{Type: protocol.EventOperationCompleted})
	if err != nil {
		t.Fatal(err)
	}
	if err := ledger.Acknowledge(t.Context(), identity, terminal.Sequence); err != nil {
		t.Fatal(err)
	}
	if _, err := ledger.Begin(t.Context(), ledgerIdentity("operation-recent")); err != nil {
		t.Fatal(err)
	}
	if _, retained := ledger.operations[identity.OperationID]; !retained {
		t.Fatal("a recently acknowledged terminal was forgotten")
	}
	now := time.Now().Add(acknowledgedOperationRetention + time.Minute)
	ledger.now = func() time.Time { return now }
	if _, err := ledger.Begin(t.Context(), ledgerIdentity("operation-trigger")); err != nil {
		t.Fatal(err)
	}
	if _, retained := ledger.operations[identity.OperationID]; retained {
		t.Fatal("expired acknowledged terminal was kept")
	}
}

func TestLedgerBoundsUnacknowledgedEventsAndReservesTheTerminal(t *testing.T) {
	ledger, identity := begunLedger(t, "operation-capacity")
	appendEvents(t, ledger, identity, maxUnacknowledgedOperationEvents)
	if _, err := ledger.Append(t.Context(), identity, protocol.Event{Type: protocol.EventOperationEvent}); !errors.Is(err, ErrLedgerCapacity) {
		t.Fatalf("event beyond capacity err=%v", err)
	}
	terminal, err := ledger.Complete(t.Context(), identity, protocol.Event{Type: protocol.EventOperationFailed})
	if err != nil || terminal.Sequence != maxUnacknowledgedOperationEvents+1 {
		t.Fatalf("terminal must use reserved capacity: %+v %v", terminal, err)
	}

	large, largeIdentity := begunLedger(t, "operation-bytes")
	payload := json.RawMessage(`"` + strings.Repeat("x", maxUnacknowledgedOperationBytes-1024) + `"`)
	if _, err := large.Append(t.Context(), largeIdentity, protocol.Event{Type: protocol.EventOperationEvent, Payload: payload}); err != nil {
		t.Fatal(err)
	}
	if _, err := large.Append(t.Context(), largeIdentity, protocol.Event{Type: protocol.EventOperationEvent, Payload: json.RawMessage(`"` + strings.Repeat("y", 2048) + `"`)}); !errors.Is(err, ErrLedgerCapacity) {
		t.Fatalf("bytes beyond capacity err=%v", err)
	}
	if _, err := large.Complete(t.Context(), largeIdentity, protocol.Event{Type: protocol.EventOperationCompleted, Payload: json.RawMessage(`{"final_response":"larger than remaining capacity"}`)}); err != nil {
		t.Fatalf("terminal must use reserved bytes: %v", err)
	}
}

func TestLedgerActiveListsRunningOperations(t *testing.T) {
	ledger, identity := begunLedger(t, "operation-active")
	appendEvents(t, ledger, identity, 1)
	finished, finishedIdentity := ledger, ledgerIdentity("operation-finished")
	if _, err := finished.Begin(t.Context(), finishedIdentity); err != nil {
		t.Fatal(err)
	}
	if _, err := finished.Complete(t.Context(), finishedIdentity, protocol.Event{Type: protocol.EventOperationCompleted}); err != nil {
		t.Fatal(err)
	}
	active, err := ledger.Active(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	var snapshots []map[string]any
	if json.Unmarshal(active, &snapshots) != nil || len(snapshots) != 1 || snapshots[0]["operation_id"] != identity.OperationID ||
		snapshots[0]["kind"] != "run.start" || snapshots[0]["last_emitted_seq"] != float64(1) {
		t.Fatalf("active snapshots=%s", active)
	}
}

func TestLedgerBusyInputRejectionIsReplayedAndKeepsThePendingClaim(t *testing.T) {
	ledger, identity := begunLedger(t, "overlap")
	first := retainedInputCommand(identity)
	if result, err := ledger.BeginInput(t.Context(), identity, first); err != nil || result.Disposition != BeginInputNew {
		t.Fatalf("first claim: %+v %v", result, err)
	}
	second := first
	second.CommandID = "different-input"
	result, err := ledger.BeginInput(t.Context(), identity, second)
	if err != nil || result.Disposition != BeginInputOutcome || result.Outcome == nil {
		t.Fatalf("overlap must return a recorded outcome: %+v %v", result, err)
	}
	var rejection struct{ Effect, Reason string }
	if err := json.Unmarshal(result.Outcome.Payload, &rejection); err != nil || rejection.Effect != "definitely_not_applied" || rejection.Reason != "rejected" || result.Outcome.Sequence != 1 {
		t.Fatalf("busy receipt lost definite non-application: %+v %v", result.Outcome, err)
	}
	saved := *result.Outcome
	result, err = ledger.BeginInput(t.Context(), identity, second)
	if err != nil || result.Outcome == nil || result.Outcome.Sequence != saved.Sequence || string(result.Outcome.Payload) != string(saved.Payload) {
		t.Fatalf("busy receipt changed on replay: %+v %v", result, err)
	}
	if result, err := ledger.BeginInput(t.Context(), identity, first); err != nil || result.Disposition != BeginInputPending {
		t.Fatalf("busy rejection lost the first input's pending claim: %+v %v", result, err)
	}
	second.Input = json.RawMessage(`{"type":"text","text":"changed"}`)
	if _, err := ledger.BeginInput(t.Context(), identity, second); !errors.Is(err, ErrLedgerIdentityConflict) {
		t.Fatalf("replay with changed content was accepted: %v", err)
	}
	ack := operationEventFromIdentity(identity)
	ack.Type, ack.CommandID, ack.Payload = protocol.EventOperationInputAck, first.CommandID, json.RawMessage(`{"turn_id":"retained-turn"}`)
	if result, err := ledger.CompleteInput(t.Context(), identity, first, ack); err != nil || result.Sequence != saved.Sequence+1 {
		t.Fatalf("first input failed to settle after busy rejection: %+v %v", result, err)
	}
	if result, err := ledger.BeginInput(t.Context(), identity, first); err != nil || result.Disposition != BeginInputOutcome || result.Outcome.Sequence != saved.Sequence+1 {
		t.Fatalf("settled input replay: %+v %v", result, err)
	}
}

func TestLedgerRejectsNewInputAfterTerminalWithoutChangingSequence(t *testing.T) {
	ledger, identity := begunLedger(t, "terminal")
	terminal := operationEventFromIdentity(identity)
	terminal.Type = protocol.EventOperationCompleted
	saved, err := ledger.Complete(t.Context(), identity, terminal)
	if err != nil {
		t.Fatal(err)
	}
	command := retainedInputCommand(identity)
	for range 2 {
		result, err := ledger.BeginInput(t.Context(), identity, command)
		if err != nil || result.Outcome == nil {
			t.Fatalf("late input needs a rejection, got %+v %v", result, err)
		}
		var payload map[string]any
		_ = json.Unmarshal(result.Outcome.Payload, &payload)
		if result.Outcome.Type != protocol.EventOperationInputClosed || payload["effect"] != "definitely_not_applied" {
			t.Fatalf("late input outcome=%+v", result.Outcome)
		}
	}
	replay, err := ledger.Replay(t.Context(), []string{identity.OperationID})
	if err != nil || len(replay) != 1 || replay[0].Sequence != saved.Sequence || replay[0].Type != terminal.Type {
		t.Fatalf("terminal stream changed: %+v %v", replay, err)
	}
	command.Input = json.RawMessage(`{"type":"text","text":"changed"}`)
	if _, err := ledger.BeginInput(t.Context(), identity, command); !errors.Is(err, ErrLedgerIdentityConflict) {
		t.Fatalf("changed input accepted: %v", err)
	}
}

func TestLedgerTerminalInputEvidenceSurvivesAcknowledgement(t *testing.T) {
	for _, scenario := range []string{"applied", "rejected"} {
		t.Run(scenario, func(t *testing.T) {
			ledger, identity := begunLedger(t, "evidence")
			command := retainedInputCommand(identity)
			if _, err := ledger.BeginInput(t.Context(), identity, command); err != nil {
				t.Fatal(err)
			}
			receipt := protocol.Event{Type: protocol.EventOperationInputAck, CommandID: command.CommandID, Payload: json.RawMessage(`{"turn_id":"retained-turn"}`)}
			if scenario == "rejected" {
				receipt.Type = protocol.EventOperationInputRejected
				receipt.Payload = json.RawMessage(`{"expected_turn_id":"retained-turn","effect":"definitely_not_applied"}`)
			}
			saved, err := ledger.CompleteInput(t.Context(), identity, command, receipt)
			if err != nil {
				t.Fatal(err)
			}
			if err := ledger.Acknowledge(t.Context(), identity, saved.Sequence); err != nil {
				t.Fatal(err)
			}
			terminal, err := ledger.Complete(t.Context(), identity, operationEventFromIdentity(identity))
			if err != nil {
				t.Fatal(err)
			}
			if err := ledger.Acknowledge(t.Context(), identity, terminal.Sequence); err != nil {
				t.Fatal(err)
			}
			result, err := ledger.BeginInput(t.Context(), identity, command)
			if err != nil || result.Outcome == nil {
				t.Fatalf("terminal input: %+v %v", result, err)
			}
			var payload struct {
				Effect string `json:"effect"`
			}
			_ = json.Unmarshal(result.Outcome.Payload, &payload)
			want := "uncertain"
			if scenario == "rejected" {
				want = "definitely_not_applied"
			}
			if payload.Effect != want {
				t.Fatalf("effect=%s want %s", payload.Effect, want)
			}
		})
	}
}

func TestLedgerReportsInputsToAnInterruptedOperationAsUncertain(t *testing.T) {
	ledger, identity := begunLedger(t, "interrupted")
	if _, err := ledger.Interrupt(t.Context(), identity, protocol.Event{Type: protocol.EventOperationFailed}); err != nil {
		t.Fatal(err)
	}
	result, err := ledger.BeginInput(t.Context(), identity, retainedInputCommand(identity))
	if err != nil || result.Outcome == nil || result.Outcome.Type != protocol.EventOperationInputClosed {
		t.Fatalf("input to interrupted Operation=%+v err=%v", result, err)
	}
	var payload struct {
		Effect string `json:"effect"`
	}
	if err := json.Unmarshal(result.Outcome.Payload, &payload); err != nil || payload.Effect != "uncertain" {
		t.Fatalf("effect=%q err=%v", payload.Effect, err)
	}
}

func TestLedgerPreparationIsReplayedUntilDeleted(t *testing.T) {
	ledger := NewMemoryLedger()
	identity := ledgerIdentity("prepared")
	command := protocol.Command{Type: protocol.CommandOperationPrepare, CommandID: "prepare-1", OperationID: identity.OperationID}
	if result, err := ledger.BeginPreparation(t.Context(), identity, command); err != nil || result.Disposition != BeginPreparationNew {
		t.Fatalf("first preparation=%+v err=%v", result, err)
	}
	if result, err := ledger.BeginPreparation(t.Context(), identity, command); err != nil || result.Disposition != BeginPreparationPreparing {
		t.Fatalf("repeated preparation=%+v err=%v", result, err)
	}
	if err := ledger.CompletePreparation(t.Context(), identity, command); err != nil {
		t.Fatal(err)
	}
	if result, err := ledger.BeginPreparation(t.Context(), identity, command); err != nil || result.Disposition != BeginPreparationReady {
		t.Fatalf("ready preparation=%+v err=%v", result, err)
	}
	changed := identity
	changed.RegistrationID = "other"
	if err := ledger.DeletePreparation(t.Context(), changed); !errors.Is(err, ErrLedgerIdentityConflict) {
		t.Fatalf("foreign delete err=%v", err)
	}
	if err := ledger.DeletePreparation(t.Context(), identity); err != nil {
		t.Fatal(err)
	}
	if _, err := ledger.Begin(t.Context(), identity); err != nil {
		t.Fatal(err)
	}
	if _, err := ledger.BeginPreparation(t.Context(), identity, command); !errors.Is(err, ErrLedgerIdentityConflict) {
		t.Fatalf("preparation of a begun Operation err=%v", err)
	}
}

func TestDaemonLateInputReturnsReceiptBeforeReplayingTerminal(t *testing.T) {
	ledger, identity := begunLedger(t, "late-input")
	terminal := operationEventFromIdentity(identity)
	terminal.Type = protocol.EventOperationCompleted
	if _, err := ledger.Complete(t.Context(), identity, terminal); err != nil {
		t.Fatal(err)
	}
	d := &Daemon{ledger: ledger}
	stream := &fakeStream{}
	if err := d.handleOperationInput(t.Context(), stream, retainedInputCommand(identity)); err != nil {
		t.Fatal(err)
	}
	events := stream.snapshotEvents()
	if len(events) != 2 || events[0].Type != protocol.EventOperationInputClosed || events[1].Type != protocol.EventOperationCompleted {
		t.Fatalf("late input did not settle before terminal replay: %+v", events)
	}
}
