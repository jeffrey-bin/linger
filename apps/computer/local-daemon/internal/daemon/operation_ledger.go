package daemon

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
)

// OperationLedgerStore holds the Operations this Daemon process admitted: their
// unacknowledged events, inputs and terminals. It lives in memory only. A short
// Gateway disconnect resumes each Operation by operation_id from it; a Daemon
// restart loses it, and the restarted process reports such an Operation as
// interrupted instead of claiming to recover it.
type OperationLedgerStore interface {
	BeginPreparation(context.Context, OperationIdentity, protocol.Command) (BeginPreparationResult, error)
	CompletePreparation(context.Context, OperationIdentity, protocol.Command) error
	DeletePreparation(context.Context, OperationIdentity) error
	Begin(context.Context, OperationIdentity) (BeginResult, error)
	Append(context.Context, OperationIdentity, protocol.Event) (protocol.Event, error)
	Complete(context.Context, OperationIdentity, protocol.Event) (protocol.Event, error)
	// Interrupt records the terminal of an Operation a previous Daemon process
	// admitted: its native effects are unknown, so a later input to it is
	// reported as uncertain rather than as never applied.
	Interrupt(context.Context, OperationIdentity, protocol.Event) (protocol.Event, error)
	Acknowledge(context.Context, OperationIdentity, uint64) error
	Replay(context.Context, []string) ([]protocol.Event, error)
	Active(context.Context) (json.RawMessage, error)
	// Unacknowledged counts the Operations whose events the Gateway has not
	// acknowledged yet; a restart now would lose them.
	Unacknowledged() int
	BeginInput(context.Context, OperationIdentity, protocol.Command) (BeginInputResult, error)
	CompleteInput(context.Context, OperationIdentity, protocol.Command, protocol.Event) (protocol.Event, error)
}

// Ledger errors: a record that disagrees with the retained one, and a full
// unacknowledged event budget.
var (
	ErrLedgerIdentityConflict = errors.New("operation identity conflicts with retained ledger record")
	ErrLedgerCapacity         = errors.New("operation ledger unacknowledged event capacity is exhausted")
)

const (
	maxUnacknowledgedOperationEvents = 16_384
	maxUnacknowledgedOperationBytes  = 64 * 1024 * 1024
	terminalEventReserveBytes        = 4 * 1024 * 1024
	inputEventReserveBytes           = 1024 * 1024
	inputEventReserveCount           = 256
	// inputOutcomeEstimateBytes is the room a claimed input keeps for its
	// receipt, which is a small fixed-shape event.
	inputOutcomeEstimateBytes = 4 * 1024
	// acknowledgedOperationRetention keeps a fully acknowledged terminal long
	// enough that a duplicate start or input still gets its recorded outcome.
	acknowledgedOperationRetention = 24 * time.Hour
)

// OperationIdentity is the placement and fencing identity an Operation keeps
// for its whole life.
type OperationIdentity struct {
	ProtocolVersion     string `json:"protocol_version"`
	HostAccess          string `json:"host_access,omitempty"`
	TenantID            string `json:"tenant_id"`
	RunnerID            string `json:"runner_id"`
	OwnerActorID        string `json:"owner_actor_id,omitempty"`
	RegistrationID      string `json:"registration_id"`
	AssignmentRevision  uint64 `json:"assignment_revision"`
	AgentID             string `json:"agent_id"`
	OperationID         string `json:"operation_id"`
	ConnectionEpoch     uint64 `json:"connection_epoch"`
	RunnerRevision      uint64 `json:"runner_revision"`
	Generation          uint64 `json:"generation"`
	ExecutionLeaseID    string `json:"execution_lease_id"`
	WorkspaceGrantID    string `json:"workspace_grant_id"`
	RuntimeType         string `json:"runtime_type"`
	OperationKind       string `json:"-"`
	ExecutionContextKey string `json:"execution_context_key,omitempty"`
	RuntimeInstanceID   string `json:"runtime_instance_id,omitempty"`
	ContextViewRef      string `json:"context_view_ref,omitempty"`
	StartCommandDigest  string `json:"-"`
}

// BeginDisposition says whether a start is new, running or already ended.
type BeginDisposition string

// Begin dispositions.
const (
	BeginNew      BeginDisposition = "new"
	BeginRunning  BeginDisposition = "running"
	BeginTerminal BeginDisposition = "terminal"
)

// BeginResult is the ledger answer to an Operation start.
type BeginResult struct {
	Disposition BeginDisposition
	Terminal    *protocol.Event
}

type BeginInputDisposition string

const (
	BeginInputNew     BeginInputDisposition = "new"
	BeginInputPending BeginInputDisposition = "pending"
	BeginInputOutcome BeginInputDisposition = "outcome"
)

type BeginInputResult struct {
	Disposition BeginInputDisposition
	Outcome     *protocol.Event
}

// BeginPreparationDisposition says whether an Operation prepare is new,
// still preparing or ready.
type BeginPreparationDisposition string

// Begin preparation dispositions.
const (
	BeginPreparationNew       BeginPreparationDisposition = "new"
	BeginPreparationPreparing BeginPreparationDisposition = "preparing"
	BeginPreparationReady     BeginPreparationDisposition = "ready"
)

// BeginPreparationResult is the ledger answer to an Operation prepare.
type BeginPreparationResult struct {
	Disposition BeginPreparationDisposition
}

type ledgerEvent struct {
	event protocol.Event
	size  int
}

type ledgerInput struct {
	digest  string
	kind    string
	outcome *protocol.Event
}

type ledgerOperation struct {
	identityJSON  string
	operationKind string
	startDigest   string
	identity      OperationIdentity
	terminal      *protocol.Event
	interrupted   bool
	lastEmitted   uint64
	lastAcked     uint64
	events        []ledgerEvent
	eventBytes    int
	inputs        map[string]*ledgerInput
	updatedAt     time.Time
}

type ledgerPreparation struct {
	identityJSON string
	digest       string
	ready        bool
}

// MemoryLedger is the process-lifetime OperationLedgerStore.
type MemoryLedger struct {
	mu           sync.Mutex
	operations   map[string]*ledgerOperation
	preparations map[string]*ledgerPreparation
	now          func() time.Time
}

// NewMemoryLedger returns an empty ledger; a Daemon restart starts with none.
func NewMemoryLedger() *MemoryLedger {
	return &MemoryLedger{
		operations:   make(map[string]*ledgerOperation),
		preparations: make(map[string]*ledgerPreparation),
		now:          time.Now,
	}
}

// BeginPreparation claims an Operation prepare or reports the one recorded.
func (l *MemoryLedger) BeginPreparation(_ context.Context, identity OperationIdentity, command protocol.Command) (BeginPreparationResult, error) {
	if err := validateIdentity(identity); err != nil {
		return BeginPreparationResult{}, err
	}
	digest, err := preparationDigest(command)
	if err != nil {
		return BeginPreparationResult{}, err
	}
	encoded, err := identityText(identity)
	if err != nil {
		return BeginPreparationResult{}, err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, retained := l.operations[identity.OperationID]; retained {
		return BeginPreparationResult{}, ErrLedgerIdentityConflict
	}
	retained, ok := l.preparations[identity.OperationID]
	if !ok {
		l.preparations[identity.OperationID] = &ledgerPreparation{identityJSON: encoded, digest: digest}
		return BeginPreparationResult{Disposition: BeginPreparationNew}, nil
	}
	if retained.identityJSON != encoded || retained.digest != digest {
		return BeginPreparationResult{}, ErrLedgerIdentityConflict
	}
	if retained.ready {
		return BeginPreparationResult{Disposition: BeginPreparationReady}, nil
	}
	return BeginPreparationResult{Disposition: BeginPreparationPreparing}, nil
}

// CompletePreparation marks a claimed prepare ready.
func (l *MemoryLedger) CompletePreparation(_ context.Context, identity OperationIdentity, command protocol.Command) error {
	digest, err := preparationDigest(command)
	if err != nil {
		return err
	}
	encoded, err := identityText(identity)
	if err != nil {
		return err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	retained, ok := l.preparations[identity.OperationID]
	if !ok || retained.identityJSON != encoded || retained.digest != digest {
		return ErrLedgerIdentityConflict
	}
	retained.ready = true
	return nil
}

// DeletePreparation forgets a prepare that was used or abandoned.
func (l *MemoryLedger) DeletePreparation(_ context.Context, identity OperationIdentity) error {
	encoded, err := identityText(identity)
	if err != nil {
		return err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	retained, ok := l.preparations[identity.OperationID]
	if !ok {
		return nil
	}
	if retained.identityJSON != encoded {
		return ErrLedgerIdentityConflict
	}
	delete(l.preparations, identity.OperationID)
	return nil
}

// Begin admits an Operation start or reports the state recorded for it.
func (l *MemoryLedger) Begin(_ context.Context, identity OperationIdentity) (BeginResult, error) {
	if err := validateIdentity(identity); err != nil {
		return BeginResult{}, ErrLedgerIdentityConflict
	}
	encoded, err := identityText(identity)
	if err != nil {
		return BeginResult{}, err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.pruneLocked()
	operation, ok := l.operations[identity.OperationID]
	if !ok {
		l.operations[identity.OperationID] = &ledgerOperation{
			identityJSON: encoded, operationKind: identity.OperationKind,
			startDigest: identity.StartCommandDigest,
			identity:    identity, inputs: make(map[string]*ledgerInput), updatedAt: l.now(),
		}
		return BeginResult{Disposition: BeginNew}, nil
	}
	if operation.identityJSON != encoded || operation.operationKind != identity.OperationKind {
		return BeginResult{}, ErrLedgerIdentityConflict
	}
	if operation.startDigest != identity.StartCommandDigest {
		return BeginResult{}, ErrLedgerIdentityConflict
	}
	if operation.terminal == nil {
		return BeginResult{Disposition: BeginRunning}, nil
	}
	terminal := *operation.terminal
	return BeginResult{Disposition: BeginTerminal, Terminal: &terminal}, nil
}

// Append records an Operation event under the next sequence.
func (l *MemoryLedger) Append(_ context.Context, identity OperationIdentity, event protocol.Event) (protocol.Event, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	operation, err := l.matchLocked(identity)
	if err != nil {
		return protocol.Event{}, err
	}
	if operation.terminal != nil {
		return protocol.Event{}, errors.New("cannot append an event after operation is terminal")
	}
	event.Sequence = operation.lastEmitted + 1
	size, err := eventSize(event)
	if err != nil {
		return protocol.Event{}, err
	}
	if err := operation.ensureCapacity(size, 0, 0); err != nil {
		return protocol.Event{}, err
	}
	operation.push(event, size, l.now())
	return event, nil
}

// Complete records an Operation terminal.
func (l *MemoryLedger) Complete(_ context.Context, identity OperationIdentity, event protocol.Event) (protocol.Event, error) {
	return l.complete(identity, event, false)
}

// Interrupt records the terminal of an Operation this process cannot finish.
func (l *MemoryLedger) Interrupt(_ context.Context, identity OperationIdentity, event protocol.Event) (protocol.Event, error) {
	return l.complete(identity, event, true)
}

func (l *MemoryLedger) complete(identity OperationIdentity, event protocol.Event, interrupted bool) (protocol.Event, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	operation, err := l.matchLocked(identity)
	if err != nil {
		return protocol.Event{}, err
	}
	if operation.terminal != nil {
		return *operation.terminal, nil
	}
	event.Sequence = operation.lastEmitted + 1
	size, err := eventSize(event)
	if err != nil {
		return protocol.Event{}, err
	}
	if size > terminalEventReserveBytes {
		return protocol.Event{}, ErrLedgerCapacity
	}
	if err := operation.ensureCapacity(size, inputEventReserveCount+1, inputEventReserveBytes+terminalEventReserveBytes); err != nil {
		return protocol.Event{}, err
	}
	operation.push(event, size, l.now())
	terminal := event
	operation.terminal = &terminal
	operation.interrupted = interrupted
	return event, nil
}

// Acknowledge releases the events the Gateway confirmed through a sequence.
func (l *MemoryLedger) Acknowledge(_ context.Context, identity OperationIdentity, through uint64) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	operation, err := l.matchLocked(identity)
	if err != nil {
		return err
	}
	if through < operation.lastAcked || through > operation.lastEmitted {
		return ErrLedgerIdentityConflict
	}
	operation.lastAcked = through
	operation.updatedAt = l.now()
	kept := operation.events[:0]
	operation.eventBytes = 0
	for _, retained := range operation.events {
		if retained.event.Sequence > through {
			kept = append(kept, retained)
			operation.eventBytes += retained.size
		}
	}
	operation.events = kept
	l.pruneLocked()
	return nil
}

// Replay returns the unacknowledged events of the named Operations in order.
func (l *MemoryLedger) Replay(_ context.Context, operationIDs []string) ([]protocol.Event, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	var result []protocol.Event
	for _, operationID := range operationIDs {
		operation, ok := l.operations[operationID]
		if !ok {
			continue
		}
		for _, retained := range operation.events {
			result = append(result, retained.event)
		}
	}
	return result, nil
}

// Active lists the Operations a hello reports.
func (l *MemoryLedger) Active(context.Context) (json.RawMessage, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	items := make([]map[string]any, 0)
	for _, operationID := range sortedKeys(l.operations) {
		operation := l.operations[operationID]
		if operation.terminal != nil {
			continue
		}
		items = append(items, activeOperationSnapshot(operation.identity, operation.lastEmitted, operation.lastAcked))
	}
	return json.Marshal(items)
}

// Unacknowledged counts Operations with events the Gateway has not confirmed.
func (l *MemoryLedger) Unacknowledged() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	count := 0
	for _, operation := range l.operations {
		if operation.lastAcked < operation.lastEmitted {
			count++
		}
	}
	return count
}

// BeginInput claims an Operation input or reports its recorded outcome.
func (l *MemoryLedger) BeginInput(_ context.Context, identity OperationIdentity, command protocol.Command) (BeginInputResult, error) {
	digest, err := commandDigest(command)
	if err != nil {
		return BeginInputResult{}, err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	operation, err := l.matchLocked(identity)
	if err != nil {
		return BeginInputResult{}, err
	}
	if operation.terminal != nil {
		return operation.closedInput(command, digest, l.now())
	}
	retained, ok := operation.inputs[command.CommandID]
	if ok {
		if retained.digest != digest {
			return BeginInputResult{}, ErrLedgerIdentityConflict
		}
		if retained.outcome == nil {
			return BeginInputResult{Disposition: BeginInputPending}, nil
		}
		outcome := *retained.outcome
		return BeginInputResult{Disposition: BeginInputOutcome, Outcome: &outcome}, nil
	}
	if len(operation.inputs) >= maxUnacknowledgedOperationEvents {
		return BeginInputResult{}, ErrLedgerCapacity
	}
	kind := inputKind(command.Input)
	for _, input := range operation.inputs {
		// A steer waits for the Runtime to show it, which can take until the
		// next model request, and the turn may first need the answer to one
		// of its questions; so only an input of the same kind is busy.
		if input.outcome != nil || input.kind != kind {
			continue
		}
		// Normal overlap, not an identity conflict: record the rejection
		// without claiming another Provider input. A busy receipt cannot
		// consume the pending input's reserve.
		outcome := rejectedInputEvent(command, "definitely_not_applied", "rejected", "", "Another input is awaiting Provider confirmation")
		outcome.Sequence = operation.lastEmitted + 1
		size, err := eventSize(outcome)
		if err != nil {
			return BeginInputResult{}, err
		}
		if err := operation.ensureCapacity(size, 0, 0); err != nil {
			return BeginInputResult{}, err
		}
		operation.push(outcome, size, l.now())
		operation.inputs[command.CommandID] = &ledgerInput{digest: digest, kind: kind, outcome: &outcome}
		return BeginInputResult{Disposition: BeginInputOutcome, Outcome: &outcome}, nil
	}
	if err := operation.ensureCapacity(inputOutcomeEstimateBytes, inputEventReserveCount, inputEventReserveBytes); err != nil {
		return BeginInputResult{}, err
	}
	operation.inputs[command.CommandID] = &ledgerInput{digest: digest, kind: kind}
	operation.updatedAt = l.now()
	return BeginInputResult{Disposition: BeginInputNew}, nil
}

// inputKind separates answers to Runtime questions from text steers.
func inputKind(input json.RawMessage) string {
	var decoded struct {
		RuntimeResponse json.RawMessage `json:"runtime_response"`
	}
	if json.Unmarshal(input, &decoded) == nil && len(decoded.RuntimeResponse) != 0 && string(decoded.RuntimeResponse) != "null" {
		return "runtime_response"
	}
	return "text"
}

// CompleteInput records a claimed input's outcome.
func (l *MemoryLedger) CompleteInput(_ context.Context, identity OperationIdentity, command protocol.Command, event protocol.Event) (protocol.Event, error) {
	digest, err := commandDigest(command)
	if err != nil {
		return protocol.Event{}, err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	operation, err := l.matchLocked(identity)
	if err != nil {
		return protocol.Event{}, err
	}
	if operation.terminal != nil {
		return protocol.Event{}, ErrLedgerIdentityConflict
	}
	retained, ok := operation.inputs[command.CommandID]
	if !ok {
		return protocol.Event{}, ErrLedgerIdentityConflict
	}
	if retained.digest != digest {
		return protocol.Event{}, ErrLedgerIdentityConflict
	}
	if retained.outcome != nil {
		return *retained.outcome, nil
	}
	event.Sequence = operation.lastEmitted + 1
	size, err := eventSize(event)
	if err != nil {
		return protocol.Event{}, err
	}
	if err := operation.ensureCapacity(size, inputEventReserveCount, inputEventReserveBytes); err != nil {
		return protocol.Event{}, err
	}
	operation.push(event, size, l.now())
	outcome := event
	retained.outcome = &outcome
	return event, nil
}

// closedInput answers an input to a terminal Operation. It is a command
// receipt, not another event of the Operation: it never advances the
// Operation's sequence or reaches the Provider.
func (o *ledgerOperation) closedInput(command protocol.Command, digest string, now time.Time) (BeginInputResult, error) {
	effect := "definitely_not_applied"
	if o.interrupted {
		// A previous Daemon process may have delivered this input before it
		// stopped; nothing here proves it did not.
		effect = "uncertain"
	}
	if retained, ok := o.inputs[command.CommandID]; ok {
		if retained.digest != digest {
			return BeginInputResult{}, ErrLedgerIdentityConflict
		}
		effect = "uncertain"
		if retained.outcome != nil {
			if retained.outcome.Type == protocol.EventOperationInputClosed {
				outcome := *retained.outcome
				return BeginInputResult{Disposition: BeginInputOutcome, Outcome: &outcome}, nil
			}
			var payload struct {
				Effect string `json:"effect"`
			}
			_ = json.Unmarshal(retained.outcome.Payload, &payload)
			if retained.outcome.Type == protocol.EventOperationInputRejected && payload.Effect == "definitely_not_applied" {
				effect = payload.Effect
			}
		}
		// An earlier sequenced receipt stays: reconnect may still need it.
		event := closedInputEvent(command, effect)
		return BeginInputResult{Disposition: BeginInputOutcome, Outcome: &event}, nil
	}
	if len(o.inputs) >= maxUnacknowledgedOperationEvents {
		return BeginInputResult{}, ErrLedgerCapacity
	}
	event := closedInputEvent(command, effect)
	o.inputs[command.CommandID] = &ledgerInput{digest: digest, outcome: &event}
	o.updatedAt = now
	return BeginInputResult{Disposition: BeginInputOutcome, Outcome: &event}, nil
}

func closedInputEvent(command protocol.Command, effect string) protocol.Event {
	return withOperationIdentity(protocol.Event{Type: protocol.EventOperationInputClosed, ProtocolVersion: command.ProtocolVersion, Payload: mustJSON(map[string]any{"expected_turn_id": command.ExpectedTurnID, "effect": effect})}, command)
}

func (o *ledgerOperation) ensureCapacity(nextBytes, reserveCount, reserveBytes int) error {
	if len(o.events) >= maxUnacknowledgedOperationEvents+reserveCount ||
		o.eventBytes+nextBytes > maxUnacknowledgedOperationBytes+reserveBytes {
		return ErrLedgerCapacity
	}
	return nil
}

func (o *ledgerOperation) push(event protocol.Event, size int, now time.Time) {
	o.events = append(o.events, ledgerEvent{event: event, size: size})
	o.eventBytes += size
	o.lastEmitted = event.Sequence
	o.updatedAt = now
}

func (l *MemoryLedger) matchLocked(identity OperationIdentity) (*ledgerOperation, error) {
	if validateIdentity(identity) != nil {
		return nil, ErrLedgerIdentityConflict
	}
	operation, ok := l.operations[identity.OperationID]
	if !ok {
		return nil, ErrLedgerIdentityConflict
	}
	encoded, err := identityText(identity)
	if err != nil {
		return nil, err
	}
	if operation.identityJSON != encoded {
		return nil, ErrLedgerIdentityConflict
	}
	return operation, nil
}

// pruneLocked forgets terminal Operations whose every event was acknowledged
// longer ago than the retention.
func (l *MemoryLedger) pruneLocked() {
	cutoff := l.now().Add(-acknowledgedOperationRetention)
	for operationID, operation := range l.operations {
		if operation.terminal != nil && operation.lastAcked == operation.lastEmitted && operation.updatedAt.Before(cutoff) {
			delete(l.operations, operationID)
		}
	}
}

func preparationDigest(command protocol.Command) (string, error) {
	if command.Type != protocol.CommandOperationPrepare {
		return "", errors.New("Operation preparation command type is invalid")
	}
	return commandDigest(command)
}

func validateIdentity(identity OperationIdentity) error {
	if identity.OperationID == "" || identity.RegistrationID == "" || identity.AgentID == "" {
		return errors.New("operation identity requires operation, registration, and agent ids")
	}
	return nil
}

func identityText(identity OperationIdentity) (string, error) {
	encoded, err := json.Marshal(identity)
	if err != nil {
		return "", fmt.Errorf("encode operation identity: %w", err)
	}
	return string(encoded), nil
}

func eventSize(event protocol.Event) (int, error) {
	encoded, err := json.Marshal(event)
	if err != nil {
		return 0, fmt.Errorf("encode operation event: %w", err)
	}
	return len(encoded), nil
}

// commandDigest names a command's content independent of JSON key order, so
// a resent command matches the one recorded whatever spelling it arrives in.
func commandDigest(command protocol.Command) (string, error) {
	encoded, err := json.Marshal(command)
	if err != nil {
		return "", fmt.Errorf("encode Operation command: %w", err)
	}
	encoded, err = canonicalJSON(encoded)
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256(encoded)
	return hex.EncodeToString(hash[:]), nil
}

func canonicalJSON(encoded []byte) ([]byte, error) {
	var value any
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	return json.Marshal(value)
}

func sameOperationIdentity(left, right OperationIdentity) bool {
	left.OperationKind = ""
	right.OperationKind = ""
	if left.StartCommandDigest == "" || right.StartCommandDigest == "" {
		left.StartCommandDigest = ""
		right.StartCommandDigest = ""
	}
	if left.ContextViewRef != right.ContextViewRef && sameJSONText(left.ContextViewRef, right.ContextViewRef) {
		// Equal Context Views may differ only in key order.
		left.ContextViewRef = right.ContextViewRef
	}
	return left == right
}

func sameJSONText(left, right string) bool {
	leftJSON, leftErr := canonicalJSON([]byte(left))
	rightJSON, rightErr := canonicalJSON([]byte(right))
	return leftErr == nil && rightErr == nil && bytes.Equal(leftJSON, rightJSON)
}

func activeOperationSnapshot(identity OperationIdentity, emitted, acknowledged uint64) map[string]any {
	value := map[string]any{
		"protocol_version": identity.ProtocolVersion,
		"tenant_id":        identity.TenantID, "runner_id": identity.RunnerID,
		"agent_id": identity.AgentID, "operation_id": identity.OperationID,
		"connection_epoch": identity.ConnectionEpoch, "runner_revision": identity.RunnerRevision,
		"generation": identity.Generation, "execution_lease_id": identity.ExecutionLeaseID,
		"workspace_grant_id": identity.WorkspaceGrantID, "runtime_type": identity.RuntimeType,
		"kind": identity.OperationKind, "last_emitted_seq": emitted, "last_acked_seq": acknowledged,
		"host_access": identity.HostAccess, "registration_id": identity.RegistrationID,
		"assignment_revision": identity.AssignmentRevision,
	}
	value["execution_context_key"] = identity.ExecutionContextKey
	value["runtime_instance_id"] = identity.RuntimeInstanceID
	var contextView any
	if json.Unmarshal([]byte(identity.ContextViewRef), &contextView) == nil {
		value["context_view_ref"] = contextView
	}
	return value
}

func sortedKeys[V any](values map[string]V) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

var _ OperationLedgerStore = (*MemoryLedger)(nil)
