//go:build !windows

package native

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

type claudeLogRecord struct {
	message string
	attrs   map[string]string
}

// claudeLogCapture records every log record, Debug included.
type claudeLogCapture struct {
	mu      sync.Mutex
	records []claudeLogRecord
}

func (c *claudeLogCapture) Enabled(context.Context, slog.Level) bool { return true }
func (c *claudeLogCapture) Handle(_ context.Context, record slog.Record) error {
	attrs := map[string]string{}
	record.Attrs(func(attr slog.Attr) bool {
		attrs[attr.Key] = attr.Value.String()
		return true
	})
	c.mu.Lock()
	c.records = append(c.records, claudeLogRecord{message: record.Message, attrs: attrs})
	c.mu.Unlock()
	return nil
}
func (c *claudeLogCapture) WithAttrs([]slog.Attr) slog.Handler { return c }
func (c *claudeLogCapture) WithGroup(string) slog.Handler      { return c }

func (c *claudeLogCapture) matching(prefix string) []claudeLogRecord {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []claudeLogRecord
	for _, record := range c.records {
		if strings.HasPrefix(record.message, prefix) {
			out = append(out, record)
		}
	}
	return out
}

func (c *claudeLogCapture) await(t *testing.T, prefix string, n int) []claudeLogRecord {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if records := c.matching(prefix); len(records) >= n {
			return records
		}
		if time.Now().After(deadline) {
			t.Fatalf("expected %d %q records", n, prefix)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func claudeEnableResidency(t *testing.T, cap int) {
	t.Helper()
	previousGrace := claudeTerminationGrace
	claudeTerminationGrace = time.Second
	withResidentCap(t, claudeResidents, cap)
	t.Cleanup(func() {
		_, _ = StopAllParkedResidents()
		claudeTerminationGrace = previousGrace
	})
}

type claudeResidentHome struct {
	dir     string
	root    string
	profile Profile
	logs    *claudeLogCapture
}

func claudeNewResidentHome(t *testing.T, extra map[string]string) *claudeResidentHome {
	t.Helper()
	home := &claudeResidentHome{dir: t.TempDir(), logs: &claudeLogCapture{}}
	home.root = filepath.Join(home.dir, "sessions")
	env := map[string]string{"CLAUDE_FAKE_DIR": home.dir, "CLAUDE_FAKE_SESSION": claudeTestSession, claudeSessionRoot: home.root}
	for key, value := range extra {
		env[key] = value
	}
	home.profile = claudeFakeProfile(t, "resident", env)
	home.profile.Logger = slog.New(home.logs)
	return home
}

func (h *claudeResidentHome) turn(t *testing.T, prompt string, spec RunSpec) ([]Event, Outcome) {
	t.Helper()
	spec.ExposeTurnStarted = true
	return claudeFinish(t, claudeStart(t, h.profile, prompt, spec), 15*time.Second)
}

func (h *claudeResidentHome) pids(t *testing.T) []int {
	t.Helper()
	return claudeReadPIDs(t, h.dir)
}

func claudeAlive(pid int) bool { return syscall.Kill(pid, 0) == nil }

func claudeTurnStarted(events []Event) *Event {
	for _, event := range events {
		if event.Kind == EventStatus && event.TurnID != "" {
			return &event
		}
	}
	return nil
}

func TestClaudeResidentServesTwoTurnsOnOneProcess(t *testing.T) {
	claudeEnableResidency(t, 8)
	home := claudeNewResidentHome(t, nil)
	var reused []bool
	for i := 1; i <= 2; i++ {
		spec := RunSpec{}
		if i == 2 {
			spec.ResumeID = claudeTestSession
		}
		events, outcome := home.turn(t, "hello", spec)
		started := claudeTurnStarted(events)
		if outcome.Status != statusCompleted || outcome.Output != fmt.Sprintf("done %d", i) || outcome.Usage["m"] != (TokenCount{Input: 10, Output: 5}) || started == nil || outcome.ExitConfirmed {
			t.Fatalf("turn %d = %+v started = %+v", i, outcome, started)
		}
		reused = append(reused, *started.ProcessReused)
	}
	if reused[0] || !reused[1] {
		t.Fatalf("ProcessReused = %v", reused)
	}
	pids := home.pids(t)
	events, _ := os.ReadFile(filepath.Join(home.dir, "events"))
	lines := strings.Split(strings.TrimSpace(string(events)), "\n")
	if len(pids) != 1 || !claudeAlive(pids[0]) || len(lines) != 3 || lines[0] != "init" || lines[1] == lines[2] {
		t.Fatalf("pids = %v events = %q", pids, lines)
	}
}

func TestClaudeResidentIncompatibleTurnSpawnsFresh(t *testing.T) {
	claudeEnableResidency(t, 8)
	front := `{"mcpServers":{"a":{"type":"http","url":"http://127.0.0.1:1/a"}}}`
	for name, second := range map[string]RunSpec{
		"model":     {ResumeID: claudeTestSession, Model: "other"},
		"prompt":    {ResumeID: claudeTestSession, AppendPrompt: "other"},
		"resume id": {ResumeID: "87654321-4321-4321-8321-210987654321"},
		"assign":    {AssignSessionID: "87654321-4321-4321-8321-210987654321"},
	} {
		t.Run(name, func(t *testing.T) {
			home := claudeNewResidentHome(t, nil)
			if _, outcome := home.turn(t, "hello", RunSpec{MCPServers: json.RawMessage(front)}); outcome.Status != statusCompleted {
				t.Fatalf("first = %+v", outcome)
			}
			if second.MCPServers == nil {
				second.MCPServers = json.RawMessage(front)
			}
			events, _ := home.turn(t, "hello", second)
			if started := claudeTurnStarted(events); started == nil || *started.ProcessReused {
				t.Fatalf("second turn reused: %+v", started)
			}
			pids := home.pids(t)
			if len(pids) != 2 {
				t.Fatalf("pids = %v", pids)
			}
			claudeAssertGone(t, pids[:1])
			if records := home.logs.matching("claude resident recycled"); len(records) == 0 || strings.Contains(records[0].attrs["mismatch"], "127.0.0.1") {
				t.Fatalf("recycle log = %+v", records)
			}
		})
	}
}

// MCP servers are a Run's attachment: a changed set is connected to the
// parked process, never a reason to start another one.
func TestClaudeResidentMCPSetChangeAttachesWithoutRespawn(t *testing.T) {
	claudeEnableResidency(t, 8)
	home := claudeNewResidentHome(t, nil)
	first := RunSpec{MCPServers: json.RawMessage(`{"mcpServers":{"a":{"type":"http","url":"http://127.0.0.1:1/a"}}}`)}
	if _, outcome := home.turn(t, "hello", first); outcome.Status != statusCompleted {
		t.Fatalf("first = %+v", outcome)
	}
	for _, servers := range []string{
		`{"mcpServers":{"b":{"type":"http","url":"http://127.0.0.1:1/b"}}}`,
		`{"mcpServers":{}}`,
	} {
		events, outcome := home.turn(t, "hello", RunSpec{ResumeID: claudeTestSession, MCPServers: json.RawMessage(servers)})
		if started := claudeTurnStarted(events); outcome.Status != statusCompleted || started == nil || !*started.ProcessReused {
			t.Fatalf("turn with %s = %+v started = %+v", servers, outcome, started)
		}
	}
	if pids := home.pids(t); len(pids) != 1 {
		t.Fatalf("pids = %v", pids)
	}
	if records := home.logs.matching("claude resident recycled"); len(records) != 0 {
		t.Fatalf("recycled = %+v", records)
	}
	sets, _ := os.ReadFile(filepath.Join(home.dir, "mcp"))
	if strings.Count(string(sets), "mcp_set_servers") != 2 {
		t.Fatalf("mcp_set_servers = %s", sets)
	}
}

func TestClaudeResidentMismatchLogNamesFieldsOnly(t *testing.T) {
	claudeEnableResidency(t, 8)
	home := claudeNewResidentHome(t, nil)
	home.turn(t, "hello", RunSpec{})
	home.profile.Env["EXTRA_SECRET"] = "value-that-must-not-leak"
	home.turn(t, "hello", RunSpec{AppendPrompt: "secret prompt", AgentArgs: []string{"--verbose-extra"}, AssignSessionID: "87654321-4321-4321-8321-210987654321"})
	records := home.logs.await(t, "claude resident recycled", 1)
	if got := records[0].attrs["mismatch"]; got != "args,env,initialize,create_session,session" {
		t.Fatalf("mismatch = %q", got)
	}
	for _, record := range home.logs.matching("") {
		for _, value := range record.attrs {
			if strings.Contains(value, "value-that-must-not-leak") || strings.Contains(value, "secret prompt") {
				t.Fatalf("log leaked a value: %+v", record)
			}
		}
	}
}

func TestClaudeResidentDoesNotParkUncleanTurns(t *testing.T) {
	claudeEnableResidency(t, 8)
	for _, test := range []struct {
		prompt string
		spec   RunSpec
	}{
		{"error", RunSpec{}},
		{"reason", RunSpec{}},
		{"async", RunSpec{}},
		{"hello", RunSpec{MCPServers: json.RawMessage(`{"mcpServers":{"s":{"type":"stdio","command":"x"}}}`)}},
	} {
		t.Run(test.prompt, func(t *testing.T) {
			home := claudeNewResidentHome(t, nil)
			_, outcome := home.turn(t, test.prompt, test.spec)
			if !outcome.ExitConfirmed {
				t.Fatalf("outcome = %+v", outcome)
			}
			claudeAssertGone(t, home.pids(t))
		})
	}
}

func TestClaudeResidentCancelledTurnsDoNotPark(t *testing.T) {
	claudeEnableResidency(t, 8)
	home := claudeNewResidentHome(t, nil)
	cancelTurn := func(spec RunSpec) Outcome {
		ctx, cancel := context.WithCancel(t.Context())
		backend, _ := Open("claude", home.profile)
		spec.ExposeTurnStarted = true
		run, err := backend.Start(ctx, "hang", claudeSpec(spec))
		if err != nil {
			t.Fatal(err)
		}
		<-run.Events
		cancel()
		_, outcome := claudeFinish(t, run, 10*time.Second)
		return outcome
	}
	if outcome := cancelTurn(RunSpec{}); outcome.Status != statusAborted {
		t.Fatalf("first = %+v", outcome)
	}
	claudeAssertGone(t, home.pids(t))
	home.turn(t, "hello", RunSpec{})
	if outcome := cancelTurn(RunSpec{ResumeID: claudeTestSession}); outcome.Status != statusAborted {
		t.Fatalf("reused = %+v", outcome)
	}
	pids := home.pids(t)
	claudeAssertGone(t, pids)
	events, _ := home.turn(t, "hello", RunSpec{ResumeID: claudeTestSession})
	if started := claudeTurnStarted(events); started == nil || *started.ProcessReused || len(home.pids(t)) != 3 {
		t.Fatalf("next turn did not spawn fresh: %+v %v", started, home.pids(t))
	}
}

func TestClaudeResidentForgetsDeadProcess(t *testing.T) {
	claudeEnableResidency(t, 8)
	home := claudeNewResidentHome(t, nil)
	home.turn(t, "die", RunSpec{})
	claudeAssertGone(t, home.pids(t))
	events, _ := home.turn(t, "hello", RunSpec{ResumeID: claudeTestSession})
	if started := claudeTurnStarted(events); started == nil || *started.ProcessReused {
		t.Fatal("a dead process was reused")
	}
	pids := home.pids(t)
	if !claudeAlive(pids[1]) {
		t.Fatal("clean turn did not park")
	}
	if count, err := StopAllParkedResidents(); count != 1 || err != nil {
		t.Fatalf("stop all = %d %v", count, err)
	}
	claudeAssertGone(t, pids[1:])
	claudeAwaitRemoved(t, filepath.Clean(home.root))
}

func claudeAwaitRemoved(t *testing.T, root string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, _, present := residentEntryOf(claudeResidents, root); !present {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("entry for %s stayed in the table", root)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestClaudeResidentCapAndStopFunctions(t *testing.T) {
	claudeEnableResidency(t, 2)
	var homes []*claudeResidentHome
	for i := range 3 {
		home := claudeNewResidentHome(t, nil)
		home.profile.ContextKey = fmt.Sprintf("context-%d", i)
		home.turn(t, "hello", RunSpec{})
		homes = append(homes, home)
	}
	claudeAssertGone(t, homes[0].pids(t))
	claudeAwaitRemoved(t, filepath.Clean(homes[0].root))
	if !claudeAlive(homes[1].pids(t)[0]) || !claudeAlive(homes[2].pids(t)[0]) {
		t.Fatal("the newest residents were stopped")
	}
	if count, err := StopParkedResidentsForContext("context-1"); count != 1 || err != nil {
		t.Fatalf("context stop = %d %v", count, err)
	}
	claudeAssertGone(t, homes[1].pids(t))
	if !claudeAlive(homes[2].pids(t)[0]) {
		t.Fatal("another Context's process was stopped")
	}
	if err := StopParkedClaudeResidentForCredentials(homes[2].root); err != nil {
		t.Fatal(err)
	}
	claudeAssertGone(t, homes[2].pids(t))
	events, _ := homes[2].turn(t, "hello", RunSpec{ResumeID: claudeTestSession})
	if started := claudeTurnStarted(events); started == nil || *started.ProcessReused {
		t.Fatal("turn after credential stop reused a process")
	}
	if count, err := StopParkedResidentsForContext(""); count != 0 || err != nil {
		t.Fatal("empty context key matched")
	}
	if count, err := StopParkedResidentsForAgent(""); count != 0 || err != nil {
		t.Fatal("empty agent matched")
	}
}

func TestClaudeResidentMCPFrontFailsClosedWhileParked(t *testing.T) {
	claudeEnableResidency(t, 8)
	var hits sync.Map
	targets := []*httptest.Server{}
	for i := range 2 {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Store(i, true) }))
		t.Cleanup(server.Close)
		targets = append(targets, server)
	}
	config := func(i int) json.RawMessage {
		return json.RawMessage(`{"mcpServers":{"tools":{"type":"http","url":"` + targets[i].URL + `/rpc"}}}`)
	}
	home := claudeNewResidentHome(t, nil)
	home.turn(t, "hello", RunSpec{MCPServers: config(0)})
	pid := home.pids(t)[0]
	data, _ := os.ReadFile(filepath.Join(home.dir, fmt.Sprintf("mcp-%d.json", pid)))
	if !strings.Contains(string(data), "/mcp/") || strings.Contains(string(data), targets[0].URL) {
		t.Fatalf("mcp config = %s", data)
	}
	var document struct {
		MCPServers map[string]struct {
			URL string `json:"url"`
		} `json:"mcpServers"`
	}
	_ = json.Unmarshal(data, &document)
	frontURL := document.MCPServers["tools"].URL
	post := func() int {
		response, err := http.Post(frontURL, "application/json", strings.NewReader("{}"))
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		return response.StatusCode
	}
	if status := post(); status != http.StatusServiceUnavailable {
		t.Fatalf("parked front = %d", status)
	}
	events, _ := home.turn(t, "hello", RunSpec{ResumeID: claudeTestSession, MCPServers: config(1)})
	if started := claudeTurnStarted(events); started == nil || !*started.ProcessReused {
		t.Fatal("URL-only MCP change was not reused")
	}
	if status := post(); status != http.StatusServiceUnavailable {
		t.Fatalf("front after second park = %d", status)
	}
	if _, hit := hits.Load(0); hit {
		t.Fatal("a finished Run's target was reached")
	}
}

func TestClaudeResidentRecycleOverlapWaitsForExit(t *testing.T) {
	claudeEnableResidency(t, 8)
	home := claudeNewResidentHome(t, map[string]string{"CLAUDE_FAKE_SLOW_TERM": "1"})
	home.turn(t, "hello", RunSpec{})
	home.turn(t, "hello", RunSpec{ResumeID: claudeTestSession, Model: "other"})
	read := func(name string) map[int]int64 {
		data, _ := os.ReadFile(filepath.Join(home.dir, name))
		out := map[int]int64{}
		for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
			var pid int
			var at int64
			_, _ = fmt.Sscan(line, &pid, &at)
			out[pid] = at
		}
		return out
	}
	pids := home.pids(t)
	starts, exits := read("starts"), read("exits")
	if len(pids) != 2 || exits[pids[0]] == 0 || starts[pids[1]] <= exits[pids[0]] {
		t.Fatalf("pids %v starts %v exits %v", pids, starts, exits)
	}
}

func TestClaudeResidentSteeredHoldParksAndIsReused(t *testing.T) {
	claudeEnableResidency(t, 8)
	home := claudeNewResidentHome(t, nil)
	run := claudeStart(t, home.profile, "hold", RunSpec{ExposeTurnStarted: true})
	started := <-run.Events
	ack, err := run.Steer(t.Context(), SteerRequest{ExpectedTurnID: started.TurnID, Input: "go"})
	if err != nil || ack.TurnID != started.TurnID {
		t.Fatalf("steer = %+v %v", ack, err)
	}
	if _, outcome := claudeFinish(t, run, 10*time.Second); outcome.Status != statusCompleted {
		t.Fatalf("steered = %+v", outcome)
	}
	events, _ := home.turn(t, "hello", RunSpec{ResumeID: claudeTestSession})
	if s := claudeTurnStarted(events); s == nil || !*s.ProcessReused {
		t.Fatal("steered turn did not park")
	}
}

func TestClaudeResidentParkFailureStillDelivers(t *testing.T) {
	claudeEnableResidency(t, 8)
	home := claudeNewResidentHome(t, nil)
	run := claudeStart(t, home.profile, "pause", RunSpec{})
	blocker := claudeStuckResident(t, filepath.Clean(home.root))
	_, outcome := claudeFinish(t, run, 10*time.Second)
	if outcome.Status != statusCompleted {
		t.Fatalf("outcome = %+v", outcome)
	}
	claudeAssertGone(t, home.pids(t))
	if owner, _, _ := residentEntryOf(claudeResidents, filepath.Clean(home.root)); owner != blocker {
		t.Fatal("the unconfirmable owner lost its slot")
	}
}

func TestClaudeResidentLogsStayWithTheirRun(t *testing.T) {
	claudeEnableResidency(t, 8)
	home := claudeNewResidentHome(t, nil)
	first := home.logs
	home.turn(t, "hello", RunSpec{})
	second := &claudeLogCapture{}
	home.profile.Logger = slog.New(second)
	home.turn(t, "stderr", RunSpec{ResumeID: claudeTestSession})
	for _, logs := range []*claudeLogCapture{first, second} {
		logs.await(t, timingClaudeTurnResult, 1)
		time.Sleep(50 * time.Millisecond)
		if len(logs.matching(timingClaudeTurnResult)) != 1 || len(logs.matching("claude finished")) != 1 || len(logs.matching("claude resident parked")) != 1 {
			t.Fatalf("records = %+v", logs.records)
		}
	}
	second.await(t, claudeStderrPrefix+"stderr turn 2", 1)
	if len(first.matching(claudeStderrPrefix)) != 0 {
		t.Fatal("turn 2 stderr reached Run 1's logger")
	}
}

func TestClaudeTurnStartedSentAt(t *testing.T) {
	claudeEnableResidency(t, 8)
	home := claudeNewResidentHome(t, nil)
	for i, prompt := range []string{"late assist", "late assist"} {
		spec := RunSpec{}
		if i == 1 {
			spec.ResumeID = claudeTestSession
		}
		before := time.Now()
		events, _ := home.turn(t, prompt, spec)
		after := time.Now()
		started := claudeTurnStarted(events)
		if started == nil || started.SentAt.Before(before) || after.Sub(started.SentAt) < 900*time.Millisecond {
			t.Fatalf("turn %d SentAt = %+v window %v..%v", i, started, before, after)
		}
		for _, event := range events {
			if (event.Kind == EventText || event.Kind == EventToolCall) && (event.ObservedAt.Before(before) || event.ObservedAt.After(after)) {
				t.Fatalf("ObservedAt outside the turn: %+v", event)
			}
		}
	}
	events, _ := home.turn(t, "stamp", RunSpec{ResumeID: claudeTestSession})
	want, _ := time.Parse(time.RFC3339Nano, "2026-01-02T03:04:05.678Z")
	if started := claudeTurnStarted(events); started == nil || !started.SentAt.Equal(want) {
		t.Fatalf("stamped SentAt = %+v", started)
	}
}

// claudeStuckResident inserts an entry whose tree never confirms and whose
// extra kill rounds are spent.
func claudeStuckResident(t *testing.T, root string) *claudeProcess {
	t.Helper()
	return claudeStuckResidentIn(t, root, Profile{})
}

func claudeStuckResidentIn(t *testing.T, root string, scope Profile) *claudeProcess {
	t.Helper()
	group := &claudeFakeGroup{killsBeforeEmpty: -1}
	p := claudeNewProcess(group, claudeQuietLogger())
	p.shape = &claudeShape{}
	p.res.bind(root, scope)
	p.stopRounds = claudeExtraKillRounds
	claudeResidents.hold(p)
	t.Cleanup(func() { claudeResidents.forget(p) })
	return p
}

func TestClaudeUnconfirmedTrees(t *testing.T) {
	claudeEnableResidency(t, 8)
	previous := claudeKillWait
	claudeKillWait = 50 * time.Millisecond
	defer func() { claudeKillWait = previous }()

	fresh := claudeNewProcess(&claudeFakeGroup{killsBeforeEmpty: 1}, claudeQuietLogger())
	fresh.res.bind("/claude-test/fresh", Profile{})
	if !fresh.stop() {
		t.Fatal("first SIGKILL round did not confirm")
	}

	root := "/claude-test/stuck"
	stuck := claudeStuckResident(t, root)
	want := claudeMismatch(&claudeShape{}, RunSpec{})
	if _, _, err := claudeResidents.take(root, want, claudeQuietLogger(), nil); !errors.Is(err, errResidentRecycleUnconfirmed) {
		t.Fatalf("take ignored an unconfirmed tree: %v", err)
	}
	if err := claudeResidents.stopKey(root, claudeQuietLogger(), nil); !errors.Is(err, errResidentRecycleUnconfirmed) {
		t.Fatalf("spawn-time stop ignored an unconfirmed tree: %v", err)
	}
	if still, _, _ := residentEntryOf(claudeResidents, root); still != stuck {
		t.Fatal("unconfirmed entry left the table")
	}
	stuck.group.(*claudeFakeGroup).setEmptyAfter(0)
	if proc, _, err := claudeResidents.take(root, want, claudeQuietLogger(), nil); proc != nil || err != nil {
		t.Fatalf("take after exit = %v %v", proc, err)
	}
	if err := claudeResidents.stopKey(root, claudeQuietLogger(), nil); err != nil {
		t.Fatal(err)
	}

	reusedRoot := "/claude-test/reused"
	group := &claudeFakeGroup{killsBeforeEmpty: -1}
	reused := claudeNewProcess(group, claudeQuietLogger())
	reused.shape = &claudeShape{}
	reused.res.bind(reusedRoot, Profile{})
	reused.stopRounds = claudeExtraKillRounds
	claudeSettle(reused, false)
	if _, _, err := claudeResidents.take(reusedRoot, want, claudeQuietLogger(), nil); err == nil {
		t.Fatal("take ignored a held reused process")
	}
	claudeSettle(reused, true)
	if _, _, present := residentEntryOf(claudeResidents, reusedRoot); present {
		t.Fatal("confirmed settle kept the entry")
	}
}
