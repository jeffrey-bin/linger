package app

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voice"
)

// sendVoiceCaptureQuestionTask hands a recording's task request to the
// recorder's Another Me; sending it again returns it unchanged.
func (a *App) sendVoiceCaptureQuestionTask(c *gin.Context) {
	task, err := a.voice.SendCaptureQuestionTask(c.Request.Context(), currentPrincipal(c).Session.AccountID,
		c.Param("captureSessionId"), c.Param("questionId"))
	switch {
	case errors.Is(err, voice.ErrNotTaskRequest):
		a.writeError(c, http.StatusConflict, "CONFLICT", "Only a task request can be handed to Another Me")
	case errors.Is(err, voice.ErrVoiceCaptureQuestionSent):
		a.writeError(c, http.StatusConflict, "CONFLICT", "The task request was already sent")
	case err == nil && task.Sent != nil:
		c.JSON(http.StatusOK, task.Sent)
	default:
		a.writeRecordingTaskResult(c, task.Result, err)
	}
}
