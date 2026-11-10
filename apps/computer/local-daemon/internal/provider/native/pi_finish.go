package native

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"time"
)

const (
	piStatusCancelled = "cancelled"
	piStartupBudget   = 30 * time.Second
	piAbortBudget     = 2 * time.Second
	piProbeBudget     = 2 * time.Second
)

// drive runs the startup exchange, waits for the turn to settle, then parks
// the process or stops it, and delivers the single Outcome.
func (t *piTurn) drive(prompt string) {
	began := time.Now()
	status, failure := statusCompleted, ""
	settled := false
	if err := t.startup(prompt); err != nil {
		status, failure = statusFailed, err.Error()
	} else {
		select {
		case <-t.settled:
			settled = true
		case <-t.proc.closed:
			select {
			case <-t.settled:
				settled = true
			default:
			}
		case <-t.runCtx.Done():
		}
	}
	if settled {
		t.timing("pi.agent_settled")
	}
	t.mu.Lock()
	t.stopping = true
	streamFailure := t.failure
	t.mu.Unlock()
	interrupted := t.runCtx.Err() != nil && !settled
	switch {
	case interrupted:
		status, failure = piInterruption(t.runCtx)
	case status == statusCompleted && !settled:
		status, failure = statusFailed, "Pi exited before agent_settled"
		if streamFailure != "" {
			failure = streamFailure
		}
	}
	if status == statusCompleted && settled && t.park(began) {
		return
	}
	t.finish(began, status, failure, interrupted)
}

// startup checks the session identity of a fresh process, then submits the
// prompt, within one 30-second budget that the run context also bounds. A
// reused process already passed the idle probe.
func (t *piTurn) startup(prompt string) error {
	ctx, cancel := context.WithTimeout(t.runCtx, piStartupBudget)
	defer cancel()
	if !t.reused {
		if _, err := t.proc.sessionState(ctx); err != nil {
			return err
		}
		t.timing("pi.get_state_ok")
	}
	reply, err := t.proc.call(ctx, "prompt", map[string]any{"message": prompt}, nil)
	if err != nil {
		return fmt.Errorf("Pi prompt did not start: %w", err)
	}
	var started struct {
		Disposition string `json:"disposition"`
	}
	_ = json.Unmarshal(reply.Data, &started)
	if started.Disposition != "started" {
		return fmt.Errorf("Pi prompt did not start (disposition %q)", started.Disposition)
	}
	t.timing("pi.prompt_ok")
	return nil
}

func piInterruption(ctx context.Context) (string, string) {
	if errors.Is(context.Cause(ctx), errRunBudgetExpired) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return statusTimeout, "operation timed out"
	}
	return piStatusCancelled, "operation cancelled"
}

// park keeps a cleanly settled process for the next turn on its session.
// The Outcome then goes out while Pi still runs, with neither exit flag.
func (t *piTurn) park(began time.Time) bool {
	p := t.proc
	t.mu.Lock()
	clean := t.failure == "" && !t.settleAborted && t.sawAssistant && t.steering == nil
	t.mu.Unlock()
	if p.shape == nil || !clean || p.res.isStopping() || t.runCtx.Err() != nil || !p.alive() || !piResidents.enabled() {
		return false
	}
	// Steer admission is closed, so no new input can overtake the probe.
	probeCtx, cancel := context.WithTimeout(context.Background(), piProbeBudget)
	err := p.probeIdle(probeCtx)
	cancel()
	if err != nil {
		return false
	}
	p.mu.Lock()
	if t.runCtx.Err() != nil || p.res.isStopping() || p.turn != t {
		p.mu.Unlock()
		return false
	}
	p.turn = nil
	p.mu.Unlock()
	p.front.Unbind()
	outcome := t.outcomeFor(began, statusCompleted, "")
	if !piResidents.park(p, t.fence, false, t.logger, t.readiness) {
		return false
	}
	t.timing("pi.turn.parked")
	t.deliver(outcome)
	return true
}

// finish stops the process and reports how the turn ended. An unconfirmed
// exit holds the process in the table so no spawn reuses its session.
func (t *piTurn) finish(began time.Time, status, failure string, interrupted bool) {
	p := t.proc
	if status != statusCompleted {
		t.abortQueue()
	}
	confirmed := p.stop()
	if status == statusCompleted {
		status, failure = t.settledStatus()
	}
	outcome := t.outcomeFor(began, status, failure)
	outcome.ExitConfirmed, outcome.ExitUnconfirmed = confirmed, !confirmed
	if status == statusFailed && !interrupted && !p.terminated.Load() {
		outcome.Diagnostics = processExitDiagnostics(p.cmd.ProcessState)
	}
	p.unbind(t)
	if confirmed {
		piResidents.forget(p)
	} else {
		piResidents.hold(p)
	}
	t.timing("pi.cleanup_completed", "code", status)
	t.deliver(outcome)
}

func (t *piTurn) outcomeFor(began time.Time, status, failure string) Outcome {
	outcome := Outcome{Status: status, Error: failure, SessionID: t.proc.sessionID, TurnID: t.id}
	t.mu.Lock()
	outcome.Output = t.output
	outcome.Usage, outcome.LastUsage = maps.Clone(t.usage), maps.Clone(t.lastUsage)
	compactions := t.compactions
	t.mu.Unlock()
	outcome.CompactionCount = &compactions
	outcome.ElapsedMs = time.Since(began).Milliseconds()
	return outcome
}

// abortQueue clears queued input before aborting; abort alone would let
// queued steering continue. Errors are ignored.
func (t *piTurn) abortQueue() {
	ctx, cancel := context.WithTimeout(context.Background(), piAbortBudget)
	defer cancel()
	_, _ = t.proc.call(ctx, "clear_queue", nil, nil)
	_, _ = t.proc.call(ctx, "abort", nil, nil)
}

// settledStatus decides a turn that settled normally, after the stop.
func (t *piTurn) settledStatus() (string, string) {
	t.mu.Lock()
	failure, aborted, sawAssistant := t.failure, t.settleAborted, t.sawAssistant
	t.mu.Unlock()
	p := t.proc
	switch {
	case failure != "":
		return statusFailed, failure
	case aborted:
		return statusAborted, "Pi aborted the turn"
	case !sawAssistant:
		return statusFailed, "Pi settled without an assistant result"
	case p.waitErr != nil:
		return statusFailed, "Pi exited unsuccessfully: " + p.waitErr.Error()
	}
	if err := piValidateSession(p.sessionDir, p.sessionID, p.contextDir); err != nil {
		return statusFailed, err.Error()
	}
	return statusCompleted, ""
}
