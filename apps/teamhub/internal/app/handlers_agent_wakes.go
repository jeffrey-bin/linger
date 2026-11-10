package app

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/realtime"
)

// This stream carries service-only hints. A hint is never a receipt: the
// Agent Service claims queued Runs and reads steers itself, and its periodic
// scan of waiting Runs covers a lost hint.
func (a *App) streamAgentWakes(c *gin.Context) {
	subscription := a.broker.Subscribe(realtime.AgentInboxWakeTopic)
	defer subscription.Close()
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no")
	c.Status(http.StatusOK)
	flusher, ok := c.Writer.(http.Flusher)
	if !ok {
		a.internalError(c, "stream Agent wakes", fmt.Errorf("response writer does not support flushing"))
		return
	}
	if !writeServiceWakeEvent(c, flusher, "reconcile", struct{}{}) {
		return
	}
	heartbeat := time.NewTicker(a.cfg.SSEHeartbeatInterval)
	defer heartbeat.Stop()
	for {
		select {
		case <-c.Request.Context().Done():
			return
		case <-a.streamsDone.Done():
			return
		case <-subscription.Done():
			return
		case wake := <-subscription.Events():
			if !writeAgentWake(c, flusher, wake) {
				return
			}
		case <-heartbeat.C:
			if _, err := fmt.Fprint(c.Writer, ": heartbeat\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// writeAgentWake writes one hint; it reports false once the stream is gone.
func writeAgentWake(c *gin.Context, flusher http.Flusher, wake realtime.Event) bool {
	switch {
	case wake.Kind == realtime.ReconcileKind:
		return writeServiceWakeEvent(c, flusher, "reconcile", struct{}{})
	case wake.Kind == realtime.TaskClaimableKind:
		return writeServiceWakeEvent(c, flusher, wake.Kind, struct{}{})
	case wake.ContextKey == "":
		return true
	case wake.Kind == "context.changed":
		return writeServiceWakeEvent(c, flusher, wake.Kind, struct {
			ContextKey    string `json:"context_key"`
			StateRevision string `json:"state_revision"`
		}{wake.ContextKey, strconv.FormatInt(wake.Revision, 10)})
	case wake.Kind == realtime.ContextPrepareKind, wake.Kind == realtime.RunQueuedKind, wake.Kind == realtime.RunSteeredKind:
		return writeServiceWakeEvent(c, flusher, wake.Kind, struct {
			ContextKey string `json:"context_key"`
		}{wake.ContextKey})
	default:
		return true
	}
}

// Shared by service-only wake streams; payloads never contain product content.
func writeServiceWakeEvent(c *gin.Context, flusher http.Flusher, event string, payload any) bool {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return false
	}
	if _, err := fmt.Fprintf(c.Writer, "event: %s\ndata: %s\n\n", event, encoded); err != nil {
		return false
	}
	flusher.Flush()
	return true
}
