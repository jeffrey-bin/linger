//go:build !windows

package native

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestCodexExternalLeaderExit(t *testing.T) {
	for _, tc := range []struct {
		name, die  string
		holdStdout bool
	}{
		{"sigterm", "SIGTERM", false},
		{"sigterm with descendant on stdout", "SIGTERM", true},
		{"exit 3", "3", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fake := newCodexFake(t, []codexFakeTurn{{Die: tc.die}}, nil)
			receipt := filepath.Join(fake.root, "pids")
			fake.env["FAKE_GRANDCHILD"] = receipt
			if tc.holdStdout {
				fake.env["FAKE_MODES"] = "child_holds_stdout"
			}
			var log codexTestLog
			out, _ := codexDrain(t, fake.runtime(log.logger()), "go", fake.spec())
			if out.Status != statusFailed || !out.ExitConfirmed || !strings.HasPrefix(out.Error, "codex process exited") {
				t.Fatalf("outcome = %+v", out)
			}
			switch tc.die {
			case "SIGTERM":
				if out.Diagnostics.Signal != "SIGTERM" || out.Diagnostics.ExitCode != nil {
					t.Fatalf("diagnostics = %+v", out.Diagnostics)
				}
			default:
				if out.Diagnostics.ExitCode == nil || *out.Diagnostics.ExitCode != 3 {
					t.Fatalf("diagnostics = %+v", out.Diagnostics)
				}
			}
			text := log.String()
			observed := strings.Index(text, "codex leader exit observed")
			signal := strings.Index(text, `"cause":"signal"`)
			if observed < 0 || (signal >= 0 && signal < observed) {
				t.Fatalf("attribution log order wrong:\n%s", text)
			}
			if tc.holdStdout && signal < 0 {
				t.Fatalf("descendant was not signalled:\n%s", text)
			}
			codexWaitProcessesGone(t, receipt)
			// A same-home retry then succeeds.
			fake.env["FAKE_TURNS"] = `[{"status":"completed"}]`
			delete(fake.env, "FAKE_GRANDCHILD")
			if out, _ := codexDrain(t, fake.runtime(nil), "go", fake.spec()); out.Status != statusCompleted {
				t.Fatalf("retry = %+v", out)
			}
		})
	}
}

func TestCodexAttributionWithoutObservation(t *testing.T) {
	fake := newCodexFake(t, nil, nil)
	out, _ := codexDrain(t, fake.runtime(nil), "go", fake.spec())
	if out.Status != statusCompleted {
		t.Fatalf("outcome = %+v", out)
	}
	// The resident is stopped by the Daemon: stdin close is a termination
	// action, so its exit is not external.
	proc, _, _ := residentEntryOf(codexResidents, fake.home)
	if proc == nil {
		t.Fatal("no parked process")
	}
	if stopped, err := StopCodexHomeForMaintenance(fake.home); !stopped || err != nil {
		t.Fatalf("stop = %t, %v", stopped, err)
	}
	if proc.externalExit() || !proc.exitDiagnostics().empty() {
		t.Fatal("daemon-caused exit attributed as external")
	}
	proc.terminate("signal")
	if proc.externalExit() {
		t.Fatal("a later signal changed attribution")
	}
}
