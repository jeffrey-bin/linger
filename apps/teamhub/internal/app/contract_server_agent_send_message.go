package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentsendmessage"
	teamhubagentapi "github.com/simplexai-labs/linger/contracts-go/teamhubagentapi"
)

const agentSendMessageRequestMaxBytes = 5 << 20

type agentSendMessageService interface {
	Send(context.Context, string, agentsendmessage.Input) (agentsendmessage.Result, error)
	CreateTeamMd(context.Context, string, agentsendmessage.CreateTeamMdInput) (agentsendmessage.TeamMdResult, error)
}

func (a *App) writeInvalidAgentSendMessage(c *gin.Context) {
	a.writeAgentAPIError(
		c,
		http.StatusBadRequest,
		teamhubagentapi.AgentApiErrorCodeInvalidRequest,
		"Agent Send Message request is invalid",
	)
}

func (a *App) writeAgentSendMessageError(c *gin.Context, err error) bool {
	if err == nil {
		return false
	}
	switch {
	case errors.Is(err, agentsendmessage.ErrInvalid), errors.Is(err, agentauth.ErrInvalid):
		a.writeInvalidAgentSendMessage(c)
	case errors.Is(err, agentauth.ErrCredentialInvalid):
		a.writeAgentAPIError(c, http.StatusUnauthorized, teamhubagentapi.AgentApiErrorCodeAgentCredentialInvalid, "Agent credential is invalid or expired")
	case errors.Is(err, agentsendmessage.ErrForbidden), errors.Is(err, agentauth.ErrForbidden):
		a.writeAgentAPIError(c, http.StatusForbidden, teamhubagentapi.AgentApiErrorCodeOperationForbidden, agentForbiddenMessage(err, "send_message is not allowed for this Context"))
	case errors.Is(err, agentsendmessage.ErrReplySourceUnavailable):
		a.writeAgentAPIError(c, http.StatusForbidden, teamhubagentapi.AgentApiErrorCodeForbidden, "Reply source is unavailable or not authorized. Check the source_message_id passed with --reply-to; after correcting it, start a new operation with a new operation ID.")
	case errors.Is(err, agentsendmessage.ErrInboxUnavailable):
		a.writeAgentAPIError(c, http.StatusForbidden, teamhubagentapi.AgentApiErrorCodeForbidden, "Public Inbox is unavailable or not authorized")
	case errors.Is(err, agentsendmessage.ErrIdempotencyConflict):
		a.writeAgentAPIError(c, http.StatusConflict, teamhubagentapi.AgentApiErrorCodeIdempotencyConflict, "Agent Send Message invocation was reused with different input")
	case errors.Is(err, agentsendmessage.ErrUnavailable):
		a.writeAgentAPIError(c, http.StatusServiceUnavailable, teamhubagentapi.AgentApiErrorCodeDependencyUnavailable, "Agent Send Message service is unavailable")
	default:
		if a.logger != nil {
			a.logger.Error("send Agent Message", "request_id", c.GetString("request_id"), "error_type", fmt.Sprintf("%T", err))
		}
		a.writeAgentAPIError(c, http.StatusInternalServerError, teamhubagentapi.AgentApiErrorCodeInternalError, "Agent Send Message service could not complete the request")
	}
	return true
}
