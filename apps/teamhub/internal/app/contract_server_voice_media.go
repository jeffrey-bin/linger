package app

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voice"
)

func (a *App) retryVoiceCaptureTranscript(c *gin.Context) {
	id := c.Param("captureSessionId")
	if !a.requireVoiceMedia(c) || !a.ownVoiceCapture(c, id) {
		return
	}
	retryErr := a.voiceMedia.RetryTranscriptRecovery(c.Request.Context(), currentPrincipal(c).Session.AccountID, id)
	if retryErr != nil && !errors.Is(retryErr, pgx.ErrNoRows) && a.writeVoiceMediaError(c, "retry archive transcript", retryErr) {
		return
	}
	capture, err := a.voiceMedia.GetCapture(c.Request.Context(), currentPrincipal(c).Session.AccountID, id)
	if a.writeVoiceMediaError(c, "read archive transcript retry", err) {
		return
	}
	if errors.Is(retryErr, pgx.ErrNoRows) && capture.TranscriptRecoveryStatus == "" {
		a.writeVoiceMediaError(c, "retry archive transcript", retryErr)
		return
	}
	c.JSON(http.StatusAccepted, voice.VoiceCaptureModel(capture))
}

func (a *App) requireVoiceMedia(c *gin.Context) bool {
	if a.voiceMedia != nil {
		return true
	}
	a.writeError(c, http.StatusServiceUnavailable, "VOICE_MEDIA_UNAVAILABLE", "Hardware Voice media is not configured")
	return false
}
