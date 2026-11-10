package app

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func (a *App) listExternalApps(c *gin.Context) {
	apps := a.externalSources.ListApps()
	response := httpapi.ExternalAppList{
		Apps: make([]httpapi.ExternalApp, 0, len(apps)), ProviderConfigured: a.externalSources.ProviderConfigured(),
		ProviderKey: externalProviderKeyModel(a.externalSources.ManagedKey()),
	}
	for _, item := range apps {
		capabilities := make([]httpapi.ExternalAppCapability, 0, len(item.Capabilities))
		for _, capability := range item.Capabilities {
			capabilities = append(capabilities, httpapi.ExternalAppCapability(capability))
		}
		response.Apps = append(response.Apps, httpapi.ExternalApp{
			Key: item.Key, DisplayName: item.DisplayName,
			Description: item.Description, Availability: httpapi.ExternalAppAvailability(item.Availability),
			Capabilities: capabilities, AllowsMultipleConnections: item.AllowsMultipleConnections,
			SupportsReauthorization: &item.SupportsReauthorization,
		})
		if item.LogoURL != "" {
			response.Apps[len(response.Apps)-1].LogoUrl = &item.LogoURL
		}
	}
	c.JSON(http.StatusOK, response)
}

// saveExternalProviderKey lets a deployment without COMPOSIO_API_KEY save one.
// Any signed-in Human may save it; the key is never echoed or logged.
func (a *App) saveExternalProviderKey(c *gin.Context) {
	var request httpapi.SaveExternalProviderKeyRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Composio API key request is invalid")
		return
	}
	err := a.externalSources.SaveManagedKey(c.Request.Context(), request.ApiKey)
	switch {
	case errors.Is(err, externalsource.ErrInvalid):
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Composio API key is invalid")
	case errors.Is(err, externalsource.ErrManagedKeyRejected):
		a.writeError(c, http.StatusBadRequest, "COMPOSIO_KEY_REJECTED", "Composio rejected this API key")
	case errors.Is(err, externalsource.ErrManagedKeyFromEnvironment):
		a.writeError(c, http.StatusConflict, "COMPOSIO_KEY_FROM_ENVIRONMENT", "This deployment sets the Composio API key")
	case errors.Is(err, externalsource.ErrManagedKeyStorageMissing):
		a.writeError(c, http.StatusServiceUnavailable, "COMPOSIO_KEY_STORAGE_UNAVAILABLE", "This deployment cannot store a Composio API key")
	case errors.Is(err, externalsource.ErrUnavailable):
		a.writeError(c, http.StatusServiceUnavailable, "EXTERNAL_SOURCE_UNAVAILABLE", "Composio could not be reached; try again")
	case err != nil:
		a.internalError(c, "save Composio API key", err)
	default:
		// The Agents waiting for a key can now ask for their apps. A failure
		// leaves those cards for the user to decline; it never fails the save.
		if a.typedCards != nil {
			if err := a.typedCards.SettleProviderKeys(c.Request.Context()); err != nil {
				a.logger.Error("settle Composio key cards", "error", err)
			}
		}
		c.JSON(http.StatusOK, externalProviderKeyModel(a.externalSources.ManagedKey()))
	}
}

func externalProviderKeyModel(status externalsource.ManagedKeyStatus) httpapi.ExternalProviderKeyStatus {
	return httpapi.ExternalProviderKeyStatus{Source: httpapi.ExternalProviderKeyStatusSource(status.Source), CanSave: status.CanSave}
}

func (a *App) createExternalConnection(c *gin.Context) {
	var request httpapi.CreateExternalConnectionRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "External application connection request is invalid")
		return
	}
	connection, err := a.externalSources.CreateConnection(c.Request.Context(), currentPrincipal(c).Session.AccountID, request.AppKey)
	if errors.Is(err, externalsource.ErrManagedKeyForbidden) {
		a.writeError(c, http.StatusForbidden, "COMPOSIO_CONNECTION_FORBIDDEN", "Composio denied this connection. Check the API key's permissions and confirm this app is available in your Composio project. If the key lacks Write All access, create a new key with Read All and Write All, then update it in Security.")
		return
	}
	if errors.Is(err, externalsource.ErrManagedKeyRejected) {
		a.writeError(c, http.StatusConflict, "COMPOSIO_KEY_REJECTED", "Composio rejected the configured API key")
		return
	}
	if errors.Is(err, externalsource.ErrUnavailable) {
		a.writeError(c, http.StatusServiceUnavailable, "APP_CONNECTION_UNAVAILABLE", "This application is not available for connection")
		return
	}
	if a.writeExternalSourceError(c, "create external connection", err) {
		return
	}
	c.JSON(http.StatusCreated, externalConnectionModel(connection, true))
}

// completeExternalConnectionAuthorization makes the checks of a returning OAuth
// popup due. A named upstream outside this account's pending authorizations is
// not found; the callback itself never counts as success.
func (a *App) completeExternalConnectionAuthorization(c *gin.Context) {
	var request httpapi.CompleteExternalConnectionAuthorizationRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Authorization completion request is invalid")
		return
	}
	upstreamID := ""
	if request.ConnectedAccountId != nil {
		upstreamID = *request.ConnectedAccountId
	}
	err := a.externalSources.CompleteConnectionAuthorization(c.Request.Context(), currentPrincipal(c).Session.AccountID, upstreamID)
	if a.writeExternalSourceError(c, "complete external connection authorization", err) {
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) listExternalConnections(c *gin.Context) {
	connections, err := a.externalSources.ListConnections(c.Request.Context(), currentPrincipal(c).Session.AccountID)
	if a.writeExternalSourceError(c, "list external connections", err) {
		return
	}
	response := httpapi.ExternalConnectionList{Connections: make([]httpapi.ExternalConnection, 0, len(connections))}
	for _, connection := range connections {
		response.Connections = append(response.Connections, externalConnectionModel(connection, false))
	}
	c.JSON(http.StatusOK, response)
}

func (a *App) listExternalConnectionAgentAccess(c *gin.Context) {
	access, err := a.externalSources.ListAgentConnectionAccess(
		c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("externalConnectionId"),
	)
	if a.writeExternalSourceError(c, "list external connection Agent grants", err) {
		return
	}
	response := httpapi.ExternalConnectionAgentAccessList{
		Agents: make([]httpapi.ExternalConnectionAgentAccess, 0, len(access)),
	}
	for _, item := range access {
		response.Agents = append(response.Agents, externalConnectionAgentAccessModel(item))
	}
	c.JSON(http.StatusOK, response)
}

func (a *App) setExternalConnectionAgentAccess(c *gin.Context) {
	var request httpapi.SetExternalConnectionAgentAccessRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "External connection Agent grant request is invalid")
		return
	}
	access, err := a.externalSources.SetAgentConnectionAccess(
		c.Request.Context(), currentPrincipal(c).Session.AccountID,
		c.Param("externalConnectionId"), c.Param("agentActorId"), request.Granted,
	)
	if a.writeExternalSourceError(c, "set external connection Agent grant", err) {
		return
	}
	c.JSON(http.StatusOK, externalConnectionAgentAccessModel(access))
}

// setExternalConnectionAutoReminders turns AnotherMe's listener for one
// connection on or off together with its listener Routines, so the change
// takes effect before the next poll or sweep.
func (a *App) setExternalConnectionAutoReminders(c *gin.Context) {
	var request httpapi.SetExternalConnectionAutoRemindersRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "External connection auto reminders request is invalid")
		return
	}
	ctx, accountID, connectionID := c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("externalConnectionId")
	err := a.externalSources.SetAutoReminders(ctx, accountID, connectionID, request.Enabled)
	if a.writeExternalSourceError(c, "set external connection auto reminders", err) {
		return
	}
	connection, err := a.externalSources.GetConnection(ctx, accountID, connectionID)
	if a.writeExternalSourceError(c, "get external connection", err) {
		return
	}
	c.JSON(http.StatusOK, externalConnectionModel(connection, false))
}

func externalConnectionAgentAccessModel(access externalsource.AgentConnectionAccess) httpapi.ExternalConnectionAgentAccess {
	return httpapi.ExternalConnectionAgentAccess{
		AgentActorId: access.AgentActorID, AgentManagementId: access.AgentManagementID,
		AgentDisplayName: access.AgentDisplayName, TenantId: access.TenantID,
		Granted: access.Granted, Revision: access.Revision,
	}
}

func (a *App) createExternalConnectionStatusCheck(c *gin.Context) {
	var request httpapi.ExternalConnectionStatusCheckRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Status check request is invalid")
		return
	}
	connection, err := a.externalSources.CreateStatusCheck(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("externalConnectionId"), request.ExpectedRevision)
	if a.writeExternalSourceError(c, "create external connection status check", err) {
		return
	}
	c.JSON(http.StatusAccepted, externalConnectionModel(connection, connection.Status == "pending"))
}

func (a *App) createExternalConnectionReauthorization(c *gin.Context) {
	var request httpapi.CreateExternalConnectionReauthorizationRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Reauthorization request is invalid")
		return
	}
	connection, err := a.externalSources.CreateReauthorization(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("externalConnectionId"), request.ExpectedRevision)
	if a.writeExternalSourceError(c, "create external connection reauthorization", err) {
		return
	}
	c.JSON(http.StatusAccepted, externalConnectionModel(connection, connection.Status == "pending"))
}

func (a *App) disconnectExternalConnection(c *gin.Context) {
	var request httpapi.DisconnectExternalConnectionRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Disconnect request is invalid")
		return
	}
	connection, err := a.externalSources.Disconnect(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("externalConnectionId"), request.ExpectedRevision)
	if a.writeExternalSourceError(c, "disconnect external connection", err) {
		return
	}
	c.JSON(http.StatusAccepted, externalConnectionModel(connection, false))
}
