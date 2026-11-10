package native

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"time"
)

const claudeSteerNotConfirmed = "Claude steer submission was not confirmed; execution must not be retried"

// claudeConversation is the input state of one process. A reused turn resets
// it; the end of the stream finishes it for good.
type claudeConversation struct {
	proc    *claudeProcess
	steerMu sync.Mutex

	mu                 sync.Mutex
	owner              *claudeTurn
	nativeID           string
	runID              string
	active             bool
	closed             bool
	started            bool
	pendingInterrupted int
	steerUnconfirmed   bool
	failure            string
	finished           bool
	finishedCh         chan struct{}
	requests           map[string]chan claudeControlResult
	waiters            map[string]chan struct{}
	submitted          bool
	inputWrittenAt     time.Time
	// changed is closed and replaced whenever the turn's input state moves:
	// confirmation, acceptance, abort, finish or reset.
	changed chan struct{}
}

// claudeControlResult is the answer to one control request: the response
// payload on success, or an error.
type claudeControlResult struct {
	payload json.RawMessage
	err     error
}

func claudeNewConversation(p *claudeProcess) *claudeConversation {
	return &claudeConversation{
		proc: p, finishedCh: make(chan struct{}), changed: make(chan struct{}),
		requests: map[string]chan claudeControlResult{}, waiters: map[string]chan struct{}{},
	}
}

// reset starts a new turn on the conversation with nativeID as both the
// native and the run turn ID.
func (c *claudeConversation) reset(owner *claudeTurn, nativeID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.owner, c.nativeID, c.runID = owner, nativeID, nativeID
	c.active, c.closed, c.started = false, false, false
	c.pendingInterrupted, c.steerUnconfirmed, c.failure = 0, false, ""
	c.submitted, c.inputWrittenAt = false, time.Time{}
	for id, ch := range c.requests {
		ch <- claudeControlResult{err: errors.New("Claude turn was reset")}
		delete(c.requests, id)
	}
	c.waiters = map[string]chan struct{}{}
	c.signalLocked()
}

// signalLocked wakes everyone waiting for an input state change.
func (c *claudeConversation) signalLocked() {
	close(c.changed)
	c.changed = make(chan struct{})
}

func (c *claudeConversation) current() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.nativeID
}

// markSubmitted records, just before the turn's first user frame is
// written, that the initial input is on its way.
func (c *claudeConversation) markSubmitted(at time.Time) {
	c.mu.Lock()
	c.submitted = true
	if c.inputWrittenAt.IsZero() {
		c.inputWrittenAt = at
	}
	c.mu.Unlock()
}

// confirmLocked marks the current input confirmed.
func (c *claudeConversation) confirmLocked() {
	c.active, c.steerUnconfirmed = true, false
	if waiter := c.waiters[c.nativeID]; waiter != nil {
		close(waiter)
		delete(c.waiters, c.nativeID)
	}
	c.signalLocked()
}

// claudeTurnStart is the moment a turn's run input reached the CLI.
type claudeTurnStart struct {
	turnID    string
	writtenAt time.Time
}

// beginAtInit starts the turn on a system/init frame. It only counts once
// the initial input is submitted and the turn has not started yet, so an
// init sent at process start or caused by a steer is ignored.
func (c *claudeConversation) beginAtInit() (claudeTurnStart, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.submitted || c.started {
		return claudeTurnStart{}, false
	}
	c.started = true
	return claudeTurnStart{turnID: c.nativeID, writtenAt: c.inputWrittenAt}, true
}

// confirmReplay applies a root replay of id. It starts the turn when no
// system/init did.
func (c *claudeConversation) confirmReplay(id string) (claudeTurnStart, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if id == "" || id != c.nativeID {
		return claudeTurnStart{}, false
	}
	c.confirmLocked()
	if c.started {
		return claudeTurnStart{}, false
	}
	c.started = true
	return claudeTurnStart{turnID: c.nativeID, writtenAt: c.inputWrittenAt}, true
}

// acceptResult applies the result acceptance rules.
func (c *claudeConversation) acceptResult(parent, userMessage string) bool {
	if parent != "" {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if userMessage != "" && userMessage != c.nativeID {
		if c.pendingInterrupted > 0 {
			c.pendingInterrupted--
		}
		return false
	}
	if userMessage == "" && c.pendingInterrupted > 0 {
		c.pendingInterrupted--
		return false
	}
	c.confirmLocked()
	c.pendingInterrupted = 0
	c.closed = true
	c.signalLocked()
	return true
}

// idle reports a conversation that may park.
func (c *claudeConversation) idle() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.pendingInterrupted == 0 && !c.steerUnconfirmed && c.failure == ""
}

func (c *claudeConversation) failureSummary() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.failure
}

// abort records a failure, closes the conversation and cancels the process.
func (c *claudeConversation) abort(text string) {
	c.mu.Lock()
	if c.failure == "" {
		c.failure = text
	}
	c.closed = true
	c.signalLocked()
	c.mu.Unlock()
	c.proc.cancel()
}

// finish ends the stream: unconfirmed steer input becomes the failure, and
// every waiter is released. Repeated calls return the same failure.
func (c *claudeConversation) finish() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.finished {
		if c.steerUnconfirmed && c.failure == "" {
			c.failure = claudeSteerNotConfirmed
		}
		c.closed, c.finished = true, true
		close(c.finishedCh)
		for id, ch := range c.requests {
			ch <- claudeControlResult{err: io.EOF}
			delete(c.requests, id)
		}
		c.signalLocked()
	}
	return c.failure
}

// request writes a control request and waits for its control response. It
// returns the response payload.
func (c *claudeConversation) request(ctx context.Context, id string, frame []byte) (json.RawMessage, error) {
	reply := make(chan claudeControlResult, 1)
	c.mu.Lock()
	if c.finished {
		c.mu.Unlock()
		return nil, io.EOF
	}
	c.requests[id] = reply
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		if c.requests[id] == reply {
			delete(c.requests, id)
		}
		c.mu.Unlock()
	}()
	if err := c.proc.write(ctx, frame); err != nil {
		return nil, err
	}
	select {
	case result := <-reply:
		return result.payload, result.err
	case <-ctx.Done():
		return nil, context.Cause(ctx)
	case <-c.proc.ctx.Done():
		return nil, errors.New("Claude process is stopping")
	}
}

// handleResponse completes the pending request a control response names.
func (c *claudeConversation) handleResponse(raw json.RawMessage) {
	var response struct {
		RequestID string          `json:"request_id"`
		Subtype   string          `json:"subtype"`
		Error     string          `json:"error"`
		Response  json.RawMessage `json:"response"`
	}
	if json.Unmarshal(raw, &response) != nil {
		return
	}
	c.mu.Lock()
	reply := c.requests[response.RequestID]
	delete(c.requests, response.RequestID)
	c.mu.Unlock()
	if reply != nil {
		if response.Subtype == "success" {
			reply <- claudeControlResult{payload: response.Response}
		} else {
			reply <- claudeControlResult{err: errors.New("Claude rejected control request: " + response.Error)}
		}
	}
}
