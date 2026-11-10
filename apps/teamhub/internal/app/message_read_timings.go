package app

import (
	"time"

	"github.com/gin-gonic/gin"
)

// messageReadTimings adds bounded, content-free diagnostics to the existing
// request log. A stage measures elapsed wall time since the preceding stage,
// including database pool waits and any in-between projection work, not SQL time.
type messageReadTimings struct {
	last   time.Time
	fields map[string]any
}

func startMessageReadTimings(c *gin.Context) *messageReadTimings {
	timings := &messageReadTimings{last: time.Now(), fields: make(map[string]any, 14)}
	c.Set("message_read", timings.fields)
	return timings
}

// Set records one content-free count of the read.
func (t *messageReadTimings) Set(name string, value any) {
	t.fields[name] = value
}

// Stage records the wall time since the preceding stage.
func (t *messageReadTimings) Stage(name string) {
	now := time.Now()
	t.fields[name+"_ms"] = float64(now.Sub(t.last)) / float64(time.Millisecond)
	t.last = now
}
