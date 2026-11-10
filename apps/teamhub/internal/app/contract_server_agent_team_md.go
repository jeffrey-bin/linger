package app

import (
	"errors"
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentsendmessage"
	teamhubagentapi "github.com/simplexai-labs/linger/contracts-go/teamhubagentapi"
)

func (a *App) createAgentTeamMd(c *gin.Context) {
	token, ok := a.agentCommandBearer(c)
	if !ok {
		return
	}

	var request teamhubagentapi.AgentCreateTeamMdRequest
	body := http.MaxBytesReader(c.Writer, c.Request.Body, agentSendMessageRequestMaxBytes)
	if err := decodeStrictJSON(body, &request, "request body must contain one JSON object"); err != nil {
		a.writeInvalidAgentTeamMd(c)
		return
	}

	result, err := a.agentSendMessages.CreateTeamMd(
		c.Request.Context(),
		token,
		agentsendmessage.CreateTeamMdInput{
			SourceInboxIDs: append([]string{}, []string{}...),
			InvocationID:   request.InvocationId,
			Content:        request.Content,
		},
	)
	if a.writeAgentTeamMdError(c, err) {
		return
	}
	c.JSON(http.StatusOK, teamhubagentapi.AgentCreateTeamMdResponse{
		Created:          result.Accepted,
		RoomId:           result.RoomID,
		Revision:         result.Revision,
		NotifiedActorIds: result.NotifiedActorIDs,
		MessageId:        result.MessageID,
	})
}

func (a *App) writeInvalidAgentTeamMd(c *gin.Context) {
	a.writeAgentAPIError(
		c,
		http.StatusBadRequest,
		teamhubagentapi.AgentApiErrorCodeInvalidRequest,
		"create_team_md request is invalid",
	)
}

func (a *App) writeAgentTeamMdError(c *gin.Context, err error) bool {
	if err == nil {
		return false
	}
	// Every broken rule is reported at once so the Agent can fix the document
	// in one pass instead of rediscovering problems one at a time.
	var invalid *agentsendmessage.DocumentInvalidError
	if errors.As(err, &invalid) {
		issues := make([]teamhubagentapi.AgentApiErrorIssue, 0, len(invalid.Issues))
		for _, issue := range invalid.Issues {
			issues = append(issues, teamhubagentapi.AgentApiErrorIssue{
				Path: issue.Path, Code: issue.Code, Message: issue.Message,
			})
		}
		a.writeAgentAPIErrorWithIssues(
			c,
			http.StatusBadRequest,
			teamhubagentapi.AgentApiErrorCodeTeamMdDocumentInvalid,
			"team.md document is invalid",
			issues,
		)
		return true
	}
	switch {
	case errors.Is(err, agentsendmessage.ErrInvalid), errors.Is(err, agentauth.ErrInvalid):
		a.writeInvalidAgentTeamMd(c)
	case errors.Is(err, agentauth.ErrCredentialInvalid):
		a.writeAgentAPIError(c, http.StatusUnauthorized, teamhubagentapi.AgentApiErrorCodeAgentCredentialInvalid, "Agent credential is invalid or expired")
	case errors.Is(err, agentsendmessage.ErrForbidden), errors.Is(err, agentauth.ErrForbidden):
		a.writeAgentAPIError(c, http.StatusForbidden, teamhubagentapi.AgentApiErrorCodeOperationForbidden, agentForbiddenMessage(err, "create_team_md is not allowed for this Context"))
	case errors.Is(err, agentsendmessage.ErrInboxUnavailable):
		a.writeAgentAPIError(c, http.StatusNotFound, teamhubagentapi.AgentApiErrorCodeNotFound, "Room is not available for this Context")
	case errors.Is(err, agentsendmessage.ErrIdempotencyConflict):
		a.writeAgentAPIError(c, http.StatusConflict, teamhubagentapi.AgentApiErrorCodeIdempotencyConflict, "Agent invocation was reused with different input")
	case errors.Is(err, agentsendmessage.ErrUnavailable):
		a.writeAgentAPIError(c, http.StatusServiceUnavailable, teamhubagentapi.AgentApiErrorCodeDependencyUnavailable, "team.md publication is temporarily unavailable")
	default:
		if a.logger != nil {
			a.logger.Error("create Agent team.md", "request_id", c.GetString("request_id"), "error_type", fmt.Sprintf("%T", err))
		}
		a.writeAgentAPIError(c, http.StatusInternalServerError, teamhubagentapi.AgentApiErrorCodeInternalError, "create_team_md could not complete the request")
	}
	return true
}
