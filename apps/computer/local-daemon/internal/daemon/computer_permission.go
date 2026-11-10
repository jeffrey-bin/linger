package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/localtools"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

// ComputerPermissions reports and requests this Computer's macOS privacy
// permissions. Only the dedicated execute computer_permission command
// reaches it.
type ComputerPermissions interface {
	ComputerPermission(ctx context.Context, action, subject, permission string) (localtools.ComputerPermissionStatus, error)
}

func (d *Daemon) handleComputerPermissionCommand(ctx context.Context, stream transport.Stream, command protocol.Command) error {
	var request struct {
		RunnerID     string    `json:"runner_id"`
		TenantID     string    `json:"tenant_id"`
		OwnerActorID string    `json:"owner_actor_id"`
		ExpiresAt    time.Time `json:"expires_at"`
		Action       string    `json:"action"`
		Subject      string    `json:"subject"`
		Permission   string    `json:"permission"`
	}
	if err := json.Unmarshal(command.Payload, &request); err != nil {
		return errors.New("invalid computer permission command")
	}
	route := protocol.EventCapabilityComputerPermissionSucceeded
	result := map[string]any{
		"type": wire.TypeExecuted, "kind": wire.KindComputerPermission,
		"protocol_version": command.ProtocolVersion, "command_id": command.CommandID, "runner_id": command.RunnerID,
		"tenant_id": request.TenantID, "owner_actor_id": request.OwnerActorID, "connection_epoch": command.ConnectionEpoch,
		"expires_at": request.ExpiresAt, "action": request.Action,
	}
	fail := func(code, message string, retryable bool) {
		route = protocol.EventCapabilityComputerPermissionFailed
		result["outcome"] = wire.OutcomeFailed
		result["error"] = map[string]any{"code": code, "message": message, "retryable": retryable}
	}
	switch {
	case request.RunnerID != d.computerID || !d.ownedBy(request.TenantID, request.OwnerActorID):
		// The Agent Service routes only the Computer's own owners here, so a
		// mismatch is a malformed request that no retry fixes.
		fail("COMPUTER_PERMISSION_INVALID", "this Computer does not belong to the owner", false)
	case !request.ExpiresAt.After(time.Now()):
		fail("COMPUTER_PERMISSION_TIMEOUT", "the permission request expired; try again", true)
	case d.computerPermissions == nil:
		fail("COMPUTER_PERMISSION_UNSUPPORTED", "this Computer cannot manage system permissions", false)
	default:
		// The Gateway stops waiting at expires_at; a prompt raised after it
		// would answer nobody.
		commandCtx, cancel := context.WithDeadline(ctx, request.ExpiresAt)
		status, err := d.computerPermissions.ComputerPermission(commandCtx, request.Action, request.Subject, request.Permission)
		expired := commandCtx.Err() != nil
		cancel()
		var typed *localtools.ComputerPermissionError
		switch {
		case errors.As(err, &typed):
			fail(typed.Code, typed.Message, typed.Retryable)
		case err != nil && expired:
			fail("COMPUTER_PERMISSION_TIMEOUT", "the Computer did not finish the permission request in time; try again", true)
		case err != nil:
			// Internal errors can name local paths; the owner sees a generic one.
			slog.Warn("computer_permission.failed", "action", request.Action, "error", err)
			fail("COMPUTER_PERMISSION_UNAVAILABLE", "the Computer could not read or request its permissions", true)
		default:
			result["outcome"] = wire.OutcomeSucceeded
			result["status"] = status
		}
	}
	payload, err := json.Marshal(result)
	if err != nil {
		return err
	}
	return stream.Send(ctx, protocol.Event{
		Type: route, ProtocolVersion: command.ProtocolVersion,
		CommandID: command.CommandID, RunnerID: command.RunnerID,
		TenantID: request.TenantID, OwnerActorID: request.OwnerActorID,
		ConnectionEpoch: command.ConnectionEpoch, SentAt: time.Now().UTC(), Payload: payload,
	})
}
