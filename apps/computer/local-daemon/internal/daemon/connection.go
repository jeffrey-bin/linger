package daemon

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	mathrand "math/rand/v2"
	"sort"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/assignment"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/registration"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

func (d *Daemon) runConnection(ctx context.Context, deviceIdentity transport.Identity) (err error) {
	hello, err := d.connectionHello(ctx, deviceIdentity)
	if err != nil {
		return err
	}
	stream, err := d.controlPlane.Connect(ctx, hello)
	if err != nil {
		return fmt.Errorf("connect Linger control plane: %w", err)
	}
	// The dispatch shutdown below closes the stream before this runs, which
	// releases a background delivery holding connectionMu on a socket write.
	defer d.clearDiagnosticsStream(stream)
	connectionCtx, cancelConnection := context.WithCancel(ctx)
	defer d.cancelPreparedOperations("")
	defer d.cancelProviderPrepares(providerPrepareAll, "connection_lost")
	defer d.cancelSessionCompacts(sessionCompactAll, "connection_lost")
	defer d.cancelModelInvokes("connection_lost")
	defer cancelConnection()
	dispatch := newCommandDispatcher(connectionCtx, stream, d.contextDispatchLimit)
	d.dispatcher.Store(dispatch)
	defer func() {
		// Shutdown closes the stream first: a background delivery may hold
		// connectionMu while it waits on that stream. Workers end before the
		// connection cleanup above, so no queued command of this connection can
		// run or send after the connection returns.
		dispatchErr := dispatch.shutdown()
		d.dispatcher.CompareAndSwap(dispatch, nil)
		if dispatchErr != nil {
			err = dispatchErr
		}
	}()
	if err := stream.Send(ctx, protocol.Event{
		Type:            protocol.EventDaemonHello,
		ProtocolVersion: d.protocolVersion,
		SentAt:          time.Now().UTC(),
		Payload: mustJSON(struct {
			DaemonID string `json:"daemon_id"`
		}{deviceIdentity.DaemonID}),
	}); err != nil {
		return fmt.Errorf("send daemon hello: %w", err)
	}
	for {
		command, err := stream.Receive(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return err
		}
		if err := d.handleConnectionCommand(ctx, connectionCtx, stream, dispatch, command); err != nil {
			return err
		}
	}
}

// connectionHello builds the signed hello that opens a Gateway connection from
// the retained Registrations, Assignments and active Operations.
func (d *Daemon) connectionHello(ctx context.Context, deviceIdentity transport.Identity) (hello transport.Hello, err error) {
	knownRegistrations, err := d.registrations.List(ctx)
	if err != nil {
		return transport.Hello{}, fmt.Errorf("load Local Runtime Registrations: %w", err)
	}
	assignedRunners, err := d.assignments.List(ctx)
	if err != nil {
		return transport.Hello{}, fmt.Errorf("load Agent Runtime Assignments: %w", err)
	}
	if assignedRunners == nil {
		assignedRunners = []assignment.Record{}
	}
	agentRunners, err := json.Marshal(assignedRunners)
	if err != nil {
		return transport.Hello{}, fmt.Errorf("encode Agent Runner snapshots: %w", err)
	}
	activeOperations, err := d.ledger.Active(ctx)
	if err != nil {
		return transport.Hello{}, fmt.Errorf("load active Operation snapshots: %w", err)
	}
	nonce, err := connectionNonce()
	if err != nil {
		return transport.Hello{}, err
	}
	runtimes, runtimeDiagnostics, runtimeObservations := d.runtimeInventory()
	hello = transport.Hello{
		ProtocolVersion:    d.protocolVersion,
		RunnerID:           d.computerID,
		ConnectionNonce:    nonce,
		Identity:           deviceIdentity,
		SentAt:             time.Now().UTC(),
		DisplayName:        d.displayName,
		Capacity:           d.capacity,
		Runtimes:           runtimes,
		RuntimeDiagnostics: runtimeDiagnostics,
		WorkspaceGrants:    append(json.RawMessage(nil), d.workspaceGrants...),
		Capabilities:       d.capabilities(),
		Registrations:      d.enabledRegistrationObservations(mergeRegistrationObservations(runtimeObservations, registrationObservations(knownRegistrations))),
		AgentRunners:       agentRunners,
		ActiveOperations:   activeOperations,
	}
	hello.Signature, err = deviceIdentity.Sign(transport.IdentityProofPayload(hello))
	if err != nil {
		return transport.Hello{}, err
	}
	return hello, nil
}

// handleConnectionCommand applies one Gateway command on the live connection.
// An error ends the connection.
func (d *Daemon) handleConnectionCommand(ctx, connectionCtx context.Context, stream transport.Stream, dispatch *commandDispatcher, command protocol.Command) error {
	switch command.Type {
	case protocol.CommandRegistrationSnapshot:
		if err := dispatch.awaitAll(); err != nil {
			return err
		}
		if err := d.applyRegistrationSnapshot(ctx, stream, command); err != nil {
			return err
		}
	case protocol.CommandRunnerWelcome:
		if err := d.acceptRunnerWelcome(ctx, connectionCtx, stream, command); err != nil {
			return err
		}
	case protocol.CommandRunnerReconciled:
		if !d.welcomeSeen || command.ConnectionEpoch != d.connectionEpoch || command.RunnerID != d.computerID {
			return errors.New("Reconciliation receipt uses a stale connection epoch")
		}
		d.gatewayStateMu.Lock()
		d.reconciled = true
		d.gatewayStateMu.Unlock()
	case protocol.CommandOperationPrepare:
		if !d.welcomeSeen || command.ConnectionEpoch != d.connectionEpoch {
			return errors.New("Operation preparation uses a stale connection epoch")
		}
		if err := dispatch.route(command, func() error {
			return d.handleOperationPrepare(connectionCtx, stream, command)
		}); err != nil {
			return err
		}
	case protocol.CommandProviderPrepare:
		if !d.welcomeSeen || command.ConnectionEpoch != d.connectionEpoch {
			return errors.New("Provider preparation uses a stale connection epoch")
		}
		if err := dispatch.route(command, func() error {
			return d.handleProviderPrepare(connectionCtx, stream, command)
		}); err != nil {
			return err
		}
	case protocol.CommandSessionCompact:
		if !d.welcomeSeen || command.ConnectionEpoch != d.connectionEpoch {
			return errors.New("Session compaction uses a stale connection epoch")
		}
		if err := dispatch.route(command, func() error {
			return d.handleSessionCompact(connectionCtx, stream, command)
		}); err != nil {
			return err
		}
	case protocol.CommandComputerToolCall:
		if !d.welcomeSeen || command.ConnectionEpoch != d.connectionEpoch {
			return errors.New("Computer tool connection authority is stale")
		}
		// A synthetic dispatch key serializes one Live session without occupying
		// an AlterEgo's Context or starting a Runtime.
		command.ExecutionContextKey = "live-tools:" + command.AgentID
		dispatch.submit(command, func() error { return d.handleComputerTool(connectionCtx, stream, command) })
	case protocol.CommandModelInvoke:
		if !d.welcomeSeen || command.ConnectionEpoch != d.connectionEpoch {
			return errors.New("Model invocation uses a stale connection epoch")
		}
		// It has no Context, so it bypasses the Context dispatch queues; the
		// handler only admits and starts the call.
		if err := d.handleModelInvoke(connectionCtx, stream, command); err != nil {
			return err
		}
	case protocol.CommandOperationStart:
		if !d.welcomeSeen {
			return errors.New("operation uses a stale connection epoch")
		}
		slog.Info("runner.operation.start", "phase", "received", "operation_id", command.OperationID,
			"received_at_unix_ms", time.Now().UnixMilli())
		if err := dispatch.route(command, func() error {
			return d.handleOperationStart(ctx, stream, command)
		}); err != nil {
			return err
		}
	case protocol.CommandOperationInput:
		if !d.welcomeSeen {
			return errors.New("Operation input arrived before Runner Gateway welcome")
		}
		if !dispatch.followOperation(command, func() error { return d.handleOperationInput(ctx, stream, command) }) {
			if err := d.handleOperationInput(ctx, stream, command); err != nil {
				return err
			}
		}
	case protocol.CommandAgentRunnerEnsure, protocol.CommandAgentRunnerRemove:
		if !d.welcomeSeen || command.ConnectionEpoch != d.connectionEpoch {
			return errors.New("Agent Runner command uses a stale connection epoch")
		}
		if err := dispatch.awaitAgent(command.TenantID, command.AgentID); err != nil {
			return err
		}
		if err := d.handleAgentRunnerCommand(ctx, stream, command); err != nil {
			return err
		}
	case protocol.CommandAgentCLICredentialPut:
		if !d.welcomeSeen || command.ConnectionEpoch != d.connectionEpoch {
			return errors.New("Agent CLI credential command uses a stale connection epoch")
		}
		if err := dispatch.awaitAgent(command.TenantID, command.AgentID); err != nil {
			return err
		}
		if err := d.handleAgentCLICredentialPut(ctx, stream, command); err != nil {
			return err
		}
	case protocol.CommandDebugInspect:
		if !d.welcomeSeen || command.ConnectionEpoch != d.connectionEpoch {
			return errors.New("Debug inspection uses a stale connection epoch")
		}
		if err := dispatch.route(command, func() error {
			return d.handleDebugInspect(dispatch.ctx, stream, command)
		}); err != nil {
			return err
		}
	case protocol.CommandCapabilitySkillsScan:
		if !d.welcomeSeen || command.ConnectionEpoch != d.connectionEpoch {
			return errors.New("Local Skill command uses a stale connection epoch")
		}
		if err := d.handleLocalSkillCommand(ctx, stream, command); err != nil {
			return err
		}
	case protocol.CommandCapabilityBrowserConnect:
		if !d.welcomeSeen || command.ConnectionEpoch != d.connectionEpoch {
			return errors.New("Browser connection command uses a stale connection epoch")
		}
		// Verifying a token can take most of a minute. Operation
		// commands, including cancellation, must not wait behind it.
		go func() {
			if err := d.handleBrowserCommand(connectionCtx, stream, command); err != nil {
				slog.Warn("browser connection outcome was not sent", "error", err)
			}
		}()
	case protocol.CommandCapabilityComputerPermission:
		if !d.welcomeSeen || command.ConnectionEpoch != d.connectionEpoch {
			return errors.New("Computer permission command uses a stale connection epoch")
		}
		// Starting CuaDriver or waiting on the Desktop app takes seconds;
		// Operation commands must not wait behind it.
		go func() {
			if err := d.handleComputerPermissionCommand(connectionCtx, stream, command); err != nil {
				slog.Warn("computer permission outcome was not sent", "error", err)
			}
		}()
	case protocol.CommandOperationCancel:
		if !dispatch.followOperation(command, func() error { return d.handleOperationCancel(command) }) {
			if err := d.handleOperationCancel(command); err != nil {
				return err
			}
		}
	case protocol.CommandOperationAck:
		if err := d.ledger.Acknowledge(ctx, operationIdentity(command), command.ThroughSequence); err != nil {
			return err
		}
	default:
		slog.Warn("runner.gateway.unknown_command")
		return errors.New("Unknown Runner Gateway command type")
	}
	return nil
}

// acceptRunnerWelcome activates the connection once the Gateway welcomes it.
func (d *Daemon) acceptRunnerWelcome(ctx, connectionCtx context.Context, stream transport.Stream, command protocol.Command) error {
	if command.ConnectionEpoch == 0 {
		return errors.New("Runner Gateway welcome omitted connection epoch")
	}
	d.connectionEpoch = command.ConnectionEpoch
	d.recordWelcomedEpoch(command.ConnectionEpoch)
	contentURL := command.ContextContentURL
	d.contentURL.Store(&contentURL)
	d.welcomeSeen = true
	d.welcomedAt = time.Now()
	if d.selfUpdate != nil {
		d.selfUpdate.WelcomeAccepted(ctx, command.TargetRelease)
	}
	if p, ok := d.localTools.(localToolPrewarmer); ok {
		// Once per process, off the command path. ctx, not connectionCtx,
		// so a reconnect neither cancels nor repeats the discovery.
		d.prewarmOnce.Do(func() { go p.Prewarm(ctx) })
	}
	d.setGatewayState("connected")
	if err := d.activateStreamAndReplay(ctx, stream, command.ReconcileOperationIDs); err != nil {
		return err
	}
	go d.heartbeatLoop(connectionCtx, stream, command.HeartbeatIntervalMs)
	return nil
}

func (d *Daemon) GatewayState() string {
	d.gatewayStateMu.RLock()
	defer d.gatewayStateMu.RUnlock()
	return d.gatewayState
}

func (d *Daemon) setGatewayState(state string) {
	d.gatewayStateMu.Lock()
	d.gatewayState = state
	if state != "connected" {
		d.reconciled = false
	}
	d.gatewayStateMu.Unlock()
}

func (d *Daemon) recordWelcomedEpoch(epoch uint64) {
	d.gatewayStateMu.Lock()
	d.welcomedEpochs[epoch] = true
	d.gatewayStateMu.Unlock()
}

func (d *Daemon) welcomedEpoch(epoch uint64) bool {
	d.gatewayStateMu.RLock()
	defer d.gatewayStateMu.RUnlock()
	return d.welcomedEpochs[epoch]
}

func (d *Daemon) Reconciled() bool {
	d.gatewayStateMu.RLock()
	defer d.gatewayStateMu.RUnlock()
	return d.reconciled && d.gatewayState == "connected"
}

func (d *Daemon) UpdateRuntimeInventory(ctx context.Context, runtimes []string, diagnostics json.RawMessage, observations []transport.RegistrationObservation) error {
	if err := validateRuntimeInventoryScope(d.enabledRuntimes, runtimes, diagnostics, observations); err != nil {
		return err
	}
	d.inventoryMu.Lock()
	d.runtimes = append([]string(nil), runtimes...)
	d.runtimeDiagnostics = append(json.RawMessage(nil), diagnostics...)
	if observations != nil {
		d.runtimeObservations = append([]transport.RegistrationObservation(nil), observations...)
	}
	d.diagnosticsRevision++
	revision := d.diagnosticsRevision
	d.inventoryMu.Unlock()

	d.connectionMu.Lock()
	stream := d.diagnosticsStream
	d.connectionMu.Unlock()
	if stream == nil {
		return nil
	}
	return stream.Send(ctx, protocol.Event{
		Type: protocol.EventRuntimeDiagnostics, ProtocolVersion: d.protocolVersion,
		RunnerID: d.computerID, Revision: revision, SentAt: time.Now().UTC(),
		Payload: append(json.RawMessage(nil), diagnostics...),
	})
}

func (d *Daemon) runtimeInventory() ([]string, json.RawMessage, []transport.RegistrationObservation) {
	d.inventoryMu.RLock()
	defer d.inventoryMu.RUnlock()
	return append([]string(nil), d.runtimes...), append(json.RawMessage(nil), d.runtimeDiagnostics...), append([]transport.RegistrationObservation(nil), d.runtimeObservations...)
}

func (d *Daemon) clearDiagnosticsStream(stream transport.Stream) {
	d.connectionMu.Lock()
	if d.diagnosticsStream == stream {
		d.diagnosticsStream = nil
	}
	d.connectionMu.Unlock()
}

// capabilities lists the host features this Computer has; everything else is
// part of protocol 2 itself.
func (d *Daemon) capabilities() []string {
	// Every platform answers computer_permission: a non-macOS Computer
	// reports that it has no permissions to grant.
	capabilities := []string{wire.CapabilityComputerPermissions}
	if d.browserConnections != nil {
		capabilities = append(capabilities, wire.CapabilityBrowserConnection)
	}
	return capabilities
}

func (d *Daemon) handleLocalSkillCommand(ctx context.Context, stream transport.Stream, command protocol.Command) error {
	if d.localSkills == nil {
		return errors.New("Local Skill catalog is unavailable")
	}
	outcome, err := d.localSkills.Handle(ctx, command.Payload)
	if err != nil {
		return err
	}
	var header struct {
		Outcome string `json:"outcome"`
	}
	if err := json.Unmarshal(outcome, &header); err != nil || header.Outcome == "" {
		return errors.New("Local Skill catalog returned an invalid outcome")
	}
	route := protocol.EventCapabilitySkillsScanned
	if header.Outcome == wire.OutcomeFailed {
		route = protocol.EventCapabilitySkillsFailed
	}
	return stream.Send(ctx, protocol.Event{
		Type: route, ProtocolVersion: command.ProtocolVersion,
		CommandID: command.CommandID, RunnerID: command.RunnerID,
		TenantID: command.TenantID, OwnerActorID: command.OwnerActorID,
		ConnectionEpoch: command.ConnectionEpoch, SentAt: time.Now().UTC(), Payload: outcome,
	})
}

func mergeRegistrationObservations(discovered, retained []transport.RegistrationObservation) []transport.RegistrationObservation {
	values := make(map[string]transport.RegistrationObservation, len(discovered)+len(retained))
	for _, observation := range retained {
		key := observation.TenantID + "\x00" + observation.OwnerActorID + "\x00" + observation.ProviderType
		values[key] = observation
	}
	for _, observation := range discovered {
		key := observation.TenantID + "\x00" + observation.OwnerActorID + "\x00" + observation.ProviderType
		if retainedObservation, ok := values[key]; ok {
			// Server snapshots and local probes have independent counters. Use
			// the current probe's state, advancing past the retained high-water
			// mark instead of replaying a stale unavailable/offline observation.
			if observation.Revision <= retainedObservation.Revision {
				observation.Revision = retainedObservation.Revision + 1
			}
		}
		values[key] = observation
	}
	result := make([]transport.RegistrationObservation, 0, len(values))
	for _, observation := range values {
		result = append(result, observation)
	}
	sort.Slice(result, func(i, j int) bool {
		left := result[i].TenantID + "\x00" + result[i].OwnerActorID + "\x00" + result[i].ProviderType
		right := result[j].TenantID + "\x00" + result[j].OwnerActorID + "\x00" + result[j].ProviderType
		return left < right
	})
	return result
}

// Losing a Gateway session that lasted this long restarts backoff at the
// shortest delay; quicker rejections keep backing off.
const stableGatewayConnection = time.Minute

// A restarting Agent Service is back within seconds; escalating backoff from
// refused dials would delay the first user message after the deploy.
const gatewayRestartRedialWindow = 2 * time.Minute

func defaultRetryDelay(override func(int) time.Duration) func(int) time.Duration {
	if override != nil {
		return override
	}
	return func(attempt int) time.Duration {
		if attempt < 0 {
			attempt = 0
		}
		if attempt > 5 {
			attempt = 5
		}
		ceiling := time.Second * time.Duration(1<<attempt)
		// Jitter keeps Computers that lose a shared link from redialing in lockstep.
		return ceiling/2 + mathrand.N(ceiling/2+1) //nolint:gosec // reconnect jitter is not security sensitive
	}
}

func (d *Daemon) replayRetainedEvents(ctx context.Context, stream transport.Stream, operationIDs []string) error {
	events, err := d.ledger.Replay(ctx, operationIDs)
	if err != nil {
		return err
	}
	for _, event := range events {
		if err := stream.Send(ctx, event); err != nil {
			return err
		}
	}
	return nil
}

func (d *Daemon) activateStreamAndReplay(ctx context.Context, stream transport.Stream, operationIDs []string) error {
	d.connectionMu.Lock()
	defer d.connectionMu.Unlock()
	d.diagnosticsStream = stream
	d.operationStream = stream
	return d.replayRetainedEvents(ctx, stream, operationIDs)
}

// deliverRecordedOperationEvent reports how long the delivery waited for the
// connection lock separately from the stream send, for event timing logs.
func (d *Daemon) deliverRecordedOperationEvent(ctx context.Context, event protocol.Event) (connectionLockWait, send time.Duration) {
	lockStartedAt := time.Now()
	d.connectionMu.Lock()
	defer d.connectionMu.Unlock()
	connectionLockWait = time.Since(lockStartedAt)
	if d.operationStream == nil {
		return connectionLockWait, 0
	}
	sendStartedAt := time.Now()
	_ = d.operationStream.Send(ctx, event)
	return connectionLockWait, time.Since(sendStartedAt)
}

func (d *Daemon) heartbeatLoop(ctx context.Context, stream transport.Stream, intervalMs int64) {
	if intervalMs < 1000 {
		return
	}
	ticker := time.NewTicker(time.Duration(intervalMs) * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			_ = stream.Send(ctx, protocol.Event{
				Type: protocol.EventRunnerHeartbeat, ProtocolVersion: d.protocolVersion,
				RunnerID: d.computerID, SentAt: now.UTC(), Payload: mustJSON(struct {
					ActiveOperationIDs []string `json:"active_operation_ids"`
				}{d.activeOperationIDs()}),
			})
		}
	}
}

func connectionNonce() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("generate connection nonce: %w", err)
	}
	return "nonce-" + hex.EncodeToString(value), nil
}

func (d *Daemon) applyRegistrationSnapshot(ctx context.Context, stream transport.Stream, command protocol.Command) error {
	d.admissionMu.Lock()
	defer d.admissionMu.Unlock()
	var snapshot []transport.RuntimeRegistration
	if err := json.Unmarshal(command.Payload, &snapshot); err != nil {
		return d.finishFailure(ctx, stream, command, operationCodeExecutionFailed, fmt.Sprintf("invalid registration snapshot: %v", err))
	}
	for _, item := range snapshot {
		if !d.runtimeEnabled(item.Observation.ProviderType) {
			return d.finishFailure(ctx, stream, command, operationCodeRuntimeNotEnabled, "Runtime is not enabled on this Computer")
		}
	}
	d.authorityRevision++
	for _, item := range snapshot {
		observation := registration.Observation{
			RegistrationID: item.RegistrationID,
			Key: registration.Key{
				DaemonID: d.daemonID, TenantID: item.Observation.TenantID,
				OwnerActorID: item.Observation.OwnerActorID, ProviderType: item.Observation.ProviderType,
			},
			Status: registration.Status(item.Observation.Status), Revision: item.Observation.Revision,
			Capabilities: append([]string{}, item.Observation.Capabilities...),
		}
		if _, err := d.registrations.Apply(ctx, observation); err != nil {
			return d.finishFailure(ctx, stream, command, operationCodeExecutionFailed, err.Error())
		}
	}
	payload := mustJSON(struct {
		Count int `json:"count"`
	}{len(snapshot)})
	return stream.Send(ctx, protocol.Event{
		Type:            protocol.EventRuntimeObserved,
		CommandID:       command.CommandID,
		ProtocolVersion: d.protocolVersion,
		ConnectionEpoch: command.ConnectionEpoch,
		SentAt:          time.Now().UTC(),
		Payload:         payload,
	})
}

func registrationObservations(items []registration.Observation) []transport.RegistrationObservation {
	result := make([]transport.RegistrationObservation, 0, len(items))
	for _, item := range items {
		result = append(result, transport.RegistrationObservation{
			TenantID:           item.Key.TenantID,
			OwnerActorID:       item.Key.OwnerActorID,
			ProviderType:       item.Key.ProviderType,
			Status:             string(item.Status),
			Revision:           item.Revision,
			Capabilities:       append([]string{}, item.Capabilities...),
			RuntimeDiagnostics: json.RawMessage(`{}`),
		})
	}
	return result
}
