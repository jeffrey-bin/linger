package app

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentconnectedapps"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/proactive"
	api "github.com/simplexai-labs/linger/contracts-go/teamhubagentapi"
)

func (a *App) listConnectorAutoReminders(c *gin.Context) {
	token, ok := a.agentCommandBearer(c)
	if !ok {
		return
	}
	var input struct{}
	if err := decodeStrictJSON(http.MaxBytesReader(c.Writer, c.Request.Body, 1024), &input, "invalid request"); err != nil {
		a.writeAgentAPIError(c, http.StatusBadRequest, api.AgentApiErrorCodeInvalidInput, "Invalid auto reminders request")
		return
	}
	ctx := c.Request.Context()
	accountID, err := a.agentConnectedApps.AutoRemindersAccount(ctx, token)
	if a.askForProviderKey(c, token, "", err) || a.writeAutoRemindersError(c, err) {
		return
	}
	connections, err := a.externalSources.ListConnections(ctx, accountID)
	if a.writeAutoRemindersError(c, err) {
		return
	}
	items := []api.ConnectorAutoReminders{}
	for _, connection := range connections {
		if proactive.IsListenerProvider(connection.Provider) {
			items = append(items, connectorAutoRemindersModel(connection))
		}
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"connections": items})
}

func (a *App) setConnectorAutoReminders(c *gin.Context) {
	token, ok := a.agentCommandBearer(c)
	if !ok {
		return
	}
	var input struct {
		ConnectionID string `json:"connection_id"`
		Enabled      *bool  `json:"enabled"`
	}
	if err := decodeStrictJSON(http.MaxBytesReader(c.Writer, c.Request.Body, 1024), &input, "invalid request"); err != nil || input.ConnectionID == "" || len(input.ConnectionID) > 128 || input.Enabled == nil {
		a.writeAgentAPIError(c, http.StatusBadRequest, api.AgentApiErrorCodeInvalidInput, "Invalid auto reminders request")
		return
	}
	ctx := c.Request.Context()
	accountID, err := a.agentConnectedApps.SetAutoReminders(ctx, token, input.ConnectionID, *input.Enabled)
	if a.askForProviderKey(c, token, "", err) || a.writeAutoRemindersError(c, err) {
		return
	}
	connection, err := a.externalSources.GetConnection(ctx, accountID, input.ConnectionID)
	if a.writeAutoRemindersError(c, err) {
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, connectorAutoRemindersModel(connection))
}

func (a *App) writeAutoRemindersError(c *gin.Context, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, agentconnectedapps.ErrAutoRemindersNotAnotherMe):
		a.writeAgentAPIError(c, http.StatusForbidden, api.AgentApiErrorCodeForbidden, "Only Another Me can change its Human's auto reminders")
	case errors.Is(err, agentconnectedapps.ErrNoSponsorAccount):
		a.writeAgentAPIError(c, http.StatusForbidden, api.AgentApiErrorCodeForbidden, "This Agent has no Human Sponsor whose connections it can manage")
	case errors.Is(err, externalsource.ErrNotFound):
		a.writeAgentAPIError(c, http.StatusNotFound, api.AgentApiErrorCodeConnectionNotFound, "Your Sponsor has no such connection")
	case errors.Is(err, externalsource.ErrInvalid):
		a.writeAgentAPIError(c, http.StatusBadRequest, api.AgentApiErrorCodeInvalidInput, "This app does not support auto reminders")
	default:
		return a.writeAgentAuthError(c, "manage connector auto reminders", err)
	}
	return true
}

func connectorAutoRemindersModel(connection externalsource.Connection) api.ConnectorAutoReminders {
	return api.ConnectorAutoReminders{
		ConnectionId: connection.ID, AppKey: connection.Provider, IdentityLabel: connection.IdentityLabel,
		Status: connection.Status, Enabled: connection.AutoReminders,
	}
}
