package app

import (
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

const (
	roomPresenceInterval = 15 * time.Second
	roomPresenceCapacity = 4096
	// roomPresenceRecentWindow covers one 20s Web heartbeat plus slack and
	// matches the Agent's 30s unused preparation window.
	roomPresenceRecentWindow = 30 * time.Second
)

// roomPresenceThrottle bounds repeated presence hints per Account and Room in
// this process. It is best effort: another TeamHub process or an evicted key
// only allows one more hint, and a repeated hint is harmless to the Agent.
type roomPresenceThrottle struct {
	mu   sync.Mutex
	seen map[string]time.Time
}

// recentlyPresent reports whether any Account sent an admitted hint for the
// Room within the window. The Web heartbeat refreshes seen at least every 20s
// while someone is in the Room.
func (t *roomPresenceThrottle) recentlyPresent(roomID string, now time.Time) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	suffix := "\x00" + roomID
	for key, last := range t.seen {
		if strings.HasSuffix(key, suffix) && now.Sub(last) < roomPresenceRecentWindow {
			return true
		}
	}
	return false
}

func (t *roomPresenceThrottle) allow(key string, now time.Time) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if last, ok := t.seen[key]; ok && now.Sub(last) < roomPresenceInterval {
		return false
	}
	if t.seen == nil {
		t.seen = make(map[string]time.Time)
	}
	if len(t.seen) >= roomPresenceCapacity {
		for candidate, last := range t.seen {
			if now.Sub(last) >= roomPresenceInterval {
				delete(t.seen, candidate)
			}
		}
		if len(t.seen) >= roomPresenceCapacity {
			clear(t.seen)
		}
	}
	t.seen[key] = now
	return true
}

// forget lets the next hint through after this one could not be delivered.
func (t *roomPresenceThrottle) forget(key string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.seen, key)
}

// notifyRoomPresence asks the Agent Service to pre-activate, on their Local
// Computers, the Contexts that would receive this Room's next message.
// Nothing is persisted.
func (a *App) notifyRoomPresence(c *gin.Context) {
	ctx := c.Request.Context()
	accountID := currentPrincipal(c).Session.AccountID
	roomID := c.Param("roomId")
	_, err := a.collaboration.AuthorizedRoom(ctx, accountID, roomID)
	if a.notFoundOrError(c, "authorize Room presence", err) {
		return
	}
	throttleKey := accountID + "\x00" + roomID
	if !a.roomPresence.allow(throttleKey, time.Now()) {
		c.Status(http.StatusNoContent)
		return
	}
	if _, err := a.collaboration.PrepareRoomPresenceContexts(ctx, roomID, nil); err != nil {
		a.roomPresence.forget(throttleKey)
		a.internalError(c, "prepare Room presence Contexts", err)
		return
	}
	c.Status(http.StatusNoContent)
}
