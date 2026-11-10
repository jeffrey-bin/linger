package app

import (
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voice"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func (a *App) askVoiceCaptureQuestionRoute(c *gin.Context) {
	id := c.Param("captureSessionId")
	a.askVoiceCaptureQuestion(c, id)
}

// ownVoiceCapture admits only the person who recorded the LiveKit capture;
// their questions and task requests are private to them.
func (a *App) ownVoiceCapture(c *gin.Context, captureID string) bool {
	_, err := a.voice.OwnedCapture(c.Request.Context(), currentPrincipal(c).Session.AccountID, captureID)
	return !a.writeVoiceMediaError(c, "authorize Voice Capture owner", err)
}

func (a *App) listVoiceCaptureQuestions(c *gin.Context) {
	items, err := a.voice.ListCaptureQuestions(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("captureSessionId"))
	if a.writeVoiceMediaError(c, "authorize Voice Capture owner", err) {
		return
	}
	c.JSON(http.StatusOK, httpapi.VoiceCaptureQuestionList{Items: items})
}

func (a *App) askVoiceCaptureQuestion(c *gin.Context, captureID string) {
	var request httpapi.VoiceCaptureQuestionRequest
	if decodeJSON(c, &request) != nil || strings.TrimSpace(request.Question) == "" ||
		utf8.RuneCountInString(request.Question) > voice.VoiceCaptureQuestionMaxRunes {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "question must be a non-empty string of at most 1000 characters")
		return
	}
	if a.voiceCaptureAnswerer == nil {
		a.writeError(c, http.StatusServiceUnavailable, "SERVICE_UNAVAILABLE", "Recording questions are not configured")
		return
	}
	item, err := a.voice.AskCaptureQuestion(c.Request.Context(), currentPrincipal(c).Session.AccountID, captureID, strings.TrimSpace(request.Question))
	switch {
	case c.Request.Context().Err() != nil:
		c.Abort()
	case errors.Is(err, voice.ErrCaptureQuestionUnanswered):
		a.writeRetryableError(c, http.StatusServiceUnavailable, "VOICE_CAPTURE_QUESTION_FAILED", "The recording question could not be answered right now")
	case a.writeVoiceMediaError(c, "authorize Voice Capture owner", err):
	default:
		c.JSON(http.StatusOK, item)
	}
}
