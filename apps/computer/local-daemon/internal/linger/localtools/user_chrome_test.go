package localtools

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/mcpproxy"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
)

func TestUserChromeBrowserUsesExtensionAndKeepsTokenInEnvironment(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	chromeEnv := fakeEverydayChrome(t)
	marker := filepath.Join(t.TempDir(), "launch.json")
	m := &Manager{options: Options{NodePath: executable, PlaywrightEntry: "/bundle/playwright-mcp/cli.js"},
		env: []string{chromeEnv, "LINGER_LOCAL_TOOL_FIXTURE=record-launch", "LINGER_LOCAL_TOOL_MARKER=" + marker}}
	op := &operation{manager: m, spec: provider.OperationSpec{WorkingDirectory: t.TempDir()}, directory: t.TempDir(), cancel: func() {}}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	client, err := op.startUserChromeBrowser(ctx, &browserConnection{Token: "secret-extension-token", Profile: "Profile 1"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.close(); op.releaseDirectories() })
	var launch struct {
		Args  []string
		Token string
	}
	encoded, err := os.ReadFile(marker)
	if err != nil || json.Unmarshal(encoded, &launch) != nil {
		t.Fatalf("launch was not recorded: %v", err)
	}
	config := filepath.Join(op.directory, "browser-user-chrome.json")
	if !strings.HasPrefix(strings.Join(launch.Args, "|"), "/bundle/playwright-mcp/cli.js|--config|"+config+"|--extension|--profile-dir-name|Profile 1|--executable-path|"+chromeExecutable(m.env)) {
		t.Fatalf("argv=%q", launch.Args)
	}
	if launch.Token != "secret-extension-token" {
		t.Fatal("the extension token did not reach the Playwright environment")
	}
	written, err := os.ReadFile(config)
	if err != nil || strings.Contains(string(written), "secret-extension-token") || strings.Contains(string(written), "cdpEndpoint") {
		t.Fatalf("user Chrome config must hold neither the token nor a CDP endpoint: %s %v", written, err)
	}
}

func newConnectionManager(t *testing.T) *Manager {
	t.Helper()
	journal, err := openJournal(filepath.Join(t.TempDir(), "action.json"))
	if err != nil {
		t.Fatal(err)
	}
	return &Manager{options: Options{StateDirectory: t.TempDir()}, journal: journal, operations: map[*operation]bool{}, chromeProfiles: map[string]chan struct{}{}}
}

func TestBrowserConnectionIsPrivatePerOwnerAndNeverReported(t *testing.T) {
	m := newConnectionManager(t)
	token := strings.Repeat("A", 43)
	connection := &browserConnection{TenantID: "tenant", OwnerActorID: "owner", Profile: "Default", Token: token, State: browserConnected, ConfiguredAt: time.Now().UTC()}
	if err := m.storeBrowserConnection(connection); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(m.browserConnectionPath("tenant", "owner"))
		if err != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("connection record is not owner-only: %v %v", info.Mode(), err)
		}
	}
	status, err := m.BrowserConnection(t.Context(), "tenant", "owner", "status", "", "")
	if err != nil || status.Mode != "user_chrome" || status.State != browserConnected || status.Profile != "Default" {
		t.Fatalf("status=%+v err=%v", status, err)
	}
	encoded, _ := json.Marshal(status)
	if strings.Contains(string(encoded), token) {
		t.Fatal("status exposed the extension token")
	}
	// Another owner of the same Computer keeps the Agent profile.
	other, err := m.BrowserConnection(t.Context(), "tenant", "other-owner", "status", "", "")
	if err != nil || other.Mode != "isolated" {
		t.Fatalf("another owner inherited the connection: %+v %v", other, err)
	}
	m.markBrowserConnection(connection, browserTokenInvalid, "rejected")
	if status, _ := m.BrowserConnection(t.Context(), "tenant", "owner", "status", "", ""); status.State != browserTokenInvalid {
		t.Fatalf("task-time rejection was not recorded: %+v", status)
	}
	if status, err := m.BrowserConnection(t.Context(), "tenant", "owner", "disconnect", "", ""); err != nil || status.Mode != "isolated" {
		t.Fatalf("disconnect: %+v %v", status, err)
	}
	if _, err := os.Stat(m.browserConnectionPath("tenant", "owner")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("disconnect left the credential on disk")
	}
}

func TestBrowserConnectionRejectsMalformedTokensWithoutStoring(t *testing.T) {
	m := newConnectionManager(t)
	for _, token := range []string{"", "short", "PLAYWRIGHT_MCP_EXTENSION_TOKEN=" + strings.Repeat("A", 43), "$(touch /tmp/x)" + strings.Repeat("A", 30)} {
		_, err := m.BrowserConnection(t.Context(), "tenant", "owner", "configure", "", token)
		var typed *BrowserCommandError
		if !errors.As(err, &typed) || typed.Code != "INVALID_BROWSER_TOKEN" {
			t.Fatalf("token %q: %v", token, err)
		}
	}
	if _, err := os.Stat(m.browserConnectionPath("tenant", "owner")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a rejected token was stored")
	}
}

func TestSameChromeProfileAdmitsOneOperation(t *testing.T) {
	m := newConnectionManager(t)
	release, err := m.acquireChromeProfile(t.Context(), "Default")
	if err != nil {
		t.Fatal(err)
	}
	previous := profileWait
	profileWait = 20 * time.Millisecond
	defer func() { profileWait = previous }()
	if _, err := m.acquireChromeProfile(t.Context(), "Default"); err == nil || !strings.Contains(err.Error(), "BROWSER_BUSY") {
		t.Fatalf("a second task shared the profile: %v", err)
	}
	other, err := m.acquireChromeProfile(t.Context(), "Profile 1")
	if err != nil {
		t.Fatal(err)
	}
	other()
	release()
	again, err := m.acquireChromeProfile(t.Context(), "Default")
	if err != nil {
		t.Fatal(err)
	}
	again()
}

func TestBusyChromeProfileWaitsOutsideTheActionJournal(t *testing.T) {
	m := newConnectionManager(t)
	holder, err := m.acquireChromeProfile(t.Context(), "Default")
	if err != nil {
		t.Fatal(err)
	}
	defer holder()
	previous := profileWait
	profileWait = 500 * time.Millisecond
	defer func() { profileWait = previous }()
	op := &operation{manager: m, label: "linger-test", userChrome: &browserConnection{Profile: "Default"}}
	result := make(chan error, 1)
	go func() {
		_, err := op.nativeBrowserCall(t.Context(), "browser_tabs", json.RawMessage(`{}`))
		result <- err
	}()
	time.Sleep(50 * time.Millisecond)
	// The task holding the profile must still reach the shared input queue.
	ctx, cancel := context.WithTimeout(t.Context(), 200*time.Millisecond)
	defer cancel()
	receipt, err := m.journal.begin(ctx, actionIdentity{AgentID: "holder", OperationID: "holder", Session: "holder"})
	if err != nil {
		t.Fatalf("a task waiting for the profile blocked every other action: %v", err)
	}
	if err := receipt.finish(true); err != nil {
		t.Fatal(err)
	}
	if err := <-result; err == nil || !strings.Contains(err.Error(), "BROWSER_BUSY") {
		t.Fatalf("the waiting task did not report a busy profile: %v", err)
	}
}

func TestRejectedTokenFailsLaterCallsAtOnce(t *testing.T) {
	m := newConnectionManager(t)
	op := &operation{manager: m, label: "linger-test", userChrome: &browserConnection{Profile: "Default"}}
	op.userChromeRejected.Store(true)
	if _, err := op.nativeBrowserCall(t.Context(), "browser_tabs", json.RawMessage(`{}`)); !errors.Is(err, errUserChromeRejected) {
		t.Fatalf("a rejected token reopened the connect page: %v", err)
	}
	if op.releaseProfile != nil || m.journal.blocked() {
		t.Fatal("a refused call held the profile or blocked input")
	}
}

func TestChromeProfileReleaseIsIdempotent(t *testing.T) {
	m := newConnectionManager(t)
	release, err := m.acquireChromeProfile(t.Context(), "Default")
	if err != nil {
		t.Fatal(err)
	}
	release()
	// A retried cleanup releases again; it must neither block nor free a
	// slot that another task now holds.
	release()
	holder, ok := m.tryChromeProfile("Default")
	if !ok {
		t.Fatal("the released profile stayed busy")
	}
	release()
	if _, ok := m.tryChromeProfile("Default"); ok {
		t.Fatal("a stale release freed another task's profile")
	}
	holder()
}

func TestBrowserConfigureWaitsForNoTaskOnTheProfile(t *testing.T) {
	m := newConnectionManager(t)
	home := t.TempDir()
	var executable, data string
	switch runtime.GOOS {
	case "darwin":
		m.env = []string{"HOME=" + home}
		executable = filepath.Join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
		data = filepath.Join(home, "Library", "Application Support", "Google", "Chrome")
	case "windows":
		m.env = []string{"LOCALAPPDATA=" + home}
		executable = filepath.Join(home, "Google", "Chrome", "Application", "chrome.exe")
		data = filepath.Join(home, "Google", "Chrome", "User Data")
	default:
		t.Skip("everyday Chrome exists only on native desktops")
	}
	if err := os.MkdirAll(filepath.Dir(executable), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(executable, nil, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(data, "Default", "Extensions", playwrightExtensionID), 0o700); err != nil {
		t.Fatal(err)
	}
	release, err := m.acquireChromeProfile(t.Context(), "Default")
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	_, err = m.BrowserConnection(t.Context(), "tenant", "owner", "configure", "Default", strings.Repeat("A", 43))
	var typed *BrowserCommandError
	if !errors.As(err, &typed) || typed.Code != "BROWSER_BUSY" || !typed.Retryable {
		t.Fatalf("configure opened a second relay into a busy profile: %v", err)
	}
	if _, err := os.Stat(m.browserConnectionPath("tenant", "owner")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("an unverified token was stored")
	}
}

func TestBrowserToolsNameTheirChrome(t *testing.T) {
	catalog := []tool{{Name: "browser_navigate", Description: "Navigate."}, {Name: "browser_tabs", Description: "Tabs."}, {Name: "browser_click", Description: "Click."}}
	isolated := describeBrowserMode(append([]tool(nil), catalog...), false, false, true)
	if !strings.Contains(isolated[0].Description, "teamhub browser connect") || !strings.Contains(isolated[0].Description, "never ask them to relaunch Chrome") || isolated[2].Description != "Click." {
		t.Fatalf("isolated guidance: %+v", isolated)
	}
	user := describeBrowserMode(append([]tool(nil), catalog...), true, false, true)
	if !strings.Contains(user[1].Description, "user's own signed-in Chrome") {
		t.Fatalf("user Chrome guidance: %+v", user)
	}
	waiting := describeBrowserMode(append([]tool(nil), catalog...), false, true, true)
	if !strings.Contains(waiting[0].Description, "not connected yet") || !strings.Contains(waiting[0].Description, "teamhub browser connect") || !strings.Contains(waiting[0].Description, "never switch to another browser") {
		t.Fatalf("unconnected Chrome guidance: %+v", waiting)
	}
	unconnectable := describeBrowserMode(append([]tool(nil), catalog...), false, false, false)
	if strings.Contains(unconnectable[0].Description, "teamhub browser connect") || !strings.Contains(unconnectable[0].Description, "cannot connect") {
		t.Fatalf("Linux guidance offers a connection: %+v", unconnectable)
	}
}

// An Operation on the Agent profile switches to the owner's Chrome once they
// connect it, instead of keeping the profile without their sign-ins.
func TestAgentProfileOperationPicksUpConnection(t *testing.T) {
	m := newConnectionManager(t)
	op := &operation{manager: m, spec: provider.OperationSpec{TenantID: "tenant", OwnerActorID: "owner"}}
	if chrome, err := op.resolveUserChrome(t.Context()); chrome != nil || err != nil {
		t.Fatalf("an unconnected owner without everyday Chrome: %+v %v", chrome, err)
	}
	if err := m.storeBrowserConnection(&browserConnection{TenantID: "tenant", OwnerActorID: "owner", Profile: "Default", Token: strings.Repeat("A", 43), State: browserConnected, ConfiguredAt: time.Now().UTC()}); err != nil {
		t.Fatal(err)
	}
	if chrome, err := op.resolveUserChrome(t.Context()); err != nil || chrome == nil {
		t.Fatalf("the Agent profile kept running after the owner connected: %+v %v", chrome, err)
	}
}

func TestBrowserCallPicksUpEverydayChromeConnection(t *testing.T) {
	m := newConnectionManager(t)
	op := &operation{manager: m, spec: provider.OperationSpec{TenantID: "tenant", OwnerActorID: "owner"}, chromeRequired: true}
	// Without a connection the call fails at once with the card guidance,
	// never the Agent profile.
	if chrome, err := op.resolveUserChrome(t.Context()); chrome != nil || !errors.Is(err, errUserChromeRequired) {
		t.Fatalf("an unconnected owner fell back: %+v %v", chrome, err)
	}
	if err := m.storeBrowserConnection(&browserConnection{TenantID: "tenant", OwnerActorID: "owner", Profile: "Default", Token: strings.Repeat("A", 43), State: browserConnected, ConfiguredAt: time.Now().UTC()}); err != nil {
		t.Fatal(err)
	}
	chrome, err := op.resolveUserChrome(t.Context())
	if err != nil || chrome == nil || chrome.Profile != "Default" {
		t.Fatalf("the call did not pick up the new connection: %+v %v", chrome, err)
	}
}

// After the extension rejected a token, the same task keeps failing until the
// owner connects again, even with the same token; then it drops the old relay,
// frees the profile and uses the new connection.
func TestRejectedConnectionRecoversAfterReconnect(t *testing.T) {
	m := newConnectionManager(t)
	stale := &browserConnection{TenantID: "tenant", OwnerActorID: "owner", Profile: "Default", Token: strings.Repeat("A", 43), State: browserTokenInvalid, ConfiguredAt: time.Now().UTC()}
	if err := m.storeBrowserConnection(stale); err != nil {
		t.Fatal(err)
	}
	released := false
	op := &operation{manager: m, spec: provider.OperationSpec{TenantID: "tenant", OwnerActorID: "owner"}, userChrome: stale, userChromeVerified: true,
		releaseProfile: func() { released = true }}
	op.userChromeRejected.Store(true)
	if _, err := op.resolveUserChrome(t.Context()); !errors.Is(err, errUserChromeRejected) {
		t.Fatalf("a rejected token was reused: %v", err)
	}
	// A verdict that only flips the state back is not a reconnect.
	if err := m.storeBrowserConnection(&browserConnection{TenantID: "tenant", OwnerActorID: "owner", Profile: "Default", Token: stale.Token, State: browserConnected, ConfiguredAt: stale.ConfiguredAt}); err != nil {
		t.Fatal(err)
	}
	if _, err := op.resolveUserChrome(t.Context()); !errors.Is(err, errUserChromeRejected) {
		t.Fatalf("an unchanged connection was reused: %v", err)
	}
	fresh := &browserConnection{TenantID: "tenant", OwnerActorID: "owner", Profile: "Default", Token: stale.Token, State: browserConnected, ConfiguredAt: stale.ConfiguredAt.Add(time.Second)}
	if err := m.storeBrowserConnection(fresh); err != nil {
		t.Fatal(err)
	}
	chrome, err := op.resolveUserChrome(t.Context())
	if err != nil || chrome == nil || !chrome.ConfiguredAt.Equal(fresh.ConfiguredAt) {
		t.Fatalf("the task did not pick up the reconnected Chrome: %+v %v", chrome, err)
	}
	if !released || op.releaseProfile != nil || op.userChromeRejected.Load() || op.userChromeVerified {
		t.Fatalf("the rejected session was kept: released=%v rejected=%v verified=%v", released, op.userChromeRejected.Load(), op.userChromeVerified)
	}
}

func TestChildEnvironmentKeepsWindowsFolders(t *testing.T) {
	env := childEnvironment(map[string]string{"PATH": "/bin", "LOCALAPPDATA": `C:\Users\u\AppData\Local`, "NODE_OPTIONS": "--inspect", "GATEWAY_TOKEN": "secret"})
	joined := strings.Join(env, "\n")
	if !strings.Contains(joined, "LOCALAPPDATA=") || strings.Contains(joined, "NODE_OPTIONS") || strings.Contains(joined, "secret") {
		t.Fatalf("child environment=%q", env)
	}
}

func TestBrowserToolsBindWithoutDesktopDriver(t *testing.T) {
	if !nativeDesktop() {
		t.Skip("native desktops only")
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	m, err := New(Options{StateDirectory: t.TempDir(), NodePath: executable, PlaywrightEntry: fixtureEntry(t)})
	if err != nil {
		t.Fatal(err)
	}
	m.env = append(m.env, "LINGER_LOCAL_TOOL_FIXTURE=image")
	identity := mcpproxy.OperationIdentity{OperationID: "no-driver", ExecutionLeaseID: "lease", RuntimeType: "codex"}
	set, err := mcpproxy.Open(t.Context(), json.RawMessage(`[]`), identity)
	if err != nil {
		t.Fatal(err)
	}
	defer set.Close()
	if err := m.Bind(t.Context(), provider.OperationSpec{AgentID: "agent", WorkingDirectory: t.TempDir()}, identity, set); err != nil {
		t.Fatalf("a missing desktop driver blocked browser tools: %v", err)
	}
	var op *operation
	for item := range m.operations {
		op = item
	}
	if len(op.servers) != 2 || op.cua != nil || op.computerErr == nil {
		t.Fatalf("servers=%d cua=%v computerErr=%v", len(op.servers), op.cua, op.computerErr)
	}
	if _, err := op.computerCall(t.Context(), "click", json.RawMessage(`{}`)); err == nil || !strings.Contains(err.Error(), "COMPUTER_UNAVAILABLE") {
		t.Fatalf("computer call without a driver: %v", err)
	}
	op.nativeBrowser = &nativeBrowser{endpoint: "http://127.0.0.1:1"}
	op.browser = fixtureClient(t, "image", "")
	if _, err := op.browserCall(t.Context(), "browser_snapshot", json.RawMessage(`{}`)); err != nil {
		t.Fatalf("browser call without a driver: %v", err)
	}
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestUnusableSavedConnectionFailsOnlyBrowserCalls(t *testing.T) {
	if !nativeDesktop() || runtime.GOOS == "linux" {
		t.Skip("everyday Chrome is connected on macOS and Windows only")
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for name, prepare := range map[string]func(*Manager) error{
		"rejected token": func(m *Manager) error {
			return m.storeBrowserConnection(&browserConnection{TenantID: "tenant", OwnerActorID: "owner", Profile: "Default", Token: strings.Repeat("A", 43), State: browserTokenInvalid})
		},
		"damaged record": func(m *Manager) error {
			return os.WriteFile(m.browserConnectionPath("tenant", "owner"), []byte("{"), 0o600)
		},
	} {
		t.Run(name, func(t *testing.T) {
			m, err := New(Options{StateDirectory: t.TempDir(), NodePath: executable, PlaywrightEntry: fixtureEntry(t)})
			if err != nil {
				t.Fatal(err)
			}
			m.env = append(m.env, "LINGER_LOCAL_TOOL_FIXTURE=image")
			if err := os.MkdirAll(filepath.Dir(m.browserConnectionPath("tenant", "owner")), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := prepare(m); err != nil {
				t.Fatal(err)
			}
			identity := mcpproxy.OperationIdentity{OperationID: name, ExecutionLeaseID: "lease", RuntimeType: "codex"}
			set, err := mcpproxy.Open(t.Context(), json.RawMessage(`[]`), identity)
			if err != nil {
				t.Fatal(err)
			}
			defer set.Close()
			spec := provider.OperationSpec{AgentID: "agent", TenantID: "tenant", OwnerActorID: "owner", WorkingDirectory: t.TempDir()}
			if err := m.Bind(t.Context(), spec, identity, set); err != nil {
				t.Fatalf("an unusable browser connection blocked the Operation: %v", err)
			}
			var op *operation
			for item := range m.operations {
				op = item
			}
			if _, err := op.browserCall(t.Context(), "browser_tabs", json.RawMessage(`{}`)); !errors.Is(err, errUserChromeRejected) {
				t.Fatalf("browser call reopened the connect page or fell back: %v", err)
			}
			if err := m.Close(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

// fixtureEntry is a Playwright entry file that exists, so the catalog key can
// stamp it; the fixture child never reads it.
func fixtureEntry(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "cli.js")
	if err := os.WriteFile(path, []byte("entry"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// liveSessionOnProfile records a Live browser session that holds profile, as
// its first browser call leaves it.
func liveSessionOnProfile(t *testing.T, m *Manager, key, profile string) *operation {
	t.Helper()
	release, err := m.acquireChromeProfile(t.Context(), profile)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	op := &operation{manager: m, label: "linger-live", ctx: ctx, cancel: cancel, directory: t.TempDir(), userChrome: &browserConnection{Profile: profile}, releaseProfile: release, chromeSeat: profile}
	m.tryLockLive()
	if m.liveSessions == nil {
		m.liveSessions = map[string]*liveBrowserSession{}
	}
	m.liveSessions[key] = &liveBrowserSession{op: op, used: time.Now()}
	m.unlockLive()
	m.mu.Lock()
	m.operations[op] = true
	m.mu.Unlock()
	return op
}

func TestTaskTakesTheChromeOfALiveCallBetweenItsTurns(t *testing.T) {
	m := newConnectionManager(t)
	live := liveSessionOnProfile(t, m, "tenant\x00owner\x00agent\x00voice-1", "Default")
	previous := profileWait
	profileWait = 1500 * time.Millisecond
	defer func() { profileWait = previous }()
	// A Live call in progress keeps the profile.
	m.tryLockLive()
	if _, err := m.acquireChromeProfile(t.Context(), "Default"); err == nil || !strings.Contains(err.Error(), "BROWSER_BUSY") {
		t.Fatalf("a task took the Chrome of a running Live call: %v", err)
	}
	m.unlockLive()
	// Between turns, the waiting task gets it and the Live session ends.
	release, err := m.acquireChromeProfile(t.Context(), "Default")
	if err != nil {
		t.Fatalf("a task waited out an idle Live call: %v", err)
	}
	release()
	if !live.cleanupFinished || live.releaseProfile != nil || len(m.liveSessions) != 0 {
		t.Fatal("the idle Live session kept running")
	}
	// A Live session on another profile is left alone.
	other := liveSessionOnProfile(t, m, "tenant\x00owner\x00agent\x00voice-2", "Profile 1")
	if again, ok := m.tryChromeProfile("Default"); !ok {
		t.Fatal("the freed profile stayed busy")
	} else {
		again()
	}
	if other.cleanupFinished || len(m.liveSessions) != 1 {
		t.Fatal("a Live session on another profile was closed")
	}
}

func TestLaterTasksOfAnAgentReuseTheEverydayChromeConnection(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(t.TempDir(), "launches")
	m := newConnectionManager(t)
	m.options.NodePath, m.options.PlaywrightEntry = executable, fixtureEntry(t)
	chromeEnv := fakeEverydayChrome(t)
	m.env = []string{chromeEnv, "LINGER_LOCAL_TOOL_FIXTURE=count-launch", "LINGER_LOCAL_TOOL_MARKER=" + marker}
	workspace := t.TempDir()
	chrome := &browserConnection{Profile: "Default", Token: "token-a", State: browserConnected}
	task := func(agent string, broken bool) {
		t.Helper()
		_, cancel := context.WithCancel(t.Context())
		op := &operation{manager: m, label: "linger-test", directory: t.TempDir(), cancel: cancel, userChrome: chrome,
			spec: provider.OperationSpec{TenantID: "t", OwnerActorID: "u", AgentID: agent, WorkingDirectory: workspace}}
		if _, err := op.nativeBrowserCall(t.Context(), "browser_snapshot", json.RawMessage(`{}`)); err != nil {
			t.Fatal(err)
		}
		if broken {
			op.userChromeRejected.Store(true)
		}
		if err := op.close(); err != nil {
			t.Fatal(err)
		}
	}
	launches := func() int {
		data, _ := os.ReadFile(marker)
		return strings.Count(string(data), "launch\n")
	}
	task("a", false)
	task("a", false)
	if got := launches(); got != 1 {
		t.Fatalf("the second task of the Agent opened %d connections, want one shared", got)
	}
	task("b", false)
	if got := launches(); got != 2 {
		t.Fatalf("another Agent shared the first Agent's tab: %d connections", got)
	}
	// One profile keeps one relay: the second Agent's connection stopped the
	// first Agent's idle one.
	if len(m.userChromeSessions) != 1 {
		t.Fatalf("%d idle connections hold one Chrome profile, want one", len(m.userChromeSessions))
	}
	task("a", true)
	task("a", false)
	if got := launches(); got != 4 {
		t.Fatalf("a connection with a rejected token was reused: %d connections", got)
	}
	previous := userChromeIdle
	userChromeIdle = 20 * time.Millisecond
	defer func() { userChromeIdle = previous }()
	task("a", false)
	time.Sleep(200 * time.Millisecond)
	task("a", false)
	if got := launches(); got != 5 {
		t.Fatalf("an idle connection outlived its timeout: %d connections", got)
	}
	if err := m.closeUserChrome(); err != nil {
		t.Fatal(err)
	}
	if len(m.userChromeSessions) != 0 {
		t.Fatal("daemon stop left an idle connection running")
	}
}

// fakeEverydayChrome places an empty Chrome executable where chromeExecutable
// looks for a per-user install and returns the environment entry naming it.
func fakeEverydayChrome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	var chromeEnv, chrome string
	switch runtime.GOOS {
	case "darwin":
		chromeEnv, chrome = "HOME="+home, filepath.Join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
	case "windows":
		chromeEnv, chrome = "LOCALAPPDATA="+home, filepath.Join(home, "Google", "Chrome", "Application", "chrome.exe")
	default:
		t.Skip("everyday Chrome exists only on native desktops")
	}
	if err := os.MkdirAll(filepath.Dir(chrome), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(chrome, nil, 0o700); err != nil {
		t.Fatal(err)
	}
	return chromeEnv
}

func TestUnconfirmedEverydayChromeStartStaysWithItsTask(t *testing.T) {
	m := newConnectionManager(t)
	// A failed executable launch is reported as unconfirmed cleanup.
	m.options.NodePath, m.options.PlaywrightEntry = filepath.Join(t.TempDir(), "missing-node"), fixtureEntry(t)
	m.env = []string{fakeEverydayChrome(t)}
	chrome := &browserConnection{Profile: "Default", Token: "token-a", State: browserConnected}
	_, cancel := context.WithCancel(t.Context())
	op := &operation{manager: m, label: "linger-test", directory: t.TempDir(), cancel: cancel, userChrome: chrome,
		spec: provider.OperationSpec{TenantID: "t", OwnerActorID: "u", AgentID: "a", WorkingDirectory: t.TempDir()}}
	_, err := op.nativeBrowserCall(t.Context(), "browser_snapshot", json.RawMessage(`{}`))
	if !errors.Is(err, mcpproxy.ErrCleanupUnconfirmed) {
		t.Fatalf("err = %v, want ErrCleanupUnconfirmed", err)
	}
	if op.browser == nil || op.userChromeSession == nil {
		t.Fatal("the task dropped the child whose cleanup is unconfirmed")
	}
	if len(m.userChromeSessions) != 0 {
		t.Fatal("a connection with unconfirmed cleanup was shared with later tasks")
	}
	// Its close stays unconfirmed, so the task keeps the session and stays
	// with the Manager for cleanup retries.
	if err := op.close(); !errors.Is(err, mcpproxy.ErrCleanupUnconfirmed) {
		t.Fatalf("close err = %v, want ErrCleanupUnconfirmed", err)
	}
	if op.userChromeSession == nil || op.browser == nil || !m.operations[op] {
		t.Fatal("a close with unconfirmed cleanup dropped the session or its task")
	}
	m.retryCleanup()
	if op.userChromeSession == nil || !m.operations[op] {
		t.Fatal("a retry that still cannot confirm cleanup released the session")
	}
}

// A task that drops its everyday Chrome session, as a rejected token or a
// reconnect does, takes it out of the shared table, so the next task can
// register and reuse a new one.
func TestDroppedEverydayChromeSessionLeavesTheSharedTable(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(t.TempDir(), "launches")
	m := newConnectionManager(t)
	m.options.NodePath, m.options.PlaywrightEntry = executable, fixtureEntry(t)
	m.env = []string{fakeEverydayChrome(t), "LINGER_LOCAL_TOOL_FIXTURE=count-launch", "LINGER_LOCAL_TOOL_MARKER=" + marker}
	workspace := t.TempDir()
	chrome := &browserConnection{Profile: "Default", Token: "token-a", State: browserConnected}
	start := func() *operation {
		t.Helper()
		_, cancel := context.WithCancel(t.Context())
		op := &operation{manager: m, label: "linger-test", directory: t.TempDir(), cancel: cancel, userChrome: chrome,
			spec: provider.OperationSpec{TenantID: "t", OwnerActorID: "u", AgentID: "a", WorkingDirectory: workspace}}
		if _, err := op.nativeBrowserCall(t.Context(), "browser_snapshot", json.RawMessage(`{}`)); err != nil {
			t.Fatal(err)
		}
		return op
	}
	op := start()
	if err := op.dropBrowserSession(); err != nil {
		t.Fatal(err)
	}
	if op.browser != nil || op.userChromeSession != nil || len(m.userChromeSessions) != 0 {
		t.Fatal("a dropped session stayed with the task or in the shared table")
	}
	if err := op.close(); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := start().close(); err != nil {
			t.Fatal(err)
		}
	}
	data, _ := os.ReadFile(marker)
	if got := strings.Count(string(data), "launch\n"); got != 2 {
		t.Fatalf("after a dropped session the next tasks opened %d connections, want one new shared", got)
	}
	if err := m.closeUserChrome(); err != nil {
		t.Fatal(err)
	}
}

// An idle session whose stop is unconfirmed when it expires stays with the
// Manager, so cleanup retries and the daemon stop reach it again.
func TestExpiredEverydayChromeWithUnconfirmedStopStaysForRetries(t *testing.T) {
	m := newConnectionManager(t)
	m.options.NodePath, m.options.PlaywrightEntry = filepath.Join(t.TempDir(), "missing-node"), fixtureEntry(t)
	m.env = []string{fakeEverydayChrome(t)}
	chrome := &browserConnection{Profile: "Default", Token: "token-a", State: browserConnected}
	op := &operation{manager: m, directory: t.TempDir(), userChrome: chrome,
		spec: provider.OperationSpec{TenantID: "t", OwnerActorID: "u", AgentID: "a", WorkingDirectory: t.TempDir()}}
	session, err := m.checkoutUserChrome(t.Context(), op, chrome)
	if session == nil || !errors.Is(err, mcpproxy.ErrCleanupUnconfirmed) {
		t.Fatalf("session=%v err=%v, want an unconfirmed start", session, err)
	}
	// Make it an idle shared session, as a healthy task would leave it.
	m.mu.Lock()
	session.inUse = false
	m.userChromeSessions[session.key] = session
	m.mu.Unlock()
	m.expireUserChrome(session)
	if len(m.userChromeSessions) != 0 || len(m.userChromeStray) != 1 {
		t.Fatalf("an expired session with an unconfirmed stop was dropped: shared=%d stray=%d", len(m.userChromeSessions), len(m.userChromeStray))
	}
	m.retryCleanup()
	if len(m.userChromeStray) != 1 {
		t.Fatal("a retry that still cannot confirm the stop dropped the session")
	}
	if err := m.closeUserChrome(); !errors.Is(err, mcpproxy.ErrCleanupUnconfirmed) {
		t.Fatalf("daemon stop err = %v, want ErrCleanupUnconfirmed", err)
	}
}

func TestBrowserCallNotRunNamesACallThatNeverReachedChrome(t *testing.T) {
	for err, want := range map[error]string{
		errUserChromeRequired: "browser_connection_required",
		errBrowserBusy:        "browser_busy",
		errors.Join(errUserChromeRejected, errors.New("cleanup")): "browser_connection_invalid",
		errors.New("page did not load"):                           "",
		nil:                                                       "",
	} {
		if got := BrowserCallNotRun(err); got != want {
			t.Fatalf("BrowserCallNotRun(%v) = %q, want %q", err, got, want)
		}
	}
}

// A task whose cleanup fails, here for a desktop action of unknown outcome,
// stays for cleanup retries but passes the owner's Chrome profile on.
func TestFailedCleanupPassesTheChromeProfileOn(t *testing.T) {
	m := newConnectionManager(t)
	release, err := m.acquireChromeProfile(t.Context(), "Default")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	op := &operation{manager: m, label: "linger-task", ctx: ctx, cancel: cancel, directory: t.TempDir(), userChrome: &browserConnection{Profile: "Default"}, releaseProfile: release, unknown: true}
	m.mu.Lock()
	m.operations[op] = true
	m.mu.Unlock()
	if err := op.close(); !errors.Is(err, mcpproxy.ErrCleanupUnconfirmed) {
		t.Fatalf("close err=%v, want the unknown action kept", err)
	}
	m.mu.Lock()
	retained := m.operations[op]
	m.mu.Unlock()
	if !retained {
		t.Fatal("the task was not kept for cleanup retries")
	}
	previous := profileWait
	profileWait = 20 * time.Millisecond
	defer func() { profileWait = previous }()
	next, err := m.acquireChromeProfile(t.Context(), "Default")
	if err != nil {
		t.Fatalf("the next task found the Chrome profile held: %v", err)
	}
	next()
}

// An action of unknown outcome in the owner's Chrome settles once this task's
// Playwright child, its only sender, has stopped: input must not stay blocked
// for every later task.
func TestUserChromeUnknownActionSettlesWhenTheTaskStops(t *testing.T) {
	m := newConnectionManager(t)
	journal, err := m.namedJournal(chromeProfileJournal("Default"))
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := journal.begin(t.Context(), actionIdentity{AgentID: "agent", OperationID: "op", Session: "linger-task-browser"})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	session := &userChromeSession{key: "k", inUse: true, directory: t.TempDir()}
	op := &operation{manager: m, label: "linger-task", ctx: ctx, cancel: cancel, directory: t.TempDir(), userChrome: &browserConnection{Profile: "Default"}, userChromeSession: session}
	op.markBrowserUnknown(receipt, true)
	m.mu.Lock()
	m.operations[op] = true
	m.mu.Unlock()
	if err := op.close(); err != nil {
		t.Fatalf("close err=%v, want the stopped child to settle the action", err)
	}
	next, err := journal.begin(t.Context(), actionIdentity{AgentID: "other-agent", OperationID: "next", Session: "linger-next-browser"})
	if err != nil {
		t.Fatalf("input stayed blocked: %v", err)
	}
	_ = next.finish(true)
}

// A Live session whose cleanup is unconfirmed leaves the table anyway; its
// Operation stays for cleanup retries.
func TestLiveSessionWithFailedCleanupLeavesTheTable(t *testing.T) {
	m := newConnectionManager(t)
	key := "tenant\x00owner\x00agent\x00voice-1"
	live := liveSessionOnProfile(t, m, key, "Default")
	live.unknown = true
	m.liveSessions[key].used = time.Now().Add(-time.Hour)
	_, err := m.CallLiveBrowser(t.Context(), "tenant", "owner", "agent", "voice-2", "browser_snapshot", nil)
	if errors.Is(err, mcpproxy.ErrCleanupUnconfirmed) {
		t.Fatalf("a failed cleanup broke the next Live call: %v", err)
	}
	if m.liveSessions[key] != nil {
		t.Fatal("the session whose cleanup failed stayed in the table")
	}
}

// A Live call waiting behind another gives up with its caller.
func TestLiveCallStopsWaitingWithItsCaller(t *testing.T) {
	m := newConnectionManager(t)
	if !m.tryLockLive() {
		t.Fatal("the Live slot was taken")
	}
	defer m.unlockLive()
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Millisecond)
	defer cancel()
	if _, err := m.CallLiveBrowser(ctx, "tenant", "owner", "agent", "voice-1", "browser_snapshot", nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err=%v, want the caller's deadline", err)
	}
}
