package app

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voice"
)

func (a *App) writeRecordingTaskResult(c *gin.Context, result idempotency.Result, err error) {
	switch {
	case err == nil:
		writeResultResponse(c, result)
	case errors.Is(err, voice.ErrRecordingTaskAgentUnavailable):
		a.writeError(c, http.StatusConflict, "VOICE_TASK_AGENT_UNAVAILABLE", "The recording's Agent is not available")
	case errors.Is(err, artifactstore.ErrTooLarge):
		a.writeArtifactStorageError(c, err)
	default:
		a.writeVoiceMediaError(c, "send recording task", err)
	}
}
