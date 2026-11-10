package native

import (
	"encoding/json"
	"errors"
	"sync"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/permission"
)

var _ permission.Requester = (*HumanInteractionBridge)(nil)

const interactionCapacity = 32

var (
	errInteractionCapacity = errors.New("Runtime interaction capacity is unavailable")
	errInteractionPending  = errors.New("Runtime request is already pending")
)

func interactionNotPending() *SteerError {
	return &SteerError{Effect: "definitely_not_applied", Reason: "no_active_turn", Message: "Runtime interaction is no longer pending"}
}

// HumanInteractionBridge holds the response callbacks of one Operation's
// requests that wait on a human. TeamHub stays the authority for cards and
// decisions. It also serves permission reviews as a permission.Requester.
type HumanInteractionBridge struct {
	emit    func(Event)
	mu      sync.Mutex
	pending map[string]func(json.RawMessage) error
	closed  bool
}

func NewHumanInteractionBridge(emit func(Event)) *HumanInteractionBridge {
	return &HumanInteractionBridge{emit: emit, pending: map[string]func(json.RawMessage) error{}}
}

// Request registers respond under id and emits the request as a
// human-interaction event before returning.
func (b *HumanInteractionBridge) Request(id string, request map[string]any, respond func(json.RawMessage) error) error {
	if respond == nil {
		respond = func(json.RawMessage) error { return nil }
	}
	b.mu.Lock()
	switch {
	case b.closed || len(b.pending) >= interactionCapacity:
		b.mu.Unlock()
		return errInteractionCapacity
	case b.pending[id] != nil:
		b.mu.Unlock()
		return errInteractionPending
	}
	b.pending[id] = respond
	b.mu.Unlock()
	if request == nil {
		request = map[string]any{}
	}
	request["request_id"] = id
	if b.emit != nil {
		b.emit(Event{Kind: EventHumanPrompt, InvocationID: id, Input: request})
	}
	return nil
}

// Respond delivers TeamHub's reply. The entry is removed before its callback
// runs, so an id is answered at most once.
func (b *HumanInteractionBridge) Respond(id string, payload json.RawMessage) error {
	b.mu.Lock()
	respond := b.pending[id]
	delete(b.pending, id)
	b.mu.Unlock()
	if respond == nil {
		return interactionNotPending()
	}
	return respond(payload)
}

// Forget drops a pending request without answering it.
func (b *HumanInteractionBridge) Forget(id string) {
	b.mu.Lock()
	delete(b.pending, id)
	b.mu.Unlock()
}

func (b *HumanInteractionBridge) Waiting() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.pending) > 0
}

// Close drops every pending request; later requests fail.
func (b *HumanInteractionBridge) Close() {
	b.mu.Lock()
	b.closed = true
	b.pending = map[string]func(json.RawMessage) error{}
	b.mu.Unlock()
}
