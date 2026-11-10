package app

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/collaboration"
)

func (a *App) deleteRoom(c *gin.Context) {
	err := a.collaboration.DeleteRoom(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("roomId"))
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		a.writeError(c, http.StatusNotFound, "NOT_FOUND", "room was not found")
	case errors.Is(err, collaboration.ErrRoomOwnerRequired):
		a.writeError(c, http.StatusForbidden, "ROOM_OWNER_REQUIRED", "only a Room owner can delete the Room")
	case errors.Is(err, collaboration.ErrRoomIsWorkRoom):
		a.writeError(c, http.StatusConflict, "ROOM_IS_MANAGED", "a Work Room cannot be deleted independently from its Work Item")
	case errors.Is(err, collaboration.ErrDirectRoomImmutable):
		a.writeError(c, http.StatusConflict, "DIRECT_ROOM_IMMUTABLE", "Direct Room cannot be deleted")
	case errors.Is(err, collaboration.ErrThreadImmutable):
		a.writeError(c, http.StatusConflict, "THREAD_ROOM_IMMUTABLE", "Thread room cannot be deleted independently")
	case errors.Is(err, collaboration.ErrPendingCardDecision):
		a.writeError(c, http.StatusConflict, "PENDING_CARD_DECISION", "resolve pending card work before deleting the Room")
	case err != nil:
		a.internalError(c, "delete room", err)
	default:
		c.Status(http.StatusNoContent)
	}
}
