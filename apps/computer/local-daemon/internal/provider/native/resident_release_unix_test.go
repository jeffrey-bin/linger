//go:build !windows

package native

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func codexAwaitFile(t *testing.T, path string) {
	t.Helper()
	awaitTrue(t, filepath.Base(path), 10*time.Second, func() bool {
		_, err := os.Stat(path)
		return err == nil
	})
}

// A release that finds nothing parked still keeps the settling turn from
// parking; a turn of another Context parks.
func TestCodexReleaseBeforeParkRefusesPark(t *testing.T) {
	gate := filepath.Join(t.TempDir(), "gate")
	fake := newCodexFake(t, []codexFakeTurn{{Status: "completed", Gate: true}}, map[string]string{"FAKE_GATE": gate})
	run, err := fake.scopedRuntime(nil, "ctx-released", "agent-r").Start(context.Background(), "go", fake.spec())
	if err != nil {
		t.Fatal(err)
	}
	codexAwaitFile(t, gate+".started")
	if count, err := StopParkedResidentsForContext("ctx-released"); count != 0 || err != nil {
		t.Fatalf("release = %d %v", count, err)
	}
	if err := os.WriteFile(gate, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	out, _ := codexCollect(t, run)
	if out.Status != statusCompleted || !out.ExitConfirmed {
		t.Fatalf("outcome = %+v", out)
	}
	if _, _, ok := residentEntryOf(codexResidents, fake.home); ok {
		t.Fatal("a released Context's turn parked")
	}

	other := newCodexFake(t, nil, nil)
	if out, _ := codexDrain(t, other.scopedRuntime(nil, "ctx-other", "agent-r"), "go", other.spec()); out.Status != statusCompleted || out.ExitConfirmed {
		t.Fatalf("other Context = %+v", out)
	}
	if _, _, ok := residentEntryOf(codexResidents, other.home); !ok {
		t.Fatal("another Context's turn did not park")
	}
}

func TestCodexStopByContextAgentAndAll(t *testing.T) {
	type parked struct {
		fake *codexFake
		proc *codexProcess
	}
	var homes []parked
	for _, scope := range [][2]string{{"stop-ctx-a", "stop-agent-a"}, {"stop-ctx-b", "stop-agent-a"}, {"stop-ctx-c", "stop-agent-c"}} {
		fake := newCodexFake(t, nil, nil)
		if out, _ := codexDrain(t, fake.scopedRuntime(nil, scope[0], scope[1]), "go", fake.spec()); out.Status != statusCompleted {
			t.Fatalf("turn = %+v", out)
		}
		homes = append(homes, parked{fake, codexParkedProcess(t, fake)})
	}
	stillParked := func(i int) bool {
		_, _, ok := residentEntryOf(codexResidents, homes[i].fake.home)
		return ok && !homes[i].proc.isReaped()
	}
	if count, err := StopParkedResidentsForContext("stop-ctx-a"); count != 1 || err != nil {
		t.Fatalf("context stop = %d %v", count, err)
	}
	if stillParked(0) || !stillParked(1) || !stillParked(2) {
		t.Fatal("context stop hit the wrong process")
	}
	if count, err := StopParkedResidentsForAgent("stop-agent-a"); count != 1 || err != nil {
		t.Fatalf("agent stop = %d %v", count, err)
	}
	if stillParked(1) || !stillParked(2) {
		t.Fatal("agent stop hit the wrong process")
	}
	if count, err := StopParkedResidentsForContext(""); count != 0 || err != nil {
		t.Fatalf("empty context stop = %d %v", count, err)
	}
	if count, err := StopAllParkedResidents(); count != 1 || err != nil {
		t.Fatalf("stop all = %d %v", count, err)
	}
	if stillParked(2) {
		t.Fatal("stop all left a process")
	}
}

func TestCodexExplicitStopReleasesTempLease(t *testing.T) {
	fake := newCodexFake(t, nil, nil)
	temp := filepath.Join(t.TempDir(), "process-temp")
	if err := os.Mkdir(temp, 0o700); err != nil {
		t.Fatal(err)
	}
	rt, _ := Open("codex", Profile{Program: fake.program, Env: fake.env, RetainProcessTemp: func() (func() error, error) {
		return func() error { return os.RemoveAll(temp) }, nil
	}})
	if out, _ := codexDrain(t, rt, "go", fake.spec()); out.Status != statusCompleted || out.ExitConfirmed {
		t.Fatalf("turn = %+v", out)
	}
	if _, err := os.Stat(temp); err != nil {
		t.Fatal("parked process lost its temp directory")
	}
	if _, err := StopAllParkedResidents(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(temp); !os.IsNotExist(err) {
		t.Fatalf("temp directory after stop: %v", err)
	}
}

func TestClaudeAgentReleaseBeforeParkRefusesPark(t *testing.T) {
	claudeEnableResidency(t, DefaultResidentCap)
	home := claudeNewResidentHome(t, nil)
	home.profile.AgentID = "agent-released"
	run := claudeStart(t, home.profile, "pause", RunSpec{})
	time.Sleep(300 * time.Millisecond)
	if count, err := StopParkedResidentsForAgent("agent-released"); count != 0 || err != nil {
		t.Fatalf("release = %d %v", count, err)
	}
	if _, outcome := claudeFinish(t, run, 10*time.Second); outcome.Status != statusCompleted {
		t.Fatalf("outcome = %+v", outcome)
	}
	claudeAssertGone(t, home.pids(t))
	claudeAwaitRemoved(t, filepath.Clean(home.root))

	other := claudeNewResidentHome(t, nil)
	other.profile.AgentID = "agent-other"
	other.turn(t, "hello", RunSpec{})
	if pids := other.pids(t); len(pids) != 1 || !claudeAlive(pids[0]) {
		t.Fatal("another Agent's turn did not park")
	}
	if _, _, ok := residentEntryOf(claudeResidents, filepath.Clean(other.root)); !ok {
		t.Fatal("another Agent's process is not in the table")
	}
}

func TestReleaseAggregatesAcrossProvidersWithUnconfirmedStop(t *testing.T) {
	claudeEnableResidency(t, DefaultResidentCap)
	previous := claudeKillWait
	claudeKillWait = 50 * time.Millisecond
	t.Cleanup(func() { claudeKillWait = previous })

	scope := Profile{ContextKey: "ctx-mixed"}
	stuckRoot := filepath.Join(t.TempDir(), "sessions")
	stuck := claudeStuckResidentIn(t, stuckRoot, scope)
	fake := newCodexFake(t, nil, nil)
	if out, _ := codexDrain(t, fake.scopedRuntime(nil, "ctx-mixed", ""), "go", fake.spec()); out.Status != statusCompleted {
		t.Fatalf("codex turn = %+v", out)
	}
	codexProc := codexParkedProcess(t, fake)
	pi := piNewResidentHome(t, nil)
	pi.profile.ContextKey = "ctx-mixed"
	piProc := pi.createParked("mixed-session", RunSpec{})

	count, err := StopParkedResidentsForContext("ctx-mixed")
	if count != 3 || !errors.Is(err, errResidentRecycleUnconfirmed) {
		t.Fatalf("release = %d %v", count, err)
	}
	awaitTrue(t, "codex exit", 5*time.Second, codexProc.isReaped)
	if _, _, ok := residentEntryOf(codexResidents, fake.home); ok {
		t.Fatal("codex entry stayed")
	}
	if _, _, ok := residentEntryOf(piResidents, pi.sessionDir("mixed-session")); ok || piProc.alive() {
		t.Fatal("the Pi process stayed")
	}
	piAwaitGone(t, piProc)
	if owner, retiring, _ := residentEntryOf(claudeResidents, stuckRoot); owner != stuck || !retiring {
		t.Fatal("the unconfirmed Claude entry was not held")
	}
}
