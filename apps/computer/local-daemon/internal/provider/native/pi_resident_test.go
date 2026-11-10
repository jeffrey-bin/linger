package native

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/process"
)

// piResidentHome is one Context with the resident fake Pi and residency on.
type piResidentHome struct {
	t       *testing.T
	root    string
	dir     string
	log     string
	profile Profile
}

type piSyncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *piSyncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *piSyncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func piEnableResidency(t *testing.T, limit int) {
	t.Helper()
	withResidentCap(t, piResidents, limit)
}

func piNewResidentHome(t *testing.T, extra map[string]string) *piResidentHome {
	t.Helper()
	piEnableResidency(t, DefaultResidentCap)
	program, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	base := t.TempDir()
	h := &piResidentHome{t: t, root: filepath.Join(base, "sessions"), dir: filepath.Join(base, "context"), log: filepath.Join(base, "fake.log")}
	if err := os.MkdirAll(h.dir, 0o700); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{piFakeEnv: "resident", piSessionRootKey: h.root, piResidentLogEnv: h.log}
	for key, value := range extra {
		env[key] = value
	}
	h.profile = Profile{Program: program, Env: env, ContextKey: "pi-ctx-" + piRandomHex(6), AgentID: "pi-agent-" + piRandomHex(6)}
	t.Cleanup(func() { _, _ = StopParkedResidentsForContext(h.profile.ContextKey) })
	return h
}

func (h *piResidentHome) runtime() Runtime {
	rt, err := Open("pi", h.profile)
	if err != nil {
		h.t.Fatal(err)
	}
	return rt
}

func (h *piResidentHome) start(ctx context.Context, prompt string, spec RunSpec) *Run {
	h.t.Helper()
	if spec.Dir == "" {
		spec.Dir = h.dir
	}
	run, err := h.runtime().Start(ctx, prompt, spec)
	if err != nil {
		h.t.Fatalf("start %q: %v", prompt, err)
	}
	return run
}

func (h *piResidentHome) turn(prompt string, spec RunSpec) ([]Event, Outcome) {
	h.t.Helper()
	return piCollect(h.t, h.start(h.t.Context(), prompt, spec))
}

func (h *piResidentHome) lines(kind string) int {
	data, _ := os.ReadFile(h.log)
	count := 0
	for _, line := range strings.Split(string(data), "\n") {
		if _, rest, ok := strings.Cut(line, " "); ok && (rest == kind || strings.HasPrefix(rest, kind+":")) {
			count++
		}
	}
	return count
}

func (h *piResidentHome) sessionDir(id string) string { return filepath.Join(h.root, id) }

// parked returns the live, non-retiring process parked for session id.
func (h *piResidentHome) parked(id string) *piProcess {
	proc, retiring, ok := residentEntryOf(piResidents, h.sessionDir(id))
	if !ok || retiring || !proc.alive() {
		return nil
	}
	return proc
}

// createParked runs a create turn for id and requires that it parks.
func (h *piResidentHome) createParked(id string, spec RunSpec) *piProcess {
	h.t.Helper()
	spec.AssignSessionID = id
	_, outcome := h.turn("go", spec)
	if outcome.Status != statusCompleted || outcome.ExitConfirmed || outcome.ExitUnconfirmed {
		h.t.Fatalf("create turn = %+v", outcome)
	}
	proc := h.parked(id)
	if proc == nil {
		h.t.Fatal("create turn did not park")
	}
	return proc
}

func (h *piResidentHome) assertLockFree(id string) {
	h.t.Helper()
	lock, err := piLockSession(h.sessionDir(id))
	if err != nil {
		h.t.Fatalf("session lock: %v", err)
	}
	piReleaseLock(lock)
}

func piAwaitGone(t *testing.T, proc *piProcess) {
	t.Helper()
	awaitTrue(t, "Pi process exit", 10*time.Second, func() bool { return piProcessGone(proc.pid) })
}

// Scenario 56.
func TestPiResidentReuseAcrossTurns(t *testing.T) {
	h := piNewResidentHome(t, map[string]string{piResidentExitHangEnv: "1"})
	proc := h.createParked("reuse-session", RunSpec{})
	if piProcessGone(proc.pid) {
		t.Fatal("parked process is gone")
	}
	events, outcome := h.turn("again", RunSpec{ResumeID: "reuse-session"})
	if outcome.Status != statusCompleted || outcome.Output != "done" || outcome.SessionID != "reuse-session" {
		t.Fatalf("resume turn = %+v", outcome)
	}
	if h.parked("reuse-session") != proc || h.lines("spawn") != 1 || h.lines("prompt") != 2 {
		t.Fatalf("spawns=%d prompts=%d", h.lines("spawn"), h.lines("prompt"))
	}
	running := 0
	for _, event := range events {
		if event.Kind == EventStatus {
			running++
			if event.ProcessReused == nil || !*event.ProcessReused || event.SentAt.IsZero() || event.TurnID != outcome.TurnID {
				t.Fatalf("running = %+v", event)
			}
		}
	}
	if running != 1 {
		t.Fatalf("running statuses = %d", running)
	}
}

// Scenario 57.
func TestPiResidentRespawnsOnShapeMismatch(t *testing.T) {
	extension := filepath.Join(t.TempDir(), "mcp-extension.js")
	if err := os.WriteFile(extension, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	mcp := func(name string) json.RawMessage {
		return json.RawMessage(`{"mcpServers":{"` + name + `":{"type":"http","url":"http://127.0.0.1:9/target"}}}`)
	}
	write := func(t *testing.T, path, content string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	cases := map[string]struct {
		first, second RunSpec
		change        func(t *testing.T, h *piResidentHome)
	}{
		"model":         {first: RunSpec{Model: "fixture/a"}, second: RunSpec{Model: "fixture/b"}},
		"thinking":      {first: RunSpec{Effort: "low"}, second: RunSpec{Effort: "high"}},
		"append prompt": {first: RunSpec{AppendPrompt: "a"}, second: RunSpec{AppendPrompt: "b"}},
		"delivered skills": {change: func(t *testing.T, h *piResidentHome) {
			h.profile.ResidentSkillDigest = "skills-b"
		}},
		"project settings": {change: func(t *testing.T, h *piResidentHome) {
			write(t, filepath.Join(h.dir, ".pi", "settings.json"), `{"b":1}`)
		}},
		"agent settings": {change: func(t *testing.T, h *piResidentHome) {
			h.profile.PiConfigDigest = "config-b"
		}},
		"mcp server name": {first: RunSpec{MCPServers: mcp("one")}, second: RunSpec{MCPServers: mcp("two")}},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			h := piNewResidentHome(t, map[string]string{"PI_CODING_AGENT_DIR": filepath.Join(t.TempDir(), "agent")})
			h.profile.ManagedMCPExtension = extension
			write(t, filepath.Join(h.dir, ".agents", "skills", "s", "SKILL.md"), "first")
			write(t, filepath.Join(h.dir, ".pi", "settings.json"), `{"a":1}`)
			write(t, filepath.Join(h.profile.Env["PI_CODING_AGENT_DIR"], "settings.json"), `{"a":1}`)
			old := h.createParked("shape-session", tc.first)
			if tc.change != nil {
				tc.change(t, h)
			}
			second := tc.second
			second.ResumeID = "shape-session"
			if _, outcome := h.turn("again", second); outcome.Status != statusCompleted {
				t.Fatalf("second turn = %+v", outcome)
			}
			if got := h.lines("spawn"); got != 2 {
				t.Fatalf("spawns = %d", got)
			}
			piAwaitGone(t, old)
		})
	}
}

// Scenario 58.
func TestPiResidentNotParkedAfterUncleanTurn(t *testing.T) {
	for _, tc := range []struct{ prompt, status string }{
		{"fail", statusFailed}, {"no_assistant", statusFailed}, {"aborted", statusAborted},
		{"pending", statusCompleted}, {"streaming", statusCompleted},
	} {
		t.Run(tc.prompt, func(t *testing.T) {
			h := piNewResidentHome(t, nil)
			_, outcome := h.turn(tc.prompt, RunSpec{AssignSessionID: "unclean"})
			if outcome.Status != tc.status || !outcome.ExitConfirmed || outcome.ExitUnconfirmed {
				t.Fatalf("outcome = %+v", outcome)
			}
			if _, _, ok := residentEntryOf(piResidents, h.sessionDir("unclean")); ok {
				t.Fatal("unclean turn parked")
			}
			h.assertLockFree("unclean")
		})
	}
	t.Run("timeout", func(t *testing.T) {
		h := piNewResidentHome(t, nil)
		if _, outcome := h.turn("hold", RunSpec{AssignSessionID: "unclean", Budget: 300 * time.Millisecond}); outcome.Status != statusTimeout {
			t.Fatalf("outcome = %+v", outcome)
		}
		if h.parked("unclean") != nil {
			t.Fatal("timed out turn parked")
		}
	})
	t.Run("cancel", func(t *testing.T) {
		h := piNewResidentHome(t, nil)
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		run := h.start(ctx, "hold", RunSpec{AssignSessionID: "unclean"})
		piWaitRunning(t, run)
		cancel()
		if _, outcome := piCollect(t, run); outcome.Status != piStatusCancelled {
			t.Fatalf("outcome = %+v", outcome)
		}
		if h.parked("unclean") != nil {
			t.Fatal("cancelled turn parked")
		}
	})
}

// Scenario 59.
func TestPiResidentUnconfirmedStopBlocksSession(t *testing.T) {
	h := piNewResidentHome(t, nil)
	proc := h.createParked("stuck-session", RunSpec{})
	check := func(cmd *exec.Cmd, budget time.Duration) bool {
		if cmd == proc.cmd {
			return false
		}
		return process.WaitEmpty(cmd, budget)
	}
	piTreeCheck.Store(&check)
	t.Cleanup(func() { piTreeCheck.Store(nil) })
	if _, err := StopParkedResidentsForContext(h.profile.ContextKey); !errors.Is(err, errResidentRecycleUnconfirmed) {
		t.Fatalf("stop = %v", err)
	}
	if _, err := h.runtime().Start(t.Context(), "again", RunSpec{ResumeID: "stuck-session", Dir: h.dir}); !errors.Is(err, errResidentRecycleUnconfirmed) {
		t.Fatalf("resume while held = %v", err)
	}
	if got := h.lines("spawn"); got != 1 {
		t.Fatalf("spawns = %d", got)
	}
	piTreeCheck.Store(nil)
	if _, outcome := h.turn("again", RunSpec{ResumeID: "stuck-session"}); outcome.Status != statusCompleted {
		t.Fatalf("resume = %+v", outcome)
	}
	if got := h.lines("spawn"); got != 2 {
		t.Fatalf("spawns = %d", got)
	}
}

// Scenario 60.
func TestPiResidentStopPaths(t *testing.T) {
	for name, stop := range map[string]func(h *piResidentHome) (int, error){
		"context": func(h *piResidentHome) (int, error) { return StopParkedResidentsForContext(h.profile.ContextKey) },
		"agent":   func(h *piResidentHome) (int, error) { return StopParkedResidentsForAgent(h.profile.AgentID) },
		"all":     func(*piResidentHome) (int, error) { return StopAllParkedResidents() },
	} {
		t.Run(name, func(t *testing.T) {
			h := piNewResidentHome(t, nil)
			proc := h.createParked("stop-session", RunSpec{})
			if count, err := stop(h); count != 1 || err != nil {
				t.Fatalf("stop = %d %v", count, err)
			}
			if _, _, ok := residentEntryOf(piResidents, h.sessionDir("stop-session")); ok {
				t.Fatal("stopped process stayed in the table")
			}
			piAwaitGone(t, proc)
			h.assertLockFree("stop-session")
		})
	}
}

// Scenario 61.
func TestPiResidentFrontRoutesEachTurn(t *testing.T) {
	target := func(body string) string {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, body) }))
		t.Cleanup(server.Close)
		return server.URL
	}
	first, second := target("first"), target("second")
	config := func(url string) json.RawMessage {
		return json.RawMessage(`{"mcpServers":{"computer":{"type":"http","url":"` + url + `"}}}`)
	}
	extension := filepath.Join(t.TempDir(), "mcp-extension.js")
	if err := os.WriteFile(extension, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	h := piNewResidentHome(t, nil)
	h.profile.ManagedMCPExtension = extension
	proc := h.createParked("front-session", RunSpec{MCPServers: config(first)})
	data, err := os.ReadFile(filepath.Join(h.sessionDir("front-session"), piMCPConfigName))
	if err != nil {
		t.Fatal(err)
	}
	var written struct {
		MCPServers map[string]struct{ URL string } `json:"mcpServers"`
	}
	if err := json.Unmarshal(data, &written); err != nil {
		t.Fatal(err)
	}
	front := written.MCPServers["computer"].URL
	if !strings.Contains(front, "/mcp/") || strings.Contains(string(data), first) {
		t.Fatalf("MCP file = %s", data)
	}
	get := func() (int, string) {
		t.Helper()
		response, err := http.Get(front)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		body, _ := io.ReadAll(response.Body)
		return response.StatusCode, string(body)
	}
	if code, _ := get(); code != http.StatusServiceUnavailable {
		t.Fatalf("parked front = %d", code)
	}
	run := h.start(t.Context(), "hold", RunSpec{ResumeID: "front-session", MCPServers: config(second)})
	turn := piWaitRunning(t, run).TurnID
	if code, body := get(); code != http.StatusOK || body != "second" {
		t.Fatalf("turn 2 front = %d %q", code, body)
	}
	if _, err := run.Steer(t.Context(), SteerRequest{ExpectedTurnID: turn, Input: "finish"}); err != nil {
		t.Fatal(err)
	}
	if _, outcome := piCollect(t, run); outcome.Status != statusCompleted {
		t.Fatalf("turn 2 = %+v", outcome)
	}
	if h.parked("front-session") != proc {
		t.Fatal("turn 2 did not park the same process")
	}
	if code, _ := get(); code != http.StatusServiceUnavailable {
		t.Fatalf("parked again front = %d", code)
	}
}

// piHeldReuse parks a process, then starts a settle_later resume turn on
// it and returns with the process write lock held after turn start.
func piHeldReuse(t *testing.T, h *piResidentHome) (*piProcess, *Run, string) {
	t.Helper()
	proc := h.createParked("held-session", RunSpec{})
	run := h.start(t.Context(), "settle_later", RunSpec{ResumeID: "held-session"})
	turn := piWaitRunning(t, run).TurnID
	proc.writeMu.Lock()
	return proc, run, turn
}

// Scenario 10.
func TestPiReleaseDuringParkProbe(t *testing.T) {
	for name, stop := range map[string]func(h *piResidentHome) (int, error){
		"context": func(h *piResidentHome) (int, error) { return StopParkedResidentsForContext(h.profile.ContextKey) },
		"agent":   func(h *piResidentHome) (int, error) { return StopParkedResidentsForAgent(h.profile.AgentID) },
		"all":     func(*piResidentHome) (int, error) { return StopAllParkedResidents() },
	} {
		t.Run(name, func(t *testing.T) {
			h := piNewResidentHome(t, nil)
			proc, run, _ := piHeldReuse(t, h)
			time.Sleep(800 * time.Millisecond)
			_, err := stop(h)
			proc.writeMu.Unlock()
			if err != nil {
				t.Fatalf("stop = %v", err)
			}
			if _, outcome := piCollect(t, run); outcome.Status != statusCompleted || !outcome.ExitConfirmed {
				t.Fatalf("outcome = %+v", outcome)
			}
			if _, _, ok := residentEntryOf(piResidents, h.sessionDir("held-session")); ok {
				t.Fatal("a released turn parked")
			}
			if proc.alive() || !piProcessGone(proc.pid) {
				t.Fatal("released process is alive")
			}
			h.assertLockFree("held-session")
		})
	}
}

// Scenario 11 for Pi: a release of one Context leaves another parking.
func TestPiReleaseOfAnotherContextStillParks(t *testing.T) {
	h := piNewResidentHome(t, nil)
	if _, err := StopParkedResidentsForContext("ctx-released-" + piRandomHex(4)); err != nil {
		t.Fatal(err)
	}
	h.createParked("other-session", RunSpec{})
}

// Scenario 62.
func TestPiSteerRacingParkIsRejected(t *testing.T) {
	h := piNewResidentHome(t, nil)
	proc, run, turn := piHeldReuse(t, h)
	steered := make(chan error, 1)
	go func() {
		_, err := run.Steer(context.Background(), SteerRequest{ExpectedTurnID: turn, Input: "late"})
		steered <- err
	}()
	time.Sleep(800 * time.Millisecond)
	proc.writeMu.Unlock()
	var refused *SteerError
	if err := <-steered; !errors.As(err, &refused) || refused.Effect != "definitely_not_applied" {
		t.Fatalf("steer = %v", err)
	}
	if _, outcome := piCollect(t, run); outcome.Status != statusCompleted {
		t.Fatalf("outcome = %+v", outcome)
	}
	if got := h.lines("steer"); got != 0 {
		t.Fatalf("steer lines = %d", got)
	}
}

// Scenario 63.
func TestPiSteerFromEarlierTurnIsRejected(t *testing.T) {
	h := piNewResidentHome(t, nil)
	first := h.start(t.Context(), "go", RunSpec{AssignSessionID: "steer-session"})
	if _, outcome := piCollect(t, first); outcome.Status != statusCompleted || h.parked("steer-session") == nil {
		t.Fatalf("turn 1 = %+v", outcome)
	}
	second := h.start(t.Context(), "hold", RunSpec{ResumeID: "steer-session"})
	turn := piWaitRunning(t, second).TurnID
	var refused *SteerError
	if _, err := first.Steer(t.Context(), SteerRequest{ExpectedTurnID: turn, Input: "stale"}); !errors.As(err, &refused) || refused.Effect != "definitely_not_applied" || refused.ActualTurnID != turn {
		t.Fatalf("earlier turn steer = %v", err)
	}
	if ack, err := second.Steer(t.Context(), SteerRequest{ExpectedTurnID: turn, Input: "finish"}); err != nil || ack.TurnID != turn {
		t.Fatalf("own steer = %+v %v", ack, err)
	}
	if _, outcome := piCollect(t, second); outcome.Status != statusCompleted {
		t.Fatalf("turn 2 = %+v", outcome)
	}
	if got := h.lines("steer"); got != 1 {
		t.Fatalf("steer lines = %d", got)
	}
}

// Scenario 64.
func TestPiCallerCancelDuringReuseProbe(t *testing.T) {
	h := piNewResidentHome(t, nil)
	proc := h.createParked("probe-session", RunSpec{})
	proc.writeMu.Lock()
	ctx, cancel := context.WithCancel(t.Context())
	time.AfterFunc(100*time.Millisecond, cancel)
	_, err := h.runtime().Start(ctx, "again", RunSpec{ResumeID: "probe-session", Dir: h.dir})
	proc.writeMu.Unlock()
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("start = %v", err)
	}
	if _, _, ok := residentEntryOf(piResidents, h.sessionDir("probe-session")); ok || proc.alive() {
		t.Fatal("probed process was not retired")
	}
	piAwaitGone(t, proc)
	if got := h.lines("spawn"); got != 1 {
		t.Fatalf("spawns = %d", got)
	}
	if _, outcome := h.turn("later", RunSpec{ResumeID: "probe-session"}); outcome.Status != statusCompleted {
		t.Fatalf("later turn = %+v", outcome)
	}
}

// Scenario 65.
func TestPiResidentDiagnosticsFollowCurrentTurn(t *testing.T) {
	h := piNewResidentHome(t, nil)
	piEnableResidency(t, 1)
	var logs1, logs2 piSyncBuffer
	h.profile.Logger = slog.New(slog.NewTextHandler(&logs1, nil))
	victim := h.createParked("session-a", RunSpec{})
	h.profile.Logger = slog.New(slog.NewTextHandler(&logs2, nil))
	if _, outcome := h.turn("again", RunSpec{ResumeID: "session-a"}); outcome.Status != statusCompleted {
		t.Fatalf("reuse = %+v", outcome)
	}
	h.createParked("session-b", RunSpec{})
	piAwaitGone(t, victim)
	second := logs2.String()
	for _, want := range []string{"pi resident reused", "pi resident parked", "reason=cap"} {
		if !strings.Contains(second, want) {
			t.Fatalf("run-2 log lacks %q:\n%s", want, second)
		}
	}
	if first := logs1.String(); strings.Contains(first, "reason=cap") || strings.Contains(first, "pi resident reused") {
		t.Fatalf("run-1 log:\n%s", first)
	}
}

// Reuse depends only on the Skills the Daemon delivered: a file an Agent or
// Pi writes under the workspace Skills never recycles the process.
func TestPiWorkspaceSkillWritesKeepProcess(t *testing.T) {
	h := piNewResidentHome(t, nil)
	path := filepath.Join(h.dir, ".agents", "skills", "s", "SKILL.md")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}
	h.createParked("skill-session", RunSpec{})
	if err := os.WriteFile(path, []byte("changed"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, outcome := h.turn("again", RunSpec{ResumeID: "skill-session"}); outcome.Status != statusCompleted || h.lines("spawn") != 1 {
		t.Fatalf("outcome=%+v spawns=%d", outcome, h.lines("spawn"))
	}
}

// The Daemon reads Pi's settings.json and models.json once while it prepares
// an Operation. A write to them after the process parked, by Pi or anyone,
// does not recycle it within that identity.
func TestPiAgentSettingsWriteAfterParkKeepsProcess(t *testing.T) {
	agentDir := filepath.Join(t.TempDir(), "agent")
	h := piNewResidentHome(t, map[string]string{"PI_CODING_AGENT_DIR": agentDir})
	settings := filepath.Join(agentDir, "settings.json")
	if err := os.MkdirAll(agentDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(settings, []byte(`{"a":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	h.profile.PiConfigDigest = "config-a"
	h.createParked("settings-session", RunSpec{})
	if err := os.WriteFile(settings, []byte(`{"lastChangelogVersion":"1.2.0"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, outcome := h.turn("again", RunSpec{ResumeID: "settings-session"}); outcome.Status != statusCompleted || h.lines("spawn") != 1 {
		t.Fatalf("outcome=%+v spawns=%d", outcome, h.lines("spawn"))
	}
}

// Scenario 42 for Pi.
func TestPiToolActivityKinds(t *testing.T) {
	h := piNewResidentHome(t, nil)
	events, outcome := h.turn("tools", RunSpec{})
	if outcome.Status != statusCompleted {
		t.Fatalf("outcome = %+v", outcome)
	}
	want := map[string]string{
		"read": ActivityRead, "edit": ActivityFileChange, "write": ActivityFileChange, "grep": ActivitySearch,
		"bash": ActivityCommand, "mcp__browser__navigate": ActivityBrowse, "mcp__computer__run_actions": ActivityTool, "notebook": ActivityTool,
	}
	seen := 0
	for _, event := range events {
		if event.Kind != EventToolCall {
			continue
		}
		seen++
		if event.ActivityKind != want[event.ToolName] {
			t.Fatalf("%s = %q", event.ToolName, event.ActivityKind)
		}
	}
	if seen != len(want) {
		t.Fatalf("tool calls = %d", seen)
	}
	if piToolActivities["find"] != ActivitySearch || piToolActivities["ls"] != ActivitySearch {
		t.Fatal("find and ls are searches")
	}
}

func TestPiTempLeaseFollowsProcess(t *testing.T) {
	h := piNewResidentHome(t, nil)
	temp := filepath.Join(t.TempDir(), "process-temp")
	if err := os.Mkdir(temp, 0o700); err != nil {
		t.Fatal(err)
	}
	retained := 0
	h.profile.RetainProcessTemp = func() (func() error, error) {
		retained++
		return func() error { return os.RemoveAll(temp) }, nil
	}
	h.createParked("temp-session", RunSpec{})
	if _, outcome := h.turn("again", RunSpec{ResumeID: "temp-session"}); outcome.Status != statusCompleted {
		t.Fatalf("resume = %+v", outcome)
	}
	if _, err := os.Stat(temp); err != nil || retained != 1 {
		t.Fatalf("parked process lost its temp lease (retained %d): %v", retained, err)
	}
	if _, err := StopParkedResidentsForContext(h.profile.ContextKey); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(temp); !os.IsNotExist(err) {
		t.Fatalf("temp directory after stop: %v", err)
	}
}
