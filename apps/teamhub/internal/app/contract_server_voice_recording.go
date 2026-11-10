package app

import (
	"errors"
	"io"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voice"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

func (a *App) putVoiceMediaObject(c *gin.Context) {
	params := contractParams[teamhubinternal.PutVoiceMediaObjectParams](c)
	if a.voiceRecordings == nil {
		c.JSON(http.StatusNotFound, teamhubinternal.VoiceError{Code: "NOT_FOUND", Message: "Voice recording is not configured"})
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, voice.MaximumVoiceMediaObjectBytes+1))
	if err != nil || len(body) > voice.MaximumVoiceMediaObjectBytes {
		c.JSON(http.StatusBadRequest, teamhubinternal.VoiceError{Code: "INVALID_REQUEST", Message: "Voice media object is too large"})
		return
	}
	a.writeVoiceRecordingResult(c, "store voice media object", a.voiceRecordings.Put(c.Request.Context(), params.Key, body))
}

func (a *App) reportVoiceRecording(c *gin.Context) {
	if a.voiceRecordings == nil {
		c.JSON(http.StatusNotFound, teamhubinternal.VoiceError{Code: "NOT_FOUND", Message: "Voice recording is not configured"})
		return
	}
	var request teamhubinternal.VoiceRecordingReport
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, teamhubinternal.VoiceError{Code: "INVALID_REQUEST", Message: "Voice recording report is invalid"})
		return
	}
	report := voicemedia.RecordingReport{
		StagingPrefix: request.StagingPrefix, State: string(request.State),
		StartedAt: request.StartedAt, ArchivedThroughMS: request.ArchivedThroughMs,
	}
	if request.FailureCode != nil {
		report.FailureCode = *request.FailureCode
	}
	err := a.voiceRecordings.ReportRecording(c.Request.Context(), report)
	a.writeVoiceRecordingResult(c, "report voice recording", err)
}

func (a *App) writeVoiceRecordingResult(c *gin.Context, action string, err error) {
	switch {
	case err == nil:
		c.Status(http.StatusNoContent)
	case errors.Is(err, voicemedia.ErrRecordingInvalid):
		c.JSON(http.StatusBadRequest, teamhubinternal.VoiceError{Code: "INVALID_REQUEST", Message: "Voice recording request is invalid"})
	case errors.Is(err, voicemedia.ErrRecordingNotFound):
		c.JSON(http.StatusNotFound, teamhubinternal.VoiceError{Code: "NOT_FOUND", Message: "Voice recording epoch was not found"})
	case errors.Is(err, voicemedia.ErrRecordingClosed), errors.Is(err, voicemedia.ErrRecordingConflict):
		c.JSON(http.StatusConflict, teamhubinternal.VoiceError{Code: "VOICE_RECORDING_CONFLICT", Message: "Voice recording no longer accepts this object"})
	default:
		a.internalVoiceRuntimeError(c, action, err)
	}
}
