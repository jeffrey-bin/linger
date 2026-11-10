package app

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/collaboration"
)

func (a *App) createOrGetMessageThread(c *gin.Context) {
	thread, created, err := a.collaboration.CreateOrGetMessageThread(
		c.Request.Context(),
		currentPrincipal(c).Session.AccountID,
		c.Param("roomId"),
		c.Param("messageId"),
	)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		a.writeError(c, http.StatusNotFound, "NOT_FOUND", "room or message was not found")
	case errors.Is(err, collaboration.ErrThreadNested), errors.Is(err, collaboration.ErrThreadRootInvalid):
		a.writeError(c, http.StatusBadRequest, "INVALID_THREAD_ROOT", "a Thread can only be created from a parent-timeline conversation Message")
	case err != nil:
		a.internalError(c, "create or get message thread", err)
	case created:
		c.JSON(http.StatusCreated, thread)
	default:
		c.JSON(http.StatusOK, thread)
	}
}
