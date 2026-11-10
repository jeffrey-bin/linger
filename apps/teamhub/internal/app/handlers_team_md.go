package app

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

func (a *App) getRoomTeamMd(c *gin.Context) {
	document, err := a.collaboration.RoomTeamMd(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("roomId"))
	if a.notFoundOrError(c, "read Room team document", err) {
		return
	}
	c.JSON(http.StatusOK, document)
}
