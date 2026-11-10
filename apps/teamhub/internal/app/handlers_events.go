package app

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
)

func (a *App) listRoomEvents(c *gin.Context) {
	after, limit, ok := parseEventPage(c)
	if !ok {
		a.writeError(c, http.StatusBadRequest, "INVALID_PAGE", "invalid event pagination parameters")
		return
	}
	page, err := a.collaboration.ListRoomEvents(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("roomId"), after, limit)
	if a.notFoundOrError(c, "get event watermark", err) {
		return
	}
	c.JSON(http.StatusOK, page)
}

func (a *App) ensureStreamSession(c *gin.Context, flusher http.Flusher, digest []byte) bool {
	code, err := a.streamSessionInvalidationCode(c.Request.Context(), digest)
	if err != nil {
		return false
	}
	if code == "" {
		return true
	}
	writeSessionInvalidated(c, flusher, code)
	return false
}

// A renewal can outlive the deadline captured when this connection opened.
func (a *App) resetStreamSessionExpiry(c *gin.Context, flusher http.Flusher, digest []byte, timer *time.Timer) bool {
	session, err := a.sessions.Active(c.Request.Context(), digest)
	if err != nil {
		a.ensureStreamSession(c, flusher, digest)
		return false
	}
	timer.Reset(max(time.Millisecond, time.Until(session.ExpiresAt.Time)))
	return true
}

func writeSessionInvalidated(c *gin.Context, flusher http.Flusher, code string) {
	message := "session expired"
	payload, err := json.Marshal(map[string]string{"code": code, "message": message})
	if err != nil {
		return
	}
	_, _ = fmt.Fprintf(c.Writer, "event: session.expired\ndata: %s\n\n", payload)
	flusher.Flush()
}

func parseAfter(c *gin.Context) (int64, bool) {
	raw := c.DefaultQuery("after", "0")
	value, err := strconv.ParseInt(raw, 10, 64)
	return value, err == nil && value >= 0
}

func parseEventPage(c *gin.Context) (int64, int32, bool) {
	after, ok := parseAfter(c)
	if !ok {
		return 0, 0, false
	}
	limit := int32(50)
	if raw := c.Query("limit"); raw != "" {
		value, err := strconv.ParseInt(raw, 10, 32)
		if err != nil || value < 1 || value > 200 {
			return 0, 0, false
		}
		limit = int32(value)
	}
	return after, limit, true
}
