package app

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/collaboration"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voice"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func (a *App) listVoiceTranscriptEvents(c *gin.Context) {
	params := contractParams[httpapi.ListVoiceTranscriptEventsParams](c)
	if !a.ownVoiceSession(c, c.Param("voiceSessionId")) {
		return
	}
	after := time.Unix(0, 0).UTC()
	if params.AfterUpdatedAt != nil {
		after = *params.AfterUpdatedAt
	}
	afterID := ""
	if params.AfterId != nil {
		afterID = *params.AfterId
	}
	page, err := a.voice.TranscriptEvents(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("voiceSessionId"), after, afterID)
	if a.writeVoiceMediaError(c, "list Voice transcript events", err) {
		return
	}
	c.JSON(http.StatusOK, page)
}

func (a *App) createVoiceSession(c *gin.Context) {
	if !a.requireVoiceMedia(c) {
		return
	}
	var request httpapi.VoiceSessionCreateRequest
	if decodeJSON(c, &request) != nil {
		return
	}
	purpose := string(request.Purpose)
	if purpose != voicemedia.PurposeHardwareControl && purpose != voicemedia.PurposeChatDictation && purpose != voicemedia.PurposeChatLive {
		a.writeError(c, http.StatusBadRequest, "INVALID_VOICE_PURPOSE", "Voice session purpose is invalid")
		return
	}
	// Live runs on xAI alone; every other purpose transcribes with Soniox.
	if purpose == voicemedia.PurposeChatLive && a.cfg.Voice.XaiAPIKey == "" {
		a.writeVoiceMediaError(c, "start Live", voicemedia.ErrProviderUnavailable)
		return
	}
	if purpose != voicemedia.PurposeChatLive && !a.voiceTranscription {
		a.writeVoiceMediaError(c, "start voice transcription", voicemedia.ErrProviderUnavailable)
		return
	}
	session, err := a.voiceMedia.CreateVoiceSession(c.Request.Context(), voicemedia.CreateVoiceSessionRequest{
		AccountID: currentPrincipal(c).Session.AccountID, AuthSessionID: currentPrincipal(c).Session.ID,
		RoomID: c.Param("roomId"), Purpose: purpose,
	})
	if a.writeVoiceMediaError(c, "create VoiceSession", err) {
		return
	}
	c.JSON(http.StatusCreated, voice.VoiceSessionModel(session))
}

func (a *App) commitVoiceDictationTurn(c *gin.Context) {
	if !a.requireVoiceMedia(c) {
		return
	}
	var request httpapi.VoiceDictationCommitRequest
	if decodeJSON(c, &request) != nil {
		return
	}
	if !voice.VoiceDictationRequestIDPattern.MatchString(request.RequestId) {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Dictation commit request ID is invalid")
		return
	}
	if !a.ownVoiceSession(c, c.Param("voiceSessionId")) {
		return
	}
	committer, ok := a.voiceMedia.(interface {
		CommitDictationTurn(context.Context, string, string, string) error
	})
	if !ok {
		a.writeVoiceMediaError(c, "commit Voice dictation turn", voicemedia.ErrProviderUnavailable)
		return
	}
	if a.writeVoiceMediaError(c, "commit Voice dictation turn", committer.CommitDictationTurn(
		c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("voiceSessionId"), request.RequestId,
	)) {
		return
	}
	c.JSON(http.StatusAccepted, httpapi.VoiceDictationCommitReceipt{RequestId: request.RequestId, Status: httpapi.Accepted})
}

// ownVoiceSession admits only the login session that created the VoiceSession;
// another browser of the same Account gets not found like any other caller.
func (a *App) ownVoiceSession(c *gin.Context, voiceSessionID string) bool {
	err := a.voice.OwnVoiceSession(c.Request.Context(), currentPrincipal(c).Session.ID, voiceSessionID)
	return !a.writeVoiceMediaError(c, "authorize VoiceSession login session", err)
}

// ownCaptureVoiceSession admits only the login session whose VoiceSession
// records the Capture.
func (a *App) ownCaptureVoiceSession(c *gin.Context, captureID string) bool {
	err := a.voice.OwnCaptureVoiceSession(c.Request.Context(), currentPrincipal(c).Session.ID, captureID)
	return !a.writeVoiceMediaError(c, "authorize Voice Capture login session", err)
}

func (a *App) getVoiceSession(c *gin.Context) {
	if !a.requireVoiceMedia(c) || !a.ownVoiceSession(c, c.Param("voiceSessionId")) {
		return
	}
	session, err := a.voiceMedia.GetVoiceSession(
		c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("voiceSessionId"),
	)
	if a.writeVoiceMediaError(c, "get VoiceSession", err) {
		return
	}
	c.JSON(http.StatusOK, voice.VoiceSessionModel(session))
}

func (a *App) getActiveVoiceSession(c *gin.Context) {
	if !a.requireVoiceMedia(c) {
		return
	}
	session, err := a.voiceMedia.GetActiveVoiceSession(
		c.Request.Context(), currentPrincipal(c).Session.AccountID, currentPrincipal(c).Session.ID, c.Param("roomId"),
	)
	if a.writeVoiceMediaError(c, "get active VoiceSession", err) {
		return
	}
	c.JSON(http.StatusOK, voice.VoiceSessionModel(session))
}

func (a *App) createVoiceSessionCredential(c *gin.Context) {
	if !a.requireVoiceMedia(c) || !a.ownVoiceSession(c, c.Param("voiceSessionId")) {
		return
	}
	grant, err := a.voiceMedia.IssuePublisherGrant(
		c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("voiceSessionId"),
	)
	if a.writeVoiceMediaError(c, "issue VoiceSession credential", err) {
		return
	}
	c.JSON(http.StatusCreated, httpapi.VoiceConnectionCredential{
		Endpoint: grant.Endpoint, Credential: grant.Credential,
		ExpiresAt: grant.ExpiresAt, Generation: grant.Generation,
	})
}

func (a *App) closeVoiceSession(c *gin.Context) {
	if !a.requireVoiceMedia(c) || !a.ownVoiceSession(c, c.Param("voiceSessionId")) {
		return
	}
	session, err := a.voiceMedia.CloseVoiceSession(
		c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("voiceSessionId"),
	)
	if a.writeVoiceMediaError(c, "close VoiceSession", err) {
		return
	}
	c.JSON(http.StatusOK, voice.VoiceSessionModel(session))
}

func (a *App) startVoiceCapture(c *gin.Context) {
	if !a.requireVoiceMedia(c) {
		return
	}
	var request httpapi.VoiceCaptureStartRequest
	if decodeJSON(c, &request) != nil {
		return
	}
	if request.RoomId != c.Param("roomId") && c.Param("roomId") != "" {
		a.writeError(c, http.StatusBadRequest, "VOICE_CAPTURE_ROOM_MISMATCH", "Voice Capture Room does not match the route")
		return
	}
	if !a.ownVoiceSession(c, c.Param("voiceSessionId")) {
		return
	}
	capture, err := a.voiceMedia.BeginCapture(c.Request.Context(), voicemedia.BeginCaptureRequest{
		AccountID: currentPrincipal(c).Session.AccountID, VoiceSessionID: c.Param("voiceSessionId"),
		RoomID: request.RoomId, StartOffsetMS: request.StartOffsetMs,
	})
	if a.writeVoiceMediaError(c, "start Voice Capture", err) {
		return
	}
	c.JSON(http.StatusAccepted, voice.VoiceCaptureModel(capture))
}

// getVoiceCapture shows a Capture only to the person who recorded it; it
// outlives its VoiceSession, so any of their login sessions may read it.
func (a *App) getVoiceCapture(c *gin.Context) {
	if !a.requireVoiceMedia(c) || !a.ownVoiceCapture(c, c.Param("captureSessionId")) {
		return
	}
	capture, err := a.voiceMedia.GetCapture(
		c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("captureSessionId"),
	)
	if a.writeVoiceMediaError(c, "get Voice Capture", err) {
		return
	}
	c.JSON(http.StatusOK, voice.VoiceCaptureModel(capture))
}

func (a *App) getActiveVoiceCapture(c *gin.Context) {
	if !a.requireVoiceMedia(c) {
		return
	}
	capture, err := a.voiceMedia.GetActiveCapture(
		c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("roomId"),
	)
	if errors.Is(err, voicemedia.ErrNoActiveCapture) {
		_, roomErr := a.collaboration.AuthorizedRoom(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("roomId"))
		if a.writeVoiceMediaError(c, "authorize empty Voice Capture", roomErr) {
			return
		}
		c.JSON(http.StatusOK, nil)
		return
	}
	if a.writeVoiceMediaError(c, "get active Voice Capture", err) {
		return
	}
	c.JSON(http.StatusOK, voice.VoiceCaptureModel(capture))
}

func (a *App) stopVoiceCapture(c *gin.Context) {
	if !a.requireVoiceMedia(c) || !a.ownCaptureVoiceSession(c, c.Param("captureSessionId")) {
		return
	}
	capture, err := a.voiceMedia.EndCapture(c.Request.Context(), voicemedia.EndCaptureRequest{
		AccountID: currentPrincipal(c).Session.AccountID, CaptureSessionID: c.Param("captureSessionId"),
	})
	if a.writeVoiceMediaError(c, "stop Voice Capture", err) {
		return
	}
	c.JSON(http.StatusAccepted, voice.VoiceCaptureModel(capture))
}

func (a *App) writeVoiceMediaError(c *gin.Context, operation string, err error) bool {
	if err == nil {
		return false
	}
	var internal *collaboration.InternalError
	switch {
	case errors.As(err, &internal):
		a.internalError(c, internal.Action, internal.Err)
	case errors.Is(err, pgx.ErrNoRows):
		a.writeError(c, http.StatusNotFound, "NOT_FOUND", "Voice media resource was not found")
	case errors.Is(err, idempotency.ErrConflict):
		a.writeError(c, http.StatusConflict, "IDEMPOTENCY_KEY_REUSED", "idempotency key was used with different input")
	case errors.Is(err, voicemedia.ErrSessionClosed):
		a.writeError(c, http.StatusConflict, "VOICE_SESSION_CLOSED", "VoiceSession is closed")
	case errors.Is(err, voicemedia.ErrLiveUnavailable):
		a.writeError(c, http.StatusConflict, "LIVE_UNAVAILABLE", "Live requires an active Room Agent")
	case errors.Is(err, voicemedia.ErrCaptureConflict):
		a.writeError(c, http.StatusConflict, "VOICE_CAPTURE_CONFLICT", "Voice Capture state conflicts with the request")
	case errors.Is(err, voicemedia.ErrTranscriptIntegrityLost):
		a.writeError(c, http.StatusConflict, "VOICE_TRANSCRIPT_INCOMPLETE", "Voice transcript contains an unconfirmed input interval")
	case errors.Is(err, voicemedia.ErrProviderUnavailable):
		a.writeError(c, http.StatusServiceUnavailable, "VOICE_MEDIA_UNAVAILABLE", "Voice media provider is temporarily unavailable")
	default:
		a.internalError(c, operation, err)
	}
	return true
}
