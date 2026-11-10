package app

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
)

// getAnotherMe returns the current Human's Another Me and its Chat.
func (a *App) getAnotherMe(c *gin.Context) {
	model, err := a.agents.AnotherMe(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("tenantId"))
	if errors.Is(err, pgx.ErrNoRows) {
		a.writeError(c, http.StatusNotFound, "TENANT_NOT_FOUND", "Space was not found")
		return
	}
	if err != nil {
		a.internalError(c, "get Another Me", err)
		return
	}
	c.JSON(http.StatusOK, model)
}
