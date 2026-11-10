package native

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// claudeEnding says how a turn ended: by parking (exited false) or with the
// process exit and the cleanup decision.
type claudeEnding struct {
	exited    bool
	confirmed bool
	readErr   error
	parked    bool
}

func (t *claudeTurn) compute(end claudeEnding) Outcome {
	<-t.submitDone
	t.flushResponses()
	conv := t.proc.conv
	nativeID := conv.current()
	compactions := t.compactions
	out := Outcome{
		Status:          statusCompleted,
		SessionID:       t.observedSession,
		TurnID:          nativeID,
		ElapsedMs:       time.Since(t.startedAt).Milliseconds(),
		Usage:           t.usage,
		LastUsage:       t.lastUsage,
		CompactionCount: &compactions,
		ExitConfirmed:   end.exited && end.confirmed,
		ExitUnconfirmed: end.exited && !end.confirmed,
	}
	// A parked turn ended while its run context was alive.
	interrupted := ""
	if !end.parked {
		interrupted = interruptedStatus(t.runCtx)
	}
	terminal := t.terminal
	promptTooLong := false
	if terminal != nil {
		out.Output = terminal.Result
		if out.Output == "" && t.defaultFailureFor == nativeID {
			out.Output = t.fallback
		}
		if terminal.TerminalReason != "completed" {
			out.Diagnostics.Code = terminal.TerminalReason
		}
		if terminal.APIErrorStatus != 0 {
			out.Diagnostics.StatusCode = intPointer(int(terminal.APIErrorStatus))
		}
		if terminal.IsError {
			out.Status, out.Error = statusFailed, claudeErrorText(terminal)
		}
		if strings.TrimSpace(terminal.TerminalReason) == "prompt_too_long" {
			promptTooLong = true
			out.Status = statusFailed
			out.Error = "Claude terminal_reason=prompt_too_long: context window exhausted"
			if text := strings.TrimSpace(terminal.Result); text != "" {
				out.Error += ": " + text
			}
		}
	}
	if out.Status == statusCompleted {
		switch {
		case interrupted == statusTimeout:
			out.Status, out.Error = statusTimeout, "Claude execution deadline exceeded"
		case interrupted == statusAborted:
			out.Status, out.Error = statusAborted, "execution cancelled"
		case end.readErr != nil:
			out.Status, out.Error = statusFailed, "Claude stdout read error: "+end.readErr.Error()
		case t.inputErr != nil && t.observedSession == "":
			out.Status, out.Error = statusFailed, "write Claude input: "+t.inputErr.Error()
		case end.exited && t.proc.exitError() != nil:
			out.Status, out.Error = statusFailed, "Claude exited with error: "+t.proc.exitError().Error()
		case terminal == nil:
			out.Status, out.Error = statusFailed, "Claude stream ended without terminal result"
		case t.background:
			out.Status, out.Error = statusFailed, "Claude launched an async background task; Local Computer runs require foreground execution"
		}
	}
	failure := conv.failureSummary()
	if failure != "" {
		out.Status, out.Error = statusFailed, failure
	}
	if end.exited && !end.confirmed {
		out.Status, out.Error = statusFailed, "Claude native Session cleanup was not confirmed"
	}
	if failure == "" && !end.parked && errors.Is(t.callerCtx.Err(), context.Canceled) &&
		(terminal == nil || t.terminalAfterCancel) && !promptTooLong {
		out.Status, out.Error = statusAborted, "execution cancelled"
	}
	if out.Status == statusCompleted && t.spec.ResumeRequired && t.spec.ResumeID != "" && t.observedSession != t.spec.ResumeID {
		out.Status = statusFailed
		out.Error = "Claude native Session restoration identity was not confirmed; submitted execution must not be retried"
	}
	if out.Status != statusCompleted {
		out.Output = ""
	}
	tail := t.proc.stderrSnippet.Tail()
	out.ResumeRefused = t.resumeRefused(out.Status)
	if out.ResumeRefused {
		out.FailureCode = "session_not_found"
	} else if promptTooLong {
		out.FailureCode = "context_too_long"
	} else if out.Status == statusFailed {
		out.FailureCode = claudeAPIErrorFailureCodes[t.apiError]
	}
	if out.ResumeRefused || (t.spec.ResumeRequired && out.Status != statusCompleted && t.observedSession != t.spec.ResumeID) {
		out.SessionID = ""
	}
	if out.Error != "" {
		out.Error = withStderr(out.Error, "claude", tail)
	}
	if out.Status != statusFailed {
		out.Diagnostics = RuntimeFailureDiagnostics{}
	} else if end.exited && t.runCtx.Err() == nil && !t.proc.cancelledByDaemon() {
		exit := processExitDiagnostics(t.proc.exitState())
		out.Diagnostics.ExitCode, out.Diagnostics.Signal = exit.ExitCode, exit.Signal
	}
	t.writeRunSummary(out, end.readErr != nil)
	return out
}

func claudeErrorText(frame *claudeFrame) string {
	if frame.Result != "" {
		return frame.Result
	}
	var texts []string
	for _, raw := range frame.Errors {
		var text string
		if json.Unmarshal(raw, &text) == nil && text != "" {
			texts = append(texts, text)
		}
	}
	if len(texts) > 0 {
		return strings.Join(texts, "; ")
	}
	return "Claude returned an error result without details"
}

// claudeAPIErrorFailureCodes maps the error code Claude puts on a synthetic
// API-error assistant message to a public failure code. Unlisted codes fall
// through to the diagnostics.
var claudeAPIErrorFailureCodes = map[string]string{
	"authentication_failed": "authentication_required",
	"rate_limit":            "rate_limited",
	"billing_error":         "rate_limited",
	"model_not_found":       "model_unavailable",
	"server_error":          "model_service_error",
}

// resumeRefused accepts only structural evidence that the native session is
// gone or belongs elsewhere: the CLI reported another session, or a CLI
// started for this resume failed during execution before it ever announced
// the session with init. A reused process announced its session on an
// earlier turn, so the missing init proves nothing there.
func (t *claudeTurn) resumeRefused(status string) bool {
	resumeID := t.spec.ResumeID
	if resumeID == "" || status != statusFailed {
		return false
	}
	if t.observedSession != "" && t.observedSession != resumeID {
		return true
	}
	return !t.reused && !t.initSeen && t.terminal != nil && t.terminal.IsError &&
		t.terminal.Subtype == "error_during_execution"
}

func (t *claudeTurn) writeRunSummary(out Outcome, readFailed bool) {
	t.logger.Info("agent stream protocol summary",
		"provider", "claude", "cli_version", t.version, "model", t.spec.Model,
		"frames", t.counts.frames, "invalid_frames", t.counts.invalid, "assistant_frames", t.counts.assistant,
		"tool_calls", t.counts.toolCalls, "unreadable_assistant_messages", t.counts.unreadable,
		"terminal_seen", t.terminal != nil, "stdout_read_failed", readFailed)
	recordTiming(t.logger, time.Now(), timingClaudeCleanupComplete, "pid", t.proc.pid, "status", out.Status)
	t.logger.Info("claude finished", "pid", t.proc.pid, "status", out.Status, "elapsed_ms", out.ElapsedMs)
}
