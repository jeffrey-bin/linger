package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/mcpproxy"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/redact"
)

func (d *Daemon) awaitOperation(ctx context.Context, command protocol.Command, spec provider.OperationSpec, resultCh <-chan provider.Result) {
	result, ok := <-resultCh
	if !ok {
		result = provider.Result{Status: "failed", Error: "provider result channel closed without a result"}
	}
	d.finishOperation(ctx, command, spec, result)
}

func (d *Daemon) finishOperation(ctx context.Context, command protocol.Command, spec provider.OperationSpec, result provider.Result) {
	d.activeMu.Lock()
	active := d.activeOperations[command.OperationID]
	reason := ""
	if active != nil {
		reason = active.reason
	}
	d.activeMu.Unlock()
	if active != nil {
		active.inputMu.Lock()
		active.finishing = true
		pending := make([]*pendingOperationInput, 0, len(active.pendingInputs))
		for _, input := range active.pendingInputs {
			pending = append(pending, input)
		}
		active.inputMu.Unlock()
		active.cancel()
		// Finish every claimed input before committing the terminal sequence.
		// Cancellation releases native confirmation waits; reconnect alone does not.
		for _, input := range pending {
			<-input.done
			if input.failure != nil {
				// A terminal cannot overtake a missing input outcome. The input
				// worker reports fatal, stops admission and closes the Gateway;
				// the restarted Daemon reports the Operation as interrupted when
				// the Gateway sends it again.
				_ = active.mcpProxies.Close()
				return
			}
		}
		if err := active.mcpProxies.Close(); err != nil {
			result.Status, result.Error = "failed", "Local MCP cleanup failed"
			result.CleanupUnconfirmed = result.CleanupUnconfirmed || errors.Is(err, mcpproxy.ErrCleanupUnconfirmed)
		}
	}
	terminalType := protocol.EventOperationCompleted
	if reason != "" && !result.CleanupUnconfirmed {
		terminalType = protocol.EventOperationCancelled
	} else if result.Status != "completed" {
		terminalType = protocol.EventOperationFailed
		if d.onModelUnavailable != nil && spec.Model != "" && provider.ClassifyExecutionFailure(spec.Provider, spec.CodexVersion, result.Status, result.FailureCode, result.Diagnostics).Code == "model_unavailable" {
			d.onModelUnavailable(spec.Provider, spec.Model)
		}
	}
	slog.Info("runner.operation.finished", "operation_id", command.OperationID, "kind", spec.OperationKind,
		"provider", spec.Provider, "status", terminalType, "failure_code", result.FailureCode,
		"error", receiptReason(redact.Text(result.Error)))
	payload := terminalPayload(spec, result)
	if terminalType == protocol.EventOperationCancelled {
		payload = terminalWithUsage(map[string]any{"reason": reason}, spec, result)
	}
	terminal := withOperationIdentity(protocol.Event{
		Type:    terminalType,
		SentAt:  time.Now().UTC(),
		Payload: payload,
	}, command)
	if active != nil {
		active.inputMu.Lock()
		defer active.inputMu.Unlock()
	}
	terminal, err := d.ledger.Complete(context.WithoutCancel(ctx), operationIdentity(command), terminal)
	if errors.Is(err, ErrLedgerCapacity) {
		terminal = withOperationIdentity(protocol.Event{Type: protocol.EventOperationFailed, SentAt: time.Now().UTC(), Payload: terminalPayload(spec, provider.Result{Status: "failed", Error: "Operation terminal result exceeds its reserved capacity"})}, command)
		terminal, err = d.ledger.Complete(context.WithoutCancel(ctx), operationIdentity(command), terminal)
	}
	if err != nil {
		d.reportFatal(fmt.Errorf("record terminal Operation %q: %w", command.OperationID, err))
		return
	}
	d.activeMu.Lock()
	if active := d.activeOperations[command.OperationID]; active != nil {
		active.terminalCommitted = true
	}
	d.activeMu.Unlock()
	d.deliverRecordedOperationEvent(context.WithoutCancel(ctx), terminal)
	d.activeMu.Lock()
	delete(d.activeOperations, command.OperationID)
	d.activeMu.Unlock()
}

func (d *Daemon) handleOperationCancel(command protocol.Command) error {
	if err := d.cancelPreparedOperation(command); err != nil {
		return err
	}
	d.activeMu.Lock()
	defer d.activeMu.Unlock()
	active := d.activeOperations[command.OperationID]
	if active == nil {
		return nil
	}
	if !sameOperationIdentity(active.identity, operationIdentity(command)) {
		return ErrLedgerIdentityConflict
	}
	if active.reason == "" {
		var payload struct {
			Reason string `json:"reason"`
		}
		_ = json.Unmarshal(command.Payload, &payload)
		if payload.Reason == "" {
			payload.Reason = "Operation cancelled"
		}
		active.reason = payload.Reason
		active.cancel()
	}
	return nil
}

func (d *Daemon) activeOperationIDs() []string {
	d.activeMu.Lock()
	defer d.activeMu.Unlock()
	result := make([]string, 0, len(d.activeOperations))
	for operationID := range d.activeOperations {
		result = append(result, operationID)
	}
	sort.Strings(result)
	return result
}

func operationContextKey(identity OperationIdentity) string {
	return identity.TenantID + ":" + identity.ExecutionContextKey
}

func (d *Daemon) finishAdmissionBusy(ctx context.Context, stream transport.Stream, command protocol.Command, message string) error {
	event := withOperationIdentity(protocol.Event{
		Type: protocol.EventOperationFailed, Stage: "operation_admission", SentAt: time.Now().UTC(),
		Payload: mustJSON(map[string]any{"code": "OPERATION_CAPACITY_BUSY", "message": message, "retryable": true}),
	}, command)
	persisted, err := d.ledger.Complete(ctx, operationIdentity(command), event)
	if err != nil {
		return err
	}
	return stream.Send(ctx, persisted)
}

// Operation failure codes for a start this Computer refused. The first two
// tell the Agent Service the Computer cannot run the Agent right now, so the
// Room can say so instead of a generic failure.
const (
	operationCodeRunnerStopped     = "RUNNER_STOPPED"
	operationCodeRuntimeNotEnabled = "RUNTIME_NOT_ENABLED"
	operationCodeExecutionFailed   = "RUNTIME_EXECUTION_FAILED"
)

func (d *Daemon) finishFailure(ctx context.Context, stream transport.Stream, command protocol.Command, code, message string) error {
	event := withOperationIdentity(protocol.Event{
		Type:   protocol.EventOperationFailed,
		SentAt: time.Now().UTC(),
		Payload: mustJSON(map[string]any{
			"code": code, "message": message, "retryable": false,
		}),
	}, command)
	if command.OperationID != "" {
		persisted, err := d.ledger.Complete(ctx, operationIdentity(command), event)
		if err != nil {
			return err
		}
		event = persisted
	}
	return stream.Send(ctx, event)
}

// payloadType decodes only the top-level type of an event payload for logging.
func payloadType(payload json.RawMessage) string {
	var head struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(payload, &head) != nil {
		return ""
	}
	return head.Type
}

func withOperationIdentity(event protocol.Event, command protocol.Command) protocol.Event {
	event.CommandID = command.CommandID
	event.ProtocolVersion = command.ProtocolVersion
	event.HostAccess = command.HostAccess
	event.TenantID = command.TenantID
	event.OwnerActorID = command.OwnerActorID
	event.RegistrationID = command.RegistrationID
	event.AssignmentRevision = command.AssignmentRevision
	event.AgentID = command.AgentID
	event.OperationID = command.OperationID
	event.ConnectionEpoch = command.ConnectionEpoch
	event.RunnerRevision = command.RunnerRevision
	event.Generation = command.Generation
	event.ExecutionLeaseID = command.ExecutionLeaseID
	event.RunnerID = command.RunnerID
	event.ExecutionContextKey = command.ExecutionContextKey
	event.RuntimeInstanceID = command.RuntimeInstanceID
	event.ContextViewRef = append(json.RawMessage(nil), command.ContextViewRef...)
	event.WorkspaceGrantID = command.WorkspaceGrantID
	event.RuntimeType = command.RuntimeType
	return event
}

func operationIdentity(command protocol.Command) OperationIdentity {
	identity := OperationIdentity{
		ProtocolVersion:     command.ProtocolVersion,
		HostAccess:          command.HostAccess,
		TenantID:            command.TenantID,
		RunnerID:            command.RunnerID,
		OwnerActorID:        command.OwnerActorID,
		RegistrationID:      command.RegistrationID,
		AssignmentRevision:  command.AssignmentRevision,
		AgentID:             command.AgentID,
		OperationID:         command.OperationID,
		ConnectionEpoch:     command.ConnectionEpoch,
		RunnerRevision:      command.RunnerRevision,
		Generation:          command.Generation,
		ExecutionLeaseID:    command.ExecutionLeaseID,
		WorkspaceGrantID:    command.WorkspaceGrantID,
		RuntimeType:         command.RuntimeType,
		OperationKind:       command.OperationKind,
		ExecutionContextKey: command.ExecutionContextKey,
		RuntimeInstanceID:   command.RuntimeInstanceID,
		ContextViewRef:      string(command.ContextViewRef),
	}
	if command.Type == protocol.CommandOperationStart {
		if digest, err := commandDigest(command); err == nil {
			identity.StartCommandDigest = digest
		}
	}
	return identity
}

func terminalPayload(spec provider.OperationSpec, result provider.Result) json.RawMessage {
	if result.CleanupUnconfirmed {
		return terminalWithUsage(map[string]any{"code": "RUNTIME_CLEANUP_UNCONFIRMED", "message": "Provider cancellation cleanup is unconfirmed", "retryable": false}, spec, result)
	}
	if result.Status != "completed" {
		failure := provider.ClassifyExecutionFailure(spec.Provider, spec.CodexVersion, result.Status, result.FailureCode, result.Diagnostics)
		payload := map[string]any{"code": "RUNTIME_EXECUTION_FAILED", "message": "Runtime execution failed", "retryable": false, "failure": failure}
		if diagnostics := result.Diagnostics.Sanitized(); diagnostics != nil {
			payload["diagnostics"] = diagnostics
			if spec.Provider == "codex" && (diagnostics.Signal != "" || diagnostics.ExitCode != nil) {
				payload["message"] = "codex process exited"
			}
		}
		return terminalWithUsage(payload, spec, result)
	}
	sessionID := result.SessionID
	if sessionID == "" {
		sessionID = spec.ResumeSessionID
	}
	var session map[string]any
	switch spec.Provider {
	case "codex":
		session = map[string]any{"threadId": sessionID}
	case "claude", "pi":
		session = map[string]any{"provider": spec.Provider, "sessionId": sessionID, "lingerMaterialized": true}
	default:
		session = map[string]any{"thread_id": sessionID}
	}
	return terminalWithUsage(map[string]any{"type": "run", "final_response": result.Output, "session": session}, spec, result)
}
