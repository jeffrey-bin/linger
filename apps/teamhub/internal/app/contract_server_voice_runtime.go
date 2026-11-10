package app

import (
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voice"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

// requireVoiceRuntime authenticates the Voice Runtime. Its callbacks exist
// only with voice media on; without it they are not found.
func (a *App) requireVoiceRuntime() gin.HandlerFunc {
	return func(c *gin.Context) {
		if a.voiceMedia == nil {
			c.JSON(http.StatusNotFound, teamhubinternal.VoiceError{Code: "NOT_FOUND", Message: "Voice media is not configured"})
			c.Abort()
			return
		}
		if a.cfg.Voice.RuntimeToken == "" {
			c.JSON(http.StatusServiceUnavailable, teamhubinternal.VoiceError{
				Code: "DEPENDENCY_UNAVAILABLE", Message: "Voice Runtime callback is not configured",
			})
			c.Abort()
			return
		}
		token, ok := strings.CutPrefix(c.GetHeader("Authorization"), "Bearer ")
		if !ok || token == "" || subtle.ConstantTimeCompare([]byte(token), []byte(a.cfg.Voice.RuntimeToken)) != 1 {
			c.JSON(http.StatusUnauthorized, teamhubinternal.VoiceError{
				Code: "UNAUTHENTICATED", Message: "Voice Runtime authentication is invalid",
			})
			c.Abort()
			return
		}
		c.Next()
	}
}

func (a *App) reportVoiceObservationRoute(c *gin.Context) {
	var request teamhubinternal.VoiceObservation
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, teamhubinternal.VoiceError{Code: "INVALID_REQUEST", Message: "Voice observation is invalid"})
		return
	}
	a.reportVoiceObservation(c, request)
}

// reportVoiceObservation applies one Voice Runtime observation. Every write is
// keyed by the event ID, the transcript window or a monotonic offset, so a
// retried observation applies again without a receipt table.
func (a *App) reportVoiceObservation(c *gin.Context, request teamhubinternal.VoiceObservation) {
	if request.MediaEpoch < 0 || request.StartOffsetMs < 0 || request.EndOffsetMs < request.StartOffsetMs ||
		(request.Kind == teamhubinternal.Final &&
			(request.Text == nil || strings.TrimSpace(*request.Text) == "" || request.EndOffsetMs <= request.StartOffsetMs)) ||
		(request.Kind == teamhubinternal.TurnFinalized && (request.Text == nil ||
			(!voice.VoiceFinalIsFormattingOnly(*request.Text) && request.EndOffsetMs <= request.StartOffsetMs))) {
		c.JSON(http.StatusBadRequest, teamhubinternal.VoiceError{Code: "INVALID_REQUEST", Message: "Voice observation fields are invalid"})
		return
	}
	status, err := a.voice.ReportObservation(c.Request.Context(), request)
	switch {
	case errors.Is(err, voice.ErrVoiceSessionNotFound):
		c.JSON(http.StatusNotFound, teamhubinternal.VoiceError{Code: "NOT_FOUND", Message: "VoiceSession was not found"})
		return
	case errors.Is(err, voice.ErrVoicePurposeConflict):
		c.JSON(http.StatusConflict, teamhubinternal.VoiceError{Code: "VOICE_PURPOSE_CONFLICT", Message: "Dictation turns require a live chat dictation session"})
		return
	case errors.Is(err, voice.ErrVoiceEventConflict):
		c.JSON(http.StatusConflict, teamhubinternal.VoiceError{Code: "EVENT_CONFLICT", Message: "Voice event conflicts with existing evidence"})
		return
	case err != nil:
		a.internalVoiceRuntimeError(c, "apply Voice observation", err)
		return
	}
	receiptStatus := teamhubinternal.VoiceObservationReceiptStatusAccepted
	if status == "ignored" {
		receiptStatus = teamhubinternal.VoiceObservationReceiptStatusIgnored
	}
	c.JSON(http.StatusAccepted, teamhubinternal.VoiceObservationReceipt{
		EventId: request.EventId, Status: receiptStatus,
	})
}

func (a *App) internalVoiceRuntimeError(c *gin.Context, operation string, err error) {
	a.logger.Error(operation, "error", err)
	c.JSON(http.StatusInternalServerError, teamhubinternal.VoiceError{
		Code: "INTERNAL_ERROR", Message: "Voice observation could not be processed",
	})
}
