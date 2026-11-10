package native

import (
	"sync"
	"time"
)

// Granularity of a Runtime's first observable model output: a whole item
// (Codex), a content block (Claude), or a stream delta (Pi). A first item
// can arrive only after the whole message was generated, so it is never a
// time to first token.
const (
	GranularityItem  = "item"
	GranularityBlock = "block"
	GranularityDelta = "delta"
)

// ModelResponse is one completed model request, reported once per native
// response at the boundary where the Runtime reports that response's usage.
type ModelResponse struct {
	Model     string
	Usage     TokenCount
	MessageID string
	// StartedAt is when the Runtime had the request's inputs: the turn
	// dispatch, the previous response, or the last tool result after it
	// that a previous request's call produced.
	StartedAt time.Time
	// FirstItemAt is the first observable output; zero when none was seen.
	FirstItemAt time.Time
	Granularity string
	// Agent is empty for the Run's own agent. A sub-agent names itself and
	// the tool call of its parent that started it, so parallel sub-agent
	// requests are attributed instead of summed into the parent.
	Agent        string
	ParentCallID string
}

// modelRequestClock derives each agent's request start and first item from
// the boundaries an adapter observes. Every adapter feeds it the same way, so
// the request record means the same thing for every Runtime.
type modelRequestClock struct {
	mu          sync.Mutex
	granularity string
	agents      map[string]*modelRequestState
}

type modelRequestState struct {
	start, first time.Time
	// called is set once the request issued a tool call: that call's result
	// is an input of the next request, not of this one.
	called bool
}

func newModelRequestClock(granularity string) *modelRequestClock {
	return &modelRequestClock{granularity: granularity, agents: map[string]*modelRequestState{}}
}

func (c *modelRequestClock) state(agent string) *modelRequestState {
	state := c.agents[agent]
	if state == nil {
		state = &modelRequestState{}
		c.agents[agent] = state
	}
	return state
}

// begin starts an agent's next request at a turn dispatch.
func (c *modelRequestClock) begin(agent string, at time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	*c.state(agent) = modelRequestState{start: at}
}

// ready moves a request's start to a later input, such as a tool result,
// until the request shows its first output.
func (c *modelRequestClock) ready(agent string, at time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	state := c.state(agent)
	if state.first.IsZero() && !state.called && at.After(state.start) {
		state.start = at
	}
}

// call records that the current request issued a tool call. A Runtime that
// reports a response's usage only after running its calls (Codex) would
// otherwise start the request at its own call's result.
func (c *modelRequestClock) call(agent string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.state(agent).called = true
}

// item records the first observable output of the current request.
func (c *modelRequestClock) item(agent string, at time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	state := c.state(agent)
	if state.first.IsZero() {
		state.first = at
		if state.start.IsZero() || state.start.After(at) {
			state.start = at
		}
	}
}

// respond closes the current request at its response and starts the next.
func (c *modelRequestClock) respond(response ModelResponse, at time.Time) ModelResponse {
	c.mu.Lock()
	defer c.mu.Unlock()
	state := c.state(response.Agent)
	response.StartedAt, response.FirstItemAt, response.Granularity = state.start, state.first, c.granularity
	if response.StartedAt.IsZero() || response.StartedAt.After(at) {
		response.StartedAt = at
	}
	*state = modelRequestState{start: at}
	return response
}
