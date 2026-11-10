package app

import (
	"crypto/sha256"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentregistry"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/collaboration"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
	api "github.com/simplexai-labs/linger/contracts-go/teamhubagentapi"
)

// Agents create and change Agents of their own Sponsor. TeamHub
// decides whether a change runs now or waits for the Sponsor's card; the
// caller never chooses its Sponsor, Runtime, or Room.

func (a *App) decodeAgentRequest(c *gin.Context, target any) bool {
	body := http.MaxBytesReader(c.Writer, c.Request.Body, agentregistry.AgentRequestMaxBytes)
	if err := decodeStrictJSON(body, target, "request body must contain one JSON object"); err != nil {
		a.writeAgentAPIError(c, http.StatusBadRequest, api.AgentApiErrorCodeInvalidRequest, "Agent request is invalid")
		return false
	}
	return true
}

// writeAgentChangeError maps errors of the Agent commands; it reports false
// when err is nil.
func (a *App) writeAgentChangeError(c *gin.Context, action string, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, pgx.ErrNoRows):
		a.writeAgentAPIError(c, http.StatusNotFound, api.AgentApiErrorCodeNotFound, "Agent was not found")
	case errors.Is(err, collaboration.ErrAgentSponsorRequired):
		a.writeAgentAPIError(c, http.StatusForbidden, api.AgentApiErrorCodeForbidden, "Only an active General Agent of your Sponsor can be read or changed")
	case errors.Is(err, agentregistry.ErrAgentLimitReached):
		a.writeAgentAPIError(c, http.StatusConflict, api.AgentApiErrorCodeAgentLimitReached, "Your Sponsor already has 50 Agents; the Sponsor must delete one first")
	case errors.Is(err, agentregistry.ErrAgentConfigurationConflict):
		a.writeAgentAPIError(c, http.StatusConflict, api.AgentApiErrorCodeVersionConflict, "The Agent changed meanwhile; read it again and retry")
	case errors.Is(err, idempotency.ErrConflict):
		a.writeAgentAPIError(c, http.StatusConflict, api.AgentApiErrorCodeIdempotencyConflict, "This operation was used with different input")
	case errors.Is(err, agentregistry.ErrAgentPlacementTargetUnavailable):
		a.writeAgentAPIError(c, http.StatusConflict, api.AgentApiErrorCodeOperationForbidden, "Your Sponsor's computer was removed or no longer offers your workspace; the Sponsor must move you first")
	default:
		return a.writeAgentAuthError(c, action, err)
	}
	return true
}

func (a *App) getAgent(c *gin.Context) {
	token, ok := a.agentCommandBearer(c)
	if !ok {
		return
	}
	var request api.AgentGetAgentRequest
	if !a.decodeAgentRequest(c, &request) {
		return
	}
	profile, err := a.agents.GetSponsorAgent(c.Request.Context(), a.agentAuth, token, request.ActorId)
	if a.writeAgentChangeError(c, "get Agent", err) {
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, profile)
}

func (a *App) updateAgent(c *gin.Context) {
	token, ok := a.agentCommandBearer(c)
	if !ok {
		return
	}
	var request api.AgentUpdateAgentRequest
	if !a.decodeAgentRequest(c, &request) {
		return
	}
	change := agentregistry.AgentProfileChange{
		Name: agentregistry.NormalizedAgentText(request.Name), Description: agentregistry.NormalizedAgentText(request.Description),
		Instructions: agentregistry.NormalizedAgentText(request.Prompt),
	}
	if change.Empty() || !agentregistry.ValidAgentProfileChange(change) || !agentregistry.AgentInvocationPattern.MatchString(request.InvocationId) {
		a.writeAgentAPIError(c, http.StatusBadRequest, api.AgentApiErrorCodeInvalidRequest, "Provide a name, description, or prompt within the limits")
		return
	}
	result, err := a.agents.UpdateSponsorAgent(c.Request.Context(), a.agentAuth, token, request, change)
	if a.writeAgentChangeError(c, "update Agent", err) {
		return
	}
	a.writeAgentChange(c, request.InvocationId, result)
}

func (a *App) createAgent(c *gin.Context) {
	token, ok := a.agentCommandBearer(c)
	if !ok {
		return
	}
	var request api.AgentCreateAgentRequest
	if !a.decodeAgentRequest(c, &request) {
		return
	}
	description := ""
	if request.Description != nil {
		description = *request.Description
	}
	change := agentregistry.AgentProfileChange{
		Name: agentregistry.NormalizedAgentText(&request.Name), Description: agentregistry.NormalizedAgentText(&description),
		Instructions: agentregistry.NormalizedAgentText(&request.Prompt),
	}
	if !agentregistry.ValidAgentProfileChange(change) || !agentregistry.AgentInvocationPattern.MatchString(request.InvocationId) {
		a.writeAgentAPIError(c, http.StatusBadRequest, api.AgentApiErrorCodeInvalidRequest, "Provide a name and prompt within the limits")
		return
	}
	result, err := a.agents.CreateSponsorGeneralAgent(c.Request.Context(), a.agentAuth, token, request, change)
	if a.writeAgentChangeError(c, "create Agent", err) {
		return
	}
	a.writeAgentChange(c, request.InvocationId, result)
}

func (a *App) addAgentRoomMember(c *gin.Context) {
	token, ok := a.agentCommandBearer(c)
	if !ok {
		return
	}
	var request api.AgentAddRoomMemberRequest
	if !a.decodeAgentRequest(c, &request) {
		return
	}
	if !agentregistry.AgentInvocationPattern.MatchString(request.InvocationId) {
		a.writeAgentAPIError(c, http.StatusBadRequest, api.AgentApiErrorCodeInvalidRequest, "Provide the Agent's actor_id and a valid invocation_id")
		return
	}
	result, added, err := a.agents.AddSponsorAgentToRoom(c.Request.Context(), a.agentAuth, token, request.ActorId)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		a.writeAgentAPIError(c, http.StatusNotFound, api.AgentApiErrorCodeNotFound, "Agent was not found; take its actor_id from teamhub agent list")
	case errors.Is(err, agentregistry.ErrSponsorNotRoomMember):
		a.writeAgentAPIError(c, http.StatusForbidden, api.AgentApiErrorCodeForbidden, "Your Sponsor is not in this Room; only a member can add Agents here")
	case errors.Is(err, collaboration.ErrAgentNotRegistered):
		a.writeAgentAPIError(c, http.StatusConflict, api.AgentApiErrorCodeOperationForbidden, "This Agent is not active and cannot join a Room")
	case errors.Is(err, collaboration.ErrAgentSponsorRequired):
		a.writeAgentAPIError(c, http.StatusForbidden, api.AgentApiErrorCodeForbidden, "Only the Agent's own Sponsor can add it to a Room")
	case errors.Is(err, collaboration.ErrDirectRoomImmutable), errors.Is(err, collaboration.ErrThreadImmutable):
		a.writeAgentAPIError(c, http.StatusConflict, api.AgentApiErrorCodeOperationForbidden, "A Direct Room or Thread keeps its members; create a collaboration Room with teamhub room create instead")
	case err != nil:
		a.writeAgentAuthError(c, "add Room member", err)
	default:
		a.prepareAddedRoomAgents(c, result.RoomId, added)
		c.Header("Cache-Control", "no-store")
		c.JSON(http.StatusOK, result)
	}
}

func (a *App) writeAgentChange(c *gin.Context, invocationID string, result agentregistry.AgentChange) {
	switch {
	case result.Confirm != nil:
		a.requestAgentChangeConfirmation(c, result.Auth, invocationID, *result.Confirm)
	case result.Created != nil:
		c.Header("Cache-Control", "no-store")
		c.JSON(result.Status, result.Created)
	default:
		c.Header("Cache-Control", "no-store")
		c.Data(result.Status, "application/json", result.Body)
	}
}

// requestAgentChangeConfirmation posts the Sponsor's decision card for a
// change that cannot run now. A retried operation replays its card.
func (a *App) requestAgentChangeConfirmation(c *gin.Context, auth agentauth.Authorization, invocationID string, change typedcard.AgentChangeDecision) {
	ctx := c.Request.Context()
	roomID, err := a.sponsorConfirmationRoom(ctx, auth)
	if err != nil || roomID == "" {
		a.writeAgentAPIError(c, http.StatusForbidden, api.AgentApiErrorCodeForbidden, "Run this command from a chat your Sponsor can see to request confirmation")
		return
	}
	hash := sha256.Sum256([]byte(roomID + "\x00" + invocationID))
	result, err := a.typedCards.CreateDecision(ctx, roomID, auth.AgentID, "agent-change-"+invocationID, hash[:], typedcard.DecisionCommand{
		Principal: auth.Principal, DeciderActorID: auth.SponsorActorID, AgentChange: &change,
	})
	if a.writeDecisionRequestError(c, err) {
		return
	}
	messageID, decisionID := result.MessageID, result.DecisionID
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, api.AgentAgentChangeResponse{
		Status: api.AgentChangeConfirmationPending, RoomId: &roomID, MessageId: &messageID, InteractionId: &decisionID,
	})
}
