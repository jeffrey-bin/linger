package localtools

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/mcpproxy"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
)

// laneJournal returns the action journal of a browser lane or seat.
func laneJournal(t *testing.T, m *Manager, lane string) *actionJournal {
	t.Helper()
	journal, err := m.namedJournal(lane)
	if err != nil {
		t.Fatal(err)
	}
	return journal
}

// laneBlocked reports whether a lane's journal holds an unknown action.
func laneBlocked(t *testing.T, m *Manager, lane string) bool {
	t.Helper()
	return laneJournal(t, m, lane).blocked()
}

func laneManager(t *testing.T, directory string) *Manager {
	t.Helper()
	journal, err := openJournal(filepath.Join(directory, "action.json"))
	if err != nil {
		t.Fatal(err)
	}
	m := &Manager{journal: journal, operations: map[*operation]bool{}, browsers: map[string]*nativeBrowser{}, chromeProfiles: map[string]chan struct{}{}}
	if err := m.openBrowserJournals(); err != nil {
		t.Fatal(err)
	}
	return m
}

// leaveUnknown records an action of unknown outcome in a journal.
func leaveUnknown(t *testing.T, journal *actionJournal) {
	t.Helper()
	receipt, err := journal.begin(t.Context(), actionIdentity{AgentID: "a", OperationID: "earlier", Session: "s"})
	if err != nil {
		t.Fatal(err)
	}
	if err := receipt.finish(false); err != nil {
		t.Fatal(err)
	}
}

// agentBrowserOp is a task of agent whose running Agent Chrome answers each
// browser call after 250 ms, through the fixture's delayed click.
func agentBrowserOp(t *testing.T, m *Manager, agent string) *operation {
	t.Helper()
	ctx, cancel := context.WithCancel(t.Context())
	t.Cleanup(cancel)
	op := &operation{manager: m, spec: provider.OperationSpec{AgentID: agent, WorkingDirectory: t.TempDir()}, identity: mcpproxy.OperationIdentity{OperationID: agent + "-" + t.Name()}, directory: t.TempDir(), ctx: ctx, cancel: cancel, label: "linger-" + agent}
	op.nativeBrowser = &nativeBrowser{done: make(chan struct{})}
	var err error
	if op.nativeProxy, err = openNativeCDPProxy("http://127.0.0.1:1"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = op.nativeProxy.close() })
	op.browser = fixtureClient(t, "delay", "")
	return op
}

func browserClick(op *operation) func() error {
	return func() error {
		_, err := op.nativeBrowserCall(op.ctx, "click", json.RawMessage(`{}`))
		return err
	}
}

// Browser calls of two Agents run together; tasks of one Agent take turns.
func TestBrowserCallsOfTwoAgentsRunTogetherAndOneAgentsTasksTakeTurns(t *testing.T) {
	m := laneManager(t, t.TempDir())
	b, again := agentBrowserOp(t, m, "b"), agentBrowserOp(t, m, "a")
	// Hold Agent a's lane as a call of its in flight does.
	_, release, err := m.holdLane(t.Context(), browserLane("a"))
	if err != nil {
		t.Fatal(err)
	}
	if err := browserClick(b)(); err != nil {
		t.Fatalf("Agent b's browser call failed while Agent a's ran: %v", err)
	}
	done := make(chan error, 1)
	go func() { done <- browserClick(again)() }()
	select {
	case err := <-done:
		t.Fatalf("two tasks of one Agent drove its browser at once: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	release()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

// focusBusy reports whether a hold of the gate waits: it gives up after a
// short wait and then returns the not-sent error.
func focusBusy(t *testing.T, m *Manager, exclusive bool) bool {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 50*time.Millisecond)
	defer cancel()
	_, release, err := m.holdFocus(ctx, exclusive)
	if err == nil {
		release()
		return false
	}
	if !errors.Is(err, errNotSent) || !strings.Contains(err.Error(), "COMPUTER_BUSY") {
		t.Fatalf("a cancelled wait for the gate: %v", err)
	}
	return true
}

// A desktop input that needs the front window waits for browser calls in
// flight and holds back new ones; the call sends nothing until then.
func TestFocusedDesktopInputAndBrowserCallsTakeTurns(t *testing.T) {
	m := laneManager(t, t.TempDir())
	_, releaseBrowser, err := m.holdFocus(t.Context(), false)
	if err != nil {
		t.Fatal(err)
	}
	if focusBusy(t, m, false) {
		t.Fatal("browser calls of two Agents queued behind each other")
	}
	if !focusBusy(t, m, true) {
		t.Fatal("a focused desktop input ran beside a browser call")
	}
	type hold struct {
		ctx     context.Context
		release func()
	}
	held := make(chan hold, 1)
	go func() {
		ctx, release, err := m.holdFocus(t.Context(), true)
		if err != nil {
			t.Error(err)
			release = func() {}
		}
		held <- hold{ctx, release}
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		m.focus.mu.Lock()
		waiting := m.focus.waiting
		m.focus.mu.Unlock()
		if waiting == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the desktop input never waited")
		}
		time.Sleep(time.Millisecond)
	}
	// A browser call that arrives while that input waits runs after it.
	if !focusBusy(t, m, false) {
		t.Fatal("a browser call overtook a waiting desktop input")
	}
	select {
	case <-held:
		t.Fatal("a focused desktop input ran beside a browser call")
	default:
	}
	releaseBrowser()
	input := <-held
	if !holdsFocus(input.ctx) {
		t.Fatal("exclusive hold not marked")
	}
	if _, _, err := m.holdFocus(input.ctx, true); err != nil {
		t.Fatalf("a nested input did not reuse the hold: %v", err)
	}
	done := make(chan error, 1)
	go func() { done <- browserClick(agentBrowserOp(t, m, "a"))() }()
	select {
	case err := <-done:
		t.Fatalf("a browser call ran during focused desktop input: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	input.release()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestCancelledFocusWaitIsNotSentAndFreesWaiters(t *testing.T) {
	m := laneManager(t, t.TempDir())
	_, release, err := m.holdFocus(t.Context(), false)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 50*time.Millisecond)
	defer cancel()
	if _, _, err := m.holdFocus(ctx, true); !errors.Is(err, errNotSent) || !strings.Contains(err.Error(), "COMPUTER_BUSY") {
		t.Fatalf("cancelled exclusive wait: %v", err)
	}
	// The abandoned writer no longer holds back browser calls.
	_, again, err := m.holdFocus(t.Context(), false)
	if err != nil {
		t.Fatal(err)
	}
	again()
	release()
}

// An unknown browser action blocks its Agent's browser and desktop input that
// needs the front window, also after a restart, and nothing else.
func TestUnknownBrowserActionBlocksItsAgentAndFocusedInput(t *testing.T) {
	directory := t.TempDir()
	leaveUnknown(t, laneJournal(t, laneManager(t, directory), browserLane("a")))
	m := laneManager(t, directory)
	if _, _, err := m.holdFocusedInput(t.Context()); !errors.Is(err, errNotSent) || !strings.Contains(err.Error(), "COMPUTER_ACTION_UNKNOWN") {
		t.Fatalf("focused desktop input ran beside an unknown browser action: %v", err)
	}
	if _, release, err := m.holdFocus(t.Context(), true); err != nil {
		t.Fatalf("the refused input kept the gate: %v", err)
	} else {
		release()
	}
	a, b := agentBrowserOp(t, m, "a"), agentBrowserOp(t, m, "b")
	if err := browserClick(a)(); err == nil || !strings.Contains(err.Error(), "COMPUTER_ACTION_UNKNOWN") {
		t.Fatalf("the Agent's unknown action admitted its next browser call: %v", err)
	}
	if err := browserClick(b)(); err != nil {
		t.Fatalf("another Agent's browser waited for it: %v", err)
	}
	desktop, err := m.journal.begin(t.Context(), actionIdentity{AgentID: "c", OperationID: "desktop", Session: "s", Background: true})
	if err != nil {
		t.Fatalf("background desktop input waited for a browser action: %v", err)
	}
	_ = desktop.finish(true)
}

// A task that holds one unknown browser action sends no other browser call
// until it ends, even to a browser whose journal is another one: an unknown
// action in the owner's Chrome stops its later Agent Chrome calls.
func TestTaskWithUnknownBrowserActionSendsNoOther(t *testing.T) {
	m := laneManager(t, t.TempDir())
	op := agentBrowserOp(t, m, "a")
	journal, err := m.namedJournal(chromeProfileJournal("Default"))
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := journal.begin(t.Context(), actionIdentity{AgentID: "a", OperationID: "earlier", Session: "s"})
	if err != nil {
		t.Fatal(err)
	}
	op.markBrowserUnknown(receipt, true)
	if err := browserClick(op)(); !errors.Is(err, errNotSent) || !strings.Contains(err.Error(), "COMPUTER_ACTION_UNKNOWN") {
		t.Fatalf("a second unknown action could replace the first: %v", err)
	}
	_ = receipt.finish(true)
}

func TestUnknownDesktopInputBlocksBrowsersOnlyWhenItNeededFocus(t *testing.T) {
	for _, tc := range []struct {
		name    string
		record  string
		blocked bool
	}{
		{"background", `{"version":1,"active":{"nonce":"n","agent_id":"x","operation_id":"o","session":"s","background":true}}`, false},
		{"focused", `{"version":1,"active":{"nonce":"n","agent_id":"x","operation_id":"o","session":"s"}}`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			directory := t.TempDir()
			// A record without the background field may be a browser
			// action, so it blocks browsers too.
			if err := os.WriteFile(filepath.Join(directory, "action.json"), []byte(tc.record), 0o600); err != nil {
				t.Fatal(err)
			}
			m := laneManager(t, directory)
			err := browserClick(agentBrowserOp(t, m, "a"))()
			if tc.blocked != (err != nil) || tc.blocked && (!errors.Is(err, errNotSent) || !strings.Contains(err.Error(), "COMPUTER_ACTION_UNKNOWN")) {
				t.Fatalf("browser call with a %s unknown desktop input: %v", tc.name, err)
			}
			if !m.journal.blocked() {
				t.Fatal("the unknown desktop input was dropped")
			}
		})
	}
}

func TestLaneRecordsSurviveRestartPerLane(t *testing.T) {
	directory := t.TempDir()
	m := laneManager(t, directory)
	for _, lane := range []string{browserLane("a"), chromeProfileJournal("Default")} {
		journal, err := m.namedJournal(lane)
		if err != nil {
			t.Fatal(err)
		}
		receipt, err := journal.begin(t.Context(), actionIdentity{AgentID: "a", OperationID: "op", Session: "s"})
		if err != nil {
			t.Fatal(err)
		}
		if err := receipt.finish(false); err != nil {
			t.Fatal(err)
		}
	}
	restarted := laneManager(t, directory)
	if !laneBlocked(t, restarted, browserLane("a")) || !laneBlocked(t, restarted, chromeProfileJournal("Default")) {
		t.Fatal("a restart cleared an unknown browser action")
	}
	if laneBlocked(t, restarted, browserLane("b")) || restarted.journal.blocked() {
		t.Fatal("an unknown browser action blocked another lane after a restart")
	}
	// No task of this Daemon settles the record, so the refusal names it.
	if _, _, err := restarted.holdFocusedInput(t.Context()); err == nil || !strings.Contains(err.Error(), "before the Daemon restarted") || !strings.Contains(err.Error(), browserJournalPrefix) {
		t.Fatalf("focused desktop input after a restart left browser records: %v", err)
	}
	// A settled record leaves no file behind.
	journal, _ := restarted.namedJournal(browserLane("b"))
	receipt, err := journal.begin(t.Context(), actionIdentity{AgentID: "b", OperationID: "op", Session: "s"})
	if err != nil {
		t.Fatal(err)
	}
	if err := receipt.finish(true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(journal.path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("settled record kept its file: %v", err)
	}
}

// A browser call of one Agent and Cua input, which holds only the desktop
// lane and the focus gate, never wait on each other's locks in a cycle.
func TestLanesAndFocusUnderLoad(t *testing.T) {
	m := laneManager(t, t.TempDir())
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	// Each side counts itself in before it looks at the other, so a desktop
	// input and a browser call holding the gate at once see each other.
	var desktop, browsers atomic.Int32
	var wg sync.WaitGroup
	for worker := range 16 {
		wg.Go(func() {
			for range 200 {
				var held context.Context
				var releases []func()
				var err error
				if worker%4 == 0 {
					var release func()
					if held, release, err = m.holdLane(ctx, desktopLane); err == nil {
						releases = append(releases, release)
						held, release, err = m.holdFocus(held, true)
						releases = append(releases, release)
					}
				} else {
					var release func()
					if held, release, err = m.holdLane(ctx, browserLane(string(rune('a'+worker%3)))); err == nil {
						releases = append(releases, release)
						held, release, err = m.holdFocus(held, false)
						releases = append(releases, release)
					}
				}
				if err == nil {
					if holdsFocus(held) {
						if desktop.Add(1) > 1 || browsers.Load() > 0 {
							t.Error("a focused desktop input ran beside another holder of the gate")
						}
						desktop.Add(-1)
					} else {
						browsers.Add(1)
						if desktop.Load() > 0 {
							t.Error("a browser call ran beside a focused desktop input")
						}
						browsers.Add(-1)
					}
				}
				for i := len(releases) - 1; i >= 0; i-- {
					if releases[i] != nil {
						releases[i]()
					}
				}
				if err != nil {
					t.Errorf("worker %d: %v", worker, err)
					return
				}
			}
		})
	}
	wg.Wait()
}

func TestCuaInputNeedsFocusUnlessBackgroundToAnotherApp(t *testing.T) {
	previous := processCommand
	t.Cleanup(func() { processCommand = previous })
	processCommand = func(_ context.Context, pid int) (string, error) {
		if pid == 7 {
			return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n", nil
		}
		return "/System/Applications/TextEdit.app/Contents/MacOS/TextEdit\n", nil
	}
	m := laneManager(t, t.TempDir())
	m.agentChromePID = 9
	c := &cuaSession{op: &operation{manager: m}}
	c.op.reads.observe(json.RawMessage(`{"content":[{"type":"text","text":"window_id=3 pid=42\n- [5] AXButton Save"}],"structuredContent":{"snapshot_id":"s1"}}`))
	for _, tc := range []struct {
		name, args string
		darwin     bool
	}{
		{"get_window_state", `{"pid":42}`, false},
		{"recognize_text", `{"pid":42}`, false},
		{"recognize_text", `{"pid":42,"pages":3}`, true},
		{"click", `{"pid":42,"window_id":3,"element_token":"s1:5"}`, false},
		{"double_click", `{"element_token":"s1:5"}`, true},
		{"scroll", `{"pid":9}`, false},
		{"click", `{"pid":7}`, true},
		{"click", `{"pid":42,"delivery_mode":"foreground"}`, true},
		{"click", `{"pid":42,"modifier":["cmd"]}`, true},
		{"click", `{"element_token":"unknown"}`, true},
		{"type_text", `{"pid":42,"text":"x"}`, true},
		{"run_actions", `{"actions":[]}`, true},
		{"run_script", `{"script":"return 1"}`, true},
		{"launch_app", `{}`, true},
		{"clipboard_write", `{"text":"x"}`, true},
	} {
		want := !cuaReadTools[tc.name]
		if runtime.GOOS == "darwin" {
			want = tc.darwin
		}
		if got := c.needsFocus(t.Context(), tc.name, json.RawMessage(tc.args)); got != want {
			t.Errorf("%s %s: needsFocus=%v, want %v", tc.name, tc.args, got, want)
		}
	}
}

// chromeHome is a user's home whose Chrome profile "Default" has the
// Playwright Extension installed in each version given.
func chromeHome(t *testing.T, versions ...string) []string {
	t.Helper()
	home := t.TempDir()
	data := filepath.Join(home, "Library", "Application Support", "Google", "Chrome")
	env := []string{"HOME=" + home}
	if runtime.GOOS == "windows" {
		data = filepath.Join(home, "Google", "Chrome", "User Data")
		env = []string{"LOCALAPPDATA=" + home}
	}
	for _, version := range versions {
		if err := os.MkdirAll(filepath.Join(data, "Default", "Extensions", playwrightExtensionID, version), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	return env
}

func TestExtensionThatKeepsManyClientsGivesEachAgentItsOwnSeat(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "windows" {
		t.Skip("the everyday Chrome is connected on macOS and Windows")
	}
	for _, test := range []struct {
		versions []string
		many     bool
	}{
		{[]string{"0.5.0_0"}, true},
		{[]string{"0.10.1_0"}, true},
		{[]string{"1.0_0"}, true},
		{[]string{"0.4.9_0"}, false},
		{[]string{"0.5.0_0", "0.4.2_0"}, false},
		{[]string{"0.5.x_0"}, false},
		{nil, false},
	} {
		env := chromeHome(t, test.versions...)
		if got := extensionTakesManyClients(env, "Default"); got != test.many {
			t.Errorf("versions %v: many clients = %v, want %v", test.versions, got, test.many)
		}
	}
	previous := profileWait
	profileWait = 300 * time.Millisecond
	defer func() { profileWait = previous }()
	hold := func(m *Manager, agent string) (*operation, string, error) {
		op := agentBrowserOp(t, m, agent)
		seat, err := op.holdUserChromeProfile(t.Context(), "Default")
		return op, seat, err
	}
	m := laneManager(t, t.TempDir())
	m.env = chromeHome(t, "0.5.0_0")
	a, seatA, err := hold(m, "a")
	if err != nil {
		t.Fatal(err)
	}
	if _, seatB, err := hold(m, "b"); err != nil || seatB == seatA {
		t.Fatalf("another Agent waited for the profile: seat %q err=%v", seatB, err)
	}
	if _, _, err := hold(m, "a"); !errors.Is(err, errBrowserBusy) {
		t.Fatalf("a second task of the Agent shared its tabs: %v", err)
	}
	a.releaseChromeProfile()
	if _, _, err := hold(m, "a"); err != nil {
		t.Fatalf("the freed seat stayed busy: %v", err)
	}
	// An extension that keeps one client admits one task to the profile.
	m = laneManager(t, t.TempDir())
	m.env = chromeHome(t, "0.4.9_0")
	if _, seat, err := hold(m, "a"); err != nil || seat != "Default" {
		t.Fatalf("seat %q err=%v, want the whole profile", seat, err)
	}
	if _, _, err := hold(m, "b"); !errors.Is(err, errBrowserBusy) {
		t.Fatalf("two Agents shared a profile whose extension keeps one client: %v", err)
	}
}

// extensionVersions installs the Playwright Extension versions in the
// "Default" profile of the everyday Chrome that chromeEnv names.
func extensionVersions(t *testing.T, chromeEnv string, versions ...string) {
	t.Helper()
	_, root, _ := strings.Cut(chromeEnv, "=")
	data := filepath.Join(root, "Library", "Application Support", "Google", "Chrome")
	if runtime.GOOS == "windows" {
		data = filepath.Join(root, "Google", "Chrome", "User Data")
	}
	for _, version := range versions {
		if err := os.MkdirAll(filepath.Join(data, "Default", "Extensions", playwrightExtensionID, version), 0o700); err != nil {
			t.Fatal(err)
		}
	}
}

// With an extension that keeps many clients, two Agents keep their own
// connections to one Chrome profile, and an unknown action blocks only the
// seat it was sent to.
func TestEverydayChromeSeatsKeepAgentsApart(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(t.TempDir(), "launches")
	m := laneManager(t, t.TempDir())
	m.options = Options{StateDirectory: t.TempDir(), NodePath: executable, PlaywrightEntry: fixtureEntry(t)}
	chromeEnv := fakeEverydayChrome(t)
	extensionVersions(t, chromeEnv, "0.5.0_0")
	m.env = []string{chromeEnv, "LINGER_LOCAL_TOOL_FIXTURE=count-launch", "LINGER_LOCAL_TOOL_MARKER=" + marker}
	workspace := t.TempDir()
	chrome := &browserConnection{Profile: "Default", Token: "token-a", State: browserConnected}
	task := func(agent string) error {
		t.Helper()
		_, cancel := context.WithCancel(t.Context())
		op := &operation{manager: m, label: "linger-test", directory: t.TempDir(), cancel: cancel, userChrome: chrome,
			spec: provider.OperationSpec{TenantID: "t", OwnerActorID: "u", AgentID: agent, WorkingDirectory: workspace}}
		_, callErr := op.nativeBrowserCall(t.Context(), "browser_snapshot", json.RawMessage(`{}`))
		if err := op.close(); err != nil {
			t.Fatal(err)
		}
		return callErr
	}
	for _, agent := range []string{"a", "b"} {
		if err := task(agent); err != nil {
			t.Fatal(err)
		}
	}
	m.mu.Lock()
	idle := len(m.userChromeSessions)
	m.mu.Unlock()
	if idle != 2 {
		t.Fatalf("%d idle connections, want each Agent's kept", idle)
	}
	leaveUnknown(t, laneJournal(t, m, chromeProfileJournal("Default\x00a")))
	if err := task("a"); err == nil || !strings.Contains(err.Error(), "COMPUTER_ACTION_UNKNOWN") {
		t.Fatalf("the seat with an unknown action took a call: %v", err)
	}
	if err := task("b"); err != nil {
		t.Fatalf("another Agent's seat was blocked: %v", err)
	}
	// A record left on the whole profile, before the extension kept many
	// clients, still guards every seat of that profile.
	whole := laneJournal(t, m, chromeProfileJournal("Default"))
	leaveUnknown(t, whole)
	if err := task("b"); err == nil || !strings.Contains(err.Error(), "COMPUTER_ACTION_UNKNOWN") || !strings.Contains(err.Error(), whole.path) {
		t.Fatalf("a seat ran beside an unknown action on its whole profile: %v", err)
	}
	if err := m.closeUserChrome(); err != nil {
		t.Fatal(err)
	}
}

// Verifying a token opens one more client, which an extension that keeps
// many clients accepts beside a running task, even one that took the whole
// profile before the extension updated.
func TestBrowserConfigureBesideATaskWhenTheExtensionKeepsManyClients(t *testing.T) {
	m := newConnectionManager(t)
	chromeEnv := fakeEverydayChrome(t)
	extensionVersions(t, chromeEnv, "0.5.0_0")
	m.env = []string{chromeEnv}
	release, err := m.acquireChromeProfile(t.Context(), "Default")
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	_, err = m.BrowserConnection(t.Context(), "tenant", "owner", "configure", "Default", strings.Repeat("A", 43))
	var typed *BrowserCommandError
	if errors.As(err, &typed) && typed.Code == "BROWSER_BUSY" {
		t.Fatalf("configure waited for a task on another seat: %v", err)
	}
}

// A Cua input that needs the front window waits for browser calls in flight;
// a background click to another app runs beside them.
func TestCuaCallTakesTheFocusGateItNeeds(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("background input exists on macOS")
	}
	previous := processCommand
	t.Cleanup(func() { processCommand = previous })
	processCommand = func(context.Context, int) (string, error) {
		return "/System/Applications/TextEdit.app/Contents/MacOS/TextEdit", nil
	}
	c := cuaFixtureSession(t, "window-view", filepath.Join(t.TempDir(), "calls.jsonl"))
	m := c.op.manager
	_, releaseBrowser, err := m.holdBrowserFocus(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = c.call(t.Context(), "click", json.RawMessage(`{"pid":42,"window_id":7,"x":5,"y":5}`))
	}()
	select {
	case <-done:
	// A blocked click never returns; the long limit only absorbs a slow,
	// loaded test machine, where one fixture click takes over a second.
	case <-time.After(30 * time.Second):
		t.Fatal("a background click waited for a browser call")
	}
	done = make(chan struct{})
	go func() {
		defer close(done)
		_, _ = c.call(t.Context(), "press_key", json.RawMessage(`{"pid":42,"window_id":7,"key":"a"}`))
	}()
	select {
	case <-done:
		t.Fatal("a key press ran beside a browser call")
	case <-time.After(300 * time.Millisecond):
	}
	releaseBrowser()
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("the key press never ran after the browser call")
	}
	if err := c.drain(); err != nil {
		t.Fatal(err)
	}
}

// The screenshot that evidence takes drives the page as a browser call does,
// so it waits its turn in the Agent's browser lane and at the focus gate.
func TestBrowserScreenshotTakesTurnsLikeABrowserCall(t *testing.T) {
	m := laneManager(t, t.TempDir())
	op := agentBrowserOp(t, m, "a")
	holds := []struct {
		name string
		hold func(context.Context) (context.Context, func(), error)
	}{
		{"the task's browser calls", func(ctx context.Context) (context.Context, func(), error) {
			release, err := op.holdBrowserCalls(ctx)
			return ctx, release, err
		}},
		{"the Agent's browser lane", func(ctx context.Context) (context.Context, func(), error) {
			return m.holdLane(ctx, browserLane("a"))
		}},
		{"focused desktop input", func(ctx context.Context) (context.Context, func(), error) { return m.holdFocus(ctx, true) }},
	}
	for _, held := range holds {
		_, release, err := held.hold(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		done := make(chan struct{})
		go func() { op.browserScreenshot(op.ctx); close(done) }()
		select {
		case <-done:
			t.Fatalf("screenshot ran while %s held it back", held.name)
		case <-time.After(100 * time.Millisecond):
		}
		release()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatalf("screenshot did not run once %s let go", held.name)
		}
	}
}

// A Cua input whose outcome is unknown records whether it needed the front
// window, which decides whether it blocks browser calls.
func TestUnknownCuaInputRecordsWhetherItNeededFocus(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("background input exists on macOS")
	}
	previous := processCommand
	t.Cleanup(func() { processCommand = previous })
	processCommand = func(context.Context, int) (string, error) {
		return "/System/Applications/TextEdit.app/Contents/MacOS/TextEdit", nil
	}
	for _, input := range []struct {
		name, args  string
		blocksFocus bool
	}{
		{"background click", `{"pid":42,"window_id":7,"x":5,"y":5}`, false},
		{"foreground click", `{"pid":42,"window_id":9,"x":5,"y":5,"delivery_mode":"foreground"}`, true},
	} {
		marker := filepath.Join(t.TempDir(), "submitted")
		c := cuaFixtureSession(t, "delay", marker)
		ctx, cancel := context.WithCancel(t.Context())
		done := make(chan error, 1)
		go func() { _, err := c.call(ctx, "click", json.RawMessage(input.args)); done <- err }()
		for deadline := time.Now().Add(30 * time.Second); ; time.Sleep(time.Millisecond) {
			if _, err := os.Stat(marker); err == nil {
				break
			}
			if time.Now().After(deadline) {
				cancel()
				t.Fatalf("%s was not sent: %v", input.name, <-done)
			}
		}
		cancel()
		if err := <-done; !errors.Is(err, errOutcomeUnknown) {
			t.Fatalf("%s: %v, want an unknown outcome", input.name, err)
		}
		journal := c.op.manager.journal
		if !journal.blocked() || journal.blocksFocus() != input.blocksFocus {
			t.Fatalf("%s: blocked %v, blocks browser calls %v", input.name, journal.blocked(), journal.blocksFocus())
		}
		if err := c.drain(); err != nil {
			t.Fatal(err)
		}
	}
}
