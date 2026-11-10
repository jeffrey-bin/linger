package app

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

func (a *App) listVoiceLiveTasksRoute(c *gin.Context) {
	voiceSessionID := c.Param("voiceSessionId")
	response, err := a.voice.LiveTasks(c.Request.Context(), voiceSessionID)
	if a.writeVoiceLiveError(c, "read live Voice tasks", err) {
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, response)
}
