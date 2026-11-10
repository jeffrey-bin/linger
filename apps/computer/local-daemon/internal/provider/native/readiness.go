package native

import (
	"fmt"
	"slices"
	"strings"
	"sync"
)

// ReadinessCounters count the work one Operation did to get a ready
// process. A Run that adopts a prepared or parked process counts nothing;
// any count is work the readiness rules should have avoided, so it is
// logged once per Operation with its reasons.
type ReadinessCounters struct {
	mu             sync.Mutex
	spawns         int
	sessionStarts  int
	sessionResumes int
	rebounds       int
	recycles       map[string]int
}

func (c *ReadinessCounters) add(count func()) {
	if c == nil {
		return
	}
	c.mu.Lock()
	count()
	c.mu.Unlock()
}

func (c *ReadinessCounters) spawned() { c.add(func() { c.spawns++ }) }

// session counts a native session opened by this Operation: resumed is a
// reopened conversation, otherwise a new one.
func (c *ReadinessCounters) session(resumed bool) {
	c.add(func() {
		if resumed {
			c.sessionResumes++
		} else {
			c.sessionStarts++
		}
	})
}

func (c *ReadinessCounters) rebound() { c.add(func() { c.rebounds++ }) }

// recycled counts a parked process this Operation stopped, by reason and
// the mismatched fields.
func (c *ReadinessCounters) recycled(reason string, mismatch []string) {
	if len(mismatch) > 0 {
		reason += ":" + strings.Join(mismatch, "+")
	}
	c.add(func() {
		if c.recycles == nil {
			c.recycles = map[string]int{}
		}
		c.recycles[reason]++
	})
}

// LogAttrs are the counters as log attributes; recycles reads like
// "cap=1,incompatible:skills=1".
func (c *ReadinessCounters) LogAttrs() []any {
	if c == nil {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	reasons := make([]string, 0, len(c.recycles))
	for reason, count := range c.recycles {
		reasons = append(reasons, fmt.Sprintf("%s=%d", reason, count))
	}
	slices.Sort(reasons)
	return []any{"spawns", c.spawns, "session_starts", c.sessionStarts, "session_resumes", c.sessionResumes,
		"rebounds", c.rebounds, "recycles", strings.Join(reasons, ",")}
}
