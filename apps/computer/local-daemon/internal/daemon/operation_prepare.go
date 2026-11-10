package daemon

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/mcpproxy"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/redact"
)

const (
	operationMCPPrepareTimeout = 3 * time.Second
	operationMCPCleanupLimit   = 3 * time.Second
)

type preparedOperation struct {
	identity       OperationIdentity
	command        protocol.Command
	startedAt      time.Time
	expiryTimer    *time.Timer
	stopConnection func() bool
	adopted        bool
	done           chan struct{}
	cancelled      <-chan struct{}
	cancel         context.CancelFunc
	fingerprint    string
	mcpProxies     *mcpproxy.Set
	err            error
	activationMu   sync.RWMutex
	activated      bool
	resumeMu       sync.Mutex
	nativeResume   *native.NativeResumeMeasurement
	receiptMu      sync.Mutex
	receiptOff     bool
	cleanupOnce    sync.Once
	cleanupDone    chan struct{}
	cancelMu       sync.Mutex
	cancelSource   string
}

func (p *preparedOperation) resumeMeasurement() *native.NativeResumeMeasurement {
	p.resumeMu.Lock()
	defer p.resumeMu.Unlock()
	return p.nativeResume
}

func (p *preparedOperation) activate() {
	p.activationMu.Lock()
	p.activated = true
	p.activationMu.Unlock()
}

func (p *preparedOperation) requireActivation() error {
	p.activationMu.RLock()
	defer p.activationMu.RUnlock()
	if !p.activated {
		return errors.New("Operation MCP tools are unavailable before admission")
	}
	return nil
}

func (p *preparedOperation) suppressReceipt() {
	p.receiptMu.Lock()
	p.receiptOff = true
	p.receiptMu.Unlock()
}

func (p *preparedOperation) sendReceipt(send func() error) error {
	p.receiptMu.Lock()
	defer p.receiptMu.Unlock()
	// Admission/expiry suppress readiness-only receipts. A measured native RPC
	// still needs a receipt for prepare-only failure/cancellation; terminal
	// adoption also carries this sample, and the Gateway deduplicates both.
	if p.receiptOff && p.resumeMeasurement() == nil {
		return nil
	}
	return send()
}

func (p *preparedOperation) cancelFrom(source string) {
	p.cancelMu.Lock()
	if p.cancelSource == "" {
		p.cancelSource = source
	}
	p.cancelMu.Unlock()
	p.cancel()
}

func (p *preparedOperation) cancellationCategory(err error) string {
	p.cancelMu.Lock()
	source := p.cancelSource
	p.cancelMu.Unlock()
	if source != "" {
		return source
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "runtime_deadline"
	}
	if errors.Is(err, context.Canceled) {
		return "gateway_context"
	}
	return "none"
}

func bindOperationSpec(command protocol.Command, spec provider.OperationSpec) provider.OperationSpec {
	spec.TaskID = command.OperationID
	spec.ComputerID = command.RunnerID
	spec.RegistrationID = command.RegistrationID
	spec.TenantID = command.TenantID
	if spec.OwnerActorID == "" {
		spec.OwnerActorID = command.OwnerActorID
	}
	spec.AgentID = command.AgentID
	spec.ScopeID = command.ExecutionContextKey
	return spec
}

func operationPreparationFingerprint(spec provider.OperationSpec) (string, error) {
	canonicalRelays := append(json.RawMessage(nil), spec.MCPRelays...)
	if len(canonicalRelays) > 0 {
		var err error
		canonicalRelays, err = canonicalJSON(canonicalRelays)
		if err != nil {
			return "", fmt.Errorf("canonicalize Operation MCP relays: %w", err)
		}
	}
	encoded, err := json.Marshal(struct {
		Provider, ExecutablePath, WorkingDirectory, Model, ResumeSessionID string
		Environment                                                        map[string]string
		ExtraArgs, CustomArgs                                              []string
		MCPRelays                                                          json.RawMessage
		ThinkingLevel, ThreadName, SystemPrompt                            string
		BaseInstructions, DeveloperInstructions                            *string
		RegistrationID, CodexVersion                                       string
		TenantID, OwnerActorID, AgentID, ComputerID, ScopeID               string
		PermissionReview                                                   bool
	}{
		Provider: spec.Provider, ExecutablePath: spec.ExecutablePath, WorkingDirectory: spec.WorkingDirectory,
		Model: spec.Model, ResumeSessionID: spec.ResumeSessionID, Environment: spec.Environment,
		ExtraArgs: spec.ExtraArgs, CustomArgs: spec.CustomArgs, MCPRelays: canonicalRelays,
		ThinkingLevel: spec.ThinkingLevel, ThreadName: spec.ThreadName,
		SystemPrompt: spec.SystemPrompt, BaseInstructions: spec.BaseInstructions, DeveloperInstructions: spec.DeveloperInstructions,
		RegistrationID: spec.RegistrationID, CodexVersion: spec.CodexVersion,
		TenantID: spec.TenantID, OwnerActorID: spec.OwnerActorID, AgentID: spec.AgentID, ComputerID: spec.ComputerID,
		ScopeID: spec.ScopeID, PermissionReview: spec.PermissionReview,
	})
	if err != nil {
		return "", fmt.Errorf("encode Operation preparation fingerprint: %w", err)
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}

func (d *Daemon) handleOperationPrepare(ctx context.Context, stream transport.Stream, command protocol.Command) error {
	if command.OperationID == "" || command.ExecutionLeaseID == "" || command.ExecutionContextKey == "" || len(command.ContextViewRef) == 0 {
		return d.sendOperationPrepared(ctx, stream, command, false, 0, "fallback")
	}
	if command.RuntimeType != "codex" || command.OperationKind != "run.start" {
		return d.sendOperationPrepared(ctx, stream, command, false, 0, "fallback")
	}
	d.admissionMu.Lock()
	if d.draining {
		d.admissionMu.Unlock()
		return d.sendOperationPrepared(ctx, stream, command, false, 0, "fallback")
	}
	identity := operationIdentity(command)
	d.activeMu.Lock()
	stopped := d.locallyStopped[command.AgentID]
	d.activeMu.Unlock()
	activeCount, contextBusy := d.operationOccupancy(identity)
	if stopped || contextBusy || (d.capacity != nil && activeCount >= *d.capacity) {
		d.admissionMu.Unlock()
		return d.sendOperationPrepared(ctx, stream, command, false, 0, "fallback")
	}
	begin, err := d.ledger.BeginPreparation(ctx, identity, command)
	if err != nil {
		d.admissionMu.Unlock()
		if errors.Is(err, ErrLedgerIdentityConflict) {
			return d.sendOperationPrepared(ctx, stream, command, false, 0, "fallback")
		}
		return err
	}
	d.preparationMu.Lock()
	if retained := d.preparedOperations[command.OperationID]; retained != nil {
		d.preparationMu.Unlock()
		d.admissionMu.Unlock()
		select {
		case <-retained.done:
			return retained.sendReceipt(func() error {
				return d.sendOperationPrepared(ctx, stream, command, retained.err == nil, time.Since(retained.startedAt), preparationOutcome(retained.err), retained.resumeMeasurement())
			})
		default:
			return nil
		}
	}
	if begin.Disposition != BeginPreparationNew {
		d.preparationMu.Unlock()
		d.admissionMu.Unlock()
		_ = d.ledger.DeletePreparation(context.WithoutCancel(ctx), identity)
		return d.sendOperationPrepared(ctx, stream, command, false, 0, "fallback")
	}
	startedAt := time.Now()
	prepareCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	prepared := &preparedOperation{
		identity: identity, command: command, startedAt: startedAt,
		done: make(chan struct{}), cleanupDone: make(chan struct{}), cancel: cancel, cancelled: prepareCtx.Done(),
	}
	prepared.stopConnection = context.AfterFunc(ctx, func() {
		prepared.cancelMu.Lock()
		defer prepared.cancelMu.Unlock()
		if !prepared.adopted {
			prepared.cancelSource = "gateway_context"
			prepared.cancel()
		}
	})
	prepared.expiryTimer = time.AfterFunc(operationMCPPrepareTimeout, func() { d.expirePreparedOperation(prepared) })
	d.preparedOperations[command.OperationID] = prepared
	d.preparationMu.Unlock()
	d.admissionMu.Unlock()
	slog.Info("runner.operation.prepare", "phase", "created", "operation_id", command.OperationID)

	d.preparationWG.Add(1)
	go func() {
		defer d.preparationWG.Done()
		d.runOperationPrepare(prepareCtx, stream, prepared)
	}()
	return nil
}

// The speculative budget stops at adoption. Expiry and adoption linearize on
// cancelMu; stopping a timer alone cannot fence a callback already in flight.
func (d *Daemon) expirePreparedOperation(prepared *preparedOperation) {
	prepared.cancelMu.Lock()
	if prepared.adopted || prepared.cancelSource != "" {
		prepared.cancelMu.Unlock()
		return
	}
	prepared.cancelSource = "prepare_deadline"
	prepared.cancelMu.Unlock()
	// Reclaim even without a later start. Native owns any unconfirmed writer.
	d.discardPreparedOperationAsync(prepared, "prepare_deadline")
}

func (d *Daemon) runOperationPrepare(ctx context.Context, stream transport.Stream, prepared *preparedOperation) {
	command := prepared.command
	var err error
	if !d.contextHasActiveOperation(command) {
		err = d.ensureContextView(ctx, command, command.ContextViewRef)
	}
	var spec provider.OperationSpec
	if err == nil {
		spec, err = d.operationResolver.Resolve(ctx, command, command.Payload)
	}
	if err == nil {
		spec = bindOperationSpec(command, spec)
		if spec.Provider != "codex" || spec.OperationKind != "run.start" || spec.ResumeSessionID == "" || ((len(spec.MCPRelays) == 0 || string(spec.MCPRelays) == "[]") && d.localTools == nil) {
			err = errors.New("Operation is not eligible for exact Codex MCP preparation")
		}
	}
	var fingerprint string
	if err == nil {
		fingerprint, err = operationPreparationFingerprint(spec)
	}
	var proxies *mcpproxy.Set
	if err == nil {
		proxies, err = d.openOperationMCP(ctx, spec, mcpproxy.OperationIdentity{
			OperationID: command.OperationID, ExecutionLeaseID: command.ExecutionLeaseID, RuntimeType: spec.Provider,
			BeforeRequest: func(requestCtx context.Context) error {
				for !d.Reconciled() {
					select {
					case <-requestCtx.Done():
						return requestCtx.Err()
					case <-time.After(100 * time.Millisecond):
					}
				}
				return requestCtx.Err()
			},
			BeforeToolCall: prepared.requireActivation,
		})
	}
	if err == nil {
		spec.MCPConfig = proxies.Config()
		spec.TrustedLocalMCPTools = proxies.LocalToolNames()
		spec.MCPReady = proxies.WaitReady
		result, prepareErr := d.executor.PrepareMCP(ctx, spec)
		prepared.resumeMu.Lock()
		prepared.nativeResume = result.NativeResume
		prepared.resumeMu.Unlock()
		err = prepareErr
	}
	if err == nil {
		err = d.ledger.CompletePreparation(ctx, prepared.identity, command)
	}
	if err != nil {
		prepared.cancel()
		closeErr := proxies.Close()
		err = errors.Join(err, closeErr)
		if errors.Is(closeErr, mcpproxy.ErrCleanupUnconfirmed) {
			err = errors.Join(err, provider.ErrPreparationCleanupUnconfirmed)
		}
		if !errors.Is(err, provider.ErrPreparationCleanupUnconfirmed) {
			prepared.expiryTimer.Stop()
		}
		proxies = nil
	}
	// A successful preparation transfers these live proxies, including their
	// Context, to the Operation. Only failure or the new owner may cancel it.

	// Ready is not adoption: keep the speculative expiry until start owns it.
	d.preparationMu.Lock()
	prepared.fingerprint = fingerprint
	prepared.mcpProxies = proxies
	prepared.err = err
	close(prepared.done)
	d.preparationMu.Unlock()
	if err != nil {
		prepared.stopConnection()
		if !errors.Is(err, provider.ErrPreparationCleanupUnconfirmed) {
			d.releasePreparedOperation(prepared)
		}
		_ = d.ledger.DeletePreparation(context.WithoutCancel(ctx), prepared.identity)
		phase := "failed"
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			phase = "canceled"
		}
		slog.Warn("runner.operation.prepare", "phase", phase, "operation_id", command.OperationID,
			"cancellation_source", prepared.cancellationCategory(err), "reason", redact.Text(err.Error()))
	} else {
		slog.Info("runner.operation.prepare", "phase", "ready", "operation_id", command.OperationID,
			"duration_ms", time.Since(prepared.startedAt).Milliseconds())
	}
	if sendErr := prepared.sendReceipt(func() error {
		return d.sendOperationPrepared(context.WithoutCancel(ctx), stream, command, err == nil, time.Since(prepared.startedAt), preparationOutcome(err), prepared.resumeMeasurement())
	}); sendErr != nil {
		slog.Debug("runner.operation.prepare receipt unavailable", "operation_id", command.OperationID)
	}
}

func preparationOutcome(err error) string {
	if err != nil {
		return "fallback"
	}
	return "ready"
}

func (d *Daemon) sendOperationPrepared(ctx context.Context, stream transport.Stream, command protocol.Command, ready bool, duration time.Duration, outcome string, measurements ...*native.NativeResumeMeasurement) error {
	payload := map[string]any{
		"prepare_command_id": command.CommandID, "prepared": ready, "duration_ms": duration.Milliseconds(), "outcome": outcome,
	}
	if len(measurements) > 0 && measurements[0] != nil {
		payload["prepare_native_resume"] = measurements[0]
	}
	if !ready {
		payload["error"] = map[string]any{
			"code": "MCP_PREPARE_FAILED", "message": "Local MCP pre-handshake unavailable", "retryable": true,
		}
	}
	return stream.Send(ctx, withOperationIdentity(protocol.Event{
		Type: protocol.EventOperationPrepared, SentAt: time.Now().UTC(), Payload: mustJSON(payload),
	}, command))
}

// takePreparedOperation transfers cancellation ownership to the admitted Operation.
// Retain occupancy until reuse or confirmed cleanup, including admission failure.
// The Gateway receive loop never waits for MCP readiness. Only the admitted
// Operation may cancel it after this point; connection replacement must not.
func (d *Daemon) takePreparedOperation(operationID string) *preparedOperation {
	d.preparationMu.Lock()
	defer d.preparationMu.Unlock()
	prepared := d.preparedOperations[operationID]
	if prepared != nil {
		prepared.cancelMu.Lock()
		prepared.adopted = true
		prepared.expiryTimer.Stop()
		prepared.stopConnection()
		prepared.cancelMu.Unlock()
	}
	return prepared
}

func (d *Daemon) claimPreparedOperation(ctx context.Context, command protocol.Command, spec provider.OperationSpec, prepared *preparedOperation) (*mcpproxy.Set, error) {
	if prepared == nil {
		slog.Debug("runner.operation.mcp_prepare", "phase", "not_requested", "operation_id", command.OperationID)
		return nil, nil
	}

	if !sameOperationIdentity(prepared.identity, operationIdentity(command)) {
		if err := d.discardPreparedOperationWithin(prepared, operationMCPCleanupLimit, "identity_mismatch"); err != nil {
			return nil, err
		}
		slog.Info("runner.operation.prepare", "phase", "start_fallback", "operation_id", command.OperationID, "reason", "identity_mismatch")
		return nil, nil
	}
	slog.Info("runner.operation.prepare", "phase", "start_joined", "operation_id", command.OperationID)
	select {
	case <-ctx.Done():
		return nil, errors.Join(ctx.Err(), d.discardPreparedOperationWithin(prepared, operationMCPCleanupLimit, "start_context"))
	case <-prepared.done:
	case <-prepared.cancelled:
		select {
		case <-prepared.done:
		default:
			if err := d.discardPreparedOperationWithin(prepared, operationMCPCleanupLimit, prepared.cancellationCategory(nil)); err != nil {
				return nil, err
			}
		}
	}
	if ctx.Err() != nil {
		return nil, errors.Join(ctx.Err(), d.discardPreparedOperationWithin(prepared, operationMCPCleanupLimit, "start_context"))
	}
	if errors.Is(prepared.err, provider.ErrPreparationCleanupUnconfirmed) {
		d.releasePreparedOperation(prepared)
		return nil, prepared.err
	}
	if source := prepared.cancellationCategory(nil); source != "none" {
		if err := d.discardPreparedOperationWithin(prepared, operationMCPCleanupLimit, source); err != nil {
			return nil, err
		}
		if source != "prepare_deadline" {
			return nil, fmt.Errorf("Operation preparation canceled by %s", source)
		}
		slog.Info("runner.operation.prepare", "phase", "start_fallback", "operation_id", command.OperationID, "reason", source)
		return nil, nil
	}
	if prepared.err != nil || prepared.mcpProxies == nil {
		_ = d.ledger.DeletePreparation(context.WithoutCancel(ctx), prepared.identity)
		slog.Info("runner.operation.prepare", "phase", "start_fallback", "operation_id", command.OperationID, "reason", "prepare_failed")
		return nil, nil //nolint:nilerr // a failed preparation falls back to starting without it
	}
	fingerprint, err := operationPreparationFingerprint(spec)
	if err != nil || fingerprint != prepared.fingerprint {
		d.discardPreparedOperation(prepared, "fingerprint_mismatch")
		slog.Info("runner.operation.prepare", "phase", "start_fallback", "operation_id", command.OperationID, "reason", "fingerprint_mismatch")
		return nil, err
	}
	if err := d.ledger.DeletePreparation(ctx, prepared.identity); err != nil {
		d.discardPreparedOperation(prepared, "ledger_failure")
		return nil, err
	}
	prepared.activate()
	d.releasePreparedOperation(prepared)
	slog.Info("runner.operation.prepare", "phase", "start_reused", "operation_id", command.OperationID)
	return prepared.mcpProxies, nil
}

func (d *Daemon) discardPreparedOperation(prepared *preparedOperation, source string) {
	if prepared == nil {
		return
	}
	d.discardPreparedOperationAsync(prepared, source)
	<-prepared.cleanupDone
}

func (d *Daemon) discardPreparedOperationWithin(prepared *preparedOperation, waitLimit time.Duration, source string) error {
	if prepared == nil {
		return nil
	}
	d.discardPreparedOperationAsync(prepared, source)
	select {
	case <-prepared.cleanupDone:
		if errors.Is(prepared.err, provider.ErrPreparationCleanupUnconfirmed) {
			return prepared.err
		}
		return nil
	case <-time.After(waitLimit):
		slog.Warn("runner.operation.prepare", "phase", "cleanup_finish", "operation_id", prepared.command.OperationID, "outcome", "deadline_exceeded")
		return errors.Join(provider.ErrPreparationCleanupUnconfirmed, errors.New("Operation MCP preparation cleanup did not complete before fallback deadline"))
	}
}

func (d *Daemon) discardPreparedOperationAsync(prepared *preparedOperation, source string) {
	if prepared == nil {
		return
	}
	prepared.cleanupOnce.Do(func() {
		d.cleanupWG.Add(1)
		prepared.cancelFrom(source)
		prepared.suppressReceipt()
		slog.Info("runner.operation.prepare", "phase", "cleanup_start", "operation_id", prepared.command.OperationID, "cancellation_source", source)
		go func() {
			defer d.cleanupWG.Done()
			defer close(prepared.cleanupDone)
			<-prepared.done
			_ = prepared.mcpProxies.Close()
			_ = d.ledger.DeletePreparation(context.Background(), prepared.identity)
			d.releasePreparedOperation(prepared)
			if errors.Is(prepared.err, provider.ErrPreparationCleanupUnconfirmed) {
				slog.Warn("runner.operation.prepare", "phase", "cleanup_finish", "operation_id", prepared.command.OperationID, "outcome", "unconfirmed")
				return // Native retains the home-scoped writer until cleanup is confirmed.
			}
			slog.Info("runner.operation.prepare", "phase", "cleanup_finish", "operation_id", prepared.command.OperationID, "outcome", "completed")
		}()
	})
}

func (d *Daemon) releasePreparedOperation(prepared *preparedOperation) {
	prepared.stopConnection()
	d.preparationMu.Lock()
	if d.preparedOperations[prepared.command.OperationID] == prepared {
		delete(d.preparedOperations, prepared.command.OperationID)
	}
	d.preparationMu.Unlock()
}

func (d *Daemon) cancelPreparedOperation(command protocol.Command) error {
	d.preparationMu.Lock()
	prepared := d.preparedOperations[command.OperationID]
	if prepared == nil {
		d.preparationMu.Unlock()
		return nil
	}
	if !sameOperationIdentity(prepared.identity, operationIdentity(command)) {
		d.preparationMu.Unlock()
		return ErrLedgerIdentityConflict
	}
	prepared.cancelMu.Lock()
	adopted := prepared.adopted
	prepared.cancelMu.Unlock()
	d.preparationMu.Unlock()
	if !adopted {
		d.discardPreparedOperationAsync(prepared, "operation_cancel")
	}
	return nil
}

func (d *Daemon) cancelPreparedOperations(agentID string) {
	d.preparationMu.Lock()
	items := make([]*preparedOperation, 0, len(d.preparedOperations))
	for _, prepared := range d.preparedOperations {
		if agentID != "" && prepared.identity.AgentID != agentID {
			continue
		}
		prepared.cancelMu.Lock()
		adopted := prepared.adopted
		prepared.cancelMu.Unlock()
		if adopted {
			continue // Active Operation cancellation owns adopted preparation.
		}
		items = append(items, prepared)
	}
	d.preparationMu.Unlock()
	for _, prepared := range items {
		d.discardPreparedOperationAsync(prepared, "gateway_or_daemon_shutdown")
	}
}
