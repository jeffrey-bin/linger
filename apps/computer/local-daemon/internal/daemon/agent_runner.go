package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/assignment"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/registration"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/redact"
)

type agentRunnerValidator interface {
	ValidateAgentRunner(context.Context, protocol.Command, json.RawMessage) error
}

func (d *Daemon) handleAgentRunnerCommand(ctx context.Context, stream transport.Stream, command protocol.Command) error {
	if command.Type == protocol.CommandAgentRunnerEnsure {
		validator, ok := d.operationResolver.(agentRunnerValidator)
		if !ok {
			return errors.New("local Agent Runner validator is unavailable")
		}
		if err := validator.ValidateAgentRunner(ctx, command, command.Payload); err != nil {
			slog.Warn("Agent Runner validation failed", "agent_id", command.AgentID, "command_id", command.CommandID, "error", redact.Text(err.Error()))
			return stream.Send(ctx, withOperationIdentity(protocol.Event{
				Type: protocol.EventAgentRunnerFailed,
			}, command))
		}
	}
	var payload struct {
		Runtime          json.RawMessage `json:"runtime"`
		WorkspaceGrantID string          `json:"workspace_grant_id"`
	}
	if len(command.Payload) > 0 {
		if err := json.Unmarshal(command.Payload, &payload); err != nil {
			return err
		}
	}
	d.admissionMu.Lock()
	d.authorityRevision++
	record, err := d.assignments.Apply(ctx, assignment.Command{
		Type: command.Type, CommandID: command.CommandID, RunnerID: command.RunnerID,
		TenantID: command.TenantID, AgentID: command.AgentID,
		RegistrationID: command.RegistrationID, AssignmentRevision: command.AssignmentRevision,
		RunnerRevision: command.RunnerRevision, Runtime: payload.Runtime,
		WorkspaceGrantID: payload.WorkspaceGrantID,
	}, os.Getpid())
	if err != nil {
		d.admissionMu.Unlock()
		return err
	}
	d.activeMu.Lock()
	if command.Type == protocol.CommandAgentRunnerEnsure {
		delete(d.locallyStopped, command.AgentID)
	}
	d.activeMu.Unlock()
	d.admissionMu.Unlock()
	if command.Type == protocol.CommandAgentRunnerRemove {
		if err := d.stopAgentOperations(ctx, command.AgentID, "Agent Runner removed"); err != nil {
			return err
		}
		// Removal deletes the Agent's TeamHub CLI credentials. A failure keeps the
		// command failing so the Runner is not reported removed with a live token.
		if d.cliCredentials != nil {
			if err := d.cliCredentials.RemoveAgent(command.TenantID, command.AgentID); err != nil {
				slog.Error("runner.cli_credential.remove_failed", "agent_id", command.AgentID, "error", err)
				return err
			}
		}
		if d.contextViews != nil {
			d.contextViews.ForgetAgent(command.TenantID, command.AgentID)
		}
	}
	eventType := protocol.EventAgentRunnerReady
	var report json.RawMessage
	if record.State == "removed" {
		eventType = protocol.EventAgentRunnerRemoved
	} else {
		report = d.storedCLICredentialReport(command)
	}
	return stream.Send(ctx, protocol.Event{
		Type: eventType, ProtocolVersion: command.ProtocolVersion, CommandID: command.CommandID,
		RunnerID: command.RunnerID, TenantID: command.TenantID, AgentID: command.AgentID,
		RegistrationID: record.RegistrationID, AssignmentRevision: record.AssignmentRevision,
		ConnectionEpoch: command.ConnectionEpoch, RunnerRevision: command.RunnerRevision,
		Payload: report,
	})
}

// storedCLICredentialReport tells the Agent Service which CLI credential this
// Computer holds for the Agent and for which Runtime Assignment, so it issues
// one only when none is held for the current assignment. A credential that
// cannot be read is reported as missing.
func (d *Daemon) storedCLICredentialReport(command protocol.Command) json.RawMessage {
	if d.cliCredentials == nil {
		return nil
	}
	stored, ok, err := d.cliCredentials.Current(command.TenantID, command.AgentID)
	if err != nil {
		slog.Warn("runner.cli_credential.report_failed", "agent_id", command.AgentID, "error", redact.Text(err.Error()))
		return nil
	}
	if !ok {
		return nil
	}
	return mustJSON(map[string]any{"cli_credential": map[string]any{
		"sha256": stored.SHA256, "assignment_revision": stored.AssignmentRevision, "profile": stored.Profile,
	}})
}

func (d *Daemon) validateActiveRegistration(ctx context.Context, command protocol.Command) error {
	if command.RegistrationID == "" {
		return errors.New("Context command lacks a Local Runtime Registration")
	}
	items, err := d.registrations.List(ctx)
	if err != nil {
		return err
	}
	for _, item := range items {
		if item.RegistrationID != command.RegistrationID {
			continue
		}
		if item.Key.TenantID != command.TenantID {
			return errors.New("Context command Registration tenant binding is invalid")
		}
		if !d.runtimeEnabled(item.Key.ProviderType) {
			return errors.New("Runtime is not enabled on this Computer")
		}
		if item.Status != registration.StatusOnline {
			return fmt.Errorf("Context command Local Runtime Registration is %s", item.Status)
		}
		return nil
	}
	return errors.New("Context command Local Runtime Registration is unavailable")
}

func (d *Daemon) StopAgentRunner(ctx context.Context, agentID string) error {
	return d.stopAgentOperations(ctx, agentID, "Agent Runner stopped from local control")
}

func (d *Daemon) stopAgentOperations(ctx context.Context, agentID, reason string) error {
	d.admissionMu.Lock()
	d.cancelPreparedOperations(agentID)
	d.cancelProviderPrepares(providerPrepareForAgent(agentID), "agent_runner_stop")
	compactions := d.cancelSessionCompacts(sessionCompactForAgent(agentID), "agent_runner_stop")
	d.activeMu.Lock()
	d.locallyStopped[agentID] = true
	for _, active := range d.activeOperations {
		if active.identity.AgentID != agentID || active.reason != "" {
			continue
		}
		active.reason = reason
		active.cancel()
	}
	d.activeMu.Unlock()
	d.admissionMu.Unlock()
	// A parked process of the Agent is a live writer. An unconfirmed stop keeps
	// the command failing so the Runner is not reported stopped or removed
	// while it may still write.
	if _, err := native.StopParkedResidentsForAgent(agentID); err != nil {
		slog.Error("runner.resident.stop_failed", "agent_id", agentID, "error", err)
		return err
	}
	waitSessionCompacts(ctx, compactions)
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		d.activeMu.Lock()
		active := false
		for _, operation := range d.activeOperations {
			if operation.identity.AgentID == agentID {
				active = true
				break
			}
		}
		d.activeMu.Unlock()
		if !active {
			return nil
		}
		select {
		case <-ctx.Done():
			return context.Cause(ctx)
		case <-ticker.C:
		}
	}
}
