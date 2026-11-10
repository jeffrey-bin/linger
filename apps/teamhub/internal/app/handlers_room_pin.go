package app

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
)

// updateRoomPin records a pin private to the calling Human; repeating a pin
// keeps its original time so the most recently pinned Room stays first.
func (a *App) updateRoomPin(c *gin.Context) {
	// The generated request type cannot tell a missing `pinned` from false,
	// and treating an empty body as "unpin" would silently drop a pin.
	var request struct {
		Pinned *bool `json:"pinned"`
	}
	if decodeJSON(c, &request) != nil || request.Pinned == nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "pinned must be a boolean")
		return
	}
	state, err := a.collaboration.UpdateRoomPin(
		c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("roomId"), *request.Pinned,
	)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		a.writeError(c, http.StatusNotFound, "ROOM_NOT_FOUND", "Room membership was not found")
	case err != nil:
		a.internalError(c, "update Room pin", err)
	default:
		c.JSON(http.StatusOK, state)
	}
}
