//go:build !windows

package native

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// claudeAssertGone waits briefly for init to reap reparented children.
func claudeAssertGone(t *testing.T, pids []int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for _, pid := range pids {
		for syscall.Kill(pid, 0) == nil {
			if time.Now().After(deadline) {
				t.Fatalf("pid %d is still running", pid)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
}

func claudeLowerGrace(t *testing.T, grace time.Duration) {
	previous := claudeTerminationGrace
	claudeTerminationGrace = grace
	t.Cleanup(func() { claudeTerminationGrace = previous })
}

func claudeWaitFile(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		if data, err := os.ReadFile(path); err == nil && len(data) > 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s never appeared", path)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestClaudeInitRejectionCleansUpTermIgnoringTree(t *testing.T) {
	claudeLowerGrace(t, 300*time.Millisecond)
	dir := t.TempDir()
	profile := claudeFakeProfile(t, "signal", map[string]string{"CLAUDE_FAKE_DIR": dir, "CLAUDE_FAKE_POLICY": "ignore", "CLAUDE_FAKE_INIT": "error"})
	started := time.Now()
	_, outcome := claudeFinish(t, claudeStart(t, profile, "hello", RunSpec{}), 10*time.Second)
	if outcome.Status != statusFailed || !strings.Contains(outcome.Error, "Claude initialization") || time.Since(started) > 10*time.Second {
		t.Fatalf("outcome = %+v", outcome)
	}
	claudeAssertGone(t, claudeReadPIDs(t, dir))
}

func TestClaudeCallerCancelDuringTurn(t *testing.T) {
	claudeLowerGrace(t, 300*time.Millisecond)
	for _, policy := range []string{"report", "normal", "ignore", "child"} {
		t.Run(policy, func(t *testing.T) {
			dir := t.TempDir()
			profile := claudeFakeProfile(t, "signal", map[string]string{"CLAUDE_FAKE_DIR": dir, "CLAUDE_FAKE_POLICY": policy})
			ctx, cancel := context.WithCancel(t.Context())
			backend, _ := Open("claude", profile)
			run, err := backend.Start(ctx, "hello", claudeSpec(RunSpec{}))
			if err != nil {
				t.Fatal(err)
			}
			claudeWaitFile(t, filepath.Join(dir, "ready"))
			started := time.Now()
			cancel()
			_, outcome := claudeFinish(t, run, 8*time.Second)
			pids := claudeReadPIDs(t, dir)
			for _, pid := range pids {
				if syscall.Kill(pid, 0) == nil && pid == pids[0] {
					t.Fatalf("leader %d alive when the Outcome was published", pid)
				}
			}
			if outcome.Status != statusAborted || outcome.Output != "" || !outcome.ExitConfirmed ||
				outcome.Diagnostics.ExitCode != nil || outcome.Diagnostics.Signal != "" || time.Since(started) > 8*time.Second {
				t.Fatalf("outcome = %+v", outcome)
			}
			claudeAssertGone(t, pids)
		})
	}
}

func TestClaudeFailureDiagnostics(t *testing.T) {
	frame := `{"type":"assistant","message":{"id":"a","content":[{"type":"text","text":"x"}]}}`
	apiError := `{"type":"result","is_error":true,"result":"overloaded","terminal_reason":"api_error","api_error_status":529}`
	okResult := `{"type":"result","result":"ok","terminal_reason":"completed","api_error_status":200}`
	for _, test := range []struct {
		name   string
		frames []string
		env    map[string]string
		budget time.Duration
		status string
		check  func(RuntimeFailureDiagnostics) bool
	}{
		{"api error", []string{frame, apiError}, map[string]string{"CLAUDE_FAKE_EXIT": "3"}, 0, statusFailed, func(d RuntimeFailureDiagnostics) bool {
			return d.Code == "api_error" && d.StatusCode != nil && *d.StatusCode == 529 && d.ExitCode != nil && *d.ExitCode == 3
		}},
		{"segv", []string{frame}, map[string]string{"CLAUDE_FAKE_SEGV": "1"}, 0, statusFailed, func(d RuntimeFailureDiagnostics) bool {
			return d.Signal == "SIGSEGV" && d.ExitCode == nil
		}},
		{"timeout", []string{frame}, map[string]string{"CLAUDE_FAKE_SLEEP": "1"}, 100 * time.Millisecond, statusTimeout, func(d RuntimeFailureDiagnostics) bool { return d.empty() }},
		{"success with status", []string{frame, okResult}, nil, 0, statusCompleted, func(d RuntimeFailureDiagnostics) bool { return d.empty() }},
	} {
		t.Run(test.name, func(t *testing.T) {
			claudeLowerGrace(t, 300*time.Millisecond)
			run := claudeStart(t, claudeFramesProfile(t, "frames", test.frames, test.env), "hello", RunSpec{Budget: test.budget})
			_, outcome := claudeFinish(t, run, 10*time.Second)
			if outcome.Status != test.status || !test.check(outcome.Diagnostics) {
				t.Fatalf("outcome = %+v diagnostics = %+v", outcome, outcome.Diagnostics)
			}
		})
	}
}

func TestClaudeBlockedTimingLogsDoNotStallOutcome(t *testing.T) {
	result := `{"type":"result","result":"ok","terminal_reason":"completed"}`
	for _, event := range []string{timingClaudeTurnResult, timingClaudeProcessExited, timingClaudeCleanupComplete} {
		t.Run(event, func(t *testing.T) {
			handler := &blockingHandler{entered: make(chan string, 8), release: make(chan struct{}), block: event}
			defer close(handler.release)
			profile := claudeFramesProfile(t, "frames", []string{result}, nil)
			profile.Logger = slog.New(handler)
			_, outcome := claudeFinish(t, claudeStart(t, profile, "hello", RunSpec{}), 5*time.Second)
			if outcome.Status != statusCompleted {
				t.Fatalf("outcome = %+v", outcome)
			}
		})
	}
}
