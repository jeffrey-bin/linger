package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/clicredential"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
)

// agentCLICredentialPayload is the wire payload. Its token must never reach a
// log, an error message, or the Operation ledger.
type agentCLICredentialPayload struct {
	Profile struct {
		URL      string `json:"url"`
		TenantID string `json:"tenant_id"`
		AgentID  string `json:"agent_id"`
	} `json:"profile"`
	AccessToken string `json:"access_token"`
}

func (d *Daemon) handleAgentCLICredentialPut(ctx context.Context, stream transport.Stream, command protocol.Command) error {
	failure := func(message string, retryable bool) error {
		return stream.Send(ctx, agentCLICredentialEvent(command, protocol.EventAgentCLICredentialFailed, mustJSON(map[string]any{
			"error": map[string]any{"code": "AGENT_CLI_CREDENTIAL_FAILED", "message": message, "retryable": retryable},
		})))
	}
	if d.cliCredentials == nil {
		return failure("TeamHub CLI credential store is unavailable", false)
	}
	if err := d.validateActiveRegistration(ctx, command); err != nil {
		return failure(err.Error(), false)
	}
	if err := d.liveAgentRunnerAssignment(ctx, command); err != nil {
		return failure(err.Error(), false)
	}
	var payload agentCLICredentialPayload
	if err := json.Unmarshal(command.Payload, &payload); err != nil {
		// Decoder errors can echo fragments of the input, so report a fixed message.
		return failure("TeamHub CLI credential command is invalid", false)
	}
	if payload.Profile.TenantID != command.TenantID || payload.Profile.AgentID != command.AgentID {
		return failure("TeamHub CLI credential profile does not match its Agent", false)
	}
	result, err := d.cliCredentials.Put(command.TenantID, command.AgentID, clicredential.Profile{
		URL: payload.Profile.URL, TenantID: payload.Profile.TenantID, AgentID: payload.Profile.AgentID,
	}, payload.AccessToken, command.AssignmentRevision)
	if err != nil {
		return failure(err.Error(), clicredential.Retryable(err))
	}
	slog.Info("runner.cli_credential.stored", "command_id", command.CommandID, "agent_id", command.AgentID,
		"assignment_revision", command.AssignmentRevision)
	return stream.Send(ctx, agentCLICredentialEvent(command, protocol.EventAgentCLICredentialStored, mustJSON(map[string]any{
		"sha256": result.SHA256,
	})))
}

// liveAgentRunnerAssignment requires the Runner assignment this command names
// to exist and not be removed.
func (d *Daemon) liveAgentRunnerAssignment(ctx context.Context, command protocol.Command) error {
	records, err := d.assignments.List(ctx)
	if err != nil {
		return err
	}
	for _, record := range records {
		if record.TenantID == command.TenantID && record.AgentID == command.AgentID &&
			record.RunnerID == command.RunnerID && record.RegistrationID == command.RegistrationID &&
			record.State != "removed" {
			return nil
		}
	}
	return errors.New("Agent Runner assignment is unavailable")
}

func agentCLICredentialEvent(command protocol.Command, eventType string, payload json.RawMessage) protocol.Event {
	return protocol.Event{
		Type: eventType, ProtocolVersion: command.ProtocolVersion, CommandID: command.CommandID,
		RunnerID: command.RunnerID, TenantID: command.TenantID, AgentID: command.AgentID,
		RegistrationID: command.RegistrationID, AssignmentRevision: command.AssignmentRevision,
		ConnectionEpoch: command.ConnectionEpoch, RunnerRevision: command.RunnerRevision,
		Payload: payload,
	}
}
