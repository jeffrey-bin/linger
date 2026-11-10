package app

import (
	"context"
	"crypto/sha256"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentconnectedapps"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
	api "github.com/simplexai-labs/linger/contracts-go/teamhubagentapi"
)

// writeConnectedAppResult answers a connected app call: the tool's data, or,
// for a write that needs the sponsor's confirmation, the receipt of the card
// TeamHub posts instead of running it. The sponsor's approval runs the stored
// call later in the decision.run job.
func (a *App) writeConnectedAppResult(c *gin.Context, token string, result agentconnectedapps.Result) {
	c.Header("Cache-Control", "no-store")
	if result.Confirmation == nil {
		c.JSON(http.StatusOK, gin.H{"data": result.Data})
		return
	}
	prepared := *result.Confirmation
	ctx := c.Request.Context()
	auth, err := a.agentAuth.Authorize(ctx, token, "execute_app_tool")
	if a.writeAgentAuthError(c, "request connector confirmation", err) {
		return
	}
	if auth.Principal == nil || auth.SponsorActorID == "" {
		a.writeAgentAPIError(c, http.StatusForbidden, api.AgentApiErrorCodeForbidden, "Confirmation requires a Human decision owner")
		return
	}
	roomID, err := a.sponsorConfirmationRoom(ctx, auth)
	if err != nil || roomID == "" {
		a.writeAgentAPIError(c, http.StatusForbidden, api.AgentApiErrorCodeForbidden, "Run this command from a chat its sponsor can see to request confirmation")
		return
	}
	// Check provenance against the command's source Room before posting a card
	// in the sponsor's direct chat. The redirect does not change its writing Run.
	runID, err := a.typedCards.RunClaim(ctx, auth.TenantID, auth.AgentActorID, auth.RoomID)
	if err != nil {
		a.writeAgentAPIError(c, http.StatusServiceUnavailable, api.AgentApiErrorCodeDependencyUnavailable, "Confirmation is temporarily unavailable")
		return
	}
	// A retried operation replays its card; a new operation of an identical
	// call reuses a pending card in the same Room.
	key := c.GetHeader("X-TeamHub-Operation-Id")
	if key == "" {
		key = "connector-confirmation-" + idgen.New("request")
	}
	hash := sha256.Sum256([]byte(roomID + "\x00" + prepared.Digest))
	// An ineligible source claim must not be checked again against the card's
	// redirected Room and accidentally acquire another Run there.
	cardCtx := messagecreation.WithRunClaim(ctx, "")
	card, err := a.typedCards.CreateDecision(cardCtx, roomID, auth.AgentID, key, hash[:], typedcard.DecisionCommand{
		Principal: auth.Principal, DeciderActorID: auth.SponsorActorID, RunID: runID.String,
		AlterEgoTaskID: auth.ParticipantTaskID,
		ConnectorWrite: &typedcard.ConnectorWriteDecision{
			Request: typedcard.ConnectorWriteRequest{
				ConnectionID: prepared.Connection.ID, ActionDigest: prepared.Digest, Action: prepared.Action,
			},
			View: prepared.Card,
		},
	})
	if a.writeDecisionRequestError(c, err) {
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "confirmation_pending", "room_id": roomID, "message_id": card.MessageID, "interaction_id": card.DecisionID})
}

// writeDecisionRequestError answers a decision card that could not be posted.
func (a *App) writeDecisionRequestError(c *gin.Context, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, typedcard.ErrIdempotencyConflict):
		a.writeAgentAPIError(c, http.StatusConflict, api.AgentApiErrorCodeIdempotencyConflict, "This operation already requested a different confirmation")
	case errors.Is(err, typedcard.ErrForbidden), errors.Is(err, typedcard.ErrNotFound), errors.Is(err, typedcard.ErrInvalid):
		a.writeAgentAPIError(c, http.StatusForbidden, api.AgentApiErrorCodeForbidden, "Confirmation is unavailable in this chat")
	default:
		a.writeAgentAPIError(c, http.StatusServiceUnavailable, api.AgentApiErrorCodeDependencyUnavailable, "Confirmation is temporarily unavailable")
	}
	return true
}

// sponsorConfirmationRoom picks the chat for a confirmation or approval card
// the Agent's sponsor decides.
func (a *App) sponsorConfirmationRoom(ctx context.Context, auth agentauth.Authorization) (string, error) {
	return a.humanConfirmationRoom(ctx, auth, auth.SponsorActorID)
}

// humanConfirmationRoom picks the chat for a card one Human decides.
func (a *App) humanConfirmationRoom(ctx context.Context, auth agentauth.Authorization, humanActorID string) (string, error) {
	return a.typedCards.ConfirmationRoom(ctx, typedcard.ConfirmationScope{
		TenantID: auth.TenantID, AgentActorID: auth.AgentActorID, RoomID: auth.RoomID, ParticipantTaskID: auth.ParticipantTaskID,
	}, humanActorID)
}
