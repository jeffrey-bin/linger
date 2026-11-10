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

// BrowserConnections owns the private everyday-browser records. Only the
// dedicated execute browser_connect command reaches it.
type BrowserConnections interface {
	BrowserConnection(ctx context.Context, tenantID, ownerActorID, action, profile, token string) (localtools.BrowserStatus, error)
}

// ComputerOwner is a tenant owner from this Computer's Gateway credential.
type ComputerOwner struct{ TenantID, OwnerActorID string }

func (d *Daemon) handleBrowserCommand(ctx context.Context, stream transport.Stream, command protocol.Command) error {
	var request struct {
		RunnerID       string    `json:"runner_id"`
		TenantID       string    `json:"tenant_id"`
		OwnerActorID   string    `json:"owner_actor_id"`
		ExpiresAt      time.Time `json:"expires_at"`
		Action         string    `json:"action"`
		Profile        string    `json:"profile"`
		ExtensionToken string    `json:"extension_token"`
	}
	if err := json.Unmarshal(command.Payload, &request); err != nil {
		return errors.New("invalid browser connection command")
	}
	route := protocol.EventCapabilityBrowserConnected
	result := map[string]any{
		"type": wire.TypeExecuted, "kind": wire.KindBrowserConnect,
		"protocol_version": command.ProtocolVersion, "command_id": command.CommandID, "runner_id": command.RunnerID,
		"tenant_id": request.TenantID, "owner_actor_id": request.OwnerActorID, "connection_epoch": command.ConnectionEpoch,
		"expires_at": request.ExpiresAt, "action": request.Action,
	}
	fail := func(code, message string, retryable bool) {
		route = protocol.EventCapabilityBrowserFailed
		result["outcome"] = wire.OutcomeFailed
		result["error"] = map[string]any{"code": code, "message": message, "retryable": retryable}
	}
	switch {
	case request.RunnerID != d.computerID || !d.ownedBy(request.TenantID, request.OwnerActorID):
		fail("BROWSER_CONNECTION_FORBIDDEN", "this Computer does not belong to the owner", false)
	case !request.ExpiresAt.After(time.Now()):
		fail("BROWSER_CONNECTION_EXPIRED", "the browser connection request expired; try again", true)
	case d.browserConnections == nil:
		fail("BROWSER_CONNECTION_UNSUPPORTED", "this Computer cannot connect an everyday browser", false)
	default:
		// The Gateway stops waiting at expires_at. Work past it would store a
		// token after the owner already saw the request fail.
		commandCtx, cancel := context.WithDeadline(ctx, request.ExpiresAt)
		status, err := d.browserConnections.BrowserConnection(commandCtx, request.TenantID, request.OwnerActorID, request.Action, request.Profile, request.ExtensionToken)
		cancel()
		var typed *localtools.BrowserCommandError
		switch {
		case errors.As(err, &typed):
			fail(typed.Code, typed.Message, typed.Retryable)
		case err != nil:
			// Internal errors can name local paths; the owner sees a generic one.
			slog.Warn("browser connection failed", "action", request.Action, "error", err)
			fail("BROWSER_CONNECTION_FAILED", "the browser connection could not be saved on this Computer", true)
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

func (d *Daemon) ownedBy(tenantID, ownerActorID string) bool {
	for _, owner := range d.owners {
		if owner.TenantID == tenantID && owner.OwnerActorID == ownerActorID {
			return true
		}
	}
	return false
}
