//go:build !windows

package native

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestCodexDeliverableOutput(t *testing.T) {
	commandStart := map[string]any{"method": "item/started", "params": map[string]any{"threadId": "$THREAD", "turnId": "$TURN",
		"item": map[string]any{"id": "cmd-1", "type": "commandExecution", "command": "ls"}}}
	cases := []struct {
		name   string
		turn   codexFakeTurn
		status string
		output string
	}{
		{"no phase", codexFakeTurn{Items: []map[string]any{codexAgentMessage("m1", "done", nil)}}, statusCompleted, "done"},
		{"commentary then final", codexFakeTurn{Items: []map[string]any{codexAgentMessage("m1", "thinking", "commentary"), codexAgentMessage("m2", "final", "final_answer")}}, statusCompleted, "final"},
		{"only commentary", codexFakeTurn{Items: []map[string]any{codexAgentMessage("m1", "thinking", "commentary")}}, statusCompleted, ""},
		{"text then tool", codexFakeTurn{Items: []map[string]any{codexAgentMessage("m1", "early", nil), commandStart}}, statusCompleted, ""},
		{"failed turn", codexFakeTurn{Items: []map[string]any{codexAgentMessage("m1", "partial", nil)}, Status: "failed", Error: "model broke"}, statusFailed, ""},
		{"rejected start", codexFakeTurn{Reject: true}, statusFailed, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.turn.Status == "" {
				tc.turn.Status = "completed"
			}
			fake := newCodexFake(t, []codexFakeTurn{tc.turn}, nil)
			codexResidentCapForTest(t, 0)
			out, _ := codexDrain(t, fake.runtime(nil), "hello", fake.spec())
			if out.Status != tc.status || out.Output != tc.output || !out.ExitConfirmed || out.ExitUnconfirmed {
				t.Fatalf("outcome = %+v", out)
			}
			if tc.name == "failed turn" && out.Error != "model broke" {
				t.Fatalf("error = %q", out.Error)
			}
			if out.CompactionCount == nil {
				t.Fatal("compaction count must be set")
			}
		})
	}
}

func codexResidentCapForTest(t *testing.T, limit int) {
	withResidentCap(t, codexResidents, limit)
}

func TestCodexPrepareStrictResume(t *testing.T) {
	t.Run("new empty checkpoint", func(t *testing.T) {
		fake := newCodexFake(t, nil, nil)
		spec := fake.spec()
		spec.PrepareOnly = true
		out, _ := codexDrain(t, fake.runtime(nil), "", spec)
		if out.Status != statusCompleted || out.SessionID != "thread-1" {
			t.Fatalf("outcome = %+v", out)
		}
		names := fake.requests("thread/name/set")
		if len(names) != 1 || names[0]["params"].(map[string]any)["name"] != "Linger session" || fake.count("turn/start") != 0 {
			t.Fatalf("requests = %v", fake.methods())
		}
		start := fake.requests("thread/start")[0]["params"].(map[string]any)
		if start["historyMode"] != "legacy" || start["persistExtendedHistory"] != true {
			t.Fatalf("thread/start params = %v", start)
		}
	})
	for _, mode := range []string{"reject_resume", "other_thread"} {
		t.Run(mode, func(t *testing.T) {
			fake := newCodexFake(t, nil, map[string]string{"FAKE_MODES": mode})
			spec := fake.spec()
			spec.PrepareOnly, spec.ResumeID = true, "thread-9"
			out, _ := codexDrain(t, fake.runtime(nil), "", spec)
			if out.Status != statusFailed || fake.count("thread/start") != 0 || !out.ExitConfirmed {
				t.Fatalf("outcome = %+v, methods = %v", out, fake.methods())
			}
			if out.NativeResume == nil || out.NativeResume.Result != "error" {
				t.Fatalf("native resume = %+v", out.NativeResume)
			}
			if mode == "other_thread" && out.Error != "Codex restored a different session" {
				t.Fatalf("error = %q", out.Error)
			}
			// Only a JSON-RPC refusal of thread/resume says the thread is gone.
			if want := map[string]string{"reject_resume": "session_not_found"}[mode]; out.FailureCode != want {
				t.Fatalf("failure code = %q, want %q", out.FailureCode, want)
			}
		})
	}
	t.Run("name failure", func(t *testing.T) {
		fake := newCodexFake(t, nil, map[string]string{"FAKE_MODES": "reject_name"})
		spec := fake.spec()
		spec.PrepareOnly = true
		out, _ := codexDrain(t, fake.runtime(nil), "", spec)
		if out.Status != statusFailed || !strings.HasPrefix(out.Error, "persist empty Codex session: ") {
			t.Fatalf("outcome = %+v", out)
		}
	})
}

func TestCodexTurnOwnershipAndDedupe(t *testing.T) {
	text := codexAgentMessage("m1", "answer", nil)
	turn := codexFakeTurn{Status: "completed", Items: []map[string]any{
		{"method": "turn/started", "params": map[string]any{"threadId": "foreign", "turn": map[string]any{"id": "turn-x"}}},
		{"method": "item/completed", "params": map[string]any{"threadId": "$THREAD", "turnId": "turn-old", "item": map[string]any{"id": "old", "type": "agentMessage", "text": "stale"}}},
		{"method": "codex/event/agent_message", "params": map[string]any{"threadId": "$THREAD", "msg": "dup"}},
		text, text,
	}}
	fake := newCodexFake(t, []codexFakeTurn{turn}, nil)
	codexResidentCapForTest(t, 0)
	out, events := codexDrain(t, fake.runtime(nil), "go", fake.spec())
	texts, running := 0, 0
	for _, event := range events {
		switch {
		case event.Kind == EventText:
			texts++
		case event.Kind == EventStatus && event.Status == "running":
			running++
			if event.ProcessReused == nil || *event.ProcessReused || event.TurnID != "turn-1" {
				t.Fatalf("status event = %+v", event)
			}
		}
	}
	if texts != 1 || running != 1 || out.Output != "answer" || out.TurnID != "turn-1" {
		t.Fatalf("texts=%d running=%d outcome=%+v", texts, running, out)
	}
}

func TestCodexFirstProgressTimeoutInterrupts(t *testing.T) {
	fake := newCodexFake(t, []codexFakeTurn{{Stall: true}}, nil)
	spec := fake.spec()
	spec.FirstProgressBudget = 60 * time.Millisecond
	out, _ := codexDrain(t, fake.runtime(nil), "go", spec)
	if out.Status != statusTimeout || out.Error != CodexFirstTurnNoProgressMarker+" after 60ms" || !out.ExitConfirmed {
		t.Fatalf("outcome = %+v", out)
	}
	if fake.count("turn/interrupt") != 1 {
		t.Fatalf("methods = %v", fake.methods())
	}
}

func TestCodexSilenceTimeout(t *testing.T) {
	fake := newCodexFake(t, []codexFakeTurn{{Stall: true}}, nil)
	spec := fake.spec()
	spec.SilenceBudget = 80 * time.Millisecond
	out, _ := codexDrain(t, fake.runtime(nil), "go", spec)
	if out.Status != statusTimeout || !strings.HasPrefix(out.Error, CodexSemanticInactivityMarker+" after ") {
		t.Fatalf("outcome = %+v", out)
	}
}

func TestCodexStartupStallKillsTree(t *testing.T) {
	for _, method := range []string{"initialize", "thread/start"} {
		t.Run(method, func(t *testing.T) {
			fake := newCodexFake(t, nil, nil)
			receipt := filepath.Join(fake.root, "pids")
			fake.env["FAKE_STALL"], fake.env["FAKE_GRANDCHILD"] = method, receipt
			spec := fake.spec()
			spec.StartupBudget = 200 * time.Millisecond
			out, _ := codexDrain(t, fake.runtime(nil), "go", spec)
			if out.Status != statusFailed || !out.ExitConfirmed || !strings.Contains(out.Error, CodexHandshakeTimeoutMarker+": "+method+" exceeded 200ms") {
				t.Fatalf("outcome = %+v", out)
			}
			codexWaitProcessesGone(t, receipt)
		})
	}
}

func TestCodexStartupFailureKeepsSecretsOut(t *testing.T) {
	const secret = "opaque-secret-value-123"
	for _, variant := range []string{"startup", "budget"} {
		t.Run(variant, func(t *testing.T) {
			fake := newCodexFake(t, nil, map[string]string{"FAKE_STDERR": "env " + secret, "FAKE_STALL": "initialize"})
			var log codexTestLog
			spec := fake.spec()
			if variant == "startup" {
				spec.StartupBudget = 150 * time.Millisecond
			} else {
				spec.Budget = 100 * time.Millisecond
			}
			out, _ := codexDrain(t, fake.runtime(log.logger()), "go", spec)
			if out.Status != statusFailed || !out.ExitConfirmed || strings.Contains(out.Error, secret) || strings.Contains(log.String(), secret) {
				t.Fatalf("outcome = %+v\nlog = %s", out, log.String())
			}
		})
	}
}

func TestCodexInitializeExitIsProcessFailure(t *testing.T) {
	fake := newCodexFake(t, nil, map[string]string{"FAKE_MODES": "init_exit17"})
	out, _ := codexDrain(t, fake.runtime(nil), "go", fake.spec())
	if out.Status != statusFailed || !strings.HasPrefix(out.Error, "codex initialize failed: codex process exited") || !out.ExitConfirmed {
		t.Fatalf("outcome = %+v", out)
	}
	if !strings.Contains(out.Error, "; codex stderr: ") || strings.Contains(out.Error, "sk-live-1234567890abcdef1234567890") {
		t.Fatalf("stderr handling = %q", out.Error)
	}
	if out.Diagnostics.ExitCode == nil || *out.Diagnostics.ExitCode != 17 {
		t.Fatalf("diagnostics = %+v", out.Diagnostics)
	}
}

func TestCodexInitializeCancelUnconfirmed(t *testing.T) {
	fake := newCodexFake(t, nil, map[string]string{"FAKE_STALL": "initialize"})
	var force atomic.Bool
	force.Store(true)
	codexForceUnconfirmed(&force)
	ctx, cancel := context.WithCancel(context.Background())
	run, err := fake.runtime(nil).Start(ctx, "go", fake.spec())
	if err != nil {
		t.Fatal(err)
	}
	time.AfterFunc(100*time.Millisecond, cancel)
	out, _ := codexCollect(t, run)
	if out.Status != statusFailed || !out.ExitUnconfirmed || out.ExitConfirmed || !strings.HasPrefix(out.Error, "codex initialize failed") {
		t.Fatalf("outcome = %+v", out)
	}
	// The fence holds until a retried stop confirms exit.
	if _, err := fake.runtime(nil).Start(context.Background(), "go", fake.spec()); err == nil || !strings.Contains(err.Error(), "process tree exit could not be confirmed") {
		t.Fatalf("fenced start = %v", err)
	}
	force.Store(false)
	delete(fake.env, "FAKE_STALL")
	out, _ = codexDrain(t, fake.runtime(nil), "go", fake.spec())
	if fake.launchCount() != 2 || out.Status != statusCompleted {
		t.Fatalf("recovery launches = %d outcome = %+v", fake.launchCount(), out)
	}
}

func TestCodexInitializeTimeoutRetriesOnce(t *testing.T) {
	fake := newCodexFake(t, nil, map[string]string{"FAKE_STALL": "initialize"})
	var log codexTestLog
	spec := fake.spec()
	spec.StartupBudget = 100 * time.Millisecond
	out, _ := codexDrain(t, fake.runtime(log.logger()), "go", spec)
	if out.Status != statusFailed || fake.launchCount() != 2 || strings.Count(log.String(), "codex retry scheduled") != 1 {
		t.Fatalf("outcome = %+v launches = %d", out, fake.launchCount())
	}
}

func TestCodexResidentReuseAndRebind(t *testing.T) {
	fake := newCodexFake(t, []codexFakeTurn{{Status: "completed", Items: []map[string]any{codexAgentMessage("m", "ok", nil)}}}, nil)
	rt := fake.runtime(nil)
	spec := fake.spec()
	out, events := codexDrain(t, rt, "one", spec)
	if out.Status != statusCompleted || out.ExitConfirmed || out.ExitUnconfirmed || codexReused(events) != "false" {
		t.Fatalf("first = %+v", out)
	}
	spec.ResumeID = out.SessionID
	out, events = codexDrain(t, rt, "two", spec)
	if out.Status != statusCompleted || codexReused(events) != "true" || out.NativeResume != nil {
		t.Fatalf("second = %+v", out)
	}
	if fake.launchCount() != 1 || fake.count("initialize") != 1 || fake.count("config/read") != 1 || fake.count("thread/resume") != 0 || fake.count("thread/unsubscribe") != 0 {
		t.Fatalf("methods = %v", fake.methods())
	}
	// A changed AppendPrompt rebinds on the same process.
	spec.AppendPrompt = "be brief"
	out, _ = codexDrain(t, rt, "three", spec)
	if out.Status != statusCompleted || fake.count("thread/unsubscribe") != 1 || fake.count("thread/resume") != 1 || fake.launchCount() != 1 {
		t.Fatalf("rebind = %+v methods = %v", out, fake.methods())
	}
	resume := fake.requests("thread/resume")[0]["params"].(map[string]any)
	if resume["developerInstructions"] != "be brief" || out.NativeResume == nil || out.NativeResume.Result != "success" {
		t.Fatalf("resume params = %v", resume)
	}
	// An empty ResumeID starts a fresh thread.
	spec.ResumeID = ""
	codexDrain(t, rt, "four", spec)
	if fake.count("thread/start") != 2 || fake.launchCount() != 1 {
		t.Fatalf("methods = %v", fake.methods())
	}
	// A model change recycles the process.
	spec.Model = "other-model"
	out, _ = codexDrain(t, rt, "five", spec)
	if out.Status != statusCompleted || fake.launchCount() != 2 {
		t.Fatalf("recycle = %+v launches = %d", out, fake.launchCount())
	}
}

func codexReused(events []Event) string {
	for _, event := range events {
		if event.Kind == EventStatus && event.ProcessReused != nil {
			if *event.ProcessReused {
				return "true"
			}
			return "false"
		}
	}
	return ""
}

// Codex writing its own config.toml during a turn is not a change the
// Daemon delivered, so the next turn keeps the bound thread.
func TestCodexConfigWriteDuringTurnKeepsThread(t *testing.T) {
	fake := newCodexFake(t, []codexFakeTurn{{Status: "completed", Config: "model_provider = \"other\"\n"}, {Status: "completed"}}, nil)
	rt := fake.runtime(nil)
	spec := fake.spec()
	out, _ := codexDrain(t, rt, "one", spec)
	spec.ResumeID = out.SessionID
	codexDrain(t, rt, "two", spec)
	if fake.count("thread/resume") != 0 || fake.launchCount() != 1 {
		t.Fatalf("methods = %v", fake.methods())
	}
}

func TestCodexRecycleUnconfirmedFencesKey(t *testing.T) {
	fake := newCodexFake(t, nil, nil)
	rt := fake.runtime(nil)
	spec := fake.spec()
	if out, _ := codexDrain(t, rt, "one", spec); out.Status != statusCompleted {
		t.Fatalf("first = %+v", out)
	}
	var force atomic.Bool
	force.Store(true)
	codexForceUnconfirmed(&force)
	spec.Model = "changed"
	for range 2 {
		if _, err := rt.Start(context.Background(), "two", spec); err == nil || !strings.Contains(err.Error(), "process tree exit could not be confirmed") {
			t.Fatalf("start = %v", err)
		}
	}
	if fake.launchCount() != 1 {
		t.Fatalf("launches = %d", fake.launchCount())
	}
	force.Store(false)
	if out, _ := codexDrain(t, rt, "three", spec); out.Status != statusCompleted || fake.launchCount() != 2 {
		t.Fatalf("recovered = %+v", out)
	}
}

func TestCodexTurnFailureUnconfirmedKeepsLease(t *testing.T) {
	fake := newCodexFake(t, []codexFakeTurn{{Reject: true}, {Status: "completed"}}, nil)
	released := 0
	rt, _ := Open("codex", Profile{Program: fake.program, Env: fake.env, RetainProcessTemp: func() (func() error, error) {
		return func() error { released++; return nil }, nil
	}})
	var force atomic.Bool
	force.Store(true)
	codexForceUnconfirmed(&force)
	out, _ := codexDrain(t, rt, "one", fake.spec())
	if out.Status != statusFailed || !out.ExitUnconfirmed || released != 0 {
		t.Fatalf("outcome = %+v released = %d", out, released)
	}
	if _, err := rt.Start(context.Background(), "two", fake.spec()); err == nil {
		t.Fatal("fenced start succeeded")
	}
	force.Store(false)
	fake.env["FAKE_TURNS"] = `[{"status":"completed"}]`
	out, _ = codexDrain(t, rt, "three", fake.spec())
	if out.Status != statusCompleted || fake.launchCount() != 2 || released != 1 {
		t.Fatalf("recovered = %+v launches = %d released = %d", out, fake.launchCount(), released)
	}
}

func codexPrepare(t *testing.T, fake *codexFake, rt Runtime) Outcome {
	t.Helper()
	spec := fake.spec()
	spec.PrepareOnly = true
	out, _ := codexDrain(t, rt, "", spec)
	return out
}

func codexParkedProcess(t *testing.T, fake *codexFake) *codexProcess {
	t.Helper()
	proc, _, _ := residentEntryOf(codexResidents, fake.home)
	if proc == nil {
		t.Fatal("no parked Codex process")
	}
	return proc
}

func TestCodexPreparedResidents(t *testing.T) {
	t.Run("adopted by the next start", func(t *testing.T) {
		fake := newCodexFake(t, nil, nil)
		var log codexTestLog
		rt := fake.runtime(log.logger())
		out := codexPrepare(t, fake, rt)
		if !out.Parked || !holdsPrestart() {
			t.Fatalf("prepare = %+v", out)
		}
		run := fake.spec()
		run.ResumeID = out.SessionID
		out, events := codexDrain(t, rt, "go", run)
		if out.Status != statusCompleted || out.Parked || fake.launchCount() != 1 || !strings.Contains(log.String(), "codex resident adopted") || codexReused(events) != "true" {
			t.Fatalf("adopt = %+v", out)
		}
		if holdsPrestart() || codexParkedProcess(t, fake).res.isPrestart() {
			t.Fatal("adopted process is still a prestart")
		}
		if stopped, err := StopCodexHomeForMaintenance(fake.home); !stopped || err != nil {
			t.Fatalf("normal park did not survive: %t, %v", stopped, err)
		}
		if fake.count("turn/start") != 1 || fake.count("thread/resume") != 0 {
			t.Fatalf("methods = %v", fake.methods())
		}
	})
	t.Run("the first Run adopts the empty thread a prepare started", func(t *testing.T) {
		fake := newCodexFake(t, nil, nil)
		var log codexTestLog
		rt := fake.runtime(log.logger())
		prepared := codexPrepare(t, fake, rt)
		if !prepared.Parked || prepared.SessionID == "" {
			t.Fatalf("prepare = %+v", prepared)
		}
		out, _ := codexDrain(t, rt, "go", fake.spec())
		if out.Status != statusCompleted || out.SessionID != prepared.SessionID || fake.launchCount() != 1 ||
			!strings.Contains(log.String(), `"phase":"adopted"`) {
			t.Fatalf("first run = %+v log = %s", out, log.String())
		}
		if fake.count("thread/start") != 1 || fake.count("thread/unsubscribe") != 0 || fake.count("turn/start") != 1 {
			t.Fatalf("methods = %v", fake.methods())
		}
		// A thread a turn ran on is a conversation; a later Run without a
		// thread starts its own instead of continuing it.
		next, _ := codexDrain(t, rt, "go", fake.spec())
		if next.Status != statusCompleted || fake.count("thread/unsubscribe") != 1 || fake.count("thread/start") != 2 {
			t.Fatalf("second run = %+v methods = %v", next, fake.methods())
		}
	})
	t.Run("a first Run with other inputs starts its own thread", func(t *testing.T) {
		fake := newCodexFake(t, nil, nil)
		rt := fake.runtime(nil)
		codexPrepare(t, fake, rt)
		run := fake.spec()
		instructions := "different instructions"
		run.BaseInstructions = &instructions
		out, _ := codexDrain(t, rt, "go", run)
		if out.Status != statusCompleted || fake.count("thread/unsubscribe") != 1 || fake.count("thread/start") != 2 {
			t.Fatalf("run = %+v methods = %v", out, fake.methods())
		}
	})
	t.Run("duplicate prepare leaves the resident alone", func(t *testing.T) {
		fake := newCodexFake(t, nil, nil)
		rt := fake.runtime(nil)
		codexPrepare(t, fake, rt)
		out := codexPrepare(t, fake, rt)
		if out.Status != statusCompleted || out.Parked || fake.launchCount() != 1 || !holdsPrestart() {
			t.Fatalf("second prepare = %+v launches = %d", out, fake.launchCount())
		}
	})
	t.Run("a prestart lives like a parked Run", func(t *testing.T) {
		fake := newCodexFake(t, nil, nil)
		rt := fake.runtime(nil)
		if out := codexPrepare(t, fake, rt); !out.Parked {
			t.Fatalf("prepare = %+v", out)
		}
		time.Sleep(200 * time.Millisecond)
		run := fake.spec()
		run.ResumeID = "thread-1"
		if out, _ := codexDrain(t, rt, "go", run); out.Status != statusCompleted || fake.launchCount() != 1 {
			t.Fatalf("run = %+v launches = %d", out, fake.launchCount())
		}
	})
}

func TestCodexMaintenanceStop(t *testing.T) {
	if _, err := StopCodexHomeForMaintenance("relative/home"); err == nil {
		t.Fatal("relative home accepted")
	}
	if _, err := StopCodexHomeForMaintenance("/tmp/x/../y"); err == nil {
		t.Fatal("unclean home accepted")
	}
	fake := newCodexFake(t, nil, nil)
	spec := fake.spec()
	spec.PrepareOnly = true
	codexDrain(t, fake.runtime(nil), "", spec)
	if stopped, err := StopCodexHomeForMaintenance(filepath.Join(fake.root, "elsewhere")); stopped || err != nil {
		t.Fatalf("other home: %t, %v", stopped, err)
	}
	var force atomic.Bool
	force.Store(true)
	codexForceUnconfirmed(&force)
	if stopped, err := StopCodexHomeForMaintenance(fake.home); stopped || !errors.Is(err, errResidentRecycleUnconfirmed) {
		t.Fatalf("unknown cleanup: %t, %v", stopped, err)
	}
	force.Store(false)
	if stopped, err := StopCodexHomeForMaintenance(fake.home); !stopped || err != nil {
		t.Fatalf("recovered: %t, %v", stopped, err)
	}
	if stopped, err := StopCodexHomeForMaintenance(fake.home); stopped || err != nil {
		t.Fatalf("repeat: %t, %v", stopped, err)
	}
	if fake.count("turn/start") != 0 {
		t.Fatal("maintenance ran a turn")
	}
}

func TestCodexWarmMCPReadiness(t *testing.T) {
	fake := newCodexFake(t, nil, nil)
	var log codexTestLog
	rt := fake.runtime(log.logger())
	released := make(chan struct{})
	readyReturned := false
	spec := fake.spec()
	spec.PrepareOnly, spec.WarmMCP, spec.ResumeID = true, true, "thread-7"
	spec.MCPReady = func(ctx context.Context) error {
		<-released
		readyReturned = true
		return nil
	}
	run, err := rt.Start(context.Background(), "", spec)
	if err != nil {
		t.Fatal(err)
	}
	time.AfterFunc(50*time.Millisecond, func() { close(released) })
	out, _ := codexCollect(t, run)
	if out.Status != statusCompleted || !readyReturned || out.NativeResume == nil || out.NativeResume.Result != "success" {
		t.Fatalf("prepare = %+v", out)
	}
	if strings.Count(log.String(), "resident_wait_start") != 1 || !strings.Contains(log.String(), `"outcome":"ready"`) {
		t.Fatalf("log = %s", log.String())
	}
	execution := fake.spec()
	execution.ResumeID = "thread-7"
	out, _ = codexDrain(t, rt, "go", execution)
	if out.Status != statusCompleted || out.NativeResume != nil || fake.launchCount() != 1 || fake.count("thread/resume") != 1 ||
		fake.count("config/mcpServer/reload") != 0 || fake.count("mcpServerStatus/list") != 0 {
		t.Fatalf("execution = %+v methods = %v", out, fake.methods())
	}

	t.Run("budget and nil observer", func(t *testing.T) {
		other := newCodexFake(t, nil, nil)
		spec := other.spec()
		spec.PrepareOnly, spec.WarmMCP, spec.StartupBudget = true, true, 50*time.Millisecond
		spec.MCPReady = func(ctx context.Context) error { <-ctx.Done(); return ctx.Err() }
		out, _ := codexDrain(t, other.runtime(nil), "", spec)
		if out.Status != statusFailed || !strings.Contains(out.Error, "mcp/readiness exceeded 50ms") {
			t.Fatalf("budget = %+v", out)
		}
		spec.MCPReady = nil
		out, _ = codexDrain(t, other.runtime(nil), "", spec)
		if out.Status != statusFailed || out.Error != "Codex MCP preparation has no Operation-bound readiness observer" {
			t.Fatalf("nil observer = %+v", out)
		}
	})
}

func TestCodexMemoryEnabledFailsBeforeThread(t *testing.T) {
	fake := newCodexFake(t, nil, map[string]string{"FAKE_CONFIG_READ": `{"config":{"features":{"memories":true,"memory_tool":false}}}`})
	out, _ := codexDrain(t, fake.runtime(nil), "go", fake.spec())
	if out.Status != statusFailed || !strings.Contains(out.Error, "memory must be disabled") || out.SessionID != "" {
		t.Fatalf("outcome = %+v", out)
	}
	if got := fake.methods(); !slices.Equal(got, []string{"initialize", "initialized", "config/read"}) {
		t.Fatalf("methods = %v", got)
	}
}

func TestCodexUsagePerTurnOnReusedProcess(t *testing.T) {
	start := time.Now().UTC()
	before := start.Add(-time.Hour).Format(time.RFC3339Nano)
	after := start.Add(time.Hour).Format(time.RFC3339Nano)
	compaction := map[string]any{"method": "item/completed", "params": map[string]any{"threadId": "$THREAD", "turnId": "$TURN", "item": map[string]any{"id": "c1", "type": "contextCompaction"}}}
	rollout := []string{
		`{"type":"session_meta","payload":{"id":"thread-1"}}`,
		`{"timestamp":"` + before + `","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":10,"output_tokens":50,"reasoning_output_tokens":10}}}}`,
		`{"timestamp":"` + after + `","type":"compacted","payload":{}}`,
		`{"timestamp":"` + after + `","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":130,"cached_input_tokens":15,"output_tokens":70,"reasoning_output_tokens":15},"last_token_usage":{"input_tokens":20,"cached_input_tokens":2,"output_tokens":10,"reasoning_output_tokens":3}}}}`,
	}
	fake := newCodexFake(t, []codexFakeTurn{
		{Status: "completed", Items: []map[string]any{compaction}, Usage: map[string]any{"input_tokens": 10, "cached_input_tokens": 2, "output_tokens": 4, "reasoning_output_tokens": 1}},
		{Status: "completed"},
		{Status: "completed", Rollout: rollout},
	}, nil)
	rt := fake.runtime(nil)
	spec := fake.spec()
	spec.Model = "m"
	out, _ := codexDrain(t, rt, "one", spec)
	if got := out.Usage["m"]; got != (TokenCount{Input: 8, CacheRead: 2, Output: 4, Reasoning: 1}) || *out.CompactionCount != 1 {
		t.Fatalf("first usage = %+v compactions = %d", out.Usage, *out.CompactionCount)
	}
	spec.ResumeID = out.SessionID
	out, _ = codexDrain(t, rt, "two", spec)
	if out.Usage != nil || out.LastUsage != nil || *out.CompactionCount != 0 {
		t.Fatalf("second usage leaked = %+v", out)
	}
	out, _ = codexDrain(t, rt, "three", spec)
	if got := out.Usage["m"]; got != (TokenCount{Input: 25, CacheRead: 5, Output: 20, Reasoning: 5}) {
		t.Fatalf("rollout usage = %+v", out.Usage)
	}
	if got := out.LastUsage["m"]; got != (TokenCount{Input: 18, CacheRead: 2, Output: 10, Reasoning: 3}) || *out.CompactionCount != 1 {
		t.Fatalf("rollout last = %+v compactions = %d", out.LastUsage, *out.CompactionCount)
	}
}

func TestCodexSteering(t *testing.T) {
	fake := newCodexFake(t, []codexFakeTurn{{Stall: true}}, nil)
	spec := fake.spec()
	spec.SilenceBudget = 2 * time.Second
	spec.FirstProgressBudget = 2 * time.Second
	run, err := fake.runtime(nil).Start(context.Background(), "go", spec)
	if err != nil {
		t.Fatal(err)
	}
	var steerErr *SteerError
	if _, err := run.Steer(context.Background(), SteerRequest{ExpectedTurnID: "turn-1", Input: "x"}); !errors.As(err, &steerErr) || steerErr.Reason != "no_active_turn" {
		// The turn may not have started yet; wait for it.
		_ = err
	}
	var started bool
	for event := range run.Events {
		if event.Kind == EventStatus && event.TurnID != "" && !started {
			started = true
			if _, err := run.Steer(context.Background(), SteerRequest{ExpectedTurnID: "turn-0", Input: "x"}); !errors.As(err, &steerErr) || steerErr.Reason != "target_mismatch" || steerErr.ActualTurnID != "turn-1" {
				t.Fatalf("mismatch = %v", err)
			}
			// A Codex older than the client id echo is acknowledged on acceptance.
			if ack, err := run.Steer(context.Background(), SteerRequest{ExpectedTurnID: "turn-1", Input: "x"}); err != nil || ack.TurnID != "turn-1" {
				t.Fatalf("ack = %+v %v", ack, err)
			}
		}
	}
	<-run.Outcome
	if _, err := run.Steer(context.Background(), SteerRequest{ExpectedTurnID: "turn-1"}); !errors.As(err, &steerErr) || steerErr.Message != "Codex has no active turn to steer" {
		t.Fatalf("after finish = %v", err)
	}
	if steers := fake.requests("turn/steer"); len(steers) != 1 || steers[0]["params"].(map[string]any)["expectedTurnId"] != "turn-1" {
		t.Fatalf("steer requests = %v", steers)
	}
}

func TestCodexReasoningEventsFromThread(t *testing.T) {
	turn := codexFakeTurn{Status: "completed", Items: []map[string]any{
		{"method": "item/reasoning/summaryTextDelta", "params": map[string]any{"threadId": "other", "turnId": "$TURN", "itemId": "r0", "summaryIndex": 0, "delta": "**Hidden**\n"}},
		{"method": "item/reasoning/summaryTextDelta", "params": map[string]any{"threadId": "$THREAD", "turnId": "$TURN", "itemId": "r1", "summaryIndex": 0, "delta": "**Checking the diff**\nbody"}},
		{"method": "item/reasoning/textDelta", "params": map[string]any{"threadId": "$THREAD", "turnId": "$TURN", "itemId": "r1", "delta": "raw"}},
		{"method": "item/completed", "params": map[string]any{"threadId": "$THREAD", "turnId": "$TURN", "item": map[string]any{"id": "r1", "type": "reasoning", "summary": []string{"**Checking the diff**\nbody", "Planning the fix"}}}},
	}}
	fake := newCodexFake(t, []codexFakeTurn{turn}, nil)
	_, events := codexDrain(t, fake.runtime(nil), "go", fake.spec())
	var titles []string
	for _, event := range events {
		if event.Kind == EventReasoning {
			if event.Body != "" {
				t.Fatalf("reasoning body published: %+v", event)
			}
			titles = append(titles, event.Title)
		}
	}
	if !slices.Equal(titles, []string{"Checking the diff", "", "Planning the fix"}) {
		t.Fatalf("titles = %q", titles)
	}
}

func TestCodexToolProjection(t *testing.T) {
	turn := codexFakeTurn{Status: "completed", Items: []map[string]any{
		{"method": "item/started", "params": map[string]any{"threadId": "$THREAD", "turnId": "$TURN", "item": map[string]any{"id": "c1", "type": "commandExecution", "command": "ls"}}},
		{"method": "item/completed", "params": map[string]any{"threadId": "$THREAD", "turnId": "$TURN", "item": map[string]any{"id": "c1", "type": "commandExecution", "aggregatedOutput": "a\n", "status": "completed", "exitCode": 2}}},
		{"method": "item/started", "params": map[string]any{"threadId": "$THREAD", "turnId": "$TURN", "item": map[string]any{"id": "p1", "type": "fileChange", "status": "inProgress",
			"changes": []any{map[string]any{"path": "a.go", "kind": map[string]any{"type": "add"}, "diff": "package a\n"}, map[string]any{"path": "b.go", "kind": map[string]any{"type": "update", "move_path": "c.go"}, "diff": "@@\n\nMoved to: c.go"}}}}},
		{"method": "item/completed", "params": map[string]any{"threadId": "$THREAD", "turnId": "$TURN", "item": map[string]any{"id": "p1", "type": "fileChange", "status": "completed", "changes": []any{map[string]any{}, map[string]any{}}}}},
		{"method": "item/started", "params": map[string]any{"threadId": "$THREAD", "turnId": "$TURN", "item": map[string]any{"id": "t1", "type": "mcpToolCall", "server": "s", "tool": "search", "arguments": map[string]any{"api_key": "x", "q": "y"}}}},
		{"method": "item/completed", "params": map[string]any{"threadId": "$THREAD", "turnId": "$TURN", "item": map[string]any{"id": "t1", "type": "mcpToolCall", "tool": "search", "status": "failed", "durationMs": 12, "error": map[string]any{"message": "boom"}}}},
		{"method": "turn/plan/updated", "params": map[string]any{"threadId": "$THREAD", "turnId": "$TURN", "plan": []any{map[string]any{"step": "s1", "status": "inProgress"}}, "explanation": "why"}},
	}}
	fake := newCodexFake(t, []codexFakeTurn{turn}, nil)
	_, events := codexDrain(t, fake.runtime(nil), "go", fake.spec())
	byKey := map[string]Event{}
	for _, event := range events {
		byKey[string(event.Kind)+"/"+event.InvocationID] = event
	}
	if e := byKey["tool-result/c1"]; e.ToolName != "exec_command" || e.Status != "failed" || e.Output != "a\n" {
		t.Fatalf("command = %+v", e)
	}
	patch := byKey["tool-use/p1"].Input["changes"].([]any)
	if len(patch) != 2 || patch[0].(map[string]any)["content"] != "package a\n" || patch[1].(map[string]any)["diff"] != "@@" || patch[1].(map[string]any)["move_path"] != "c.go" {
		t.Fatalf("patch = %+v", patch)
	}
	if e := byKey["tool-result/p1"]; e.Output != "completed: 2 file changes" {
		t.Fatalf("patch result = %+v", e)
	}
	if args := byKey["tool-use/t1"].Input["arguments"].(map[string]any); args["api_key"] == "x" || args["q"] != "y" {
		t.Fatalf("mcp input not redacted: %v", args)
	}
	if e := byKey["tool-result/t1"]; e.Output != "failed\nduration: 12 ms\nerror: boom" || e.ToolName != "search" {
		t.Fatalf("mcp result = %+v", e)
	}
	plan := byKey["plan/"]
	if steps := plan.Input["steps"].([]any); steps[0].(map[string]any)["status"] != "in_progress" || plan.Input["explanation"] != "why" {
		t.Fatalf("plan = %+v", plan)
	}
}

func TestCodexNativeQuestion(t *testing.T) {
	question := map[string]any{"id": "q-7", "method": "item/tool/requestUserInput", "params": map[string]any{"threadId": "$THREAD", "turnId": "$TURN",
		"questions": []any{map[string]any{"id": "q1", "question": "Pick", "options": []any{map[string]any{"label": "A"}, map[string]any{"label": "B"}}}}}}
	fake := newCodexFake(t, []codexFakeTurn{{Stall: true, Items: []map[string]any{question}}}, nil)
	requests := make(chan Event, 4)
	bridge := NewHumanInteractionBridge(func(event Event) { requests <- event })
	spec := fake.spec()
	spec.HumanInteraction = bridge
	spec.FirstProgressBudget = 100 * time.Millisecond
	spec.SilenceBudget = 100 * time.Millisecond
	run, err := fake.runtime(nil).Start(context.Background(), "go", spec)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for range run.Events {
		}
	}()
	request := <-requests
	if request.InvocationID != `codex-"q-7"` || request.Input["kind"] != "native_question" || request.Input["prompt"] != "Answer the Agent's question" {
		t.Fatalf("request = %+v", request)
	}
	// A pending question suspends both budgets.
	time.Sleep(300 * time.Millisecond)
	if err := bridge.Respond(`codex-"q-7"`, json.RawMessage(`{"decision":"submit","answers":{"q1":"1"}}`)); err != nil {
		t.Fatal(err)
	}
	out := <-run.Outcome
	if out.Status != statusTimeout {
		t.Fatalf("outcome = %+v", out)
	}
	data, _ := os.ReadFile(fake.log)
	if !strings.Contains(string(data), `"id":"q-7","jsonrpc":"2.0","result":{"answers":{"q1":{"answers":["B"]}}}`) {
		t.Fatalf("answer not sent: %s", data)
	}
}

func TestCodexQuestionWithoutBridgeKeepsTurn(t *testing.T) {
	question := map[string]any{"id": 9, "method": "item/tool/requestUserInput", "params": map[string]any{"turnId": "$TURN",
		"questions": []any{map[string]any{"id": "q", "question": "Which quarter?"}}}}
	fake := newCodexFake(t, []codexFakeTurn{{Status: "completed", Items: []map[string]any{question}, DelayMs: 100}}, nil)
	out, _ := codexDrain(t, fake.runtime(nil), "go", fake.spec())
	if out.Status != statusCompleted || out.Error != "" {
		t.Fatalf("outcome = %+v", out)
	}
	// The reply can reach the fake after the Outcome, so wait for its log.
	want := `"error":{"code":-32601,"message":"` + codexUnansweredQuestionMessage + `"},"id":9`
	var data []byte
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		if data, _ = os.ReadFile(fake.log); strings.Contains(string(data), want) {
			break
		}
	}
	if strings.Count(string(data), want) != 1 {
		t.Fatalf("missing %s in %s", want, data)
	}
}

func TestCodexServerRequestAnswers(t *testing.T) {
	permissions := map[string]any{"id": "perm-1", "method": "item/permissions/requestApproval", "params": map[string]any{"threadId": "$THREAD",
		"permissions": map[string]any{"network": map[string]any{"enabled": true}, "unknown": true, "fileSystem": nil}}}
	approval := map[string]any{"id": 41, "method": "execCommandApproval", "params": map[string]any{"threadId": "$THREAD"}}
	unknown := map[string]any{"id": 42, "method": "item/strange/request", "params": map[string]any{"threadId": "$THREAD"}}
	// The delay lets the reply queue drain before the failed turn's stop
	// closes stdin.
	fake := newCodexFake(t, []codexFakeTurn{{Status: "completed", Items: []map[string]any{permissions, approval, unknown}, DelayMs: 100}}, nil)
	out, _ := codexDrain(t, fake.runtime(nil), "go", fake.spec())
	data, _ := os.ReadFile(fake.log)
	for _, want := range []string{
		`"id":"perm-1","jsonrpc":"2.0","result":{"permissions":{"network":{"enabled":true}},"scope":"turn"}`,
		`"id":41,"jsonrpc":"2.0","result":{"decision":"accept"}`,
		`"error":{"code":-32601,"message":"unsupported codex app-server request: item/strange/request"},"id":42`,
	} {
		if !strings.Contains(string(data), want) {
			t.Fatalf("missing %s in %s", want, data)
		}
	}
	if out.Status != statusFailed || out.Error != "unsupported codex app-server request: item/strange/request" || out.FailureCode != "protocol_incompatible" {
		t.Fatalf("outcome = %+v", out)
	}
}

func codexWaitProcessesGone(t *testing.T, receipt string) {
	t.Helper()
	data, err := os.ReadFile(receipt)
	if err != nil {
		t.Fatalf("receipt: %v", err)
	}
	var pids []int
	for _, field := range strings.Fields(string(data)) {
		pid, err := strconv.Atoi(field)
		if err != nil {
			t.Fatal(err)
		}
		pids = append(pids, pid)
	}
	if len(pids) < 2 {
		t.Fatalf("receipt = %q", data)
	}
	waitGone(t, pids, 5*time.Second)
}

func TestCodexMCPFrontKeepsThreadAcrossURLChanges(t *testing.T) {
	fake := newCodexFake(t, nil, nil)
	rt := fake.runtime(nil)
	mcp := func(servers string) json.RawMessage { return json.RawMessage(`{"mcpServers":{` + servers + `}}`) }
	spec := fake.spec()
	spec.MCPServers = mcp(`"room":{"type":"http","url":"http://127.0.0.1:1/relay-a"}`)
	out, _ := codexDrain(t, rt, "one", spec)
	config, _ := os.ReadFile(filepath.Join(fake.home, "config.toml"))
	if out.Status != statusCompleted || strings.Contains(string(config), "relay-a") || !strings.Contains(string(config), "/mcp/") {
		t.Fatalf("outcome = %+v config = %s", out, config)
	}
	spec.ResumeID = out.SessionID
	spec.MCPServers = mcp(`"room":{"type":"http","url":"http://127.0.0.1:1/relay-b"}`)
	out, _ = codexDrain(t, rt, "two", spec)
	again, _ := os.ReadFile(filepath.Join(fake.home, "config.toml"))
	if out.Status != statusCompleted || string(again) != string(config) || fake.count("config/mcpServer/reload") != 0 ||
		fake.count("thread/resume") != 0 || fake.count("thread/unsubscribe") != 0 {
		t.Fatalf("URL change = %+v methods = %v", out, fake.methods())
	}
	for _, request := range fake.requests("thread/start") {
		if strings.Contains(strings.Join(strings.Fields(jsonText(request)), ""), "mcp_servers") {
			t.Fatalf("thread overrides carry mcp_servers: %v", request)
		}
	}
	spec.MCPServers = mcp(`"room":{"type":"http","url":"http://127.0.0.1:1/relay-b"},"extra":{"type":"http","url":"http://127.0.0.1:1/x"}`)
	if out, _ = codexDrain(t, rt, "three", spec); out.Status != statusCompleted || fake.count("config/mcpServer/reload") != 1 {
		t.Fatalf("added server = %+v methods = %v", out, fake.methods())
	}
	failing := newCodexFake(t, nil, map[string]string{"FAKE_MODES": "reject_reload"})
	frt := failing.runtime(nil)
	fspec := failing.spec()
	fspec.MCPServers = mcp(`"room":{"type":"http","url":"http://127.0.0.1:1/relay-a"}`)
	out, _ = codexDrain(t, frt, "one", fspec)
	fspec.ResumeID = out.SessionID
	fspec.MCPServers = mcp(`"local":{"command":"bin"}`)
	out, _ = codexDrain(t, frt, "two", fspec)
	if out.Status != statusFailed || !strings.Contains(out.Error, "config/mcpServer/reload failed") || failing.count("turn/start") != 1 {
		t.Fatalf("failing reload = %+v methods = %v", out, failing.methods())
	}
}

func jsonText(value any) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func TestCodexCancelledStartOnResidentKeepsHomeUsable(t *testing.T) {
	fake := newCodexFake(t, []codexFakeTurn{{Status: "completed", Items: []map[string]any{codexAgentMessage("m", "ok", nil)}}}, nil)
	previous := codexCleanupBudget.set(2 * time.Second)
	t.Cleanup(func() { codexCleanupBudget.set(previous) })
	rt := fake.runtime(nil)
	spec := fake.spec()
	out, _ := codexDrain(t, rt, "park", spec)
	if out.Status != statusCompleted {
		t.Fatalf("first = %+v", out)
	}
	// A cancelled Start may lose the race before turn/start reaches stdin.
	// Cleanup must not then wait for a turn that cannot exist.
	for attempt := range 4 {
		spec.ResumeID = out.SessionID
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		run, err := rt.Start(ctx, "cancelled", spec)
		if err != nil {
			t.Fatalf("attempt %d start: %v", attempt, err)
		}
		cancelled, _ := codexCollect(t, run)
		if cancelled.ExitUnconfirmed {
			t.Fatalf("attempt %d left the process unconfirmed: %+v", attempt, cancelled)
		}
		out, _ = codexDrain(t, rt, "next", fake.spec())
		if out.Status != statusCompleted {
			t.Fatalf("attempt %d follow-up = %+v", attempt, out)
		}
	}
}

// The payload is what codex-cli 0.163.0 sent without a login.
func TestCodexFailedTurnCarriesErrorInfoDiagnostics(t *testing.T) {
	fake := newCodexFake(t, []codexFakeTurn{{Status: "failed", Error: "unexpected status 401 Unauthorized: missing bearer",
		ErrorInfo: json.RawMessage(`{"httpConnectionFailed":{"httpStatusCode":401}}`)}}, nil)
	out, _ := codexDrain(t, fake.runtime(nil), "go", fake.spec())
	if out.Status != statusFailed || out.FailureCode != "" || out.Diagnostics.Code != "httpConnectionFailed" ||
		out.Diagnostics.StatusCode == nil || *out.Diagnostics.StatusCode != 401 {
		t.Fatalf("outcome = %+v", out)
	}
}

// A steer counts as applied only once Codex shows the user message with the
// steer's client id in the live turn. A turn that ends first did not apply
// it, so the caller may run it again; an RPC refusal never depends on the
// text Codex wrote.
func TestCodexSteerNeedsConsumptionEvidence(t *testing.T) {
	cases := []struct {
		mode, effect, reason string
		parked               bool
	}{
		{"steer_consumed", "", "", true},
		{"steer_unconsumed", "definitely_not_applied", "no_active_turn", false},
		{"steer_foreign", "definitely_not_applied", "no_active_turn", false},
		{"steer_reject", "definitely_not_applied", "rejected", false},
	}
	for _, tc := range cases {
		t.Run(tc.mode, func(t *testing.T) {
			fake := newCodexFake(t, []codexFakeTurn{{Stall: true}}, map[string]string{"FAKE_MODES": tc.mode})
			fake.version = "0.166.0"
			spec := fake.spec()
			spec.SilenceBudget = 3 * time.Second
			spec.ExposeTurnStarted = true
			run, err := fake.runtime(nil).Start(context.Background(), "go", spec)
			if err != nil {
				t.Fatal(err)
			}
			steered := make(chan error, 1)
			for event := range run.Events {
				if event.Kind == EventStatus && event.TurnID != "" {
					go func() {
						_, err := run.Steer(context.Background(), SteerRequest{ExpectedTurnID: event.TurnID, Input: "and tomorrow?"})
						steered <- err
					}()
				}
			}
			<-run.Outcome
			err = <-steered
			var steerErr *SteerError
			switch {
			case tc.effect == "" && err != nil:
				t.Fatalf("consumed steer = %v", err)
			case tc.effect != "" && (!errors.As(err, &steerErr) || steerErr.Effect != tc.effect || steerErr.Reason != tc.reason):
				t.Fatalf("steer = %v, want %s/%s", err, tc.effect, tc.reason)
			}
			steers := fake.requests("turn/steer")
			if client, _ := steers[0]["params"].(map[string]any)["clientUserMessageId"].(string); len(steers) != 1 || client == "" {
				t.Fatalf("steer requests = %v", steers)
			}
			// A steer Codex may still hold is never carried into a later turn.
			if _, _, parked := residentEntryOf(codexResidents, fake.home); parked != tc.parked {
				t.Fatalf("parked = %v, want %v", parked, tc.parked)
			}
		})
	}
}

func TestCodexThreadToolOutputLimitFollowsContextWindow(t *testing.T) {
	cases := []struct {
		name, version string
		window        int
		want          any
	}{
		{"small window", "0.165.0", 64896, float64(4056)},
		{"large window", "0.165.0", 272000, nil},
		{"unknown window", "0.165.0", 0, nil},
		{"Codex without the setting", "0.100.0", 64896, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fake := newCodexFake(t, []codexFakeTurn{{Status: "completed"}}, nil)
			fake.version = tc.version
			codexResidentCapForTest(t, 0)
			spec := fake.spec()
			spec.ContextWindow = tc.window
			if out, _ := codexDrain(t, fake.runtime(nil), "hello", spec); out.Status != statusCompleted {
				t.Fatalf("outcome = %+v", out)
			}
			config, _ := fake.requests("thread/start")[0]["params"].(map[string]any)["config"].(map[string]any)
			if got := config["tool_output_token_limit"]; got != tc.want {
				t.Fatalf("tool_output_token_limit = %v, want %v", got, tc.want)
			}
		})
	}
}
