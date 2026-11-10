package app

import (
	"context"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func (a *App) getExternalConnection(c *gin.Context) {
	connection, err := a.externalSources.GetConnection(
		c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("externalConnectionId"),
	)
	if a.writeExternalSourceError(c, "get external connection", err) {
		return
	}
	c.JSON(http.StatusOK, externalConnectionModel(connection, connection.Status == "pending"))
}

func externalConnectionModel(connection externalsource.Connection, includeConnectURL bool) httpapi.ExternalConnection {
	model := httpapi.ExternalConnection{
		Id: connection.ID, Provider: connection.Provider,
		Status: httpapi.ExternalConnectionStatus(connection.Status), Revision: connection.Revision,
		AutoReminders: connection.AutoReminders, CreatedAt: connection.CreatedAt, UpdatedAt: connection.UpdatedAt,
	}
	if connection.IdentityLabel != "" {
		model.IdentityLabel = &connection.IdentityLabel
	}
	model.StatusCheckedAt = connection.StatusCheckedAt
	if connection.StatusErrorCode != "" {
		model.StatusErrorCode = &connection.StatusErrorCode
	}
	if includeConnectURL && connection.ConnectURL != "" {
		model.ConnectUrl = &connection.ConnectURL
		model.ConnectExpiresAt = connection.ConnectExpiresAt
	}
	model.StatusCheckRequestedAt = connection.StatusCheckRequestedAt
	if connection.ReauthorizationUpstreamID != "" {
		reauthorizing := true
		model.Reauthorizing = &reauthorizing
	}
	if connection.ReauthorizationUpstreamID != "" && connection.ReauthorizationConnectURL != "" {
		model.ReauthorizationConnectUrl = &connection.ReauthorizationConnectURL
		model.ReauthorizationConnectExpiresAt = connection.ReauthorizationConnectExpiresAt
	}
	if connection.ReauthorizationErrorCode != "" {
		code := httpapi.ExternalConnectionReauthorizationErrorCode(connection.ReauthorizationErrorCode)
		model.ReauthorizationErrorCode = &code
	}
	return model
}

func (a *App) writeExternalSourceError(c *gin.Context, action string, err error) bool {
	if err == nil {
		return false
	}
	switch {
	case errors.Is(err, externalsource.ErrInvalid):
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "External source request is invalid")
	case errors.Is(err, externalsource.ErrNotFound):
		a.writeError(c, http.StatusNotFound, "NOT_FOUND", "External connection was not found")
	case errors.Is(err, externalsource.ErrNotActive):
		a.writeError(c, http.StatusConflict, "EXTERNAL_CONNECTION_NOT_ACTIVE", "External connection is not active")
	case errors.Is(err, externalsource.ErrUnavailable),
		errors.Is(err, context.DeadlineExceeded),
		errors.Is(err, context.Canceled):
		a.writeError(c, http.StatusServiceUnavailable, "EXTERNAL_SOURCE_UNAVAILABLE", "External source provider is unavailable")
	case errors.Is(err, externalsource.ErrConflict):
		a.writeError(c, http.StatusConflict, "CONFLICT", "External source request conflicts with current state")
	case errors.Is(err, externalsource.ErrStaleRevision):
		a.writeError(c, http.StatusConflict, "STALE_REVISION", "External source state changed; refresh before retrying")
	default:
		a.internalError(c, action, err)
	}
	return true
}
