package app

import (
	"context"
	"crypto/sha256"
	"errors"
	"net/http"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
	api "github.com/simplexai-labs/linger/contracts-go/teamhubagentapi"
)

// getAgentComputerPermissions reads the macOS permissions of the Agent's
// Local Computer. The Computer and its owner come from the Agent's current
// placement, never from the request.
func (a *App) getAgentComputerPermissions(c *gin.Context) {
	auth, computerID, ownerID, ok := a.agentComputerPermissionPlacement(c, "read_computer_permissions")
	if !ok {
		return
	}
	status, ok := a.readAgentComputerPermissions(c, auth.TenantID, ownerID, computerID)
	if !ok {
		return
	}
	c.JSON(http.StatusOK, gin.H{"computer_id": computerID, "permissions": status})
}

// requestAgentComputerPermissions posts a computer_permission card that asks
// the owner of the Agent's Local Computer to grant macOS permissions on that
// Mac. Nothing is granted remotely; the card settles once the Computer reports
// every permission granted.
func (a *App) requestAgentComputerPermissions(c *gin.Context) {
	auth, computerID, ownerID, ok := a.agentComputerPermissionPlacement(c, "request_computer_permission")
	if !ok {
		return
	}
	var request api.RequestAgentComputerPermissionsJSONRequestBody
	if !a.decodeAgentRequest(c, &request) {
		return
	}
	decision, ok := computerPermissionDecision(computerID, request)
	if !ok {
		a.writeAgentAPIError(c, http.StatusBadRequest, api.AgentApiErrorCodeInvalidRequest, "Ask for screen_recording or accessibility of linger or computer_use, each once, with a reason of at most 200 characters")
		return
	}
	ctx := c.Request.Context()
	status, ok := a.readAgentComputerPermissions(c, auth.TenantID, ownerID, computerID)
	if !ok {
		return
	}
	if status.Granted(decision.Subject, decision.Permissions) {
		c.JSON(http.StatusOK, gin.H{"status": "ready", "computer_id": computerID, "permissions": status})
		return
	}
	roomID, err := a.humanConfirmationRoom(ctx, auth, ownerID)
	if err != nil || roomID == "" {
		a.writeAgentAPIError(c, http.StatusForbidden, api.AgentApiErrorCodeForbidden, "The Computer owner has no chat with this Agent to show the permission card")
		return
	}
	// The card's result wakes the Agent where the card is. In a Room the owner
	// is not in, that would be another chat, so this chat would never resume.
	if auth.ParticipantTaskID == "" && auth.RoomID != "" && roomID != auth.RoomID {
		a.writeAgentAPIError(c, http.StatusConflict, api.AgentApiErrorCodeOperationForbidden, "The owner of this Computer is not in this chat, so they cannot grant its permissions here; tell the user the task needs the Computer owner")
		return
	}
	digest := sha256.Sum256([]byte(roomID + "\x00" + auth.AgentActorID + "\x00" + computerID + "\x00" + decision.Subject + "\x00" + strings.Join(decision.Permissions, ",")))
	// A fresh key allows a new card after a decline; the service reuses a
	// pending card under the Room membership lock.
	result, err := a.typedCards.CreateDecision(ctx, roomID, auth.AgentID, "computer-permission-"+idgen.New("request"), digest[:], typedcard.DecisionCommand{
		Principal: auth.Principal, DeciderActorID: ownerID, AlterEgoTaskID: auth.ParticipantTaskID, ComputerPermission: &decision,
	})
	switch {
	case errors.Is(err, typedcard.ErrAssigneeNotMember), errors.Is(err, typedcard.ErrForbidden), errors.Is(err, typedcard.ErrNotFound), errors.Is(err, typedcard.ErrInvalid):
		a.writeAgentAPIError(c, http.StatusForbidden, api.AgentApiErrorCodeForbidden, "Permission cards are unavailable in this chat")
		return
	case err != nil:
		a.logger.Error("create computer permission card", "error", err)
		a.writeAgentAPIError(c, http.StatusServiceUnavailable, api.AgentApiErrorCodeDependencyUnavailable, "Computer permissions are temporarily unavailable")
		return
	}
	// The owner may have granted while the card was posted. Settle it now; the
	// settled card wakes the Agent like any other grant.
	if after, err := a.localComputers.LocalComputerPermissions(ctx, roomagent.LocalComputerPermissionCommand{
		Action: roomagent.LocalComputerPermissionStatusAction, TenantID: auth.TenantID, OwnerActorID: ownerID, ComputerID: computerID,
	}); err == nil {
		status = after
		a.settleComputerPermissionCards(ctx, auth.TenantID, ownerID, computerID, after)
	}
	c.JSON(http.StatusOK, gin.H{
		"status": "permission_requested", "computer_id": computerID, "permissions": status,
		"room_id": roomID, "message_id": result.MessageID, "interaction_id": result.DecisionID,
	})
}

func (a *App) agentComputerPermissionPlacement(c *gin.Context, action string) (auth agentauth.Authorization, computerID, ownerID string, ok bool) {
	token, ok := a.agentCommandBearer(c)
	if !ok {
		return auth, "", "", false
	}
	ctx := c.Request.Context()
	auth, err := a.agentAuth.Authorize(ctx, token, action)
	if a.writeAgentAuthError(c, strings.ReplaceAll(action, "_", " "), err) {
		return auth, "", "", false
	}
	if auth.Principal == nil {
		a.writeAgentAPIError(c, http.StatusForbidden, api.AgentApiErrorCodeForbidden, "Computer permissions require an Agent identity")
		return auth, "", "", false
	}
	computerID, ownerID, err = a.agents.LocalComputerPlacement(ctx, auth.TenantID, auth.AgentActorID)
	if errors.Is(err, pgx.ErrNoRows) {
		a.writeAgentAPIError(c, http.StatusConflict, api.AgentApiErrorCodeOperationForbidden, "This Agent does not run on a Local Computer, so it has no macOS permissions to ask for")
		return auth, "", "", false
	}
	if err != nil || a.localComputers == nil || a.typedCards == nil {
		if err != nil {
			a.logger.Error("read computer permission placement", "error", err)
		}
		a.writeAgentAPIError(c, http.StatusServiceUnavailable, api.AgentApiErrorCodeDependencyUnavailable, "Computer permissions are temporarily unavailable")
		return auth, "", "", false
	}
	return auth, computerID, ownerID, true
}

// readAgentComputerPermissions reads the Computer's permissions and settles
// the owner's cards that they already satisfy.
func (a *App) readAgentComputerPermissions(c *gin.Context, tenantID, ownerID, computerID string) (roomagent.LocalComputerPermissionStatus, bool) {
	ctx := c.Request.Context()
	status, err := a.localComputers.LocalComputerPermissions(ctx, roomagent.LocalComputerPermissionCommand{
		Action: roomagent.LocalComputerPermissionStatusAction, TenantID: tenantID, OwnerActorID: ownerID, ComputerID: computerID,
	})
	switch {
	case errors.Is(err, roomagent.ErrLocalComputerPermissionsUnsupported):
		a.writeAgentAPIError(c, http.StatusConflict, api.AgentApiErrorCodeOperationForbidden, "This Computer must be upgraded before it can report macOS permissions")
		return status, false
	case errors.Is(err, roomagent.ErrLocalComputerOffline), errors.Is(err, roomagent.ErrLocalComputerNotFound):
		a.writeAgentAPIError(c, http.StatusServiceUnavailable, api.AgentApiErrorCodeDependencyUnavailable, "The Local Computer is offline")
		return status, false
	case err != nil:
		a.logger.Error("read computer permissions", "error", err)
		a.writeAgentAPIError(c, http.StatusServiceUnavailable, api.AgentApiErrorCodeDependencyUnavailable, "Computer permissions are temporarily unavailable")
		return status, false
	}
	a.settleComputerPermissionCards(ctx, tenantID, ownerID, computerID, status)
	return status, true
}

// computerPermissionDecision validates the request before any card exists, so
// the Agent gets a precise error instead of a refused card.
func computerPermissionDecision(computerID string, request api.RequestAgentComputerPermissionsJSONRequestBody) (typedcard.ComputerPermissionDecision, bool) {
	decision := typedcard.ComputerPermissionDecision{ComputerID: computerID, Subject: string(request.Subject)}
	if decision.Subject != typedcard.ComputerPermissionSubjectLinger && decision.Subject != typedcard.ComputerPermissionSubjectComputerUse ||
		len(request.Permissions) == 0 || len(request.Permissions) > 2 {
		return decision, false
	}
	for _, permission := range request.Permissions {
		value := string(permission)
		if value != typedcard.ComputerPermissionScreenRecording && value != typedcard.ComputerPermissionAccessibility || slices.Contains(decision.Permissions, value) {
			return decision, false
		}
		decision.Permissions = append(decision.Permissions, value)
	}
	if request.Reason != nil {
		decision.Reason = strings.TrimSpace(*request.Reason)
		if decision.Reason == "" || utf8.RuneCountInString(decision.Reason) > 200 {
			return decision, false
		}
	}
	return decision, true
}

// settleComputerPermissionCards answers the owner's waiting permission cards
// that the Computer's current state satisfies. A failure leaves the cards for
// the next read; it never fails the read itself.
func (a *App) settleComputerPermissionCards(ctx context.Context, tenantID, ownerID, computerID string, status roomagent.LocalComputerPermissionStatus) {
	if a.typedCards == nil {
		return
	}
	if err := a.typedCards.SettleComputerPermissions(ctx, tenantID, ownerID, computerID, status.Granted); err != nil {
		a.logger.Error("settle computer permission cards", "error", err)
	}
}
