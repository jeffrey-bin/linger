package app

import (
	"crypto/subtle"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

func (a *App) authenticateMcpAgentService(c *gin.Context) bool {
	return a.authenticateMcpInternalBearer(
		c,
		a.cfg.TeamHubInternalToken,
		"Agent Service authentication is not configured",
		"Agent Service authentication is invalid",
	)
}

func (a *App) authenticateMcpInternalBearer(
	c *gin.Context,
	expectedToken string,
	unconfiguredMessage string,
	invalidMessage string,
) bool {
	if expectedToken == "" {
		a.writeMcpContextError(
			c,
			http.StatusServiceUnavailable,
			teamhubinternal.McpContextErrorCodeDependencyUnavailable,
			unconfiguredMessage,
		)
		c.Abort()
		return false
	}
	headers := c.Request.Header.Values("Authorization")
	token := ""
	if len(headers) == 1 && !strings.Contains(headers[0], ",") {
		token, _ = strings.CutPrefix(headers[0], "Bearer ")
	}
	if token == "" || subtle.ConstantTimeCompare([]byte(token), []byte(expectedToken)) != 1 {
		a.writeMcpContextError(
			c,
			http.StatusUnauthorized,
			teamhubinternal.McpContextErrorCodeUnauthenticated,
			invalidMessage,
		)
		c.Abort()
		return false
	}
	return true
}

func (a *App) writeMcpContextError(
	c *gin.Context,
	status int,
	code teamhubinternal.McpContextErrorCode,
	message string,
) {
	a.writeMcpContextErrorWithIssues(c, status, code, message, nil)
}

func (a *App) writeMcpContextErrorWithIssues(
	c *gin.Context,
	status int,
	code teamhubinternal.McpContextErrorCode,
	message string,
	issues []teamhubinternal.McpContextErrorIssue,
) {
	requestID := c.GetString("request_id")
	if requestID == "" {
		requestID = idgen.New("request")
	}
	model := teamhubinternal.McpContextError{
		Code: code, Message: message, RequestId: requestID,
	}
	if len(issues) > 0 {
		model.Issues = &issues
	}
	c.JSON(status, teamhubinternal.McpContextErrorEnvelope{Error: model})
}
