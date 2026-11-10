package app

import (
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voice"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicelive"
	teamhubinternal "github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

func (a *App) getVoiceLiveContext(c *gin.Context) {
	response, err := a.voice.LiveContext(c.Request.Context(), c.Param("voiceSessionId"), a.connectedAppsConfigured())
	if a.writeVoiceLiveError(c, "read live Voice context", err) {
		return
	}
	c.JSON(http.StatusOK, response)
}

func (a *App) reportVoiceLiveReply(c *gin.Context) {
	var request teamhubinternal.VoiceLiveReply
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, teamhubinternal.VoiceError{Code: "INVALID_REQUEST", Message: "Live reply is invalid"})
		return
	}
	result, err := a.voice.SaveLiveReply(c.Request.Context(), request)
	if a.writeVoiceLiveError(c, "save live Voice reply", err) {
		return
	}
	status := teamhubinternal.VoiceLiveReplyReceiptStatusAccepted
	if result.Replayed {
		status = teamhubinternal.VoiceLiveReplyReceiptStatusReplayed
	}
	c.JSON(http.StatusAccepted, teamhubinternal.VoiceLiveReplyReceipt{
		EventId: request.EventId, MessageId: &result.MessageID, Status: status,
	})
}

func (a *App) executeVoiceLiveToolCall(c *gin.Context) {
	var request teamhubinternal.VoiceLiveToolCall
	if err := c.ShouldBindJSON(&request); err != nil || strings.TrimSpace(request.CallId) == "" ||
		len(request.CallId) > 255 || len(request.TurnId) > 255 || len(request.Name) > 64 ||
		utf8.RuneCountInString(request.Arguments) > 20000 {
		c.JSON(http.StatusBadRequest, teamhubinternal.VoiceError{Code: "INVALID_REQUEST", Message: "Live tool call is invalid"})
		return
	}
	output, err := a.voice.ExecuteLiveToolCall(c.Request.Context(), request)
	if errors.Is(err, voice.ErrCallIDConflict) {
		c.JSON(http.StatusConflict, teamhubinternal.VoiceError{Code: "CALL_ID_CONFLICT", Message: "Operation identity was reused for different arguments"})
		return
	}
	if a.writeVoiceLiveError(c, "execute live tool", err) {
		return
	}
	c.JSON(http.StatusOK, teamhubinternal.VoiceLiveToolResult{CallId: request.CallId, Output: output})
}

func (a *App) writeVoiceLiveError(c *gin.Context, operation string, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, voicelive.ErrNotFound):
		c.JSON(http.StatusNotFound, teamhubinternal.VoiceError{Code: "NOT_FOUND", Message: "Live VoiceSession was not found"})
	case errors.Is(err, voicelive.ErrTurnPending):
		c.JSON(http.StatusConflict, teamhubinternal.VoiceError{Code: "VOICE_LIVE_TURN_PENDING", Message: "The Human Message of this live turn has not arrived yet"})
	case errors.Is(err, voicelive.ErrInvalid):
		c.JSON(http.StatusBadRequest, teamhubinternal.VoiceError{Code: "INVALID_REQUEST", Message: "Live Voice input is invalid"})
	default:
		a.internalVoiceRuntimeError(c, operation, err)
	}
	return true
}
