//go:build !windows

package native

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

const claudeExpMCP = `{"mcpServers":{"exp":{"type":"http","url":"http://127.0.0.1:9/target"}}}`

const claudeOtherSession = "87654321-4321-4321-8321-210987654321"

func (h *claudeResidentHome) prestart(t *testing.T, spec RunSpec) Outcome {
	t.Helper()
	spec.PrepareOnly = true
	events, outcome := claudeFinish(t, claudeStart(t, h.profile, "", spec), 15*time.Second)
	if len(events) != 0 {
		t.Fatalf("pre-start events = %+v", events)
	}
	return outcome
}

// lines returns the lines of a fake record file that start with prefix.
func (h *claudeResidentHome) lines(name, prefix string) []string {
	data, _ := os.ReadFile(filepath.Join(h.dir, name))
	var out []string
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if line != "" && strings.HasPrefix(line, prefix) {
			out = append(out, line)
		}
	}
	return out
}

func (h *claudeResidentHome) argv(t *testing.T, pid int) []string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(h.dir, fmt.Sprintf("argv-%d", pid)))
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimSpace(string(data)), "\n")
}

func (h *claudeResidentHome) markerExists() bool {
	_, err := os.Stat(claudeMarkerPath(h.root, claudeTestSession))
	return err == nil
}

func claudeMustComplete(t *testing.T, outcome Outcome) {
	t.Helper()
	if outcome.Status != statusCompleted {
		t.Fatalf("outcome = %+v", outcome)
	}
}

func TestClaudePrestartAdoptedByCreateRun(t *testing.T) {
	claudeEnableResidency(t, DefaultResidentCap)
	home := claudeNewResidentHome(t, nil)
	out := home.prestart(t, RunSpec{AssignSessionID: claudeTestSession})
	if out.Status != statusCompleted || !out.Parked || out.SessionID != claudeTestSession {
		t.Fatalf("pre-start = %+v", out)
	}
	if !holdsPrestart() || home.markerExists() {
		t.Fatalf("held = %v marker = %v", holdsPrestart(), home.markerExists())
	}
	argv := home.argv(t, home.pids(t)[0])
	if v := claudeFlagValue(argv, "--session-id"); len(v) != 1 || v[0] != claudeTestSession || !slices.Contains(argv, "--strict-mcp-config") {
		t.Fatalf("pre-start argv = %q", argv)
	}

	_, run := home.turn(t, "hello", RunSpec{AssignSessionID: claudeTestSession, MCPServers: json.RawMessage(claudeExpMCP)})
	if run.Status != statusCompleted || run.SessionID != claudeTestSession {
		t.Fatalf("run = %+v", run)
	}
	mcp := home.lines("mcp", "mcp ")
	if len(home.pids(t)) != 1 || len(home.lines("events", "init")) != 1 || len(mcp) != 1 {
		t.Fatalf("pids = %v inits = %v mcp = %v", home.pids(t), home.lines("events", "init"), mcp)
	}
	if !strings.Contains(mcp[0], "/mcp/") || strings.Contains(mcp[0], "127.0.0.1:9/target") {
		t.Fatalf("mcp_set_servers = %s", mcp[0])
	}
	if !home.markerExists() || holdsPrestart() || len(home.logs.matching("claude resident adopted")) != 1 {
		t.Fatal("adoption did not write the marker, clear the prestart or log adopted")
	}
}

func TestClaudePrestartAdoptedByResumeRun(t *testing.T) {
	claudeEnableResidency(t, DefaultResidentCap)
	home := claudeNewResidentHome(t, nil)
	_, out := home.turn(t, "hello", RunSpec{AssignSessionID: claudeTestSession, MCPServers: json.RawMessage(claudeExpMCP)})
	claudeMustComplete(t, out)
	if _, err := StopAllParkedResidents(); err != nil {
		t.Fatal(err)
	}
	if pre := home.prestart(t, RunSpec{ResumeID: claudeTestSession, ResumeRequired: true}); !pre.Parked || pre.Status != statusCompleted {
		t.Fatalf("pre-start = %+v", pre)
	}
	_, out = home.turn(t, "hello", RunSpec{ResumeID: claudeTestSession, ResumeRequired: true, MCPServers: json.RawMessage(claudeExpMCP)})
	claudeMustComplete(t, out)
	if len(home.pids(t)) != 2 || len(home.lines("mcp", "mcp ")) != 1 {
		t.Fatalf("pids = %v mcp = %v", home.pids(t), home.lines("mcp", "mcp "))
	}
}

func TestClaudeUnusedPrestartLeavesNoState(t *testing.T) {
	claudeEnableResidency(t, DefaultResidentCap)
	home := claudeNewResidentHome(t, nil)
	home.prestart(t, RunSpec{AssignSessionID: claudeTestSession})
	if stopped, err := StopAllParkedResidents(); stopped != 1 || err != nil {
		t.Fatalf("stop = %v %v", stopped, err)
	}
	claudeAssertGone(t, home.pids(t))
	if home.markerExists() {
		t.Fatal("an unused pre-start wrote a marker")
	}
	_, out := home.turn(t, "hello", RunSpec{AssignSessionID: claudeTestSession})
	claudeMustComplete(t, out)
	pids := home.pids(t)
	argv := home.argv(t, pids[len(pids)-1])
	if len(pids) != 2 || len(claudeFlagValue(argv, "--session-id")) != 1 || slices.Contains(argv, "--resume") {
		t.Fatalf("pids = %v argv = %q", pids, argv)
	}
}

func TestClaudePrestartMCPErrorFallsBackToColdSpawn(t *testing.T) {
	claudeEnableResidency(t, DefaultResidentCap)
	home := claudeNewResidentHome(t, map[string]string{"CLAUDE_FAKE_MCP_ERROR": "1"})
	home.prestart(t, RunSpec{AssignSessionID: claudeTestSession})
	_, out := home.turn(t, "hello", RunSpec{AssignSessionID: claudeTestSession, MCPServers: json.RawMessage(claudeExpMCP)})
	if out.Status != statusCompleted || out.Output != "done 1" {
		t.Fatalf("run = %+v", out)
	}
	pids := home.pids(t)
	if len(pids) != 2 || !slices.Contains(home.argv(t, pids[1]), "--mcp-config") {
		t.Fatalf("pids = %v", pids)
	}
	claudeAssertGone(t, pids[:1])
	if records := home.logs.matching("claude resident recycled"); !slices.ContainsFunc(records, func(r claudeLogRecord) bool {
		return r.attrs["reason"] == "attach_failed"
	}) {
		t.Fatalf("recycle logs = %+v", records)
	}
}

func TestClaudePrestartNotAdoptedForAnotherSession(t *testing.T) {
	for name, run := range map[string]RunSpec{
		"other create": {AssignSessionID: claudeOtherSession},
		"resume":       {ResumeID: claudeTestSession, ResumeRequired: true},
	} {
		t.Run(name, func(t *testing.T) {
			claudeEnableResidency(t, DefaultResidentCap)
			home := claudeNewResidentHome(t, nil)
			home.prestart(t, RunSpec{AssignSessionID: claudeTestSession})
			_, out := home.turn(t, "hello", run)
			claudeMustComplete(t, out)
			pids := home.pids(t)
			if len(pids) != 2 || holdsPrestart() {
				t.Fatalf("pids = %v", pids)
			}
			claudeAssertGone(t, pids[:1])
		})
	}
}

func TestClaudeContextStopCatchesPrestart(t *testing.T) {
	claudeEnableResidency(t, DefaultResidentCap)
	home := claudeNewResidentHome(t, nil)
	home.profile.ContextKey = "ctx-prestart"
	home.prestart(t, RunSpec{AssignSessionID: claudeTestSession})
	if count, err := StopParkedResidentsForContext("ctx-prestart"); count != 1 || err != nil {
		t.Fatalf("stop = %d %v", count, err)
	}
	if holdsPrestart() {
		t.Fatal("prestart still held")
	}
}

func TestClaudePrestartLeavesCompatibleResidentAlone(t *testing.T) {
	claudeEnableResidency(t, DefaultResidentCap)
	home := claudeNewResidentHome(t, nil)
	_, out := home.turn(t, "hello", RunSpec{AssignSessionID: claudeTestSession, MCPServers: json.RawMessage(claudeExpMCP)})
	claudeMustComplete(t, out)
	pre := home.prestart(t, RunSpec{ResumeID: claudeTestSession, ResumeRequired: true})
	if pre.Status != statusCompleted || pre.Parked || holdsPrestart() || len(home.pids(t)) != 1 {
		t.Fatalf("pre-start = %+v pids = %v", pre, home.pids(t))
	}
}

func TestClaudePrestartReplacesIncompatibleResident(t *testing.T) {
	claudeEnableResidency(t, DefaultResidentCap)
	home := claudeNewResidentHome(t, nil)
	_, out := home.turn(t, "hello", RunSpec{AssignSessionID: claudeTestSession, AppendPrompt: "prompt"})
	claudeMustComplete(t, out)
	pre := home.prestart(t, RunSpec{ResumeID: claudeTestSession, ResumeRequired: true, AppendPrompt: "prompt B"})
	pids := home.pids(t)
	if !pre.Parked || len(pids) != 2 || !holdsPrestart() {
		t.Fatalf("pre-start = %+v pids = %v", pre, pids)
	}
	claudeAssertGone(t, pids[:1])
	_, out = home.turn(t, "hello", RunSpec{ResumeID: claudeTestSession, ResumeRequired: true, AppendPrompt: "prompt B"})
	claudeMustComplete(t, out)
	if len(home.pids(t)) != 2 || holdsPrestart() {
		t.Fatalf("pids = %v", home.pids(t))
	}
	if marker, err := claudeReadMarker(home.root, claudeTestSession); err != nil || marker.prompt != "prompt B" {
		t.Fatalf("marker = %+v %v", marker, err)
	}
}

func TestClaudeCapZeroNeverParks(t *testing.T) {
	claudeEnableResidency(t, 0)
	home := claudeNewResidentHome(t, nil)
	_, out := home.turn(t, "hello", RunSpec{AssignSessionID: claudeTestSession})
	claudeMustComplete(t, out)
	_, out = home.turn(t, "hello", RunSpec{ResumeID: claudeTestSession})
	claudeMustComplete(t, out)
	pids := home.pids(t)
	if len(pids) != 2 {
		t.Fatalf("pids = %v", pids)
	}
	claudeAssertGone(t, pids)
	spec := claudeSpec(RunSpec{PrepareOnly: true, AssignSessionID: claudeOtherSession})
	backend, _ := Open("claude", home.profile)
	if _, err := backend.Start(t.Context(), "", spec); err == nil {
		t.Fatal("a pre-start ran with residency off")
	}
}
