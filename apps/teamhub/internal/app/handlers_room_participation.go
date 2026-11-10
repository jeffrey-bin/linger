package app

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/collaboration"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func (a *App) setRoomParticipation(c *gin.Context) {
	var input httpapi.RoomParticipationRequest
	if err := decodeJSON(c, &input); err != nil || (input.Status != "joined" && input.Status != "left") {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "participation must be joined or left")
		return
	}
	room, err := a.collaboration.SetRoomParticipation(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("roomId"), input)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		a.writeError(c, http.StatusNotFound, "ROOM_NOT_FOUND", "room was not found")
	case errors.Is(err, collaboration.ErrDirectRoomImmutable), errors.Is(err, collaboration.ErrThreadImmutable):
		a.writeError(c, http.StatusConflict, "ROOM_PARTICIPATION_UNAVAILABLE", "only ordinary Rooms can be left or rejoined")
	case err != nil:
		a.internalError(c, "set Room participation", err)
	default:
		c.JSON(http.StatusOK, room)
	}
}
