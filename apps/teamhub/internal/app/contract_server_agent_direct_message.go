package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentdirectmessage"
	teamhubagentapi "github.com/simplexai-labs/linger/contracts-go/teamhubagentapi"
)

const agentDirectMessageRequestMaxBytes = 5 << 20

type agentDirectMessageService interface {
	Send(context.Context, string, agentdirectmessage.Input) (agentdirectmessage.Result, error)
}

func (a *App) sendAgentDirectMessage(c *gin.Context) {
	token, ok := a.agentCommandBearer(c)
	if !ok {
		return
	}
	var request teamhubagentapi.AgentSendDirectMessageRequest
	body := http.MaxBytesReader(c.Writer, c.Request.Body, agentDirectMessageRequestMaxBytes)
	if err := decodeStrictJSON(body, &request, "request body must contain one JSON object"); err != nil {
		a.writeAgentAPIError(
			c,
			http.StatusBadRequest,
			teamhubagentapi.AgentApiErrorCodeInvalidRequest,
			"Agent Direct Message request is invalid",
		)
		return
	}
	result, err := a.agentDirectMessages.Send(
		c.Request.Context(),
		token,
		agentdirectmessage.Input{
			InvocationID: request.InvocationId,
			Messages:     append([]string(nil), request.Messages...),
		},
	)
	if a.writeAgentDirectMessageError(c, err) {
		return
	}
	messageIDs := make([]teamhubagentapi.Id, len(result.MessageIDs))
	copy(messageIDs, result.MessageIDs)
	c.JSON(http.StatusOK, agentMessageReceipt(gin.H{"accepted": result.Accepted, "inbox_id": result.InboxID, "message_ids": messageIDs, "room_created": result.RoomCreated}, result.Replay, "This operation was already completed. The original messages are returned; no new messages or room were created."))
}

func (a *App) writeAgentDirectMessageError(c *gin.Context, err error) bool {
	if err == nil {
		return false
	}
	switch {
	case errors.Is(err, agentdirectmessage.ErrInvalid), errors.Is(err, agentauth.ErrInvalid):
		a.writeAgentAPIError(c, http.StatusBadRequest, teamhubagentapi.AgentApiErrorCodeInvalidRequest, "Agent Direct Message request is invalid")
	case errors.Is(err, agentauth.ErrCredentialInvalid):
		a.writeAgentAPIError(c, http.StatusUnauthorized, teamhubagentapi.AgentApiErrorCodeAgentCredentialInvalid, "Agent credential is invalid or expired")
	case errors.Is(err, agentdirectmessage.ErrIdentityInvalid):
		a.writeAgentAPIError(c, http.StatusForbidden, teamhubagentapi.AgentApiErrorCodeContextIdentityInvalid, "Agent identity is invalid")
	case errors.Is(err, agentdirectmessage.ErrForbidden), errors.Is(err, agentauth.ErrForbidden):
		a.writeAgentAPIError(c, http.StatusForbidden, teamhubagentapi.AgentApiErrorCodeOperationForbidden, agentForbiddenMessage(err, "send_direct_message is not allowed for this Context"))
	case errors.Is(err, agentdirectmessage.ErrSponsorUnavailable):
		a.writeAgentAPIError(c, http.StatusForbidden, teamhubagentapi.AgentApiErrorCodeForbidden, "Agent Human sponsor is unavailable")
	case errors.Is(err, agentdirectmessage.ErrIdempotencyConflict):
		a.writeAgentAPIError(c, http.StatusConflict, teamhubagentapi.AgentApiErrorCodeIdempotencyConflict, "Agent Direct Message invocation was reused with different input")
	case errors.Is(err, agentdirectmessage.ErrUnavailable):
		a.writeAgentAPIError(c, http.StatusServiceUnavailable, teamhubagentapi.AgentApiErrorCodeDependencyUnavailable, "Agent Direct Message service is unavailable")
	default:
		if a.logger != nil {
			a.logger.Error("send Agent Direct Message", "request_id", c.GetString("request_id"), "error_type", fmt.Sprintf("%T", err))
		}
		a.writeAgentAPIError(c, http.StatusInternalServerError, teamhubagentapi.AgentApiErrorCodeInternalError, "Agent Direct Message service could not complete the request")
	}
	return true
}
