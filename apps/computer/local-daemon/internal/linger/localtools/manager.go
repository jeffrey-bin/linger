package localtools

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/mcpproxy"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/permission"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/process"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
)

// Options contains locally resolved installation paths. No wire request can
// supply a tool executable or persistent profile path.
type Options struct {
	StateDirectory  string
	NodePath        string
	PlaywrightEntry string
	CuaPath         string
	// CuaEmbedded requires an already-running Cua child owned by the trusted
	// embedding host. Its real OS grants must be attributed to that host.
	// The ordinary signed-app installation never enables this option.
	CuaEmbedded bool
	Environment map[string]string
}

type Manager struct {
	// liveSlot admits one Live browser call at a time; see lockLive.
	liveSlot     chan struct{}
	liveSessions map[string]*liveBrowserSession
	options      Options
	env          []string
	journal      *actionJournal
	mu           sync.Mutex
	cuaLaunch    sync.Mutex
	// cuaGrant is the running `cua-driver permissions grant`, at most one.
	cuaGrantMu sync.Mutex
	cuaGrant   *exec.Cmd
	// lanes admit one call at a time to the desktop and to each Agent's
	// browser; see holdLane. Guarded by laneMu.
	laneMu sync.Mutex
	lanes  map[string]chan struct{}
	// browserJournals are the action journals of browser lanes and of seats
	// in the everyday Chrome by path, including those of earlier Daemons.
	// Guarded by laneMu.
	browserJournals map[string]*actionJournal
	// focus keeps browser calls apart from desktop input that depends on
	// the front window or the clipboard; see holdFocus.
	focus      focusGate
	operations map[*operation]bool
	browsers   map[string]*nativeBrowser
	// browserMu serializes the private browser connection records.
	browserMu sync.Mutex
	// noEverydayChrome marks a Linux desktop: it has no everyday Chrome
	// profile lookup, so its Agents keep their own browser.
	noEverydayChrome bool
	// chromeProfiles admits one Operation at a time to each seat in an
	// everyday Chrome profile, so tabs, refs and downloads of two tasks never
	// mix; see userChromeSeat.
	chromeProfiles map[string]chan struct{}
	// userChromeSessions keeps idle connections to everyday Chrome for the
	// next task of the same Agent; see checkoutUserChrome.
	userChromeSessions map[string]*userChromeSession
	// userChromeStray holds idle everyday Chrome sessions whose stop was
	// not confirmed; cleanup retries and the daemon stop close them again.
	userChromeStray   []*userChromeSession
	closingUserChrome bool
	// catalogMu serializes discovery so concurrent misses start one catalog.
	catalogMu sync.Mutex
	cachedKey catalogKey
	cached    *toolCatalog
	// agentChromeOwner is the Operation that holds the Computer's own browser,
	// and agentChromePID that Chrome's pid as last checked; see
	// claimAgentChrome and isAgentChrome. Guarded by mu.
	agentChromeOwner   *operation
	agentChromePID     int
	agentChromeChecked time.Time
	// agentSafariPID and agentSafariWindow are the user's Safari and the
	// window in it that the Computer opened as its own; see
	// launchAgentSafari.
	agentSafariPID    int
	agentSafariWindow float64
	// paceMu guards the persisted pace record of the Computer's own browser
	// and paceLast, when that Chrome last received input; see
	// paceAgentChrome.
	paceMu   sync.Mutex
	paceLast time.Time
	// openCuaSession is a test seam; nil means openCua.
	openCuaSession func(context.Context, *operation) (*cuaSession, []tool, error)
}

func New(options Options) (*Manager, error) {
	if !filepath.IsAbs(options.StateDirectory) {
		return nil, errors.New("local tools require a state directory")
	}
	m := &Manager{options: options, operations: map[*operation]bool{}, browsers: map[string]*nativeBrowser{}, chromeProfiles: map[string]chan struct{}{}, noEverydayChrome: runtime.GOOS == "linux"}
	// In particular, do not inherit NODE_OPTIONS, Playwright MCP overrides,
	// model keys, Gateway credentials, or ambient browser profiles.
	m.env = childEnvironment(options.Environment)
	if nativeDesktop() {
		var err error
		m.journal, err = openJournal(filepath.Join(options.StateDirectory, "computer-tools", "action.json"))
		if err != nil {
			return nil, err
		}
		if err := m.openBrowserJournals(); err != nil {
			return nil, err
		}
	}
	return m, nil
}

type operation struct {
	manager              *Manager
	spec                 provider.OperationSpec
	identity             mcpproxy.OperationIdentity
	directory            string
	playwrightSocketsDir string
	ctx                  context.Context
	cancel               context.CancelFunc
	mu                   sync.Mutex
	closing              bool
	cleanupFinished      bool
	retrying             bool
	active               sync.WaitGroup
	servers              []*toolServer
	browserCatalog       *mcpClient
	browser              *mcpClient
	// userChromeSession is the shared connection behind browser in the
	// owner's everyday Chrome; the Operation returns it instead of closing it.
	userChromeSession *userChromeSession
	nativeBrowser     *nativeBrowser
	nativeProxy       *nativeCDPProxy
	cua               *cuaSession
	// computerErr reports a missing desktop driver. Browser and file tools
	// stay available without it.
	computerErr error
	// label names this Operation's journal sessions.
	label string
	// userChrome is the owner's everyday Chrome, resolved when the Operation
	// binds or, with chromeRequired, when the owner connects it during the
	// task. connectMu guards it; nil selects the dedicated Agent profile.
	userChrome *browserConnection
	// chromeRequired is set when Chrome is the everyday browser but is not
	// connected: browser calls wait for the owner instead of falling back.
	chromeRequired     bool
	connectMu          sync.Mutex
	userChromeVerified bool
	userChromeRejected atomic.Bool
	// browserCalls admits one browser call of this Operation at a time; see
	// holdBrowserCalls.
	browserCalls     chan struct{}
	browserCallsOnce sync.Once
	// profileMu guards releaseProfile and chromeSeat while a call waits for
	// the seat.
	profileMu      sync.Mutex
	releaseProfile func()
	chromeSeat     string
	browserUnknown *actionReceipt
	// browserUnknownUser marks an unknown action sent to the owner's Chrome.
	browserUnknownUser bool
	// live marks a Live call's Operation, which waits less for the profile.
	live bool
	// linux is the native X11 driver; linuxUnknown is its unresolved input.
	// elements numbers the Linux desktop's accessibility elements.
	linux        *mcpClient
	linuxUnknown *actionReceipt
	// linuxWindow is the X11 id of the window active in the Agent's last
	// observation. Input waits for the Agent to see a window the user
	// brought forward since.
	linuxWindow []byte
	elements    elementIndex
	// pages and reads remember what the Agent last saw in the browser and
	// in each desktop window, for the permission review.
	pages browserPages
	reads windowReads
	// cuaMu serializes the first Cua open. cuaUnconfirmed means a failed
	// open left a client whose cleanup is unconfirmed; it stays in cua for
	// close and blocks any second client.
	cuaMu          sync.Mutex
	cuaUnconfirmed bool
	unknown        bool
	// chromeInputs counts the inputs this task sent the Computer's own
	// Chrome, chromeBlocked names the check it reported there, and
	// chromeSites are the sites it opened there; see paceAgentChrome.
	// Guarded by mu.
	chromeInputs  int
	chromeBlocked string
	chromeSites   map[string]bool
	// chromeTabs is the tab count of the Computer's own browser after this
	// task's last input there, and chromePID and chromeWindow the browser
	// and window this task opened with launch_app; see checkAgentChromeTabs.
	// Guarded by mu.
	chromeTabs   int
	chromePID    int
	chromeWindow float64
	closeOnce    sync.Once
	closeErr     error
}

func (m *Manager) Bind(ctx context.Context, spec provider.OperationSpec, identity mcpproxy.OperationIdentity, set *mcpproxy.Set) error {
	if m.journal == nil {
		return nil
	}
	if spec.AgentID == "" || !filepath.IsAbs(spec.WorkingDirectory) {
		return errors.New("local tool Operation identity is incomplete")
	}
	if !filepath.IsAbs(m.options.NodePath) || !filepath.IsAbs(m.options.PlaywrightEntry) {
		return errors.New("managed browser tools are not installed; repair the Computer installation")
	}
	sum := sha256.Sum256([]byte(identity.OperationID + "\x00" + identity.ExecutionLeaseID))
	directory := filepath.Join(m.options.StateDirectory, "computer-tools", "operations", hex.EncodeToString(sum[:]))
	if err := privatefs.EnsureDir(directory); err != nil {
		return err
	}
	opCtx, cancel := context.WithCancel(ctx)
	op := &operation{manager: m, spec: spec, identity: identity, directory: directory, ctx: opCtx, cancel: cancel, label: "linger-" + rand.Text()}
	var err error
	// The owner's saved connection, read now, applies to this whole task.
	// Operation input never supplies a browser credential.
	if op.userChrome, err = m.loadBrowserConnection(spec.TenantID, spec.OwnerActorID); err != nil {
		// A damaged record fails only browser calls, never by falling
		// back to the Agent profile; desktop and file tools still work.
		op.userChrome = &browserConnection{State: browserTokenInvalid}
	}
	// A token the extension already rejected would open another connect
	// page in the user's Chrome and wait out the relay on every task.
	if op.userChrome != nil && op.userChrome.State == browserTokenInvalid {
		op.userChromeRejected.Store(true)
	}
	op.chromeRequired = op.userChrome == nil && m.everydayChrome()
	catalog, err := m.toolCatalog(ctx, op)
	if err != nil {
		return errors.Join(err, op.close())
	}
	computerTools := catalog.computer
	// The cached list is shared; the browser mode belongs to this owner.
	browserTools := describeBrowserMode(slices.Clone(catalog.browser), op.userChrome != nil, op.chromeRequired, m.userChromeSupported())
	computerCall, browserCall := op.computerCall, op.browserCall
	for _, binding := range []struct {
		name     string
		tools    []tool
		call     func(context.Context, string, json.RawMessage) (json.RawMessage, error)
		evidence func(context.Context, string, json.RawMessage) *permission.Evidence
		allowed  func(string, json.RawMessage) bool
	}{
		{"computer", computerTools, computerCall, op.computerEvidence, nil}, {"browser", browserTools, browserCall, op.browserEvidence, op.browserAllowed},
	} {
		server, err := openToolServer(opCtx, identity, binding.tools, op.wrap(binding.call))
		if err != nil {
			return errors.Join(err, op.close())
		}
		op.servers = append(op.servers, server)
		names := make([]string, 0, len(binding.tools))
		for _, tool := range binding.tools {
			names = append(names, tool.Name)
		}
		if err := set.AddLocal(mcpproxy.LocalBinding{Name: binding.name, URL: server.url, ToolNames: names, WaitReady: server.waitReady, Close: op.close, Evidence: op.guard(binding.evidence), Allowed: binding.allowed}); err != nil {
			return errors.Join(err, op.close())
		}
	}
	m.mu.Lock()
	m.operations[op] = true
	m.mu.Unlock()
	return nil
}

// Prewarm discovers the tool catalog outside any Operation, so the first Bind
// finds it cached. On macOS this starts the shared Cua service in the
// background (open -g, --no-permissions-gate); it was verified to show no
// permission prompt and not take focus. An Agent that never uses computer
// tools gets only that one background launch. Failures are dropped here and
// left to the first Bind, which retries discovery as before.
func (m *Manager) Prewarm(ctx context.Context) {
	if m.journal == nil {
		return
	}
	if !filepath.IsAbs(m.options.NodePath) || !filepath.IsAbs(m.options.PlaywrightEntry) {
		return
	}
	directory := filepath.Join(m.options.StateDirectory, "computer-tools", "catalog")
	if err := privatefs.EnsureDir(directory); err != nil {
		return
	}
	opCtx, cancel := context.WithCancel(ctx)
	spec := provider.OperationSpec{WorkingDirectory: directory}
	op := &operation{manager: m, spec: spec, directory: directory, ctx: opCtx, cancel: cancel, label: "linger-" + rand.Text()}
	_, _ = m.toolCatalog(ctx, op)
	_ = op.close()
}

// toolCatalog is the final per-server tool list. toolServer only reads it, so
// one cached copy serves every Operation on the same installation.
type toolCatalog struct {
	computer []tool
	browser  []tool
	// computerErr is a failed Cua open. Such a catalog is reused only for
	// cuaRetryAfter, so concurrent Binds do not each wait out the open.
	computerErr error
	discovered  time.Time
}

const cuaRetryAfter = 30 * time.Second

// fileStamp identifies one installed file. A replaced executable or entry
// changes its size or modification time and forces rediscovery.
type fileStamp struct {
	path    string
	size    int64
	modTime int64
}

type catalogKey struct {
	node, playwright, cua fileStamp
}

func stampFile(path, missing string) (fileStamp, error) {
	info, err := os.Stat(path)
	if err != nil {
		return fileStamp{}, errors.New(missing)
	}
	return fileStamp{path: path, size: info.Size(), modTime: info.ModTime().UnixNano()}, nil
}

func (m *Manager) installationKey() (catalogKey, error) {
	const browserMissing = "managed browser tools are not installed; repair the Computer installation"
	var key catalogKey
	var err error
	if key.node, err = stampFile(m.options.NodePath, browserMissing); err != nil {
		return catalogKey{}, err
	}
	if key.playwright, err = stampFile(m.options.PlaywrightEntry, browserMissing); err != nil {
		return catalogKey{}, err
	}
	// A missing Cua driver keeps a zero stamp: discovery then binds the
	// unavailable computer tools, which toolCatalog retries after a while.
	if filepath.IsAbs(m.options.CuaPath) {
		key.cua, _ = stampFile(m.options.CuaPath, "")
	}
	return key, nil
}

// toolCatalog returns the cached tool lists for the current installation. A
// miss runs discovery under catalogMu. A desktop driver can be repaired
// without a reinstall, so a catalog without Cua expires after cuaRetryAfter.
func (m *Manager) toolCatalog(ctx context.Context, op *operation) (*toolCatalog, error) {
	m.catalogMu.Lock()
	defer m.catalogMu.Unlock()
	key, err := m.installationKey()
	if err != nil {
		return nil, err
	}
	if m.cached != nil && m.cachedKey == key && (m.cached.computerErr == nil || time.Since(m.cached.discovered) < cuaRetryAfter) {
		op.computerErr = m.cached.computerErr
		return m.cached, nil
	}
	catalog, err := m.discoverCatalog(ctx, op)
	if err != nil {
		return nil, err
	}
	catalog.computerErr, catalog.discovered = op.computerErr, time.Now()
	m.cachedKey, m.cached = key, catalog
	return catalog, nil
}

// discoverCatalog starts the discovery Cua session on macOS and keeps it as
// op.cua, so a miss needs no second client. A Cua failure keeps the computer
// server bound with the reason; browser and file tools still work.
func (m *Manager) discoverCatalog(ctx context.Context, op *operation) (*toolCatalog, error) {
	var computerTools []tool
	if m.localLinux() {
		if _, op.computerErr = op.ensureLinux(ctx); op.computerErr == nil {
			computerTools = nativeLinuxTools()
		} else {
			computerTools = unavailableComputerTools()
		}
	} else if op.cua, computerTools, op.computerErr = m.openCua(ctx, op); op.computerErr != nil {
		if op.cua != nil {
			if err := op.cua.client.close(); err != nil {
				return nil, errors.Join(op.computerErr, err)
			}
			op.cua = nil
		}
		computerTools = unavailableComputerTools()
	}
	// tools/list does not open a browser. The deliberately unreachable CDP
	// endpoint also prevents any accidental launch while discovering tools.
	discovery, err := op.startBrowser(ctx, "http://127.0.0.1:1", "catalog")
	op.browserCatalog = discovery
	if err != nil {
		return nil, err
	}
	browserTools, err := discovery.tools(ctx)
	err = errors.Join(err, discovery.close())
	if err != nil {
		return nil, err
	}
	op.browserCatalog = nil
	// Installation and arbitrary executable-code tools would escape the
	// managed browser lifecycle. Keep the pinned ordinary browser tool set.
	browserTools = filterBrowserTools(browserTools)
	return &toolCatalog{computer: computerTools, browser: browserTools}, nil
}

// ensureCua starts the macOS Cua client on first use and caches only a
// success. ctx is the tool call's context and bounds only the open, because
// startClient keeps the child's lifetime on its own context. A failed open
// closes its client; if that cleanup is unconfirmed, the client stays in
// op.cua for op.close and later calls fail instead of opening a second one.
func (op *operation) ensureCua(ctx context.Context) (*cuaSession, error) {
	op.cuaMu.Lock()
	defer op.cuaMu.Unlock()
	if op.cuaUnconfirmed {
		return nil, errors.New("Cua client cleanup is unconfirmed; the Operation must close before Cua can start again")
	}
	if op.cua != nil && !op.cua.retired() {
		return op.cua, nil
	}
	open := op.manager.openCuaSession
	if open == nil {
		open = op.manager.openCua
	}
	session, _, err := open(ctx, op)
	if err != nil {
		if session == nil {
			return nil, err
		}
		closeErr := session.client.close()
		if closeErr == nil {
			return nil, err
		}
		op.cua, op.cuaUnconfirmed = session, true
		return nil, errors.Join(err, closeErr)
	}
	if previous := op.cua; previous != nil {
		// A session replacing one whose driver stopped keeps the app it
		// brought forward, so a user who switched apps meanwhile has still
		// taken over.
		previous.mu.Lock()
		leased := previous.leased
		previous.mu.Unlock()
		session.mu.Lock()
		session.leased = leased
		session.mu.Unlock()
	}
	op.cua = session
	return session, nil
}

func (op *operation) computerCall(ctx context.Context, name string, args json.RawMessage) (json.RawMessage, error) {
	if op.computerErr != nil {
		return nil, op.computerUnavailable()
	}
	if op.manager.localLinux() {
		result, err := op.linuxComputerCall(ctx, name, args)
		return compactScreenshots(result), err
	}
	cua, err := op.ensureCua(ctx)
	if err != nil {
		return nil, err
	}
	return cua.call(ctx, name, args)
}

func (op *operation) browserCall(ctx context.Context, name string, args json.RawMessage) (json.RawMessage, error) {
	if err := op.refuseBrowserOnChromeSite(name, args); err != nil {
		return nil, err
	}
	return op.nativeBrowserCall(ctx, name, args)
}

func (op *operation) wrap(call func(context.Context, string, json.RawMessage) (json.RawMessage, error)) func(context.Context, string, json.RawMessage) (json.RawMessage, error) {
	return func(ctx context.Context, name string, args json.RawMessage) (json.RawMessage, error) {
		op.mu.Lock()
		if op.closing {
			op.mu.Unlock()
			return nil, errors.New("Operation tools are closed")
		}
		op.active.Add(1)
		op.mu.Unlock()
		defer op.active.Done()
		return call(ctx, name, args)
	}
}

// desktopLane is the desktop of the signed-in user, which every Cua and
// native Linux call shares, with the Computer's own browser that Cua drives.
// Each Agent's Playwright browser, the Agent Chrome or the owner's connected
// Chrome, is a lane of its own: those calls go over CDP or the extension.
const desktopLane = "desktop"

// browserLane names the lane of one Agent's Playwright browser. All browser
// calls of an Operation share it, also after the owner connects their Chrome
// mid-task, and every task of the Agent shares that Agent's Chrome.
func browserLane(agentID string) string { return "browser:" + agentID }

// chromeProfileJournal names the action journal of one seat in the owner's
// everyday Chrome. Its lock is the seat's slot; see acquireChromeProfile.
func chromeProfileJournal(seat string) string { return "chrome:" + seat }

// laneHeld marks a context whose call already holds the named lane.
type laneHeld struct{ lane string }

// lane returns the slot that admits one call of a lane at a time.
func (m *Manager) lane(name string) chan struct{} {
	m.laneMu.Lock()
	defer m.laneMu.Unlock()
	if m.lanes == nil {
		m.lanes = map[string]chan struct{}{}
	}
	if m.lanes[name] == nil {
		m.lanes[name] = make(chan struct{}, 1)
	}
	return m.lanes[name]
}

// browserJournalPrefix starts the file name of every browser action record.
const browserJournalPrefix = "action-browser-"

// openBrowserJournals reads the browser action records an earlier Daemon
// left, so an unknown one blocks desktop input that needs the front window
// before its Agent calls the browser again.
func (m *Manager) openBrowserJournals() error {
	paths, err := filepath.Glob(filepath.Join(filepath.Dir(m.journal.path), browserJournalPrefix+"*.json"))
	if err != nil {
		return err
	}
	m.browserJournals = map[string]*actionJournal{}
	for _, path := range paths {
		if m.browserJournals[path], err = openJournal(path); err != nil {
			return err
		}
	}
	return nil
}

// browserActionUnknown reports a browser action whose outcome is unknown,
// in any Agent's browser or everyday Chrome profile.
func (m *Manager) browserActionUnknown() bool {
	m.laneMu.Lock()
	defer m.laneMu.Unlock()
	for _, journal := range m.browserJournals {
		if journal.blocked() {
			return true
		}
	}
	return false
}

// namedJournal returns the action journal of an Agent's browser lane or of a
// seat in the everyday Chrome; desktop input uses m.journal. It opens on first
// use and reads its file, so a record left before a restart blocks its lane or
// seat again.
func (m *Manager) namedJournal(name string) (*actionJournal, error) {
	m.laneMu.Lock()
	defer m.laneMu.Unlock()
	sum := sha256.Sum256([]byte(name))
	path := filepath.Join(filepath.Dir(m.journal.path), browserJournalPrefix+hex.EncodeToString(sum[:16])+".json")
	if journal := m.browserJournals[path]; journal != nil {
		return journal, nil
	}
	journal, err := openJournal(path)
	if err != nil {
		return nil, err
	}
	if m.browserJournals == nil {
		m.browserJournals = map[string]*actionJournal{}
	}
	m.browserJournals[path] = journal
	return journal, nil
}

// holdLane takes a lane unless ctx already holds it, so a run_actions call
// keeps the screen and the clipboard until it ends. A cancelled call stops
// waiting. No call holds two lanes. Browser calls take their lane only after
// their Chrome profile, so a call never waits for a profile while it holds a
// lane.
func (m *Manager) holdLane(ctx context.Context, name string) (context.Context, func(), error) {
	if ctx.Value(laneHeld{name}) != nil {
		return ctx, func() {}, nil
	}
	slot := m.lane(name)
	select {
	case slot <- struct{}{}:
		return context.WithValue(ctx, laneHeld{name}, true), func() { <-slot }, nil
	case <-ctx.Done():
		if name == desktopLane {
			return ctx, nil, fmt.Errorf("COMPUTER_BUSY: another task was using the screen until this call ended (%v): %w", ctx.Err(), errNotSent) //nolint:errorlint // the wait's end is detail; the call classifies as not sent only
		}
		return ctx, nil, fmt.Errorf("COMPUTER_BUSY: another task of this Agent was using its browser until this call ended (%v): %w", ctx.Err(), errNotSent) //nolint:errorlint // the wait's end is detail; the call classifies as not sent only
	}
}

func (op *operation) markUnknown() { op.mu.Lock(); op.unknown = true; op.mu.Unlock() }

func (op *operation) startBrowser(ctx context.Context, endpoint, suffix string) (*mcpClient, error) {
	config := map[string]any{"browser": map[string]any{"cdpEndpoint": endpoint, "cdpTimeout": 30000}}
	return op.startPlaywright(ctx, config, nil, nil, suffix, process.Run)
}

// browserOutput is where Playwright writes this Operation's screenshots,
// downloads and page snapshots.
func (op *operation) browserOutput() string {
	sum := sha256.Sum256([]byte(op.directory))
	return filepath.Join(op.spec.WorkingDirectory, ".linger", "browser-output", hex.EncodeToString(sum[:8]))
}

func (op *operation) startPlaywright(ctx context.Context, config map[string]any, args, secrets []string, suffix string, run func(context.Context, *exec.Cmd, time.Duration) error) (*mcpClient, error) {
	if op.playwrightSocketsDir == "" {
		var err error
		if op.playwrightSocketsDir, err = playwrightSocketsDir(); err != nil {
			return nil, err
		}
	}
	return op.manager.startPlaywright(ctx, playwrightLaunch{config: config, args: args, secrets: secrets,
		configPath: filepath.Join(op.directory, "browser-"+suffix+".json"), socketsDir: op.playwrightSocketsDir,
		output: op.browserOutput(), cwd: op.spec.WorkingDirectory, run: run})
}

type playwrightLaunch struct {
	config                              map[string]any
	args, secrets                       []string
	configPath, socketsDir, output, cwd string
	run                                 func(context.Context, *exec.Cmd, time.Duration) error
}

// playwrightSocketsDir is the root Playwright appends a domain and socket
// name to. TMPDIR can contain a long Computer state path, exceeding Unix
// limits.
func playwrightSocketsDir() (string, error) {
	base := os.TempDir()
	if runtime.GOOS != "windows" {
		base = "/tmp"
	}
	return os.MkdirTemp(base, "linger-pw-")
}

func (m *Manager) startPlaywright(ctx context.Context, launch playwrightLaunch) (*mcpClient, error) {
	if err := privatefs.EnsureDir(launch.output); err != nil {
		return nil, err
	}
	launch.config["outputDir"] = launch.output
	data, _ := json.Marshal(launch.config)
	if err := privatefs.WriteFile(launch.configPath, data, false); err != nil {
		return nil, err
	}
	environment := append(append(append([]string{}, m.env...), "PWTEST_SOCKETS_DIR="+launch.socketsDir), launch.secrets...)
	argv := append([]string{m.options.PlaywrightEntry, "--config", launch.configPath}, launch.args...)
	return startClientWith(ctx, launch.run, m.options.NodePath, argv, launch.cwd, environment)
}

// describeBrowserMode tells the Agent which Chrome the browser tools drive,
// so it neither promises the user's logins nor asks for a debugging relaunch.
// A Computer that cannot connect the everyday browser, such as Linux, never
// suggests the connection card.
func describeBrowserMode(tools []tool, userChrome, chromeRequired, connectable bool) []tool {
	note := " Browser mode: a dedicated Agent Chrome profile, not the user's everyday Chrome, so the user's sign-ins are absent. To use their own signed-in Chrome when the task needs their sign-ins, run `teamhub browser connect` to post a connection card for them; never ask them for a token in a message, and never ask them to relaunch Chrome with --remote-debugging-port."
	switch {
	case !connectable:
		note = " Browser mode: a dedicated Agent Chrome profile, not the user's everyday browser, so the user's sign-ins are absent. This Computer cannot connect the user's everyday browser; when a task needs an account, ask the user to sign in inside this browser window, and never ask for a password or token in a message."
	case userChrome:
		note = " Browser mode: the user's own signed-in Chrome, through the Playwright Extension. Work in your own tab and act with the user's logins only as the task requires."
	case chromeRequired:
		note = " Browser mode: the user's own signed-in Chrome, which they have not connected yet. When a browser call returns BROWSER_CONNECTION_REQUIRED, run `teamhub browser connect` to post a connection card for them and end your turn; the card result wakes you. Never ask for a token in a message, and never switch to another browser or tool to avoid this."
	}
	for index := range tools {
		if tools[index].Name == "browser_navigate" || tools[index].Name == "browser_tabs" {
			tools[index].Description += note
		}
		if tools[index].Name == "browser_navigate" {
			tools[index].Description += siteSkillNote
		}
	}
	return tools
}

// siteSkillNote leaves the choice of tools on a site to a Skill written for
// it: sites that block automated browsers are used through the computer
// tools, and this browser leaves automation traces in their pages.
const siteSkillNote = " When a Skill covers the site, follow its choice of tools, even when it asks for the computer tools instead of these. A social network, a marketplace or another site that watches for automated browsers is used through the computer tools in the Computer's own browser, where the user signs in once, even when the user says they are signed in: never connect their everyday browser for such a site."

func filterBrowserTools(catalog []tool) []tool {
	var result []tool
	for _, item := range catalog {
		if browserTools[item.Name] {
			result = append(result, item)
		}
	}
	return result
}

func (op *operation) close() error {
	op.closeOnce.Do(func() {
		defer func() { op.mu.Lock(); op.cleanupFinished = true; op.mu.Unlock() }()
		op.mu.Lock()
		op.closing = true
		op.mu.Unlock()
		op.manager.mu.Lock()
		if op.manager.agentChromeOwner == op {
			op.manager.agentChromeOwner = nil
		}
		op.manager.mu.Unlock()
		op.cancel()
		for _, server := range op.servers {
			_ = server.server.Close()
		}
		op.active.Wait()
		browser := op.browser
		if session := op.userChromeSession; session != nil {
			// The session owns browser. One whose close is unconfirmed stays
			// with this task, so cleanup retries reach its original child.
			healthy := op.browserUnknown == nil && !op.userChromeRejected.Load()
			browser = nil
			if err := op.manager.releaseUserChrome(session, healthy); err != nil {
				op.closeErr = errors.Join(op.closeErr, err)
			} else {
				op.browser, op.userChromeSession = nil, nil
			}
		}
		// No call of this task runs any more, so its seat in the everyday
		// Chrome passes on once its Playwright child has stopped. A failing
		// cleanup step unrelated to that Chrome keeps this task for retries
		// but must not keep the owner's Chrome from every later task. A child
		// whose exit is unconfirmed keeps the seat: a second relay must not
		// take its place.
		if op.userChromeSession == nil {
			op.releaseChromeProfile()
		}
		op.closeErr = errors.Join(op.closeErr, op.browserCatalog.close(), browser.close())
		op.closeErr = errors.Join(op.closeErr, op.closeNativeProxy())
		if op.cua != nil {
			op.closeErr = errors.Join(op.closeErr, op.cua.close())
		}
		op.closeErr = errors.Join(op.closeErr, op.closeLinux())
		if op.closeErr == nil {
			op.closeErr = op.settleBrowserUnknown()
		} else if op.browserUnknown != nil {
			op.closeErr = errors.Join(op.closeErr, mcpproxy.ErrCleanupUnconfirmed)
		}
		op.mu.Lock()
		unknown := op.unknown
		op.mu.Unlock()
		if unknown && (op.cua == nil && op.linux == nil || op.closeErr != nil) {
			op.closeErr = errors.Join(op.closeErr, mcpproxy.ErrCleanupUnconfirmed)
		}
		if op.closeErr == nil {
			op.releaseDirectories()
		} else {
			// Bind can fail before publishing a tool server. Retain that
			// original owner too, without exposing a half-initialized op.
			op.manager.mu.Lock()
			op.manager.operations[op] = true
			op.manager.mu.Unlock()
		}
	})
	return op.closeErr
}

// Call only after every owned tool transport has confirmed cleanup.
func (op *operation) releaseDirectories() {
	_ = os.RemoveAll(op.directory)
	op.releaseSocketsDir()
	op.releaseChromeProfile()
	op.manager.mu.Lock()
	delete(op.manager.operations, op)
	op.manager.mu.Unlock()
}

func (op *operation) releaseSocketsDir() {
	if op.playwrightSocketsDir != "" {
		_ = os.RemoveAll(op.playwrightSocketsDir)
	}
}

func (m *Manager) Close() error {
	m.mu.Lock()
	ops := make([]*operation, 0, len(m.operations))
	for op := range m.operations {
		ops = append(ops, op)
	}
	m.mu.Unlock()
	var errs []error
	for _, op := range ops {
		errs = append(errs, op.close())
		// Each Operation owns only its stdio proxy; the shared service stops
		// once below, after every proxy closed.
		if op.cua != nil {
			errs = append(errs, op.cua.client.close())
		}
	}
	errs = append(errs, m.closeUserChrome())
	// A trusted embedding host owns its Cua service and stops it itself.
	if !m.options.CuaEmbedded {
		m.stopCuaGrant()
		errs = append(errs, m.stopCuaService())
	}
	m.mu.Lock()
	for _, browser := range m.browsers {
		stopErr := browser.close()
		errs = append(errs, stopErr)
		if stopErr == nil {
			for _, op := range ops {
				if op.nativeBrowser == browser {
					op.mu.Lock()
					errs = append(errs, op.browserUnknown.finish(true))
					op.mu.Unlock()
				}
			}
		}
	}
	m.mu.Unlock()
	return errors.Join(errs...)
}

func cleanupContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 10*time.Second)
}

// browserTools comes from the pinned official catalog. Do not grant new tools
// merely because a package adds one in a later release.
var browserTools = map[string]bool{"browser_close": true, "browser_resize": true, "browser_console_messages": true, "browser_handle_dialog": true, "browser_file_upload": true, "browser_fill_form": true, "browser_press_key": true, "browser_type": true, "browser_navigate": true, "browser_navigate_back": true, "browser_network_requests": true, "browser_take_screenshot": true, "browser_snapshot": true, "browser_click": true, "browser_drag": true, "browser_hover": true, "browser_select_option": true, "browser_tabs": true, "browser_wait_for": true}

// ended reports whether the Operation has begun to close.
func (op *operation) ended() bool {
	op.mu.Lock()
	defer op.mu.Unlock()
	return op.closing
}
