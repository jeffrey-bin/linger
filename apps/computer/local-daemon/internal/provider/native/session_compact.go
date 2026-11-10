package native

import (
	"context"
	"errors"
	"log/slog"
	"strings"

	"github.com/google/uuid"
)

// CompactResult is what one Runtime compaction of a parked session did.
type CompactResult struct {
	// Outcome is compacted, nothing_to_compact, canceled or failed.
	Outcome string
	// PreTokens is the context size Claude reported before it compacted.
	PreTokens *int64
	Reason    string
}

// ParkedSession is a parked Codex or Claude process taken out of its
// resident table for one compaction, so no Run can take it meanwhile.
type ParkedSession struct {
	codex  *codexProcess
	claude *claudeProcess
	fence  releaseFence
	logger *slog.Logger
}

// TakeParkedSession takes the process parked for an execution Context, or
// returns nil when none is. Compact must then be called exactly once.
func TakeParkedSession(runtimeType, contextKey string) *ParkedSession {
	session := &ParkedSession{logger: slog.Default().With("execution_context_key", contextKey)}
	var taken bool
	switch runtimeType {
	case "codex":
		session.codex, session.fence, taken = codexResidents.takeContext(contextKey, session.logger)
	case "claude":
		session.claude, session.fence, taken = claudeResidents.takeContext(contextKey, session.logger)
	}
	if !taken {
		return nil
	}
	return session
}

// Compact runs the Runtime's own compaction of the session. A turn that ends
// cleanly parks the process back unchanged, so the next Run reuses it; any
// other end retires the process before Compact returns.
func (s *ParkedSession) Compact(ctx context.Context, instructions string) CompactResult {
	var status, reason string
	var compactions int64
	var preTokens *int64
	if s.codex != nil {
		status, reason, compactions = s.compactCodex(ctx)
	} else {
		status, reason, compactions, preTokens = s.compactClaude(ctx, instructions)
	}
	switch {
	case status == statusCompleted && compactions > 0:
		return CompactResult{Outcome: "compacted", PreTokens: preTokens}
	case status == statusCompleted && s.claude != nil:
		// Claude answers a session too short to compact without a boundary.
		return CompactResult{Outcome: "nothing_to_compact"}
	case status == statusCompleted:
		return CompactResult{Outcome: "failed", Reason: "Codex ended the compaction turn without compacting"}
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		return CompactResult{Outcome: "failed", Reason: "Session compaction deadline exceeded"}
	case ctx.Err() != nil:
		return CompactResult{Outcome: "canceled", Reason: "Session compaction canceled"}
	}
	return CompactResult{Outcome: "failed", Reason: reason}
}

// compactCodex runs thread/compact/start on the loaded thread. Codex reads
// its compact prompt from process config, so instructions do not apply.
func (s *ParkedSession) compactCodex(ctx context.Context) (status, reason string, compactions int64) {
	proc := s.codex
	op := newCodexOperation(proc, Profile{}, RunSpec{}, "", 0, false, true, s.logger)
	op.fence = s.fence
	proc.mu.Lock()
	proc.op = op
	proc.mu.Unlock()
	failure := op.compact(ctx)
	op.closeStream()
	op.mu.Lock()
	compactions = op.compactions
	op.mu.Unlock()
	parked := false
	if failure.status == statusCompleted {
		proc.mu.Lock()
		proc.op = nil
		proc.mu.Unlock()
		if parked = codexResidents.park(proc, s.fence, false, s.logger, nil); !parked {
			proc.mu.Lock()
			proc.op = op
			proc.mu.Unlock()
		}
	}
	if !parked {
		// Cleanup interrupts a compaction still running. The Operation stays
		// attached so that its turn/completed reaches the tracker.
		codexResidents.retire(proc)
		proc.mu.Lock()
		if proc.op == op {
			proc.op = nil
		}
		proc.mu.Unlock()
	}
	return failure.status, failure.err, compactions
}

// compact starts Codex's own compaction of the bound thread and waits for
// its turn. Initialize and binding are skipped: the parked process holds
// both.
func (op *codexOperation) compact(ctx context.Context) codexFailure {
	thread := op.proc.boundThread()
	op.mu.Lock()
	op.gateArmed = true
	op.mu.Unlock()
	op.proc.trackTurnStart(thread)
	_, _, err := op.proc.transport.call(ctx, "thread/compact/start", map[string]any{"threadId": thread},
		op.budget("thread/compact/start"), &codexCallHooks{observe: op.proc.trackTurnAck})
	if codexUnsent(err) {
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
		return codexFailure{status: statusFailed, err: "codex thread/compact/start failed: " + err.Error()}
	}
	return op.waitTurn(ctx)
}

// compactClaude submits /compact as a turn of the parked conversation. A
// turn that does not park the process back ends with the process exit, so
// a later spawn on its session root never races it.
func (s *ParkedSession) compactClaude(ctx context.Context, instructions string) (status, reason string, compactions int64, preTokens *int64) {
	p := s.claude
	runCtx, runCancel := context.WithCancel(ctx)
	turn := claudeNewTurn(ctx, runCtx, p, runCancel, strings.TrimSpace("/compact "+instructions), RunSpec{}, Profile{Logger: s.logger}, true)
	turn.fence, turn.compaction = s.fence, true
	p.conv.reset(turn, uuid.NewString())
	p.stderrSnippet.Reset()
	if !p.bind(turn) {
		runCancel()
		claudeResidents.retire(p)
		return statusFailed, "Claude process ended before compaction", 0, nil
	}
	go turn.watch()
	go turn.submitReused()
	for range turn.events {
	}
	out := <-turn.outcome
	if out.CompactionCount != nil {
		compactions = *out.CompactionCount
	}
	return out.Status, out.Error, compactions, turn.preTokens
}
