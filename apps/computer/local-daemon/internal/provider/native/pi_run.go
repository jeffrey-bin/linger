package native

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"
)

const piEventBuffer = 256

// piTurn is one Operation on a Pi process. Its Run's events, outcome and
// steering belong to this turn only, never to a later turn of the same
// reused process.
type piTurn struct {
	proc   *piProcess
	id     string
	reused bool
	fence  releaseFence
	logger *slog.Logger

	runCtx context.Context
	cancel context.CancelFunc

	events       chan Event
	outcome      chan Outcome
	emitMu       sync.RWMutex
	eventsClosed bool

	steerMu     sync.Mutex
	settled     chan struct{}
	settledOnce sync.Once

	requests  *modelRequestClock
	readiness *ReadinessCounters

	// steering is the steer waiting for Pi to show its user message; at most
	// one, as steerMu serializes steers.
	steering *piSteering

	mu sync.Mutex
	piTurnState
}

// piTurnState is what the event stream has taught the turn so far.
type piTurnState struct {
	active        bool
	stopping      bool
	running       bool
	sawAssistant  bool
	settleAborted bool
	failure       string
	output        string
	textID        string
	filter        piMarkupFilter
	usage         map[string]TokenCount
	lastUsage     map[string]TokenCount
	compactions   int64
}

func newPiTurn(runCtx context.Context, cancel context.CancelFunc, p *piProcess, reused bool, fence releaseFence, logger *slog.Logger) *piTurn {
	t := &piTurn{
		proc: p, id: piRandomHex(16), reused: reused, fence: fence, logger: logger,
		runCtx: runCtx, cancel: cancel,
		events:   make(chan Event, piEventBuffer),
		outcome:  make(chan Outcome, 1),
		settled:  make(chan struct{}),
		requests: newModelRequestClock(GranularityDelta),
	}
	t.usage, t.lastUsage = map[string]TokenCount{}, map[string]TokenCount{}
	return t
}

func (t *piTurn) run() *Run {
	return &Run{Events: t.events, Outcome: t.outcome, Steer: t.steer}
}

// timing records one lifecycle observation of this turn.
func (t *piTurn) timing(event string, attrs ...any) {
	recordTiming(t.logger, time.Now(), event, append([]any{"turn_id", t.id, "session_id", t.proc.sessionID}, attrs...)...)
}

// emit blocks until the consumer takes the event or the run context ends.
func (t *piTurn) emit(event Event) {
	t.emitMu.RLock()
	defer t.emitMu.RUnlock()
	if t.eventsClosed || t.runCtx.Err() != nil {
		return
	}
	select {
	case t.events <- event:
	case <-t.runCtx.Done():
	}
}

// deliver closes the event stream and sends the single Outcome.
func (t *piTurn) deliver(outcome Outcome) {
	t.cancel()
	t.emitMu.Lock()
	t.eventsClosed = true
	close(t.events)
	t.emitMu.Unlock()
	t.outcome <- outcome
	close(t.outcome)
}

// live: the turn runs and is not stopping. The caller may hold proc.mu.
func (t *piTurn) live() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.active && !t.stopping
}

// admitted reports whether steering may still write into this turn.
func (t *piTurn) admitted() bool {
	return t.proc.boundTurn() == t && t.live()
}

// piSteering is a steer Pi queued, applied once Pi shows it as a user
// message. The message is matched to our own input bytes, which Pi echoes
// unchanged; no other Pi output is compared.
type piSteering struct {
	input    string
	consumed chan struct{}
}

// steer queues input into the live turn. Pi queues a steer whatever its turn
// does next, so the ack waits until Pi shows the user message. A turn that
// settles first did not apply it; the process is then not parked, so the
// queued input cannot surface in a later turn. Only a lost process or caller
// leaves the outcome uncertain.
func (t *piTurn) steer(ctx context.Context, request SteerRequest) (SteerAck, error) {
	t.steerMu.Lock()
	defer t.steerMu.Unlock()
	if request.ExpectedTurnID != t.id || strings.TrimSpace(request.Input) == "" || !t.admitted() {
		return SteerAck{}, t.steerRefusal(request.ExpectedTurnID)
	}
	steering := &piSteering{input: request.Input, consumed: make(chan struct{})}
	uncertain := func(message string) error {
		return &SteerError{Effect: "uncertain", Reason: "transport", ExpectedTurnID: request.ExpectedTurnID, ActualTurnID: t.id, Message: "Pi steer outcome is uncertain: " + message}
	}
	// The steer is held from the moment it is written, under the write lock
	// that admission is checked with, so Pi cannot show it before it is held
	// and a refused steer never keeps the process from parking.
	reply, err := t.proc.call(ctx, "steer", map[string]any{"message": request.Input}, func() bool {
		if !t.admitted() {
			return false
		}
		t.mu.Lock()
		t.steering = steering
		t.mu.Unlock()
		return true
	})
	if errors.Is(err, errPiNotAdmitted) {
		return SteerAck{}, t.steerRefusal(request.ExpectedTurnID)
	}
	if err != nil {
		return SteerAck{}, uncertain(err.Error())
	}
	var data struct {
		Disposition string `json:"disposition"`
	}
	_ = json.Unmarshal(reply.Data, &data)
	if data.Disposition != "queued" {
		return SteerAck{}, uncertain(fmt.Sprintf("Pi did not queue steer input (disposition %q)", data.Disposition))
	}
	select {
	case <-steering.consumed:
		return SteerAck{TurnID: t.id}, nil
	case <-t.settled:
		select {
		case <-steering.consumed:
			return SteerAck{TurnID: t.id}, nil
		default:
		}
		return SteerAck{}, &SteerError{Effect: "definitely_not_applied", Reason: "no_active_turn", ExpectedTurnID: request.ExpectedTurnID, ActualTurnID: t.id,
			Message: "Pi ended the turn before applying the steered input"}
	case <-t.proc.closed:
		return SteerAck{}, uncertain("Pi exited before showing the steered input")
	case <-ctx.Done():
		return SteerAck{}, uncertain("the steer confirmation was abandoned")
	}
}

// consumeSteer records that Pi showed a user message: when it is the queued
// steer's input, the steer was applied.
func (t *piTurn) consumeSteer(text string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.steering != nil && t.steering.input == text {
		close(t.steering.consumed)
		t.steering = nil
	}
}

// steerRefusal names the turn now bound to the process, if any.
func (t *piTurn) steerRefusal(expected string) *SteerError {
	actual := ""
	if bound := t.proc.boundTurn(); bound != nil {
		actual = bound.id
	}
	return &SteerError{Effect: "definitely_not_applied", Reason: "no_active_turn", ExpectedTurnID: expected, ActualTurnID: actual, Message: "Pi has no matching active turn"}
}
