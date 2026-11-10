package app

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/proactive"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

// The Agent's proactive feature reviews its AnotherMe direct Room in windows of
// twenty ordinary messages and queues wakes for that Room. TeamHub holds the
// window progress and the quiet-wake queue; the judgement is the Agent's.

func (a *App) getProactiveWindow(c *gin.Context) {
	window, err := a.proactive.NextWindow(c.Request.Context(), c.Param("agentId"), c.Param("roomId"))
	if a.writeProactiveWindowError(c, "read proactive window", err) {
		return
	}
	if window == nil {
		c.JSON(http.StatusOK, gin.H{})
		return
	}
	c.JSON(http.StatusOK, gin.H{"window": window})
}

func (a *App) finishProactiveWindow(c *gin.Context) {
	var request teamhubinternal.ProactiveWindowFinishRequest
	if err := decodeJSON(c, &request); err != nil || request.JudgedCount < 0 {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "judged_count is required")
		return
	}
	err := a.proactive.FinishWindow(c.Request.Context(), c.Param("agentId"), c.Param("roomId"), request.JudgedCount)
	if !a.writeProactiveWindowError(c, "finish proactive window", err) {
		c.Status(http.StatusNoContent)
	}
}

func (a *App) queueProactiveWake(c *gin.Context) {
	var request teamhubinternal.ProactiveWakeRequest
	if err := decodeJSON(c, &request); err != nil || request.Body == "" || len([]rune(request.Body)) > 20000 {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "body is required")
		return
	}
	err := a.proactive.QueueWake(c.Request.Context(), c.Param("agentId"), c.Param("roomId"), request.Body)
	if !a.writeProactiveWindowError(c, "queue proactive wake", err) {
		c.Status(http.StatusNoContent)
	}
}

func (a *App) writeProactiveWindowError(c *gin.Context, operation string, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, proactive.ErrNotAnotherMeRoom):
		a.writeError(c, http.StatusNotFound, "ANOTHERME_ROOM_NOT_FOUND", "The Agent is not the active AnotherMe of this Room")
	case errors.Is(err, proactive.ErrWindowMoved):
		a.writeError(c, http.StatusConflict, "PROACTIVE_WINDOW_MOVED", "The window was already judged")
	case errors.Is(err, proactive.ErrInvalidEvent):
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "body is required")
	default:
		a.internalError(c, operation, err)
	}
	return true
}
