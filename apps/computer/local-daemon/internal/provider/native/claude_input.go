package native

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"time"

	"github.com/google/uuid"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/permission"
)

const (
	claudeSubmitFailed      = "Claude initialization or input submission failed"
	claudeAuthorizeFailed   = "Claude tool authorization failed"
	claudePermissionInvalid = "Claude permission request is invalid"
)

// submitFresh sends the first frames of a new process: initialize, then the
// user input.
func (t *claudeTurn) submitFresh(initialize []byte) {
	defer close(t.submitDone)
	ctx, cancel := context.WithTimeout(t.runCtx, claudeInitLimit)
	_, err := t.proc.conv.request(ctx, claudeInitializeRequestID, initialize)
	cancel()
	if err == nil {
		err = t.writeInput()
	}
	if err != nil {
		t.proc.closeStdin()
	}
	t.submitFailed(err)
}

// submitReused sends only the user input to an adopted process; its
// initialize frame is part of the resident shape.
func (t *claudeTurn) submitReused() {
	defer close(t.submitDone)
	err := t.writeInput()
	if err != nil {
		t.proc.closeStdin()
	}
	t.submitFailed(err)
}

func (t *claudeTurn) writeInput() error {
	native := t.proc.conv.current()
	t.proc.conv.markSubmitted(time.Now())
	if err := t.proc.write(t.runCtx, claudeUserFrame(native, t.prompt)); err != nil {
		t.inputErr = err
		return err
	}
	return nil
}

func (t *claudeTurn) submitFailed(err error) {
	t.submitErr = err
	if err == nil || t.runCtx.Err() != nil {
		return
	}
	t.proc.conv.abort(claudeSubmitFailed)
	t.runCancel()
}

// submittedOK checks without waiting that submission finished cleanly.
func (t *claudeTurn) submittedOK() bool {
	select {
	case <-t.submitDone:
		return t.submitErr == nil
	default:
		return false
	}
}

func claudeNotApplied(expected, actual string) *SteerError {
	return &SteerError{
		Effect: "definitely_not_applied", Reason: "no_active_turn",
		ExpectedTurnID: expected, ActualTurnID: actual,
		Message: "Claude turn is not accepting input",
	}
}

const claudeSteerTargetGone = "Claude steer target is not the active turn"

// steer interrupts the running turn and submits new input to the same Run.
// The acknowledgement names the stable run turn, never the rotating native
// uuid.
func (t *claudeTurn) steer(ctx context.Context, request SteerRequest) (SteerAck, error) {
	conv := t.proc.conv
	conv.steerMu.Lock()
	defer conv.steerMu.Unlock()
	if err := ctx.Err(); err != nil {
		return SteerAck{}, err
	}
	if err := t.awaitRunInput(ctx, request.ExpectedTurnID); err != nil {
		return SteerAck{}, err
	}
	conv.mu.Lock()
	runID := conv.runID
	if conv.owner != t || conv.closed || conv.finished || !conv.active || t.proc.isStopping() || request.ExpectedTurnID != runID {
		conv.mu.Unlock()
		return SteerAck{}, claudeNotApplied(request.ExpectedTurnID, runID)
	}
	nativeID := uuid.NewString()
	conv.nativeID, conv.active = nativeID, false
	conv.pendingInterrupted++
	conv.steerUnconfirmed = true
	confirmed := make(chan struct{})
	conv.waiters[nativeID] = confirmed
	conv.mu.Unlock()

	interrupt, _ := json.Marshal(map[string]any{
		"type": "control_request", "request_id": claudeInterruptPrefix + nativeID,
		"request": map[string]any{"subtype": "interrupt"},
	})
	limit, cancel := context.WithTimeout(ctx, claudeSteerLimit)
	_, err := conv.request(limit, claudeInterruptPrefix+nativeID, interrupt)
	if err == nil {
		err = t.proc.write(limit, claudeUserFrame(nativeID, request.Input))
	}
	cancel()
	if err == nil {
		select {
		case <-confirmed:
		case <-ctx.Done():
			err = ctx.Err()
		case <-t.proc.ctx.Done():
			err = errors.New("Claude process is stopping")
		case <-conv.finishedCh:
			err = io.EOF
		}
	}
	if err != nil && !claudeClosed(confirmed) {
		conv.abort(claudeSteerNotConfirmed)
		return SteerAck{}, &SteerError{
			Effect: "uncertain", Reason: "transport",
			ExpectedTurnID: request.ExpectedTurnID, ActualTurnID: nativeID,
			Message: claudeSteerNotConfirmed,
		}
	}
	return SteerAck{TurnID: runID}, nil
}

// awaitRunInput holds a steer that arrives after system/init started the
// turn but before the run input is confirmed. Nothing is written while it
// waits. It returns nil once the input is confirmed or the turn ended; the
// caller then checks admission again.
func (t *claudeTurn) awaitRunInput(ctx context.Context, expected string) error {
	conv := t.proc.conv
	for {
		conv.mu.Lock()
		runID := conv.runID
		waiting := conv.owner == t && conv.started && !conv.active && !conv.closed && !conv.finished &&
			!t.proc.isStopping() && expected == runID
		changed := conv.changed
		conv.mu.Unlock()
		if !waiting {
			return nil
		}
		gone := func() error {
			return &SteerError{
				Effect: "definitely_not_applied", Reason: "no_active_turn",
				ExpectedTurnID: expected, ActualTurnID: runID, Message: claudeSteerTargetGone,
			}
		}
		select {
		case <-changed:
		case <-ctx.Done():
			return gone()
		case <-t.proc.ctx.Done():
			return gone()
		case <-conv.finishedCh:
			return gone()
		}
	}
}

// authorize answers a control_request on the inline path, or hands a
// can_use_tool call to the Room permission review.
func (t *claudeTurn) authorize(frame claudeFrame) {
	if t.compaction {
		if err := t.proc.write(t.runCtx, claudeControlRefusal(frame.RequestID, "Session compaction allows no requests")); err != nil {
			t.proc.conv.abort(claudeAuthorizeFailed)
		}
		return
	}
	var peek struct {
		Subtype string `json:"subtype"`
	}
	_ = json.Unmarshal(frame.Request, &peek)
	if peek.Subtype == "can_use_tool" && t.spec.PermissionReviewer != nil {
		t.review(frame)
		return
	}
	payload, err := claudeAuthorizeInline(t.spec.ClaudePolicy, frame.RequestID, frame.Request)
	if err == nil {
		err = t.proc.write(t.runCtx, claudeControlReply(frame.RequestID, payload))
	}
	if err != nil {
		t.proc.conv.abort(claudeAuthorizeFailed)
	}
}

func (t *claudeTurn) review(frame claudeFrame) {
	var request claudeControlRequest
	if frame.RequestID == "" || json.Unmarshal(frame.Request, &request) != nil {
		t.proc.conv.abort(claudePermissionInvalid)
		return
	}
	input, ok := claudeObject(request.Input)
	if !ok {
		t.proc.conv.abort(claudePermissionInvalid)
		return
	}
	if reason := t.spec.ClaudePolicy.denyReason(request.ToolName, input, request.AgentID); reason != "" {
		if err := t.proc.write(t.runCtx, claudeControlReply(frame.RequestID, claudeDeny(reason))); err != nil {
			t.proc.conv.abort(claudeAuthorizeFailed)
		}
		return
	}
	id := frame.RequestID
	reviewCtx, cancel := context.WithCancel(t.runCtx)
	t.reviewMu.Lock()
	if previous := t.reviews[id]; previous != nil {
		previous()
	}
	t.reviews[id] = cancel
	t.reviewMu.Unlock()
	session := t.observedSession
	reviewer := t.spec.PermissionReviewer
	go func() {
		defer cancel()
		review := permission.ClaudeRequest(request.ToolName, input, request.AgentID, t.spec.Dir)
		review.Transcript = permission.ClaudeTranscript(reviewCtx, t.spec.RuntimeHome, session)
		verdict := reviewer.Review(reviewCtx, review)
		t.reviewMu.Lock()
		current := t.reviews[id]
		delete(t.reviews, id)
		t.reviewMu.Unlock()
		if current == nil || reviewCtx.Err() != nil {
			return
		}
		response := claudeControlReply(id, permission.CanUseToolResponse(verdict, input, request.ToolUseID))
		if err := t.proc.write(t.runCtx, response); err != nil && t.runCtx.Err() == nil {
			t.proc.conv.abort(claudeAuthorizeFailed)
		}
	}()
}
