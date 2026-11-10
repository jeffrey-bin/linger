package app

import (
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voice"
)

// streamVoiceLiveTaskEvents tells Voice Runtime the moment a task or app
// event of the call's Room changed, so it reads them at once instead of
// polling. Each event is only a hint to read live-tasks again.
func (a *App) streamVoiceLiveTaskEvents(c *gin.Context) {
	voiceSessionID := c.Param("voiceSessionId")
	ctx := c.Request.Context()
	roomID, err := a.voice.LiveReplyRoom(ctx, voiceSessionID)
	if a.writeVoiceLiveError(c, "resolve live VoiceSession", err) {
		return
	}
	// Subscribe before answering so no change after the reader's next read
	// is missed.
	subscription := a.broker.Subscribe("voicetasks:" + roomID)
	defer subscription.Close()
	flusher, ok := c.Writer.(http.Flusher)
	if !ok {
		a.internalVoiceRuntimeError(c, "stream live Voice task events", errors.New("response writer does not support flushing"))
		return
	}
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("X-Accel-Buffering", "no")
	c.Status(http.StatusOK)
	write := func(text string) bool {
		if _, err := fmt.Fprint(c.Writer, text); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	if !write(": connected\n\n") {
		return
	}
	heartbeat := time.NewTicker(voice.VoiceLiveEventsHeartbeat)
	defer heartbeat.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-a.streamsDone.Done():
			return
		case <-subscription.Done():
			return
		case <-subscription.Events():
			if !write("event: changed\ndata: {}\n\n") {
				return
			}
		case <-heartbeat.C:
			if _, err := a.voice.LiveReplyRoom(ctx, voiceSessionID); err != nil || !write(": ping\n\n") {
				return
			}
		}
	}
}
