package localtools

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

// agentChromeWait bounds how long the Computer's own browser may take to start or
// to show an opened page in its address bar.
var agentChromeWait = 10 * time.Second

func (c *cuaSession) agentBrowserDirectory(b agentBrowser) string {
	return filepath.Join(c.op.manager.options.StateDirectory, "computer-tools", b.Directory)
}

// agentChromePID finds the main process of the browser whose profile is
// directory and returns its pid and command line, or 0 when none runs. Its
// helper and content processes name the profile too, with a process type.
var agentChromePID = func(ctx context.Context, directory string) (int, string, error) {
	output, err := exec.CommandContext(ctx, "/bin/ps", "-axww", "-o", "pid=,args=").Output()
	if err != nil {
		return 0, "", err
	}
	for _, line := range strings.Split(string(output), "\n") {
		pidText, args, _ := strings.Cut(strings.TrimSpace(line), " ")
		if !strings.Contains(args, directory) || strings.Contains(args, "--type=") || strings.Contains(args, "-contentproc") {
			continue
		}
		if pid, err := strconv.Atoi(pidText); err == nil {
			return pid, args, nil
		}
	}
	return 0, "", nil
}

// launchAgentChrome opens urls in the Computer's own browser b. Starting it
// brings its first window forward once, where the user is. Later URLs open
// in a new tab through the window's accessibility tree and one Return key to
// that browser alone, so the user's apps, focus and Space stay as they are.
func (c *cuaSession) launchAgentChrome(ctx context.Context, b agentBrowser, urls []string) (json.RawMessage, error) {
	var sites []string
	for _, address := range urls {
		if site := siteOf(address); site != "" {
			sites = append(sites, site)
		}
	}
	if err := c.op.manager.coolingSite(sites); err != nil {
		return nil, err
	}
	if err := c.claimAgentChrome(); err != nil {
		return nil, err
	}
	c.op.mu.Lock()
	c.op.addChromeSites(sites)
	c.op.mu.Unlock()
	// Opening a URL is input to that browser: a stopped task opens none.
	if _, err := c.paceAgentChrome(ctx, 0); err != nil {
		return nil, err
	}
	if b.Shared {
		return c.launchAgentSafari(ctx, b, urls)
	}
	directory := c.agentBrowserDirectory(b)
	if err := privatefs.EnsureDir(directory); err != nil {
		return nil, err
	}
	if b.Prepare != nil {
		if err := b.Prepare(directory); err != nil {
			return nil, err
		}
	}
	pid, command, err := agentChromePID(ctx, directory)
	if err != nil {
		return nil, err
	}
	if pid > 0 && !b.startedWith(command) {
		// An instance on this profile started without every setting the
		// tools rely on, such as the English interface. It is the Computer's
		// own and leased to this task, so quit it once and start it again.
		if pid, err = stopAgentChrome(ctx, directory, pid); err != nil {
			return nil, err
		}
	}
	var windows []listedWindow
	if pid > 0 {
		if windows, err = c.appWindows(ctx, pid); err != nil {
			return nil, err
		}
	}
	started := pid == 0 || len(windows) == 0
	if started {
		// A running instance without a window opens one for the same
		// command. The command opens no URL: the browser would put its first
		// tab in front, so each URL opens below as a new tab, the last one in
		// front.
		args := append([]string{"-g", "-n", "-b", b.Bundle, "--args"}, b.Args(directory)...)
		if output, err := exec.CommandContext(ctx, "/usr/bin/open", args...).CombinedOutput(); err != nil {
			return nil, fmt.Errorf("launch_app: %s: %w", strings.TrimSpace(string(output)), err)
		}
		deadline := time.Now().Add(agentChromeWait)
		for len(windows) == 0 {
			if time.Now().After(deadline) {
				return nil, fmt.Errorf("launch_app: the Computer's %s did not open a window", b.Name)
			}
			if err := sleepContext(ctx, 200*time.Millisecond); err != nil {
				return nil, err
			}
			if pid, _, err = agentChromePID(ctx, directory); err != nil {
				return nil, err
			}
			if pid > 0 {
				if windows, err = c.appWindows(ctx, pid); err != nil {
					return nil, err
				}
			}
		}
	}
	// Bubbles such as the translate or permission prompts are small extra
	// windows of the same pid, so the browser window is the largest one.
	window := slices.MaxFunc(windows, func(a, b listedWindow) int {
		return cmp.Compare(a.Bounds.Width*a.Bounds.Height, b.Bounds.Width*b.Bounds.Height)
	})
	// A just-started window shows its tab strip a moment after it appears.
	for deadline := time.Now().Add(agentChromeWait); started && len(urls) > 0 && c.agentChromeTabs(ctx, pid, window.WindowID) == 0; {
		if time.Now().After(deadline) {
			if offSpace(window) {
				return nil, errAgentChromeOffSpace
			}
			return nil, fmt.Errorf("launch_app: the Computer's %s window shows no tab", b.Name)
		}
		if err := sleepContext(ctx, 200*time.Millisecond); err != nil {
			return nil, err
		}
	}
	for i, url := range urls {
		// A browser this call started shows only its start page, which for
		// Chromium is the "(en-US)" of -AppleLanguages read as a URL, so the
		// first URL replaces it instead of leaving a stray tab behind.
		open := c.agentChromeOpenTab
		if started && i == 0 {
			open = c.agentChromeLoad
		}
		if err := open(ctx, b, pid, window.WindowID, offSpace(window), url); err != nil {
			return nil, err
		}
	}
	note := "This is the Computer's own " + b.Name + ", separate from the user's everyday browser and with its own sign-ins. It works while other windows cover it, but only on the desktop (Space) the user is on. Keys without an element, such as escape, go to it in the background; the Computer never brings it forward for them. Only a click with delivery_mode foreground brings it forward: use one only where a control takes only a real pointer, and tell the user first. Type into a page field with type_text and the field's element_token: pressing an element does not move the keyboard focus, so keys without one can land in the address bar. Close a tab with the Close button of its tab, not cmd+w. If a site asks to sign in, ask the user to sign in once in this window."
	if started {
		note = "Started the Computer's own " + b.Name + "; its window came forward once. " + note
	}
	m := c.op.manager
	m.mu.Lock()
	m.agentChromePID, m.agentChromeChecked = pid, time.Now()
	m.mu.Unlock()
	tabs := c.agentChromeTabs(ctx, pid, window.WindowID)
	c.op.mu.Lock()
	c.op.chromeTabs, c.op.chromePID, c.op.chromeWindow = tabs, pid, window.WindowID
	c.op.mu.Unlock()
	opened := "No URL was opened, so no tab is this task's."
	if len(urls) > 0 {
		opened = "The last one is this task's and in front; pass tabs to a Skill script that checks it."
	}
	text := fmt.Sprintf("Opened %d URL(s) in the Computer's own %s (pid %d), window %q [window_id: %v]. The window has %d tab(s). %s\n%s", len(urls), b.Name, pid, window.Title, window.WindowID, tabs, opened, note)
	return json.Marshal(map[string]any{"content": []any{map[string]string{"type": "text", "text": text}},
		"structuredContent": map[string]any{"browser": b.Name, "pid": pid, "windows": []map[string]any{{"window_id": window.WindowID, "title": window.Title, "on_screen": window.IsOnScreen}}, "tabs": tabs, "note": note}})
}

// agentChromeOpenTab opens url in a new tab of window: cmd+t and Return go
// to this Chrome only, and the address bar takes the URL as its value.
// Chrome's address bar ignores the accessibility confirm action. This Chrome
// has one window, so Cua delivers its keys even while it is covered, once
// the window's accessibility tree has been read.
func (c *cuaSession) agentChromeOpenTab(ctx context.Context, b agentBrowser, pid int, window float64, elsewhere bool, url string) error {
	// Each step must have worked, and a new tab must show, before the address
	// bar is set: otherwise the URL would replace the page of a tab already open.
	// A window that macOS has not shown for a while answers its first reads
	// with an empty tree, so the reads repeat for a while before giving up.
	before := c.agentChromeTabsUntil(ctx, pid, window, agentChromeWait, func(n int) bool { return n > 0 })
	if before == 0 && elsewhere {
		return errAgentChromeOffSpace
	}
	if before == 0 {
		return fmt.Errorf("COMPUTER_INPUT_NOT_SENT: the Computer's own browser tab strip could not be read, so no tab was opened: %w", errNotSent)
	}
	step := func(result json.RawMessage, err error) error {
		if err == nil && failed(result) {
			err = fmt.Errorf("COMPUTER_INPUT_NOT_SENT: the Computer's own browser refused a step of opening a tab: %s: %w", strings.TrimSpace(string(result)), errNotSent)
		}
		return err
	}
	if err := step(c.agentChromeKey(ctx, pid, window, "hotkey", map[string]any{"keys": []string{"cmd", "t"}})); err != nil {
		return err
	}
	if after := c.agentChromeTabsUntil(ctx, pid, window, 4*time.Second, func(n int) bool { return n == before+1 }); after != before+1 {
		return fmt.Errorf("COMPUTER_INPUT_NOT_SENT: no new tab opened in the Computer's own browser (%d tab(s) before, %d after), so no URL was opened: %w", before, after, errNotSent)
	}
	return c.agentChromeLoad(ctx, b, pid, window, elsewhere, url)
}

// agentChromeLoad opens url in the front tab of window through its address bar.
func (c *cuaSession) agentChromeLoad(ctx context.Context, b agentBrowser, pid int, window float64, _ bool, url string) error {
	step := func(result json.RawMessage, err error) error {
		if err == nil && failed(result) {
			err = fmt.Errorf("COMPUTER_INPUT_NOT_SENT: the Computer's own browser refused a step of opening a URL: %s: %w", strings.TrimSpace(string(result)), errNotSent)
		}
		return err
	}
	if err := step(c.agentChromePress(ctx, b, pid, window, "set_value", map[string]any{"value": url})); err != nil {
		return err
	}
	if err := step(c.agentChromeKey(ctx, pid, window, "press_key", map[string]any{"key": "return"})); err != nil {
		return err
	}
	return sleepContext(ctx, inputSettle)
}

// errAgentChromeOffSpace refuses work in the Computer's own browser while its
// window is on another Space and reads as empty. A window whose tree was read
// while the user saw it stays readable from another Space; one that never was
// reads as empty there, and Cua refuses keys to it. Covered by other windows
// on the user's Space is fine.
var errAgentChromeOffSpace = fmt.Errorf("COMPUTER_WINDOW_OFF_SPACE: the Computer's own browser window is on another desktop (Space) than the one the user is on, and macOS gives the tools no view of it there; nothing was sent. Ask the user to move that window to the desktop they are on, for example by dragging it in Mission Control; it may stay behind other windows, and Chrome keeps it on that desktop after a restart: %w", errNotSent)

func offSpace(window listedWindow) bool {
	return window.OnCurrentSpace != nil && !*window.OnCurrentSpace
}

// wakeAgentChrome readies the window a Skill script names, when it is the
// Computer's own Chrome and macOS does not show it: such a window can answer
// its first reads with an empty tree, which the script would take for a page
// that changed, so it is read until the tab strip shows, for a few seconds at
// most. A window on another Space that still reads as empty refuses the script.
func (c *cuaSession) wakeAgentChrome(ctx context.Context, pid, window any) error {
	number, ok := pid.(float64)
	id, hasWindow := window.(float64)
	if !ok || !hasWindow {
		return nil
	}
	if own, err := c.isAgentChrome(ctx, number, id); err != nil || !own {
		return err
	}
	windows, err := c.appWindows(ctx, number)
	if err != nil {
		return err
	}
	index := slices.IndexFunc(windows, func(w listedWindow) bool { return w.WindowID == id })
	if index < 0 || windows[index].IsOnScreen {
		return nil
	}
	if c.agentChromeTabsUntil(ctx, int(number), id, 5*time.Second, func(n int) bool { return n > 0 }) == 0 && offSpace(windows[index]) {
		return errAgentChromeOffSpace
	}
	return nil
}

// agentChromeTabsUntil reads the tab count of window until done accepts it
// or wait passes, and returns the last count.
func (c *cuaSession) agentChromeTabsUntil(ctx context.Context, pid int, window float64, wait time.Duration, done func(int) bool) int {
	deadline := time.Now().Add(wait)
	for {
		if err := sleepContext(ctx, inputSettle); err != nil {
			return 0
		}
		count := c.agentChromeTabs(ctx, pid, window)
		if done(count) || time.Now().After(deadline) {
			return count
		}
	}
}

// agentChromeKey sends a key tool to window in the background. Cua refuses
// keys to a window whose accessibility tree it has not resolved yet, which
// happens for a window that macOS has not shown for a while; a refused key
// was not sent, so it is sent again after a read resolves the tree.
func (c *cuaSession) agentChromeKey(ctx context.Context, pid int, window float64, tool string, extra map[string]any) (json.RawMessage, error) {
	arguments := map[string]any{"pid": pid, "window_id": window, "session": c.label}
	for key, value := range extra {
		arguments[key] = value
	}
	for attempt := 0; ; attempt++ {
		result, err := c.client.request(ctx, "tools/call", map[string]any{"name": tool, "arguments": arguments})
		if err != nil || !failed(result) || attempt == 2 || !strings.Contains(string(result), "off_space_or_ax_unresolved") {
			return result, err
		}
		if err := sleepContext(ctx, inputSettle); err != nil {
			return nil, err
		}
		c.agentChromeTabs(ctx, pid, window)
	}
}

// agentChromePress reads window and sends tool to the address bar of b,
// found by its role and label or by its identifier. The browser's own
// controls can follow the page in the tree, so the read is not cut short.
func (c *cuaSession) agentChromePress(ctx context.Context, b agentBrowser, pid int, window float64, tool string, extra map[string]any) (json.RawMessage, error) {
	role, label := b.AddressRole, b.AddressLabel
	send := func(token string) (json.RawMessage, error) {
		arguments := map[string]any{"pid": pid, "window_id": window, "element_token": token, "session": c.label}
		for key, value := range extra {
			arguments[key] = value
		}
		return c.client.request(ctx, "tools/call", map[string]any{"name": tool, "arguments": arguments})
	}
	if b.AddressID != "" {
		read, err := c.client.request(ctx, "tools/call", map[string]any{"name": "get_window_state", "arguments": map[string]any{
			"pid": pid, "window_id": window, "include_screenshot": false, "max_elements": 6000, "timeout_ms": 6000, "session": c.label}})
		if err != nil {
			return nil, err
		}
		var state struct {
			Structured struct {
				Tree     string `json:"tree_markdown"`
				Snapshot string `json:"snapshot_id"`
			} `json:"structuredContent"`
		}
		_ = json.Unmarshal(read, &state)
		for _, row := range strings.Split(state.Structured.Tree, "\n") {
			index, rest, ok := strings.Cut(strings.TrimLeft(row, " -["), "] "+role)
			if ok && strings.Contains(rest, "id="+b.AddressID) && state.Structured.Snapshot != "" {
				return send(state.Structured.Snapshot + ":" + index)
			}
		}
		return nil, fmt.Errorf("launch_app: the Computer's %s shows no address bar", b.Name)
	}
	read, err := c.client.request(ctx, "tools/call", map[string]any{"name": "get_window_state", "arguments": map[string]any{
		"pid": pid, "window_id": window, "tree_format": "elements", "include_screenshot": false, "max_elements": 3000, "timeout_ms": 4000, "session": c.label}})
	if err != nil {
		return nil, err
	}
	var state struct {
		Structured struct {
			Elements []struct {
				Token string `json:"element_token"`
				Role  string `json:"role"`
				Label string `json:"label"`
			} `json:"elements"`
		} `json:"structuredContent"`
	}
	_ = json.Unmarshal(read, &state)
	for _, element := range state.Structured.Elements {
		if element.Role != role || label != "" && element.Label != label {
			continue
		}
		return send(element.Token)
	}
	return nil, fmt.Errorf("launch_app: the Computer's %s shows no %s %q", b.Name, role, label)
}

// agentChromeRecheck bounds how long the Computer trusts its record of the
// pid of its own Chrome, which a restart of that Chrome changes.
var agentChromeRecheck = 30 * time.Second

// isAgentChrome reports whether pid is the Computer's own browser. Only a
// recent match is taken from the cache: any other pid is looked up again,
// because the Computer's own browser gets a new pid when it restarts. A failed
// lookup refuses the input instead of treating the app as another one.
//
// In the user's Safari only the window the Computer opened is its own; an
// input that names no window goes to that window.
func (c *cuaSession) isAgentChrome(ctx context.Context, pid, window any) (bool, error) {
	number, ok := pid.(float64)
	if !ok || runtime.GOOS != "darwin" {
		return false, nil
	}
	m := c.op.manager
	m.mu.Lock()
	known, checked := m.agentChromePID, m.agentChromeChecked
	safari, safariWindow := m.agentSafariPID, m.agentSafariWindow
	m.mu.Unlock()
	if safari > 0 && safari == int(number) {
		id, named := window.(float64)
		return !named || id == safariWindow, nil
	}
	if known > 0 && known == int(number) && time.Since(checked) < agentChromeRecheck {
		return true, nil
	}
	own, err := c.ownBrowserPIDs(ctx)
	if err != nil {
		return false, err
	}
	return slices.Contains(own, int(number)), nil
}

// ownBrowserPIDs returns the pids of the Computer's own browsers that run on
// their own profiles.
func (c *cuaSession) ownBrowserPIDs(ctx context.Context) ([]int, error) {
	var own []int
	for _, b := range agentBrowsers {
		if b.Shared {
			continue
		}
		pid, _, err := agentChromePID(ctx, c.agentBrowserDirectory(b))
		if err != nil {
			return nil, fmt.Errorf("COMPUTER_INPUT_NOT_SENT: could not tell whether the Computer's own browser runs: %w: %w", err, errNotSent)
		}
		if pid > 0 {
			own = append(own, pid)
		}
	}
	return own, nil
}

// agentChromeTarget names the browser window this task opened with
// launch_app, as the target of a script that names none, or nil when the
// task opened none.
func (c *cuaSession) agentChromeTarget() map[string]any {
	c.op.mu.Lock()
	defer c.op.mu.Unlock()
	if c.op.chromePID == 0 {
		return nil
	}
	return map[string]any{"pid": float64(c.op.chromePID), "window_id": c.op.chromeWindow}
}

// agentChromeRunning returns the pid of a running own browser of the
// Computer, or 0. One task at a time holds them all, so any one will do.
func (c *cuaSession) agentChromeRunning(ctx context.Context) (int, error) {
	pids, err := c.ownBrowserPIDs(ctx)
	if err != nil {
		return 0, err
	}
	own := 0
	if len(pids) > 0 {
		own = pids[0]
	}
	m := c.op.manager
	m.mu.Lock()
	safari := m.agentSafariPID
	m.mu.Unlock()
	if own == 0 && safari > 0 {
		if running, _ := lsappPID(ctx, "com.apple.Safari"); running == safari {
			return safari, nil
		}
	}
	m.mu.Lock()
	m.agentChromePID, m.agentChromeChecked = own, time.Now()
	m.mu.Unlock()
	return own, nil
}

// stopAgentChrome quits the Computer's own browser and waits until it is
// gone, so it can start again with the current arguments.
func stopAgentChrome(ctx context.Context, directory string, pid int) (int, error) {
	process, err := os.FindProcess(pid)
	if err == nil {
		err = process.Signal(syscall.SIGTERM)
	}
	if err != nil {
		return 0, fmt.Errorf("launch_app: quit the Computer's own browser: %w", err)
	}
	deadline := time.Now().Add(agentChromeWait)
	for {
		running, _, err := agentChromePID(ctx, directory)
		if err != nil || running == 0 {
			return 0, err
		}
		if time.Now().After(deadline) {
			return 0, errors.New("launch_app: the Computer's own browser did not quit to restart muted")
		}
		if err := sleepContext(ctx, 200*time.Millisecond); err != nil {
			return 0, err
		}
	}
}

// claimAgentChrome gives the Computer's own browser to one Operation at a
// time, until that Operation ends: two tasks in one window would click into
// each other's tab, and a task closes or reuses only the tab it opened.
func (c *cuaSession) claimAgentChrome() error {
	m := c.op.manager
	m.mu.Lock()
	defer m.mu.Unlock()
	if owner := m.agentChromeOwner; owner != nil && owner != c.op && !owner.ended() {
		return fmt.Errorf("COMPUTER_BUSY: another task is using the Computer's own browser until it ends; nothing was sent. Tell the user and try again later: %w", errNotSent)
	}
	m.agentChromeOwner = c.op
	return nil
}

// agentChromeKeys sends keys without an element to the Computer's own browser
// in the background: to the window the Agent named, or else to its browser
// window, the largest one. If Cua refuses background keys there, the refusal
// is the result; the window is never brought forward instead.
func (c *cuaSession) agentChromeKeys(ctx context.Context, arguments map[string]any) error {
	delete(arguments, "delivery_mode")
	if _, ok := arguments["window_id"].(float64); ok {
		return nil
	}
	m := c.op.manager
	m.mu.Lock()
	safari, safariWindow := m.agentSafariPID, m.agentSafariWindow
	m.mu.Unlock()
	if pid, ok := arguments["pid"].(float64); ok && safari > 0 && int(pid) == safari {
		arguments["window_id"] = safariWindow
		return nil
	}
	windows, err := c.appWindows(ctx, arguments["pid"])
	if err != nil {
		return err
	}
	if len(windows) == 0 {
		return fmt.Errorf("COMPUTER_WINDOW_NOT_FOUND: the Computer's own browser with pid %v shows no window: %w", arguments["pid"], errNotSent)
	}
	arguments["window_id"] = slices.MaxFunc(windows, func(a, b listedWindow) int {
		return cmp.Compare(a.Bounds.Width*a.Bounds.Height, b.Bounds.Width*b.Bounds.Height)
	}).WindowID
	return nil
}

// agentChromeTabs counts the tabs of window: each tab in Chrome's tab strip
// is a radio button with its own Close button. It returns 0 when the strip
// cannot be read.
// It returns 0 when the read fails or is cut short: the tab strip follows the
// page in the tree, so a cut read may miss it.
func (c *cuaSession) agentChromeTabs(ctx context.Context, pid int, window float64) int {
	read, err := c.client.request(ctx, "tools/call", map[string]any{"name": "get_window_state", "arguments": map[string]any{
		"pid": pid, "window_id": window, "include_screenshot": false, "max_elements": 6000, "timeout_ms": 6000, "session": c.label}})
	if err != nil {
		slog.Warn("agent_browser.tabs_unread", "pid", pid, "window_id", window, "error", err)
		return 0
	}
	var state struct {
		Structured struct {
			Tree      string `json:"tree_markdown"`
			Truncated bool   `json:"truncated"`
			Degraded  string `json:"degraded_reason"`
		} `json:"structuredContent"`
	}
	if err := json.Unmarshal(read, &state); err != nil || state.Structured.Truncated {
		slog.Warn("agent_browser.tabs_unread", "pid", pid, "window_id", window, "truncated", state.Structured.Truncated, "error", err)
		return 0
	}
	count := countTabs(state.Structured.Tree)
	if count == 0 && strings.Contains(state.Structured.Tree, "id=WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD") {
		// Safari hides its tab strip while a window has one tab.
		count = 1
	}
	if count == 0 && state.Structured.Degraded != "" {
		slog.Warn("agent_browser.tabs_unread", "pid", pid, "window_id", window, "reason", state.Structured.Degraded)
	}
	return count
}

// countTabs counts the tab rows of a browser window's tree: a radio button
// whose next row, or a row nested under it, is a Close or Close tab button.
func countTabs(tree string) int {
	rows := strings.Split(tree, "\n")
	indent := func(row string) int { return len(row) - len(strings.TrimLeft(row, " ")) }
	count := 0
	for i, row := range rows {
		if !strings.Contains(row, "] AXRadioButton \"") {
			continue
		}
		if strings.Contains(row, "id=TabBarTab") {
			// A Safari tab carries its close action itself.
			count++
			continue
		}
		for j, next := range rows[i+1:] {
			if j > 0 && indent(next) <= indent(row) {
				break
			}
			if trimmed := strings.TrimSpace(next); strings.HasSuffix(trimmed, `AXButton "Close" [actions=[press]]`) || strings.HasSuffix(trimmed, `AXButton "Close tab" [actions=[press]]`) {
				count++
				break
			}
		}
	}
	return count
}

// agentChromeTabWindow names the window whose tabs hold the task: the one
// it opened with launch_app, when an input goes to that browser and names
// no other window. An input to another app or window, such as one of the
// user's own Safari windows, is not held.
func (c *cuaSession) agentChromeTabWindow(pid, window any) (int, float64, bool) {
	c.op.mu.Lock()
	own, ownWindow := c.op.chromePID, c.op.chromeWindow
	c.op.mu.Unlock()
	number, ok := pid.(float64)
	if !ok || own == 0 || int(number) != own {
		return 0, 0, false
	}
	if id, ok := window.(float64); ok && id != ownWindow {
		return 0, 0, false
	}
	return own, ownWindow, true
}

// checkAgentChromeTabs holds the task to the tabs it left: the Computer's
// own Chrome keeps the tab count that followed this task's last input, so a
// different count means someone else opened or closed a tab, and the tab in
// front may not be this task's. The task then stops, as after a reported
// check. A strip that cannot be read, or a task that has no count yet, is not
// held.
func (c *cuaSession) checkAgentChromeTabs(ctx context.Context, pid, window any) error {
	c.op.mu.Lock()
	want := c.op.chromeTabs
	c.op.mu.Unlock()
	if want == 0 {
		return nil
	}
	number, id, ok := c.agentChromeTabWindow(pid, window)
	if !ok {
		return nil
	}
	got := c.agentChromeTabs(ctx, number, id)
	if got == 0 || got == want {
		return nil
	}
	c.op.mu.Lock()
	c.op.chromeBlocked = "a change of tabs"
	c.op.mu.Unlock()
	return fmt.Errorf("COMPUTER_TAB_CHANGED: the Computer's own browser had %d tab(s) after this task's last input and has %d now, so someone else opened or closed a tab and the tab in front may not be this task's; nothing was sent. Tell the user and end the task: %w", want, got, errNotSent)
}

// recordAgentChromeTabs keeps the tab count after this task's own input or
// script, so a tab it opened or closed, such as a link to a new tab, is the
// task's. While it runs, the task holds this browser's input lease, so no
// other task changes the tabs. Only a task that opened its tab with
// launch_app holds a count.
func (c *cuaSession) recordAgentChromeTabs(ctx context.Context, pid, window any) {
	c.op.mu.Lock()
	held := c.op.chromeTabs > 0
	c.op.mu.Unlock()
	if !held {
		return
	}
	if got := c.settledAgentChromeTabs(ctx, pid, window); got > 0 {
		c.op.mu.Lock()
		c.op.chromeTabs = got
		c.op.mu.Unlock()
	}
}

// settledAgentChromeTabs reads the window's tab count once two reads a
// settle apart agree: the browser adds or drops a tab a moment after the
// input that opened or closed it returns, and the next input's pause already
// covers that wait. It is 0 when the strip cannot be read.
func (c *cuaSession) settledAgentChromeTabs(ctx context.Context, pid, window any) int {
	number, id, ok := c.agentChromeTabWindow(pid, window)
	if !ok {
		return 0
	}
	got := c.agentChromeTabs(ctx, number, id)
	for range 3 {
		if got == 0 || sleepContext(ctx, inputSettle) != nil {
			break
		}
		next := c.agentChromeTabs(ctx, number, id)
		if next == got {
			break
		}
		got = next
	}
	return got
}
