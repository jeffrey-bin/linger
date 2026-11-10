package app

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomcreation"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func (a *App) openDirectRoom(c *gin.Context) {
	var request httpapi.DirectRoomOpenRequest
	if decodeJSON(c, &request) != nil || request.PeerActorId == "" {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Direct Room peer is invalid")
		return
	}
	result, err := a.collaboration.OpenDirectRoom(
		c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("tenantId"), request.PeerActorId,
	)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		a.writeError(c, http.StatusNotFound, "AGENT_NOT_FOUND", "Agent is unavailable")
	case errors.Is(err, roomcreation.ErrDirectRoomDeleting):
		a.writeError(c, http.StatusConflict, "DIRECT_ROOM_DELETING", "Direct Room is being deleted")
	case errors.Is(err, roomcreation.ErrInvalid):
		a.writeError(c, http.StatusConflict, "DIRECT_ROOM_INVALID", "Direct Room could not be created")
	case err != nil:
		a.internalError(c, "open Direct Room", err)
	default:
		c.JSON(result.Status, result.Room)
	}
}
