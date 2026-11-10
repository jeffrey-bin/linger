package app

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/collaboration"
)

func (a *App) getMessageActivities(c *gin.Context) {
	log, err := a.collaboration.MessageActivities(c.Request.Context(), currentPrincipal(c).Session.AccountID,
		c.Param("roomId"), c.Param("messageId"), a.messageActivityHistory())
	a.writeActivityLog(c, "get Message activities", log, err)
}

func (a *App) getRunActivities(c *gin.Context) {
	log, err := a.collaboration.RunActivities(c.Request.Context(), currentPrincipal(c).Session.AccountID,
		c.Param("roomId"), c.Param("runId"), a.messageActivityHistory())
	a.writeActivityLog(c, "authorize Runtime activity history", log, err)
}

// messageActivityHistory is nil when the Agent Service cannot read Runtime history.
func (a *App) messageActivityHistory() collaboration.MessageActivityHistoryReader {
	reader, available := a.agentManagement.(collaboration.MessageActivityHistoryReader)
	if !available {
		return nil
	}
	return reader
}

func (a *App) writeActivityLog(c *gin.Context, action string, log any, err error) {
	if errors.Is(err, collaboration.ErrMessageActivitiesUnavailable) {
		a.writeError(c, http.StatusServiceUnavailable, "MESSAGE_ACTIVITIES_UNAVAILABLE", "Message activities are unavailable")
		return
	}
	if a.notFoundOrError(c, action, err) {
		return
	}
	c.JSON(http.StatusOK, log)
}
