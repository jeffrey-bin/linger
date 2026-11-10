package native

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/permission"
)

const (
	codexEventBuffer    = 256
	codexActivityBuffer = 256
)

var (
	codexDefaultStartupBudget = 30 * time.Second
	codexDefaultThreadBudget  = 60 * time.Second
	codexDefaultFirstProgress = time.Minute
	codexDefaultSilenceBudget = 10 * time.Minute
	codexNoResultText         = "Codex operation ended without a result"
	codexNoActiveTurnText     = "Codex has no active turn to steer"
	codexSteerNotConsumedText = "Codex ended the turn before applying the steered input"
)

// codexOperation is one attempt of one Run attached to a process. Every
// per-Operation fact lives here, so attaching resets it.
type codexOperation struct {
	proc      *codexProcess
	spec      RunSpec
	prompt    string
	logger    *slog.Logger
	taskID    string
	attempt   int
	startedAt time.Time
	fresh     bool
	reused    bool
	reviewed  bool
	bridge    *HumanInteractionBridge
	mcpConfig json.RawMessage
	mcpHash   string
	// configDigest is the Daemon's projection of the Codex home this
	// Operation runs with.
	configDigest string
	fence        releaseFence

	observed atomic.Int64
	activity chan string
	terminal chan struct{}
	titles   codexReasoningTitles

	streamMu     sync.Mutex
	events       chan Event
	streamClosed bool

	mu              sync.Mutex
	gateArmed       bool
	gateClosed      bool
	gateTurn        string
	turnID          string
	steerable       bool
	terminalSeen    bool
	terminalAborted bool
	turnErr         string
	turnDiag        RuntimeFailureDiagnostics
	// failureCode is a public failure code from a structured Codex signal.
	failureCode string
	itemsDone   map[string]bool
	answer      string
	liveUsage   *codexUsage
	lastUsage   *codexUsage
	compactions int64
	// children are the sub-agent threads this turn spawned.
	children map[string]codexChild
	// steers holds each steer that waits for Codex to show its user message,
	// by the client id the steer sent.
	steers           map[string]chan struct{}
	requests         *modelRequestClock
	nativeResume     *NativeResumeMeasurement
	resumed          bool
	newThread        bool
	setupMethod      string
	setupSentAt      time.Time
	boundFingerprint string
}

func newCodexOperation(proc *codexProcess, profile Profile, spec RunSpec, prompt string, attempt int, fresh, reused bool, logger *slog.Logger) *codexOperation {
	return &codexOperation{
		proc: proc, spec: spec, prompt: prompt, logger: logger, taskID: profile.TaskID, configDigest: profile.CodexConfigDigest,
		attempt: attempt, startedAt: time.Now(), fresh: fresh, reused: reused,
		reviewed: spec.CodexPermissionHook != nil, bridge: spec.HumanInteraction,
		activity: make(chan string, codexActivityBuffer), terminal: make(chan struct{}),
		events: make(chan Event, codexEventBuffer), itemsDone: map[string]bool{},
		children: map[string]codexChild{}, steers: map[string]chan struct{}{}, requests: newModelRequestClock(GranularityItem),
	}
}

// emit sends an event without ever blocking. A full or closed stream drops
// it.
func (op *codexOperation) emit(event Event) {
	if event.ObservedAt.IsZero() && (event.Kind == EventToolCall || event.Kind == EventToolOutput || event.Kind == EventText) {
		event.ObservedAt = time.Now()
	}
	if event.Kind == EventToolCall {
		op.mu.Lock()
		op.answer = ""
		op.mu.Unlock()
	}
	op.logger.Debug("codex agent message received", "type", string(event.Kind), "tool", event.ToolName,
		"call_id", event.InvocationID, "content_len", len(event.Body), "output_len", len(event.Output))
	switch event.Kind {
	case EventStatus:
		op.activityNote("status:" + event.Status)
	case EventToolCall, EventToolOutput:
		op.activityNote(string(event.Kind) + ":" + event.ToolName)
	default:
		op.activityNote(string(event.Kind))
	}
	op.streamMu.Lock()
	defer op.streamMu.Unlock()
	if op.streamClosed {
		return
	}
	select {
	case op.events <- event:
	default:
	}
}

func (op *codexOperation) closeStream() {
	op.streamMu.Lock()
	defer op.streamMu.Unlock()
	if !op.streamClosed {
		op.streamClosed = true
		close(op.events)
	}
}

func (op *codexOperation) activityNote(note string) {
	select {
	case op.activity <- note:
	default:
	}
}

func (op *codexOperation) recordTurnFailure(message, failureCode string, diagnostics RuntimeFailureDiagnostics) {
	op.mu.Lock()
	defer op.mu.Unlock()
	op.setTurnErrorLocked(message, failureCode, diagnostics)
}

func (op *codexOperation) setTurnErrorLocked(message, failureCode string, diagnostics RuntimeFailureDiagnostics) {
	if op.turnErr != "" {
		return
	}
	op.turnErr, op.turnDiag = message, diagnostics
	// A refused resume recorded its code before any turn error; keep it.
	if failureCode != "" {
		op.failureCode = failureCode
	}
}

func (op *codexOperation) budget(method string) time.Duration {
	if op.spec.StartupBudget > 0 {
		return op.spec.StartupBudget
	}
	switch method {
	case "thread/start", "thread/resume", "thread/unsubscribe":
		return codexDefaultThreadBudget
	}
	return codexDefaultStartupBudget
}

// codexFailure is how an attempt failed before or during its turn.
type codexFailure struct {
	status  string
	err     string
	process bool
	// initTimeout: initialize failed on its own startup budget.
	initTimeout bool
	// setup: a thread setup request failed after it was sent.
	setup         bool
	budgetTimeout bool
	resumeDenied  bool
}

// execute runs the operation sequence and returns a status and failure.
func (op *codexOperation) execute(ctx context.Context) codexFailure {
	if op.fresh {
		if failure, failed := op.initialize(ctx); failed {
			return failure
		}
	}
	fingerprint := codexBindingFingerprint(op.proc.home, op.configDigest, op.spec)
	op.mu.Lock()
	op.boundFingerprint = fingerprint
	op.mu.Unlock()
	mode, err := op.bind(ctx, fingerprint)
	if err != nil {
		failure := codexFailure{status: statusFailed, err: err.Error(), setup: op.setupMethod != ""}
		failure.budgetTimeout = codexIsHandshakeTimeout(err)
		if op.proc.transport.isDead() && errors.Is(err, errCodexChildGone) && ctx.Err() == nil {
			failure.process = true
		}
		if op.spec.ResumeID != "" && codexLineTooLong(err) {
			failure.resumeDenied = true
		}
		return failure
	}
	if op.spec.PrepareOnly {
		if op.spec.WarmMCP && mode != "reused" {
			if err := op.awaitMCPReady(ctx); err != nil {
				return codexFailure{status: statusFailed, err: err.Error()}
			}
		}
		return codexFailure{status: statusCompleted}
	}
	return op.runTurn(ctx)
}

func (op *codexOperation) initialize(ctx context.Context) (codexFailure, bool) {
	op.logger.Info("codex lifecycle", "phase", "initialize_sent", "pid", op.proc.pid, "attempt", op.attempt)
	sent := time.Now()
	params := map[string]any{
		"clientInfo":   map[string]any{"name": "linger-computer", "title": "Linger Computer", "version": op.proc.computerVersion},
		"capabilities": map[string]any{"experimentalApi": true},
	}
	_, _, err := op.proc.transport.call(ctx, "initialize", params, op.budget("initialize"), nil)
	if err == nil {
		err = op.proc.transport.notify(ctx, "initialized")
	}
	if err == nil {
		op.logger.Info("codex lifecycle", "phase", "initialize_response", "pid", op.proc.pid, "attempt", op.attempt, "latency_ms", time.Since(sent).Milliseconds())
		return codexFailure{}, false
	}
	interrupted := ctx.Err() != nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
	return codexFailure{
		status:        statusFailed,
		err:           "codex initialize failed: " + err.Error(),
		process:       !interrupted,
		initTimeout:   codexIsHandshakeTimeout(err) && ctx.Err() == nil,
		budgetTimeout: codexIsHandshakeTimeout(err),
	}, true
}

func codexIsHandshakeTimeout(err error) bool {
	var timeout *codexHandshakeTimeout
	return errors.As(err, &timeout)
}

// runTurn sends turn/start and waits for the turn to settle.
func (op *codexOperation) runTurn(ctx context.Context) codexFailure {
	thread := op.proc.boundThread()
	if hook := op.spec.CodexPermissionHook; hook != nil && hook.Endpoint != nil && op.spec.PermissionReviewer != nil {
		reviewer, spec := op.spec.PermissionReviewer, op.spec
		unregister := hook.Endpoint.Register(thread, func(ctx context.Context, event permission.CodexHookEvent) permission.Verdict {
			return permission.CodexReview(ctx, reviewer, event, spec.Dir, spec.RuntimeHome, spec.SharedTaskLink)
		})
		defer unregister()
	}
	params := map[string]any{"threadId": thread, "input": []any{map[string]any{"type": "text", "text": op.prompt}}}
	if op.spec.Effort != "" {
		params["effort"] = op.spec.Effort
	}
	if op.reviewed {
		params["approvalPolicy"], params["approvalsReviewer"] = "untrusted", "user"
	}
	op.mu.Lock()
	op.gateArmed = true
	op.mu.Unlock()
	op.proc.trackTurnStart(thread)
	var sentAt time.Time
	hooks := &codexCallHooks{
		sent: func(id int64) {
			sentAt = time.Now()
			op.logger.Info("codex turn/start sent", "request_id", id, "thread_id", thread, "sent_at_unix_ms", sentAt.UnixMilli())
		},
		observe: op.proc.trackTurnAck,
	}
	result, _, err := op.proc.transport.call(ctx, "turn/start", params, op.budget("turn/start"), hooks)
	if codexUnsent(err) {
		// No turn can exist, so stop cleanup must not wait for one.
		op.proc.untrackTurnStart()
	}
	if err != nil {
		select {
		case <-op.terminal:
			return op.terminalFailure()
		default:
		}
		if ctx.Err() != nil {
			return op.contextFailure(ctx)
		}
		return codexFailure{status: statusFailed, err: "codex turn/start failed: " + err.Error(), process: op.proc.transport.isDead()}
	}
	var ack struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	_ = json.Unmarshal(result, &ack)
	now := time.Now()
	op.logger.Info("codex turn/start acknowledged", "thread_id", thread, "turn_id", ack.Turn.ID,
		"acknowledged_at_unix_ms", now.UnixMilli(), "duration_ms", now.Sub(sentAt).Milliseconds())
	op.nameThreadAfterTurnStart(ctx, thread)
	return op.waitTurn(ctx)
}

func (op *codexOperation) terminalFailure() codexFailure {
	op.mu.Lock()
	defer op.mu.Unlock()
	switch {
	case op.terminalAborted:
		return codexFailure{status: statusAborted, err: "Codex turn interrupted"}
	case op.turnErr != "":
		return codexFailure{status: statusFailed, err: op.turnErr}
	}
	return codexFailure{status: statusCompleted}
}

func (op *codexOperation) contextFailure(ctx context.Context) codexFailure {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return codexFailure{status: statusTimeout, err: "Codex operation deadline exceeded"}
	}
	return codexFailure{status: statusAborted, err: "execution cancelled"}
}

// waitTurn waits for turn/completed under the first-progress and silence
// budgets. A terminal already received wins over everything else.
func (op *codexOperation) waitTurn(ctx context.Context) codexFailure {
	firstBudget := codexDefaultFirstProgress
	if op.spec.FirstProgressBudget > 0 {
		firstBudget = op.spec.FirstProgressBudget
	}
	silenceBudget := codexDefaultSilenceBudget
	if op.spec.SilenceBudget > 0 {
		silenceBudget = op.spec.SilenceBudget
	}
	silence := time.NewTimer(silenceBudget)
	defer silence.Stop()
	var first *time.Timer
	var firstC <-chan time.Time
	firstDone := false
	defer func() {
		if first != nil {
			first.Stop()
		}
	}()
	waiting := func() bool { return op.bridge != nil && op.bridge.Waiting() }
	for {
		select {
		case <-op.terminal:
			return op.terminalFailure()
		default:
		}
		select {
		case <-op.terminal:
			return op.terminalFailure()
		case <-op.proc.transport.dead:
			select {
			case <-op.terminal:
				return op.terminalFailure()
			default:
			}
			if ctx.Err() != nil {
				return op.contextFailure(ctx)
			}
			return codexFailure{status: statusFailed, err: op.proc.transport.err().Error(), process: true}
		case <-ctx.Done():
			select {
			case <-op.terminal:
				return op.terminalFailure()
			default:
			}
			return op.contextFailure(ctx)
		case note := <-op.activity:
			silence.Reset(silenceBudget)
			switch {
			case note == "status:running":
				if !firstDone && first == nil {
					first = time.NewTimer(firstBudget)
					firstC = first.C
				}
			case note != "error:retry" && !firstDone:
				firstDone = true
				if first != nil {
					first.Stop()
				}
				firstC = nil
			}
		case <-firstC:
			if waiting() {
				first.Reset(firstBudget)
				continue
			}
			return codexFailure{status: statusTimeout, err: fmt.Sprintf("%s after %s", CodexFirstTurnNoProgressMarker, firstBudget)}
		case <-silence.C:
			if waiting() {
				silence.Reset(silenceBudget)
				continue
			}
			return codexFailure{status: statusTimeout, err: fmt.Sprintf("%s after %s", CodexSemanticInactivityMarker, silenceBudget)}
		}
	}
}

// steer injects input into the live turn. Codex accepting turn/steer only
// queues the input; it is applied when the turn shows it as a user message.
// A turn that ends first did not apply it, so the caller may run it as new
// input. Only a lost connection or process leaves the outcome uncertain.
func (op *codexOperation) steer(ctx context.Context, request SteerRequest) (SteerAck, error) {
	op.mu.Lock()
	steerable, turn := op.steerable, op.turnID
	op.mu.Unlock()
	refuse := func(reason, actual, message string) error {
		return &SteerError{Effect: "definitely_not_applied", Reason: reason, ExpectedTurnID: request.ExpectedTurnID, ActualTurnID: actual, Message: message}
	}
	if !steerable {
		return SteerAck{}, refuse("no_active_turn", "", "no active turn to steer")
	}
	if turn != request.ExpectedTurnID {
		return SteerAck{}, refuse("target_mismatch", turn, fmt.Sprintf("expected active turn id `%s` but found `%s`", request.ExpectedTurnID, turn))
	}
	params := map[string]any{
		"threadId": op.proc.boundThread(), "expectedTurnId": request.ExpectedTurnID,
		"input": []any{map[string]any{"type": "text", "text": request.Input, "text_elements": []any{}}},
	}
	evidence := codexSupportsSteerClientID(op.proc.version)
	clientID := uuid.NewString()
	consumed := make(chan struct{})
	if evidence {
		params["clientUserMessageId"] = clientID
		op.mu.Lock()
		op.steers[clientID] = consumed
		op.mu.Unlock()
	}
	uncertain := func(reason, message string) error {
		return &SteerError{Effect: "uncertain", Reason: reason, ExpectedTurnID: request.ExpectedTurnID, Message: message}
	}
	result, _, err := op.proc.transport.call(ctx, "turn/steer", params, 0, nil)
	if err != nil {
		var rpcErr *codexRPCError
		if !errors.As(err, &rpcErr) {
			return SteerAck{}, uncertain("transport", "Codex steer acknowledgement is uncertain")
		}
		// Codex refused the input, so nothing was queued.
		op.mu.Lock()
		delete(op.steers, clientID)
		op.mu.Unlock()
		return SteerAck{}, refuse("rejected", "", rpcErr.Message)
	}
	var ack struct {
		TurnID string `json:"turnId"`
	}
	if json.Unmarshal(result, &ack) != nil || ack.TurnID != request.ExpectedTurnID {
		return SteerAck{}, uncertain("ack_mismatch", "Codex acknowledged steer for an unexpected turn")
	}
	if !evidence {
		return SteerAck{TurnID: ack.TurnID}, nil
	}
	select {
	case <-consumed:
		return SteerAck{TurnID: ack.TurnID}, nil
	case <-op.terminal:
		select {
		case <-consumed:
			return SteerAck{TurnID: ack.TurnID}, nil
		default:
		}
		// The entry stays, so the process that may still hold the input is
		// not parked for a later turn.
		return SteerAck{}, refuse("no_active_turn", "", codexSteerNotConsumedText)
	case <-op.proc.waitDone:
		return SteerAck{}, uncertain("transport", "Codex exited before showing the steered input")
	case <-ctx.Done():
		return SteerAck{}, uncertain("transport", "Codex steer confirmation was abandoned")
	}
}

// consumeSteer records that Codex showed a steered input in the live turn.
func (op *codexOperation) consumeSteer(clientID string) {
	op.mu.Lock()
	defer op.mu.Unlock()
	if consumed := op.steers[clientID]; consumed != nil {
		close(consumed)
		delete(op.steers, clientID)
	}
}

// heldSteer reports a steer Codex accepted but never showed: the process
// may still hold it, so it must not serve a later turn.
func (op *codexOperation) heldSteer() bool {
	op.mu.Lock()
	defer op.mu.Unlock()
	return len(op.steers) > 0
}

func codexLineTooLong(err error) bool { return errors.Is(err, bufio.ErrTooLong) }
