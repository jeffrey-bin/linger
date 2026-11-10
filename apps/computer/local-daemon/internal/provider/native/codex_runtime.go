package native

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"time"
)

const (
	CodexSemanticInactivityMarker  = "codex semantic inactivity timeout"
	CodexFirstTurnNoProgressMarker = "codex app-server no progress timeout"
	CodexHandshakeTimeoutMarker    = "codex app-server handshake timeout"
)

const codexMaxAttempts = 2

type codexRuntime struct{ profile Profile }

func newCodexRuntime(profile Profile) Runtime { return &codexRuntime{profile: profile} }

// codexAttempt is one attempt's event stream and outcome.
type codexAttempt struct {
	op      *codexOperation
	outcome chan Outcome
}

// Start acquires a process synchronously and runs the Operation in the
// background. At most one retry follows a retry-safe initialize timeout.
func (r *codexRuntime) Start(ctx context.Context, prompt string, spec RunSpec) (*Run, error) {
	spec.MCPServers = mcpNamespace(spec.MCPServers)
	if spec.providerPrepare() {
		if run, ok := r.compatiblePrepared(spec); ok {
			return run, nil
		}
	}
	overall, cancel := budgetContext(ctx, spec.Budget)
	first, err := r.startAttempt(overall, prompt, spec, 1)
	if err != nil {
		cancel()
		return nil, err
	}
	events := make(chan Event)
	outcomes := make(chan Outcome, 1)
	var mu sync.Mutex
	current, finished := first, false
	go func() {
		defer cancel()
		attempt := first
		var out Outcome
		for number := 1; ; number++ {
			for event := range attempt.op.events {
				events <- event
			}
			result, ok := <-attempt.outcome
			if !ok {
				result = Outcome{Status: statusFailed, Error: codexNoResultText}
			}
			out = result
			if !result.retrySafe || number >= codexMaxAttempts || overall.Err() != nil {
				break
			}
			r.profile.Logger.Warn("codex retry scheduled", "reason", "initialize", "attempt", number, "next_attempt", number+1)
			next, err := r.startAttempt(overall, prompt, spec, number+1)
			if err != nil {
				out = Outcome{Status: statusFailed, Error: err.Error()}
				break
			}
			mu.Lock()
			current = next
			mu.Unlock()
			attempt = next
		}
		mu.Lock()
		finished = true
		mu.Unlock()
		out.retrySafe = false
		close(events)
		outcomes <- out
		close(outcomes)
	}()
	steer := func(ctx context.Context, request SteerRequest) (SteerAck, error) {
		mu.Lock()
		attempt, done := current, finished
		mu.Unlock()
		if done {
			return SteerAck{}, &SteerError{Effect: "definitely_not_applied", Reason: "no_active_turn", ExpectedTurnID: request.ExpectedTurnID, Message: codexNoActiveTurnText}
		}
		return attempt.op.steer(ctx, request)
	}
	return &Run{Events: events, Outcome: outcomes, Steer: steer}, nil
}

// startAttempt acquires a process (reused or launched) and starts the
// Operation on it.
func (r *codexRuntime) startAttempt(overall context.Context, prompt string, spec RunSpec, number int) (*codexAttempt, error) {
	profile, logger := r.profile, r.profile.Logger
	program := strings.TrimSpace(profile.Program)
	if program == "" {
		program = "codex"
	}
	executable, err := exec.LookPath(program)
	if err != nil {
		return nil, fmt.Errorf("locate Codex executable: %w", err)
	}
	home := strings.TrimSpace(profile.Env["CODEX_HOME"])
	key := codexResidentKey(home, profile.RuntimeID, executable)
	if home == "" {
		return nil, errCodexMissingHome
	}
	fence := captureReleaseFence(profile)
	proc, _, err := codexResidents.take(key, codexMismatch(profile, spec, executable), logger, spec.Readiness)
	if err != nil {
		return nil, err
	}
	fresh := proc == nil
	var config json.RawMessage
	if fresh {
		if err := codexResidents.stopKey(key, logger, spec.Readiness); err != nil {
			return nil, err
		}
		front, rewritten, err := codexPrepareFront(nil, spec.MCPServers)
		if err != nil {
			return nil, err
		}
		if err := codexProjectMCP(home, rewritten); err != nil {
			front.Close()
			return nil, err
		}
		proc, err = codexLaunch(profile, spec, executable, home, key, number, front, logger)
		if err != nil {
			front.Close()
			return nil, err
		}
		proc.computerVersion = profile.ComputerVersion
		spec.Readiness.spawned()
		config = rewritten
	} else {
		proc.mu.Lock()
		front := proc.front
		proc.mu.Unlock()
		newFront, rewritten, err := codexPrepareFront(front, spec.MCPServers)
		if err == nil {
			err = codexProjectMCP(home, rewritten)
		}
		if err != nil {
			newFront.Unbind()
			proc.mu.Lock()
			proc.front = newFront
			proc.mu.Unlock()
			if !codexResidents.park(proc, fence, false, logger, spec.Readiness) {
				codexResidents.retire(proc)
			}
			return nil, err
		}
		proc.mu.Lock()
		proc.front = newFront
		proc.mu.Unlock()
		config = rewritten
	}
	op := newCodexOperation(proc, profile, spec, prompt, number, fresh, !fresh, logger)
	op.fence = fence
	op.mcpConfig, op.mcpHash = config, codexMCPHash(config)
	proc.mu.Lock()
	proc.op = op
	proc.mu.Unlock()
	attemptCtx, cancel := budgetContext(overall, spec.Budget)
	attempt := &codexAttempt{op: op, outcome: make(chan Outcome, 1)}
	go func() {
		defer cancel()
		failure := op.execute(attemptCtx)
		out := op.finish(attemptCtx, failure)
		op.closeStream()
		attempt.outcome <- out
		close(attempt.outcome)
	}()
	return attempt, nil
}

// compatiblePrepared leaves a live compatible parked process alone when a
// provider prepare finds one: the prepare is already satisfied.
func (r *codexRuntime) compatiblePrepared(spec RunSpec) (*Run, bool) {
	program := strings.TrimSpace(r.profile.Program)
	if program == "" {
		program = "codex"
	}
	executable, err := exec.LookPath(program)
	if err != nil {
		return nil, false
	}
	home := strings.TrimSpace(r.profile.Env["CODEX_HOME"])
	key := codexResidentKey(home, r.profile.RuntimeID, executable)
	live, fields := codexResidents.peek(key, codexMismatch(r.profile, spec, executable))
	if !live || len(fields) > 0 {
		return nil, false
	}
	events := make(chan Event)
	close(events)
	outcomes := make(chan Outcome, 1)
	outcomes <- Outcome{Status: statusCompleted, SessionID: spec.ResumeID}
	close(outcomes)
	return &Run{Events: events, Outcome: outcomes}, true
}

// codexPrepareFront binds the process front to this Operation's targets
// and returns the config the CLI should see. A new front is created only
// when the config is eligible and has targets.
func codexPrepareFront(front *mcpFront, config json.RawMessage) (*mcpFront, json.RawMessage, error) {
	_, targets, eligible := residentMCPShape(config)
	if !eligible || len(targets) == 0 {
		front.Unbind()
		return front, config, nil
	}
	created := false
	if front == nil {
		var err error
		if front, err = newMCPFront(); err != nil {
			return nil, nil, fmt.Errorf("start Codex MCP front: %w", err)
		}
		created = true
	}
	if err := front.Bind(targets); err != nil {
		if created {
			front.Close()
			return nil, nil, err
		}
		return front, nil, err
	}
	rewritten, err := front.Rewrite(config)
	if err != nil {
		if created {
			front.Close()
			return nil, nil, err
		}
		return front, nil, err
	}
	return front, rewritten, nil
}

// finish publishes an attempt's outcome only after its process is either
// parked or stopped with cleanup evidence.
func (op *codexOperation) finish(ctx context.Context, failure codexFailure) Outcome {
	proc := op.proc
	out := Outcome{Status: failure.status, Error: failure.err, ResumeRefused: failure.resumeDenied}
	op.mu.Lock()
	out.TurnID = op.turnID
	out.NativeResume = op.nativeResume
	out.Diagnostics = op.turnDiag
	out.FailureCode = op.failureCode
	fingerprint := op.boundFingerprint
	setupMethod, setupSent := op.setupMethod, op.setupSentAt
	op.mu.Unlock()
	if out.TurnID == "" {
		out.TurnID = proc.trackerSnapshot().turnID
	}
	out.SessionID = proc.boundThread()
	proc.mu.Lock()
	front := proc.front
	proc.mu.Unlock()
	front.Unbind()

	parked := false
	if out.Status == statusCompleted {
		op.collectUsage(&out)
		proc.mu.Lock()
		proc.fingerprint, proc.mcpHash = fingerprint, op.mcpHash
		proc.op = nil
		proc.mu.Unlock()
		prestart := op.spec.providerPrepare() && op.fresh
		if op.heldSteer() {
			// Codex accepted a steer it never showed; another turn on this
			// process could still apply it after the caller ran it again.
			op.logger.Info("codex resident not parked", "reason", "steer_not_applied")
		} else {
			parked = codexResidents.park(proc, op.fence, prestart, op.logger, op.spec.Readiness)
		}
		out.Parked = parked && prestart
		if !parked {
			proc.mu.Lock()
			proc.op = op
			proc.mu.Unlock()
		}
	}
	code := "resident"
	confirmed := false
	if !parked {
		confirmed = codexResidents.retire(proc)
		out.ExitConfirmed, out.ExitUnconfirmed = confirmed, !confirmed
		code = "reaped"
		if !confirmed {
			code = "unconfirmed"
			proc.mu.Lock()
			proc.op = nil
			proc.mu.Unlock()
			if out.Status == statusCompleted {
				out.Status, out.Error = statusFailed, codexCleanupUnconfirmedText
			}
		}
	}
	recordTiming(op.logger, time.Now(), timingCodexCleanupComplete, "thread_id", out.SessionID, "turn_id", out.TurnID, "code", code)
	if failure.process {
		out.Error = withStderr(out.Error, "codex", proc.stderr.Tail())
		if diagnostics := proc.exitDiagnostics(); !diagnostics.empty() {
			out.Diagnostics.ExitCode, out.Diagnostics.Signal = diagnostics.ExitCode, diagnostics.Signal
		}
	}
	if failure.setup && setupMethod != "" {
		attrs := []any{"phase", strings.ReplaceAll(setupMethod, "/", "_") + "_failure", "method", setupMethod,
			"latency_ms", time.Since(setupSent).Milliseconds(), "reaped", proc.isReaped(), "cleanup_confirmed", confirmed,
			"retry_safe", false, "retry_attempted", false}
		op.logger.Warn("codex lifecycle", append(attrs, proc.stderrCounts(failure.budgetTimeout)...)...)
	}
	if failure.initTimeout {
		out.retrySafe = op.observed.Load() == 0 && confirmed && ctx.Err() == nil
		op.logger.Warn("codex lifecycle", "phase", "initialize_failure", "pid", proc.pid, "attempt", op.attempt,
			"cleanup_confirmed", confirmed, "retry_safe", out.retrySafe)
	}
	if out.Status == statusCompleted {
		op.mu.Lock()
		out.Output = op.answer
		op.mu.Unlock()
	}
	if !parked {
		op.collectUsage(&out)
		proc.mu.Lock()
		if proc.op == op {
			proc.op = nil
		}
		proc.mu.Unlock()
	}
	if out.CompactionCount == nil {
		zero := int64(0)
		out.CompactionCount = &zero
	}
	out.ElapsedMs = time.Since(op.startedAt).Milliseconds()
	return out
}
