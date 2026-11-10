package app

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/collaboration"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func (a *App) updateRoomReadState(c *gin.Context) {
	var request httpapi.RoomReadStateUpdateRequest
	if decodeJSON(c, &request) != nil || request.ThroughRoomSeq < 0 {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "through_room_seq must be a non-negative integer")
		return
	}
	state, err := a.collaboration.UpdateRoomReadState(
		c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("roomId"), request.ThroughRoomSeq,
	)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		a.writeError(c, http.StatusNotFound, "ROOM_NOT_FOUND", "Room membership was not found")
	case errors.Is(err, collaboration.ErrReadCursorAhead):
		a.writeError(c, http.StatusBadRequest, "READ_CURSOR_AHEAD", "through_room_seq exceeds the Room's committed sequence")
	case err != nil:
		a.internalError(c, "update Room read state", err)
	default:
		c.JSON(http.StatusOK, state)
	}
}
