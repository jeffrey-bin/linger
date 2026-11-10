package app

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	teamhubagentapi "github.com/simplexai-labs/linger/contracts-go/teamhubagentapi"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
)

// strictAgentBearer rejects duplicate or malformed Authorization headers
// before a handler authenticates the Agent credential.
func strictAgentBearer(c *gin.Context) (string, bool) {
	headers := c.Request.Header.Values("Authorization")
	if len(headers) != 1 || strings.Contains(headers[0], ",") {
		return "", false
	}
	token, ok := strings.CutPrefix(headers[0], "Bearer ")
	return token, ok && token != "" && !strings.ContainsAny(token, " \t\r\n")
}

// agentCommandBearer keeps the Agent command wire error stable across adapters.
// Credential validity and resource rights are checked by the domain transaction.
func (a *App) agentCommandBearer(c *gin.Context) (string, bool) {
	token, ok := strictAgentBearer(c)
	if !ok {
		a.writeAgentAPIError(c, http.StatusUnauthorized, teamhubagentapi.AgentApiErrorCodeAgentCredentialInvalid, "Agent credential is invalid or expired")
	}
	return token, ok
}

// writeAgentAuthError writes the wire error of a failed Agent authorization.
func (a *App) writeAgentAuthError(c *gin.Context, action string, err error) bool {
	if err == nil {
		return false
	}
	switch {
	case errors.Is(err, agentauth.ErrInvalid):
		a.writeAgentAPIError(c, http.StatusBadRequest, teamhubagentapi.AgentApiErrorCodeInvalidRequest, "Agent command target is invalid")
	case errors.Is(err, agentauth.ErrCredentialInvalid):
		a.writeAgentAPIError(c, http.StatusUnauthorized, teamhubagentapi.AgentApiErrorCodeAgentCredentialInvalid, "Agent credential is invalid or expired")
	case errors.Is(err, agentauth.ErrForbidden):
		a.writeAgentAPIError(c, http.StatusForbidden, teamhubagentapi.AgentApiErrorCodeOperationForbidden, agentForbiddenMessage(err, "Agent operation is not allowed"))
	default:
		if a.logger != nil {
			a.logger.Error(action, "request_id", c.GetString("request_id"), "error_type", fmt.Sprintf("%T", err))
		}
		a.writeAgentAPIError(c, http.StatusInternalServerError, teamhubagentapi.AgentApiErrorCodeInternalError, "Agent operation could not complete the request")
	}
	return true
}

// agentForbiddenMessage tells a Task's AlterEgo where its output goes when it
// runs a command only a Meta may run.
func agentForbiddenMessage(err error, message string) string {
	if errors.Is(err, agentauth.ErrTaskContextForbidden) {
		return agentauth.TaskContextForbiddenMessage
	}
	return message
}

func (a *App) writeAgentAPIError(
	c *gin.Context,
	status int,
	code teamhubagentapi.AgentApiErrorCode,
	message string,
) {
	a.writeAgentAPIErrorWithIssues(c, status, code, message, nil)
}

func (a *App) writeAgentAPIErrorWithIssues(
	c *gin.Context,
	status int,
	code teamhubagentapi.AgentApiErrorCode,
	message string,
	issues []teamhubagentapi.AgentApiErrorIssue,
) {
	requestID := c.GetString("request_id")
	if requestID == "" {
		requestID = idgen.New("request")
	}
	model := teamhubagentapi.AgentApiError{
		Code: code, Message: message, RequestId: requestID,
	}
	if len(issues) > 0 {
		model.Issues = &issues
	}
	c.JSON(status, teamhubagentapi.AgentApiErrorEnvelope{Error: model})
}
