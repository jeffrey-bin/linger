package app

import (
	"context"
	"crypto/sha256"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
	api "github.com/simplexai-labs/linger/contracts-go/teamhubagentapi"
)

const browserConnectionPrompt = "Please connect your everyday Chrome so I can continue the browser task. The extension token goes only to your Computer."

// requestAgentBrowserConnection posts a browser_connection card that asks the
// owner of the Agent's Local Computer to connect their everyday Chrome. The
// Computer and its owner come from the Agent's current placement, never from
// the request.
func (a *App) requestAgentBrowserConnection(c *gin.Context) {
	token, ok := a.agentCommandBearer(c)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	auth, err := a.agentAuth.Authorize(ctx, token, "request_browser_connection")
	if a.writeAgentAuthError(c, "request browser connection", err) {
		return
	}
	if auth.Principal == nil {
		a.writeAgentAPIError(c, http.StatusForbidden, api.AgentApiErrorCodeForbidden, "Browser connection requires an Agent identity")
		return
	}
	computerID, ownerID, err := a.agents.LocalComputerPlacement(ctx, auth.TenantID, auth.AgentActorID)
	if errors.Is(err, pgx.ErrNoRows) {
		a.writeAgentAPIError(c, http.StatusConflict, api.AgentApiErrorCodeOperationForbidden, "This Agent does not run on a Local Computer, so it has no everyday Chrome to connect")
		return
	}
	if err != nil {
		a.logger.Error("read browser connection placement", "error", err)
		a.writeAgentAPIError(c, http.StatusServiceUnavailable, api.AgentApiErrorCodeDependencyUnavailable, "Browser connection is temporarily unavailable")
		return
	}
	if a.localComputers == nil {
		a.writeAgentAPIError(c, http.StatusServiceUnavailable, api.AgentApiErrorCodeDependencyUnavailable, "Browser connection is temporarily unavailable")
		return
	}
	status, err := a.localComputers.ConnectLocalBrowser(ctx, roomagent.LocalBrowserConnectionCommand{
		Action: roomagent.LocalBrowserConnectionStatusAction, TenantID: auth.TenantID, OwnerActorID: ownerID, ComputerID: computerID,
	})
	switch {
	case errors.Is(err, roomagent.ErrLocalBrowserUnsupported):
		a.writeAgentAPIError(c, http.StatusConflict, api.AgentApiErrorCodeOperationForbidden, "This Computer must be upgraded before it can use the user's Chrome")
		return
	case errors.Is(err, roomagent.ErrLocalComputerOffline), errors.Is(err, roomagent.ErrLocalComputerNotFound):
		a.writeAgentAPIError(c, http.StatusServiceUnavailable, api.AgentApiErrorCodeDependencyUnavailable, "The Local Computer is offline")
		return
	case err != nil && !errors.Is(err, roomagent.ErrLocalBrowserConnectionFailed):
		// A damaged saved connection fails the read; a new connection replaces it.
		a.logger.Error("read browser connection status", "error", err)
		a.writeAgentAPIError(c, http.StatusServiceUnavailable, api.AgentApiErrorCodeDependencyUnavailable, "Browser connection is temporarily unavailable")
		return
	// An isolated Computer has no everyday Chrome yet; the owner may still
	// connect one, and the Daemon then switches the task to it.
	case err == nil && status.State == "connected":
		c.JSON(http.StatusOK, gin.H{"status": "ready"})
		return
	case err == nil && status.State == "unsupported":
		a.writeAgentAPIError(c, http.StatusConflict, api.AgentApiErrorCodeOperationForbidden, "This Computer must be upgraded before it can use the user's Chrome")
		return
	}
	roomID, err := a.humanConfirmationRoom(ctx, auth, ownerID)
	if err != nil || roomID == "" {
		a.writeAgentAPIError(c, http.StatusForbidden, api.AgentApiErrorCodeForbidden, "The Computer owner has no chat with this Agent to show the browser connection card")
		return
	}
	// The card's result wakes the Agent where the card is. In a Room the owner
	// is not in, that would be another chat, so this chat would never resume.
	if auth.ParticipantTaskID == "" && auth.RoomID != "" && roomID != auth.RoomID {
		a.writeAgentAPIError(c, http.StatusConflict, api.AgentApiErrorCodeOperationForbidden, "The owner of this Computer is not in this chat, so they cannot connect their Chrome here; tell the user the browser task needs the Computer owner")
		return
	}
	digest := sha256.Sum256([]byte(roomID + "\x00" + auth.AgentActorID + "\x00" + computerID))
	// A fresh key allows a new card after a decline; the service reuses a
	// pending card under the Room membership lock.
	result, err := a.typedCards.CreateDecision(ctx, roomID, auth.AgentID, "browser-connection-"+idgen.New("request"), digest[:], typedcard.DecisionCommand{
		Principal: auth.Principal, DeciderActorID: ownerID, AlterEgoTaskID: auth.ParticipantTaskID,
		BrowserConnection: &typedcard.BrowserConnectionDecision{Prompt: browserConnectionPrompt, ComputerID: computerID},
	})
	switch {
	case errors.Is(err, typedcard.ErrAssigneeNotMember), errors.Is(err, typedcard.ErrForbidden), errors.Is(err, typedcard.ErrNotFound), errors.Is(err, typedcard.ErrInvalid):
		a.writeAgentAPIError(c, http.StatusForbidden, api.AgentApiErrorCodeForbidden, "Browser connection cards are unavailable in this chat")
		return
	case err != nil:
		a.logger.Error("create browser connection card", "error", err)
		a.writeAgentAPIError(c, http.StatusServiceUnavailable, api.AgentApiErrorCodeDependencyUnavailable, "Browser connection is temporarily unavailable")
		return
	}
	// The owner may have connected while the card was posted. Settle it now;
	// the settled card wakes the Agent like any other connection.
	if after, err := a.localComputers.ConnectLocalBrowser(ctx, roomagent.LocalBrowserConnectionCommand{
		Action: roomagent.LocalBrowserConnectionStatusAction, TenantID: auth.TenantID, OwnerActorID: ownerID, ComputerID: computerID,
	}); err == nil && after.State == "connected" {
		if err := a.typedCards.SettleBrowserConnections(ctx, auth.TenantID, ownerID, computerID); err != nil {
			a.logger.Error("settle browser connection card", "error", err)
		}
	}
	c.JSON(http.StatusOK, gin.H{
		"status": "connection_requested", "room_id": roomID, "message_id": result.MessageID, "interaction_id": result.DecisionID,
	})
}

// settleBrowserConnectionCards resolves the owner's waiting browser connection
// cards once their Computer confirmed the connection. A failure leaves the
// cards for the owner to retry; it never fails the connection itself.
func (a *App) settleBrowserConnectionCards(ctx context.Context, command roomagent.LocalBrowserConnectionCommand, status roomagent.LocalBrowserConnectionStatus) {
	if command.Action != roomagent.LocalBrowserConnectionConfigure || status.State != "connected" || a.typedCards == nil {
		return
	}
	if err := a.typedCards.SettleBrowserConnections(ctx, command.TenantID, command.OwnerActorID, command.ComputerID); err != nil {
		a.logger.Error("settle browser connection cards", "error", err)
	}
}
