package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	lingercontext "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/context"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

type pendingOperationInput struct {
	commandID string
	done      chan struct{}
	failure   error
}

func (d *Daemon) handleOperationInput(ctx context.Context, stream transport.Stream, command protocol.Command) error {
	if command.CommandID == "" || command.ExpectedTurnID == "" {
		return errors.New("Operation input identity is incomplete")
	}
	d.activeMu.Lock()
	active := d.activeOperations[command.OperationID]
	var execution *provider.Execution
	if active != nil {
		execution = active.execution
	}
	d.activeMu.Unlock()
	// Serialize this Operation's claims, receipts and terminal commitment;
	// ledger I/O must not hold the global lock used by local Stop and inventory.
	if active != nil {
		active.inputMu.Lock()
		defer active.inputMu.Unlock()
	}
	begin, err := d.ledger.BeginInput(ctx, operationIdentity(command), command)
	if err != nil {
		return err
	}
	if begin.Disposition == BeginInputOutcome {
		if err := stream.Send(ctx, *begin.Outcome); err != nil {
			return err
		}
		if begin.Outcome.Type == protocol.EventOperationInputClosed {
			d.connectionMu.Lock()
			defer d.connectionMu.Unlock()
			return d.replayRetainedEvents(ctx, stream, []string{command.OperationID})
		}
		return nil
	}
	if begin.Disposition == BeginInputPending {
		owned := active != nil && active.pendingInputs[command.CommandID] != nil
		if owned {
			// The original owner will record and deliver the outcome on the
			// current connection. A duplicate must not manufacture uncertainty.
			return nil
		}
		event, err := d.rejectOperationInput(ctx, command, "uncertain", "transport", "", "Prior Provider input outcome is uncertain")
		if err != nil {
			return err
		}
		return stream.Send(ctx, event)
	}
	if active == nil || active.finishing || execution == nil || !sameOperationIdentity(active.identity, operationIdentity(command)) {
		event, err := d.rejectOperationInput(ctx, command, "definitely_not_applied", "no_active_turn", "", "No matching active Operation")
		if err != nil {
			return err
		}
		return stream.Send(ctx, event)
	}
	pending := &pendingOperationInput{commandID: command.CommandID, done: make(chan struct{})}
	if active.pendingInputs == nil {
		active.pendingInputs = make(map[string]*pendingOperationInput)
	}
	active.pendingInputs[command.CommandID] = pending
	d.inputWG.Add(1)
	go func() {
		defer d.inputWG.Done()
		outcome := d.operationInputOutcome(ctx, active.ctx, command, execution)
		active.inputMu.Lock()
		event, err := d.ledger.CompleteInput(context.WithoutCancel(ctx), operationIdentity(command), command, outcome)
		if err != nil {
			pending.failure = err
		} else {
			d.deliverRecordedOperationEvent(context.WithoutCancel(ctx), event)
			delete(active.pendingInputs, command.CommandID)
		}
		close(pending.done)
		active.inputMu.Unlock()
		if err != nil {
			d.reportFatal(fmt.Errorf("record Operation input %q: %w", command.CommandID, err))
		}
	}()
	return nil
}

func (d *Daemon) operationInputOutcome(ctx, operationCtx context.Context, command protocol.Command, execution *provider.Execution) protocol.Event {
	// An input names the View it was accepted with; the Context reaches it
	// before the Runtime reads the input. A cancel or the Operation's end
	// abandons the fetch, so the terminal never waits on it.
	viewCtx, stopView := context.WithCancel(ctx)
	defer stopView()
	defer context.AfterFunc(operationCtx, stopView)()
	if err := d.ensureContextView(viewCtx, command, command.InputContextViewRef); err != nil {
		if errors.Is(err, lingercontext.ErrContextStorage) {
			slog.Error("runner.context_view.read_failed", "operation_id", command.OperationID, "execution_context_key", command.ExecutionContextKey, "error", err)
		}
		return rejectedInputEvent(command, "definitely_not_applied", "rejected", "", "Operation input Context View is unavailable: "+err.Error())
	}
	var input struct {
		Type            string `json:"type"`
		Text            string `json:"text"`
		RuntimeResponse *struct {
			RequestID string          `json:"request_id"`
			Payload   json.RawMessage `json:"payload"`
		} `json:"runtime_response"`
	}
	if err := json.Unmarshal(command.Input, &input); err != nil || input.Type != "text" {
		return rejectedInputEvent(command, "definitely_not_applied", "rejected", "", "Operation input is invalid")
	}
	if input.RuntimeResponse != nil {
		err := execution.Respond(ctx, input.RuntimeResponse.RequestID, input.RuntimeResponse.Payload)
		if err != nil {
			var nativeErr *native.SteerError
			if errors.As(err, &nativeErr) {
				return rejectedInputEvent(command, nativeErr.Effect, nativeErr.Reason, nativeErr.ActualTurnID, nativeErr.Message)
			}
			return rejectedInputEvent(command, "uncertain", "transport", "", "Runtime response acknowledgement is uncertain")
		}
		return withOperationIdentity(protocol.Event{Type: protocol.EventOperationInputAck, SentAt: time.Now().UTC(), Payload: mustJSON(map[string]any{"turn_id": command.ExpectedTurnID})}, command)
	}
	ack, err := execution.Input(ctx, native.SteerRequest{ExpectedTurnID: command.ExpectedTurnID, Input: input.Text})
	if err != nil {
		var steerErr *provider.SteerError
		if errors.As(err, &steerErr) {
			return rejectedInputEvent(command, steerErr.Effect, steerErr.Reason, steerErr.ActualTurnID, steerErr.Message)
		}
		return rejectedInputEvent(command, "uncertain", "transport", "", "Provider input acknowledgement is uncertain")
	}
	if ack.TurnID == "" || ack.TurnID != command.ExpectedTurnID {
		return rejectedInputEvent(command, "uncertain", "ack_mismatch", ack.TurnID, "Provider acknowledged input for an unexpected turn")
	}
	return withOperationIdentity(protocol.Event{
		Type: protocol.EventOperationInputAck, SentAt: time.Now().UTC(),
		Payload: mustJSON(map[string]any{"turn_id": ack.TurnID}),
	}, command)
}

func (d *Daemon) rejectOperationInput(ctx context.Context, command protocol.Command, effect, reason, actualTurnID, message string) (protocol.Event, error) {
	return d.ledger.CompleteInput(context.WithoutCancel(ctx), operationIdentity(command), command, rejectedInputEvent(command, effect, reason, actualTurnID, message))
}

func rejectedInputEvent(command protocol.Command, effect, reason, actualTurnID, message string) protocol.Event {
	payload := map[string]any{
		"expected_turn_id": command.ExpectedTurnID, "effect": effect,
		"reason": reason, "message": message,
	}
	if actualTurnID != "" {
		payload["actual_turn_id"] = actualTurnID
	}
	return withOperationIdentity(protocol.Event{
		Type: protocol.EventOperationInputRejected, ProtocolVersion: command.ProtocolVersion,
		SentAt: time.Now().UTC(), Payload: mustJSON(payload),
	}, command)
}
