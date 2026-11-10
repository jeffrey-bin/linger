package app

import (
	"errors"
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagereaction"
	teamhubagentapi "github.com/simplexai-labs/linger/contracts-go/teamhubagentapi"
)

const agentSendEmojiRequestMaxBytes = 16 << 10

// sendAgentEmojiReaction lets any current Agent add one emoji Reaction to a
// Message in a Room it belongs to. Apply is idempotent, so a retried operation
// changes nothing and needs no separate replay record.
func (a *App) sendAgentEmojiReaction(c *gin.Context) {
	token, ok := a.agentCommandBearer(c)
	if !ok {
		return
	}
	var request teamhubagentapi.AgentSendEmojiReactionRequest
	body := http.MaxBytesReader(c.Writer, c.Request.Body, agentSendEmojiRequestMaxBytes)
	if err := decodeStrictJSON(body, &request, "request body must contain one JSON object"); err != nil ||
		request.MessageId == "" || !messagereaction.ValidReactionID(request.Emoji) {
		a.writeAgentSendEmojiError(c, messagereaction.ErrInvalidReaction)
		return
	}
	messageID, err := a.collaboration.SendAgentEmoji(c.Request.Context(), a.agentAuth, token, request.MessageId, request.Emoji)
	if err != nil {
		a.writeAgentSendEmojiError(c, err)
		return
	}
	c.JSON(http.StatusOK, teamhubagentapi.AgentSendEmojiReactionResponse{
		Accepted: true, MessageId: messageID, Emoji: request.Emoji,
	})
}

func (a *App) writeAgentSendEmojiError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, messagereaction.ErrInvalidReaction), errors.Is(err, agentauth.ErrInvalid):
		a.writeAgentAPIError(c, http.StatusBadRequest, teamhubagentapi.AgentApiErrorCodeInvalidRequest, "Emoji Reaction request is invalid; emoji must be an ID from the official Reaction library")
	case errors.Is(err, messagereaction.ErrUnsupported):
		a.writeAgentAPIError(c, http.StatusBadRequest, teamhubagentapi.AgentApiErrorCodeInvalidRequest, "This Message does not support Reactions")
	case errors.Is(err, agentauth.ErrCredentialInvalid):
		a.writeAgentAPIError(c, http.StatusUnauthorized, teamhubagentapi.AgentApiErrorCodeAgentCredentialInvalid, "Agent credential is invalid or expired")
	case errors.Is(err, agentauth.ErrForbidden):
		a.writeAgentAPIError(c, http.StatusForbidden, teamhubagentapi.AgentApiErrorCodeOperationForbidden, agentForbiddenMessage(err, "send_emoji is not allowed for this Context"))
	case errors.Is(err, pgx.ErrNoRows):
		a.writeAgentAPIError(c, http.StatusForbidden, teamhubagentapi.AgentApiErrorCodeForbidden, "Message is unavailable or not in a Room this Agent belongs to")
	case errors.Is(err, messagereaction.ErrCapacity):
		a.writeAgentAPIError(c, http.StatusBadRequest, teamhubagentapi.AgentApiErrorCodeInvalidRequest, "This Message has reached its Reaction limit")
	default:
		if a.logger != nil {
			a.logger.Error("send Agent emoji Reaction", "request_id", c.GetString("request_id"), "error_type", fmt.Sprintf("%T", err))
		}
		a.writeAgentAPIError(c, http.StatusServiceUnavailable, teamhubagentapi.AgentApiErrorCodeDependencyUnavailable, "Emoji Reaction service is unavailable")
	}
}
