package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/redact"
	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

const (
	// providerPrepareTimeout bounds one prepare's spawn and resume. A start
	// joining an in-flight prepare waits no longer than this.
	providerPrepareTimeout = 20 * time.Second
	// receiptReasonLimit is the contract's limit on a receipt reason.
	receiptReasonLimit = 512
)

// providerPrepare is the Daemon's record of one in-flight provider prepare for
// an execution context, so a start can join it. It is dropped when the prepare
// finishes; its parked process is then owned by the native resident table and
// lives like any parked process.
type providerPrepare struct {
	id         string
	agentID    string
	contextKey string
	startedAt  time.Time
	cancel     context.CancelFunc
	done       chan struct{}
	mu         sync.Mutex
	canceled   bool
}

type providerPrepareRequest struct {
	PrepareID      string          `json:"prepare_id"`
	Runtime        json.RawMessage `json:"runtime"`
	SessionOptions json.RawMessage `json:"session_options"`
	Session        json.RawMessage `json:"session"`
	// RunContext carries only the reviewed Run's authorization flags.
	RunContext json.RawMessage `json:"run_context"`
}

// handleProviderPrepare admits one prepare without taking the Context's
// Operation slot or the Operation ledger.
func (d *Daemon) handleProviderPrepare(ctx context.Context, stream transport.Stream, command protocol.Command) error {
	var request providerPrepareRequest
	if err := json.Unmarshal(command.Payload, &request); err != nil {
		return fmt.Errorf("decode provider preparation: %w", err)
	}
	if request.PrepareID == "" || command.ExecutionContextKey == "" {
		return errors.New("provider preparation is incomplete")
	}
	if !d.runtimeEnabled(command.RuntimeType) {
		return d.sendProviderPrepared(ctx, stream, command, request.PrepareID, "not_eligible", "Runtime is not enabled on this Computer", 0)
	}
	key := command.ExecutionContextKey
	slog.Info("runner.provider.prepare", "phase", "received", "prepare_id", request.PrepareID,
		"execution_context_key", key, "agent_id", command.AgentID)
	d.admissionMu.Lock()
	if d.draining {
		d.admissionMu.Unlock()
		return d.sendProviderPrepared(ctx, stream, command, request.PrepareID, "not_eligible", "Local Computer Daemon is draining", 0)
	}
	d.activeMu.Lock()
	stopped := d.locallyStopped[command.AgentID]
	d.activeMu.Unlock()
	if stopped {
		d.admissionMu.Unlock()
		return d.sendProviderPrepared(ctx, stream, command, request.PrepareID, "not_eligible", "Agent Runner is locally stopped", 0)
	}
	d.providerPrepareMu.Lock()
	if inFlight := d.providerPrepares[key]; inFlight != nil {
		d.providerPrepareMu.Unlock()
		d.admissionMu.Unlock()
		if inFlight.id == request.PrepareID {
			// The in-flight prepare's own receipt answers the repeated id.
			return nil
		}
		return d.sendProviderPrepared(ctx, stream, command, request.PrepareID, "already_ready", "Provider process is already being prepared for this Context", 0)
	}
	// Every presence hint is a prepare; a Context that already has a parked
	// process is ready without resolving or projecting anything again. A Run
	// whose inputs changed replaces that process when it takes it.
	if native.ContextHasParkedResident(key) {
		d.providerPrepareMu.Unlock()
		d.admissionMu.Unlock()
		return d.sendProviderPrepared(ctx, stream, command, request.PrepareID, "already_ready", "Provider process is already parked for this Context", 0)
	}
	prepareCtx, cancel := context.WithTimeout(ctx, providerPrepareTimeout)
	entry := &providerPrepare{
		id: request.PrepareID, agentID: command.AgentID, contextKey: key, startedAt: time.Now(),
		cancel: cancel, done: make(chan struct{}),
	}
	d.providerPrepares[key] = entry
	d.providerPrepareMu.Unlock()
	d.admissionMu.Unlock()

	d.preparationWG.Add(1)
	go func() {
		defer d.preparationWG.Done()
		d.runProviderPrepare(prepareCtx, stream, command, request, entry)
	}()
	return nil
}

func (d *Daemon) runProviderPrepare(ctx context.Context, stream transport.Stream, command protocol.Command, request providerPrepareRequest, entry *providerPrepare) {
	// A compaction holds the Context's parked process; the prepare runs after it.
	d.interruptSessionCompact(ctx, entry.contextKey, "provider_prepare")
	outcome, reason := d.executeProviderPrepare(ctx, command, request)
	// A parked process is detached from this context, so releasing it here
	// only frees the deadline timer.
	entry.cancel()
	d.providerPrepareMu.Lock()
	if d.providerPrepares[entry.contextKey] == entry {
		delete(d.providerPrepares, entry.contextKey)
	}
	d.providerPrepareMu.Unlock()
	entry.mu.Lock()
	canceled := entry.canceled
	entry.mu.Unlock()
	close(entry.done)
	if canceled {
		// A process the prepare parked anyway stays like any parked process; an
		// Agent stop or drain that canceled it also stops what is parked.
		outcome, reason = "canceled", "Provider prepare canceled"
	}
	duration := time.Since(entry.startedAt)
	if err := d.sendProviderPrepared(context.WithoutCancel(ctx), stream, command, entry.id, outcome, reason, duration); err != nil {
		slog.Debug("runner.provider.prepare receipt unavailable", "prepare_id", entry.id)
	}
}

// executeProviderPrepare resolves the start's spec through the same resolver
// as run.start, without input, and parks a resumed thread (Codex) or a
// pre-started CLI (Claude). It never submits a turn and never fails a real
// start.
func (d *Daemon) executeProviderPrepare(ctx context.Context, command protocol.Command, request providerPrepareRequest) (outcome, reason string) {
	if command.RuntimeType != "codex" && command.RuntimeType != "claude" {
		return "not_eligible", "Provider prepare is supported only for Codex and Claude"
	}
	start := map[string]any{
		"kind": "run.start", "runtime": request.Runtime,
		"session_options": request.SessionOptions, "session": request.Session,
	}
	if len(request.RunContext) > 0 {
		start["run_context"] = request.RunContext
	}
	payload, err := json.Marshal(start)
	if err != nil {
		return "failed", "encode provider preparation request"
	}
	// A prepare never changes the View under a running Operation of its Context.
	if !d.contextHasActiveOperation(command) {
		if err := d.ensureContextView(ctx, command, command.ContextViewRef); err != nil {
			return "not_eligible", redact.Text(err.Error())
		}
	}
	spec, err := d.operationResolver.Resolve(ctx, command, payload)
	if err != nil {
		return "not_eligible", redact.Text(err.Error())
	}
	spec = bindOperationSpec(command, spec)
	// A Claude pre-start may create its conversation. A Codex prepare resumes
	// the Context's thread, or for a Context that has none starts the thread
	// its first Run adopts.
	resumable := command.RuntimeType == "codex" || spec.ResumeSessionID != "" || spec.CreateProviderSessionID != ""
	if spec.Provider != command.RuntimeType || spec.OperationKind != "run.start" || !resumable {
		return "not_eligible", "Provider session is not resumable for provider preparation"
	}
	result, err := d.executor.PrepareProvider(ctx, spec)
	if err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			return "canceled", "Provider prepare canceled"
		}
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return "failed", "Provider prepare deadline exceeded"
		}
		return "failed", redact.Text(err.Error())
	}
	if result.PreparedParked {
		return "ready", ""
	}
	return "already_ready", "Provider process is already parked for this Context"
}

// cancelProviderPrepares cancels every matching in-flight prepare. A canceled
// prepare that still parks is refused by the resident fence when the caller
// also stops the Context's or Agent's parked processes.
func (d *Daemon) cancelProviderPrepares(match func(*providerPrepare) bool, source string) {
	d.providerPrepareMu.Lock()
	defer d.providerPrepareMu.Unlock()
	for _, entry := range d.providerPrepares {
		if !match(entry) {
			continue
		}
		entry.mu.Lock()
		entry.canceled = true
		entry.mu.Unlock()
		entry.cancel()
		slog.Info("runner.provider.prepare", "phase", "cancel_requested", "prepare_id", entry.id,
			"execution_context_key", entry.contextKey, "cancellation_source", source)
	}
}

func providerPrepareForAgent(agentID string) func(*providerPrepare) bool {
	return func(entry *providerPrepare) bool { return entry.agentID == agentID }
}

func providerPrepareAll(*providerPrepare) bool { return true }

// providerPrepareInFlight reports whether a prepare for the Context still holds
// its runtime home claim. A start must join it instead of claiming the home.
func (d *Daemon) providerPrepareInFlight(contextKey string) bool {
	if contextKey == "" {
		return false
	}
	d.providerPrepareMu.Lock()
	defer d.providerPrepareMu.Unlock()
	return d.providerPrepares[contextKey] != nil
}

// joinProviderPrepare lets a start wait for an in-flight prepare of its Context
// so the start adopts the parked process instead of spawning a second one. A
// failed or absent prepare changes nothing for the start.
func (d *Daemon) joinProviderPrepare(ctx context.Context, command protocol.Command) {
	key := command.ExecutionContextKey
	if key == "" {
		return
	}
	d.providerPrepareMu.Lock()
	entry := d.providerPrepares[key]
	d.providerPrepareMu.Unlock()
	if entry == nil {
		return
	}
	slog.Info("runner.provider.prepare", "phase", "joined_by_start", "prepare_id", entry.id,
		"execution_context_key", key, "operation_id", command.OperationID)
	select {
	case <-entry.done:
	case <-ctx.Done():
	}
}

func (d *Daemon) sendProviderPrepared(ctx context.Context, stream transport.Stream, command protocol.Command, prepareID, outcome, reason string, duration time.Duration) error {
	payload := wire.ProviderPrepared{
		Type: wire.TypePrepared, Target: wire.TargetProvider, CommandID: command.CommandID, RunnerID: command.RunnerID,
		PrepareID: prepareID, ExecutionContextKey: command.ExecutionContextKey, Outcome: outcome,
		DurationMs: uint64(max(duration.Milliseconds(), 0)), Reason: receiptReason(reason),
	}
	slog.Info("runner.provider.prepare", "phase", outcome, "prepare_id", prepareID,
		"execution_context_key", command.ExecutionContextKey, "duration_ms", duration.Milliseconds(),
		"reason", redact.Text(payload.Reason))
	return stream.Send(ctx, protocol.Event{
		Type: protocol.EventProviderPrepared, ProtocolVersion: command.ProtocolVersion, CommandID: command.CommandID,
		SentAt: time.Now().UTC(), Payload: mustJSON(payload),
	})
}

// receiptReason is a receipt reason trimmed to the contract's limit.
func receiptReason(reason string) string {
	reason = strings.TrimSpace(reason)
	if runes := []rune(reason); len(runes) > receiptReasonLimit {
		reason = string(runes[:receiptReasonLimit])
	}
	return reason
}
