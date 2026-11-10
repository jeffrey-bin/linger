package daemon

import (
	"context"
	"errors"
	"log/slog"
	"time"

	lingercontext "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/context"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
)

func (d *Daemon) handleOperationStart(ctx context.Context, stream transport.Stream, command protocol.Command) error {
	// Bring the Context to its View before admission, outside admissionMu so
	// other Contexts keep starting. Commands of one Context run in order, so
	// only a retained Operation of this Context can hold it; its View stays.
	viewStartedAt := time.Now()
	var viewErr error
	if len(command.ContextViewRef) > 0 && !d.contextHasActiveOperation(command) {
		viewErr = d.ensureContextView(ctx, command, command.ContextViewRef)
	}
	contextViewMs := time.Since(viewStartedAt).Milliseconds()
	d.admissionMu.Lock()
	defer d.admissionMu.Unlock()
	if d.draining {
		return errors.New("Local Computer Daemon is draining")
	}
	if command.OperationID == "" || command.ExecutionContextKey == "" || command.RuntimeInstanceID == "" || len(command.ContextViewRef) == 0 {
		return d.finishFailure(ctx, stream, command, operationCodeExecutionFailed, "operation_id and the Execution Context identity are required")
	}
	admissionStartedAt := time.Now()
	identity := operationIdentity(command)
	begin, err := d.ledger.Begin(ctx, identity)
	ledgerBeginMs := time.Since(admissionStartedAt).Milliseconds()
	if errors.Is(err, ErrLedgerIdentityConflict) {
		// Reject the replay, not the retained execution. A terminal here would
		// corrupt the ledger while the Provider still owns the Context slot.
		slog.Warn("Runner Operation replay rejected", "operation_id", command.OperationID,
			"command_id", command.CommandID, "connection_epoch", command.ConnectionEpoch,
			"reason", "operation_identity_conflict")
		return nil
	}
	if err != nil {
		return err
	}
	if begin.Disposition == BeginTerminal || begin.Disposition == BeginRunning {
		// A replacement cloud may have deferred the welcome replay until it
		// acquired its Context fence. Replay every unacknowledged frame, not
		// just the terminal: otherwise its sequence would have a gap.
		d.connectionMu.Lock()
		defer d.connectionMu.Unlock()
		return d.replayRetainedEvents(ctx, stream, []string{command.OperationID})
	}
	if d.welcomeSeen && command.ConnectionEpoch != d.connectionEpoch {
		return d.finishStaleEpochStart(ctx, stream, command, identity)
	}
	d.activeMu.Lock()
	stopped := d.locallyStopped[command.AgentID]
	d.activeMu.Unlock()
	admittedCount, contextBusy := d.operationOccupancy(identity)
	capacityExhausted := d.capacity != nil && admittedCount >= *d.capacity
	if stopped {
		return d.finishFailure(ctx, stream, command, operationCodeRunnerStopped, "Agent Runner is locally stopped")
	}
	if capacityExhausted {
		return d.finishAdmissionBusy(ctx, stream, command, "Local Computer capacity is exhausted")
	}
	if contextBusy {
		return d.finishAdmissionBusy(ctx, stream, command, "Context already has an active Operation")
	}
	if viewErr != nil {
		return d.finishContextViewFailure(ctx, stream, command, viewErr)
	}
	resolveStartedAt := time.Now()
	spec, err := d.operationResolver.Resolve(ctx, command, command.Payload)
	resolveMs := time.Since(resolveStartedAt).Milliseconds()
	if err != nil {
		return d.finishFailure(ctx, stream, command, operationCodeExecutionFailed, err.Error())
	}
	spec = bindOperationSpec(command, spec)
	if !d.runtimeEnabled(spec.Provider) {
		return d.finishFailure(ctx, stream, command, operationCodeRuntimeNotEnabled, "Runtime is not enabled on this Computer")
	}
	operationCtx, cancelOperation := context.WithCancel(ctx)
	prepared := d.takePreparedOperation(command.OperationID)
	cancel := func() {
		cancelOperation()
		if prepared != nil {
			prepared.cancelFrom("operation_lifecycle")
		}
	}
	active := &activeOperation{identity: identity, ctx: operationCtx, cancel: cancel}
	emitEvent := d.operationEventEmitter(command, identity, active)
	if spec.OperationKind == "run.start" {
		// Only run.start rewrites the per-run CLI files, after the Context
		// occupancy check and before any provider process starts or is reused.
		var credentials lingercontext.CLICredentialLookup
		if d.cliCredentials != nil {
			credentials = d.cliCredentials
		}
		if err := lingercontext.PrepareRunCLI(spec.WorkingDirectory, command.TenantID, command.AgentID,
			credentials, command.Payload); err != nil {
			cancel()
			d.discardPreparedOperationAsync(prepared, "cli_run_context_failure")
			return d.finishFailure(ctx, stream, command, operationCodeExecutionFailed, err.Error())
		}
	}
	acceptedAppendStartedAt := time.Now()
	accepted, err := d.ledger.Append(ctx, identity, operationAcceptedEvent(command))
	acceptedAppendMs := time.Since(acceptedAppendStartedAt).Milliseconds()
	if err != nil {
		cancel()
		d.discardPreparedOperationAsync(prepared, "admission_failure")
		return err
	}
	slog.Info("runner.operation.accepted", "operation_id", command.OperationID, "command_id", command.CommandID,
		"runner_id", command.RunnerID, "agent_id", command.AgentID, "kind", command.OperationKind,
		"accepted_at_unix_ms", time.Now().UnixMilli())
	acceptedSendStartedAt := time.Now()
	acceptanceSendErr := stream.Send(ctx, accepted)
	acceptedSendMs := time.Since(acceptedSendStartedAt).Milliseconds()
	preparedAdopted := prepared != nil
	slog.Info("runner.operation.admission_timing",
		"operation_id", command.OperationID, "kind", command.OperationKind,
		"context_view_ms", contextViewMs, "ledger_begin_ms", ledgerBeginMs, "resolve_ms", resolveMs,
		"accepted_append_ms", acceptedAppendMs, "accepted_send_ms", acceptedSendMs,
		"prepared", preparedAdopted,
		"total_ms", time.Since(admissionStartedAt).Milliseconds())
	if acceptanceSendErr != nil {
		cancel()
		d.discardPreparedOperationAsync(prepared, "acceptance_delivery")
		terminalErr := d.finishFailure(
			context.WithoutCancel(ctx), stream, command, operationCodeExecutionFailed,
			"Operation acceptance delivery became indeterminate before Provider start",
		)
		return errors.Join(acceptanceSendErr, terminalErr)
	}
	if prepared != nil {
		prepared.suppressReceipt()
	}
	// Register before releasing admissionMu: drain, stop, capacity and Context
	// occupancy must see this Operation from the moment it is accepted.
	d.activeMu.Lock()
	d.activeOperations[command.OperationID] = active
	d.activeMu.Unlock()
	acceptedRevision := d.authorityRevision
	d.operationWG.Add(1)
	go func() {
		defer d.operationWG.Done()
		d.startAcceptedOperation(operationCtx, command, spec, prepared, acceptedRevision, emitEvent, cancel)
	}()
	return acceptanceSendErr
}

// finishStaleEpochStart answers an unknown start sent on another connection
// epoch with a terminal receipt; it never starts a native turn.
func (d *Daemon) finishStaleEpochStart(ctx context.Context, stream transport.Stream, command protocol.Command, identity OperationIdentity) error {
	// A retained Operation takes the replay branches of handleOperationStart,
	// so this one is unknown to this process and can never start a native turn here.
	if !d.welcomedEpoch(command.ConnectionEpoch) {
		// It was sent on a connection of an earlier Daemon process, which
		// may have run it: its outcome is unknown and it is not retried.
		event := withOperationIdentity(protocol.Event{Type: protocol.EventOperationFailed,
			Stage: "runtime_execution", ProtocolVersion: command.ProtocolVersion, SentAt: time.Now().UTC(),
			Payload: mustJSON(map[string]any{"code": "DAEMON_RESTARTED", "message": "Local Computer Daemon restarted after the Operation was sent; native execution may have taken effect and its outcome is unknown", "retryable": false}),
		}, command)
		persisted, err := d.ledger.Interrupt(ctx, identity, event)
		if err != nil {
			return err
		}
		return stream.Send(ctx, persisted)
	}
	// This process never admitted it: record a definitive no-start receipt
	// instead of disconnecting forever or executing an old-epoch command.
	event := withOperationIdentity(protocol.Event{Type: protocol.EventOperationFailed,
		Stage: "operation_admission", ProtocolVersion: command.ProtocolVersion, SentAt: time.Now().UTC(),
		Payload: mustJSON(map[string]any{"code": "EXECUTION_NOT_ADMITTED", "message": "Cloud replaced before Local execution admission", "retryable": true}),
	}, command)
	persisted, err := d.ledger.Complete(ctx, identity, event)
	if err != nil {
		return err
	}
	return stream.Send(ctx, persisted)
}

// operationEventEmitter records each event of an accepted Operation in its
// ledger sequence and then delivers it on the current connection.
func (d *Daemon) operationEventEmitter(command protocol.Command, identity OperationIdentity, active *activeOperation) func(context.Context, protocol.Event) error {
	runStartedLogged := false
	return func(emitCtx context.Context, event protocol.Event) error {
		event = withOperationIdentity(event, command)
		event, boundErr := transport.BoundToolOutput(event)
		if boundErr != nil {
			return boundErr
		}
		active.inputMu.Lock()
		defer active.inputMu.Unlock()
		ledgerAppendStartedAt := time.Now()
		recorded, recordErr := d.ledger.Append(emitCtx, identity, event)
		ledgerAppendMs := time.Since(ledgerAppendStartedAt).Milliseconds()
		if recordErr != nil {
			return recordErr
		}
		// A recorded event belongs to the sequence even after the Operation is
		// cancelled; skipping its send would put a later event, such as the
		// cancelled terminal, on the wire first.
		connectionLockWait, sendDuration := d.deliverRecordedOperationEvent(context.WithoutCancel(emitCtx), recorded)
		// Only the first run.started frame is logged at Info; later frames stay at Debug.
		level := slog.LevelDebug
		if !runStartedLogged && event.Type == protocol.EventOperationEvent && payloadType(event.Payload) == "run.started" {
			runStartedLogged = true
			level = slog.LevelInfo
		}
		slog.Log(emitCtx, level, "runner.operation.event_sent", "operation_id", command.OperationID,
			"event_type", event.Type, "sequence", recorded.Sequence,
			"ledger_append_ms", ledgerAppendMs, "connection_lock_wait_ms", connectionLockWait.Milliseconds(),
			"send_ms", sendDuration.Milliseconds(), "sent_at_unix_ms", time.Now().UnixMilli())
		return nil
	}
}
