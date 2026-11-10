package daemon

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/mcpproxy"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
)

func (d *Daemon) operationMCPProxies(ctx context.Context, command protocol.Command, spec provider.OperationSpec, prepared *preparedOperation) (*mcpproxy.Set, error) {
	proxies, err := d.claimPreparedOperation(ctx, command, spec, prepared)
	if err != nil || proxies != nil || (spec.MCPRelays == nil && d.localTools == nil) {
		return proxies, err
	}
	return d.openOperationMCP(ctx, spec, mcpproxy.OperationIdentity{
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
	})
}

func (d *Daemon) openOperationMCP(ctx context.Context, spec provider.OperationSpec, identity mcpproxy.OperationIdentity) (*mcpproxy.Set, error) {
	proxies, err := d.openMCPProxies(ctx, spec.MCPRelays, identity)
	if err != nil {
		return nil, err
	}
	if d.localTools != nil {
		if err := d.localTools.Bind(ctx, spec, identity, proxies); err != nil {
			return nil, errors.Join(err, proxies.Close())
		}
	}
	return proxies, nil
}

// An accepted Operation owns its preparation and Context slot even before the
// provider starts. MCP preparation runs here, off the admission lock, so a slow
// tool catalog cannot delay accepted or other Contexts' admissions.
func (d *Daemon) startAcceptedOperation(ctx context.Context, command protocol.Command, spec provider.OperationSpec, prepared *preparedOperation, acceptedRevision uint64, emit func(context.Context, protocol.Event) error, cancel context.CancelFunc) {
	// A compaction of this Context holds its process. It is canceled now, so
	// its retirement overlaps MCP preparation, and awaited before the start.
	compactions := d.cancelSessionCompacts(sessionCompactForContext(command.ExecutionContextKey), "run_start")
	mcpProxiesStartedAt := time.Now()
	proxies, err := d.operationMCPProxies(ctx, command, spec, prepared)
	mcpProxiesMs := time.Since(mcpProxiesStartedAt).Milliseconds()
	if prepared != nil {
		spec.PrepareNativeResume = prepared.resumeMeasurement()
	}
	var compactWaitMs, providerJoinMs, startMs int64
	joinProvider := func() {
		joinStartedAt := time.Now()
		d.joinProviderPrepare(ctx, command)
		providerJoinMs += time.Since(joinStartedAt).Milliseconds()
	}
	logTiming := func(outcome string) {
		slog.Info("runner.operation.start_timing", "operation_id", command.OperationID, "kind", command.OperationKind,
			"prepared", prepared != nil, "mcp_proxies_ms", mcpProxiesMs, "compact_wait_ms", compactWaitMs,
			"provider_join_ms", providerJoinMs, "start_ms", startMs, "outcome", outcome)
	}
	if err == nil {
		waitStartedAt := time.Now()
		waitSessionCompacts(ctx, compactions)
		compactWaitMs = time.Since(waitStartedAt).Milliseconds()
		joinProvider()
		// Admission authority may have changed while MCP was preparing. Serialize
		// the final check with local stop and Context/Registration publication.
		// A provider prepare admitted meanwhile holds the Codex home claim, so
		// wait for it and recheck under the same lock that Start runs under.
		for {
			d.admissionMu.Lock()
			if ctx.Err() != nil || !d.providerPrepareInFlight(command.ExecutionContextKey) {
				break
			}
			d.admissionMu.Unlock()
			joinProvider()
		}
		if err = ctx.Err(); err == nil && prepared != nil {
			// Only prepared starts were admitted against a local assignment record.
			err = d.validatePendingAssignment(ctx, command)
		}
		// A prepared start rechecks its preparation-time authority. Any other
		// start was resolved at acceptance; it resolves again only when a
		// Registration or Agent Runner command ran since then.
		if err == nil && (prepared != nil || d.authorityRevision != acceptedRevision) {
			currentCommand := command
			var current provider.OperationSpec
			current, err = d.operationResolver.Resolve(ctx, currentCommand, currentCommand.Payload)
			if err == nil {
				want, fingerprintErr := operationPreparationFingerprint(spec)
				got, currentErr := operationPreparationFingerprint(bindOperationSpec(currentCommand, current))
				err = errors.Join(fingerprintErr, currentErr)
				if err == nil && want != got {
					err = errors.New("Operation authority changed while MCP preparation was pending")
				}
			}
		}
		var execution *provider.Execution
		if err == nil {
			err = ctx.Err()
		}
		if err == nil {
			spec.MCPConfig = proxies.Config()
			spec.TrustedLocalMCPTools = proxies.LocalToolNames()
			spec.LocalEvidence = proxies.LocalEvidence
			spec.LocalAllowed = proxies.LocalAllowed
			startedAt := time.Now()
			execution, err = d.executor.Start(ctx, spec, emit)
			startMs = time.Since(startedAt).Milliseconds()
		}
		if err == nil {
			d.activeMu.Lock()
			active := d.activeOperations[command.OperationID]
			active.execution, active.mcpProxies = execution, proxies
			d.activeMu.Unlock()
		}
		d.admissionMu.Unlock()
		if err == nil {
			logTiming("started")
			d.awaitOperation(ctx, command, spec, execution.Result)
			return
		}
	}
	logTiming("failed")
	err = errors.Join(err, proxies.Close())
	d.finishOperation(ctx, command, spec, provider.Result{
		Status: "failed", Error: err.Error(),
		CleanupUnconfirmed: errors.Is(err, provider.ErrPreparationCleanupUnconfirmed) || errors.Is(err, mcpproxy.ErrCleanupUnconfirmed),
	})
}

func (d *Daemon) validatePendingAssignment(ctx context.Context, command protocol.Command) error {
	records, err := d.assignments.List(ctx)
	if err != nil {
		return err
	}
	for _, record := range records {
		if record.TenantID != command.TenantID || record.AgentID != command.AgentID {
			continue
		}
		if record.State != "ready" || record.RunnerID != command.RunnerID || record.RegistrationID != command.RegistrationID ||
			record.AssignmentRevision != command.AssignmentRevision || record.RunnerRevision != command.RunnerRevision ||
			record.WorkspaceGrantID != command.WorkspaceGrantID {
			return errors.New("Agent Runner assignment changed while MCP preparation was pending")
		}
		return nil
	}
	return errors.New("Agent Runner assignment is unavailable after MCP preparation")
}

// Preparation remains occupied during adoption and cleanup. Count its active
// Operation only once, and do not treat this command's own future as a conflict.
func (d *Daemon) operationOccupancy(identity OperationIdentity) (count int, contextBusy bool) {
	d.activeMu.Lock()
	defer d.activeMu.Unlock()
	d.preparationMu.Lock()
	defer d.preparationMu.Unlock()
	for _, active := range d.activeOperations {
		if !active.terminalCommitted {
			count++
			contextBusy = contextBusy || operationContextKey(active.identity) == operationContextKey(identity)
		}
	}
	for operationID, prepared := range d.preparedOperations {
		if operationID == identity.OperationID {
			continue
		}
		if active := d.activeOperations[operationID]; active != nil && !active.terminalCommitted {
			continue
		}
		count++
		contextBusy = contextBusy || operationContextKey(prepared.identity) == operationContextKey(identity)
	}
	return count, contextBusy
}
