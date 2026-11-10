package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentconnectedapps"
	teamhubagentapi "github.com/simplexai-labs/linger/contracts-go/teamhubagentapi"
)

const agentConnectedAppsRequestMaxBytes = 1 << 20

func (a *App) listAgentConnectedApps(c *gin.Context) {
	token, ok := a.agentCommandBearer(c)
	if !ok {
		return
	}
	var request teamhubagentapi.AgentListConnectedAppsRequest
	if !a.decodeConnectedAppsRequest(c, &request) {
		return
	}
	result, err := a.agentConnectedApps.List(c.Request.Context(), token)
	if a.writeAgentConnectedAppsError(c, "list_connected_apps", err) {
		return
	}
	c.JSON(http.StatusOK, agentListConnectedAppsResponse(result))
}

func agentListConnectedAppsResponse(result []agentconnectedapps.ConnectedApp) teamhubagentapi.AgentListConnectedAppsResponse {
	connections := make([]teamhubagentapi.AgentConnectedApp, len(result))
	for index, connection := range result {
		connections[index] = agentConnectedAppToContract(connection)
	}
	return teamhubagentapi.AgentListConnectedAppsResponse{Connections: connections}
}

func (a *App) searchAgentConnectedAppTools(c *gin.Context) {
	token, ok := a.agentCommandBearer(c)
	if !ok {
		return
	}
	var request teamhubagentapi.AgentSearchAppToolsRequest
	if !a.decodeConnectedAppsRequest(c, &request) {
		return
	}
	input := agentconnectedapps.SearchInput{Query: request.Query}
	if request.ConnectionId != nil {
		input.ConnectionID = *request.ConnectionId
	}
	if request.AppKey != nil {
		input.AppKey = *request.AppKey
	}
	if request.Limit != nil {
		input.Limit = int(*request.Limit)
	}
	result, err := a.agentConnectedApps.Search(c.Request.Context(), token, input)
	if a.askForProviderKey(c, token, input.AppKey, err) || a.writeAgentConnectedAppsError(c, "search_app_tools", err) {
		return
	}
	c.JSON(http.StatusOK, agentSearchAppToolsResponse(result))
}

func agentSearchAppToolsResponse(result []agentconnectedapps.AppTool) teamhubagentapi.AgentSearchAppToolsResponse {
	tools := make([]teamhubagentapi.AgentConnectedAppTool, len(result))
	for index, tool := range result {
		connections := make([]teamhubagentapi.AgentConnectedApp, len(tool.AvailableConnections))
		for connectionIndex, connection := range tool.AvailableConnections {
			connections[connectionIndex] = agentConnectedAppToContract(connection)
		}
		tools[index] = teamhubagentapi.AgentConnectedAppTool{
			ToolSlug: tool.ToolSlug, ToolVersion: tool.ToolVersion, Name: tool.Name,
			Description: tool.Description, AppKey: tool.AppKey,
			InputSchema: tool.InputSchema, AvailableConnections: connections,
			// Discovery returns full inputs; actual outputs arrive only on execution.
			OutputSchema: map[string]any{},
		}
	}
	return teamhubagentapi.AgentSearchAppToolsResponse{Tools: tools}
}

func (a *App) executeAgentConnectedAppTool(c *gin.Context) {
	token, ok := a.agentCommandBearer(c)
	if !ok {
		return
	}
	var request teamhubagentapi.AgentExecuteAppToolRequest
	if !a.decodeConnectedAppsRequest(c, &request) {
		return
	}
	result, err := a.agentConnectedApps.Execute(connectorCallContext(c), token, agentconnectedapps.ExecuteInput{
		ConnectionID: request.ConnectionId, ToolSlug: request.ToolSlug,
		ToolVersion: request.ToolVersion, Arguments: request.Arguments,
	})
	if a.askForProviderKey(c, token, "", err) || a.writeAgentConnectedAppsError(c, "execute_app_tool", err) {
		return
	}
	a.writeConnectedAppResult(c, token, result)
}

func (a *App) decodeConnectedAppsRequest(c *gin.Context, target any) bool {
	body := http.MaxBytesReader(c.Writer, c.Request.Body, agentConnectedAppsRequestMaxBytes)
	if err := decodeStrictJSON(body, target, "request body must contain one JSON object"); err != nil {
		a.writeAgentAPIError(
			c, http.StatusBadRequest,
			teamhubagentapi.AgentApiErrorCodeInvalidRequest,
			"Connected Apps request is invalid",
		)
		return false
	}
	return true
}

func agentConnectedAppToContract(connection agentconnectedapps.ConnectedApp) teamhubagentapi.AgentConnectedApp {
	return teamhubagentapi.AgentConnectedApp{
		ConnectionId: connection.ConnectionID,
		AppKey:       connection.AppKey,
		DisplayName:  connection.DisplayName, IdentityLabel: connection.Identity,
	}
}

func (a *App) writeAgentConnectedAppsError(c *gin.Context, operation string, err error) bool {
	if err == nil {
		return false
	}
	status := http.StatusInternalServerError
	code := teamhubagentapi.AgentApiErrorCodeInternalError
	message := "Connected Apps could not complete the request"
	var issues []teamhubagentapi.AgentApiErrorIssue
	switch {
	case errors.Is(err, agentconnectedapps.ErrInvalid):
		status, code, message = http.StatusBadRequest, teamhubagentapi.AgentApiErrorCodeInvalidInput, "Connected app tool input is invalid"
	case errors.Is(err, agentauth.ErrInvalid):
		status, code, message = http.StatusBadRequest, teamhubagentapi.AgentApiErrorCodeInvalidRequest, "Connected app tool input is invalid"
	case errors.Is(err, agentauth.ErrCredentialInvalid):
		status, code, message = http.StatusUnauthorized, teamhubagentapi.AgentApiErrorCodeAgentCredentialInvalid, "Agent credential is invalid or expired"
	case errors.Is(err, agentauth.ErrForbidden):
		status, code, message = http.StatusForbidden, teamhubagentapi.AgentApiErrorCodeOperationForbidden, "Connected Apps operation is not allowed"
	default:
		var domainError *agentconnectedapps.Error
		if errors.As(err, &domainError) {
			code = teamhubagentapi.AgentApiErrorCode(domainError.Code)
			message = domainError.Message
			for _, issue := range domainError.Issues {
				issues = append(issues, teamhubagentapi.AgentApiErrorIssue{Path: issue.Path, Code: issue.Code, Message: issue.Message})
			}
			switch domainError.Code {
			case "invalid_input", "invalid_tool_arguments":
				status = http.StatusBadRequest
			case "connection_not_found", "tool_not_found":
				status = http.StatusNotFound
			case "connection_not_active", "app_not_connected", "provider_auth_failed", "tool_execution_failed":
				status = http.StatusConflict
			case "provider_rate_limited":
				status = http.StatusTooManyRequests
			case "provider_unavailable":
				status = http.StatusServiceUnavailable
			default:
				status, code, message, issues = http.StatusInternalServerError, teamhubagentapi.AgentApiErrorCodeInternalError, "Connected Apps could not complete the request", nil
			}
		}
	}
	if status == http.StatusInternalServerError && a.logger != nil {
		a.logger.Error("execute Connected Apps operation",
			"request_id", c.GetString("request_id"), "operation", operation,
			"error_type", fmt.Sprintf("%T", err), "occurred_at", time.Now().UTC(),
		)
	}
	a.writeAgentAPIErrorWithIssues(c, status, code, message, issues)
	return true
}

// connectorCallContext carries the CLI's operation ID into the connected
// app call log.
func connectorCallContext(c *gin.Context) context.Context {
	return agentconnectedapps.WithOperationID(c.Request.Context(), c.GetHeader("X-TeamHub-Operation-Id"))
}
