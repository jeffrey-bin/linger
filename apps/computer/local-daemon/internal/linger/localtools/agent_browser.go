package localtools

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

// agentBrowser is one browser the Computer can run as its own: a separate
// instance on a profile of its own, with no remote debugging, so sites see a
// person's browser and the user's everyday browser stays untouched.
type agentBrowser struct {
	// Name is how messages and the model name the browser.
	Name string
	// Bundle is its macOS bundle id, and App the app folder in Applications.
	Bundle, App string
	// Directory is the profile's folder under computer-tools.
	Directory string
	// Args start the browser on profile, after open's --args.
	Args func(profile string) []string
	// Settings are what a running instance's command line must carry for
	// the tools to rely on it; one without them is restarted.
	Settings []string
	// AddressRole and AddressLabel find the address bar; an empty label
	// takes the first element with that role, which in the browser's
	// toolbar comes before the page.
	AddressRole, AddressLabel string
	// AddressID finds the address bar by its accessibility identifier
	// instead, where the name follows the user's language.
	AddressID string
	// Prepare writes the profile's own settings before a start.
	Prepare func(profile string) error
	// Shared marks a browser that runs only as the user's own instance, as
	// Safari does: it has no separate profile, so the Computer works in a
	// window of its own there, with the user's sign-ins.
	Shared bool
}

// chromiumArgs start a Chromium browser as the Computer's own. Without
// --disable-backgrounding-occluded-windows Chromium stops painting and
// updating the accessibility tree of a window that is covered or on another
// Space, so a page loaded there reads as empty. With it, the window keeps
// working wherever the user puts it.
// Translate is off so its prompt does not open as an extra window, and the
// audio is muted, so a video page read in the background stays silent.
// --use-mock-keychain keeps sign-ins: Chromium encrypts cookies with a key
// from the login keychain, and when that keychain is locked, as it can be
// for a daemon, it keeps cookies in memory only and every restart signs the
// user out. The profile directory is private to the user instead.
// Chromium takes its interface language from macOS, and the tools find the
// address bar and tab buttons by their English names, so the command pins
// English. Chromium also opens that setting's value, "(en-US)", as the first
// tab: it stays as the window's spare tab, so closing the last opened page
// with its tab keeps the window and the next URL does not start it again.
var chromiumArgs = []string{"--disable-backgrounding-occluded-windows", "--disable-features=Translate", "--mute-audio", "--no-first-run", "--no-default-browser-check", "--use-mock-keychain"}

func chromium(profile string) []string {
	return append(append([]string{"--user-data-dir=" + profile}, chromiumArgs...), "-AppleLanguages", "(en-US)")
}

// firefoxPrefs skip Firefox's first-run pages and prompts, which would open
// as extra tabs or bars, pin the English interface the tools read, and keep
// pages silent.
const firefoxPrefs = `user_pref("browser.aboutwelcome.enabled", false);
user_pref("trailhead.firstrun.didSeeAboutWelcome", true);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("termsofuse.bypassNotification", true);
user_pref("intl.locale.requested", "en-US");
user_pref("browser.tabs.warnOnClose", false);
user_pref("browser.translations.automaticallyPopup", false);
user_pref("media.autoplay.default", 5);
`

var agentBrowsers = []agentBrowser{
	{Name: "Chrome", Bundle: "com.google.Chrome", App: "Google Chrome.app", Directory: "agent-chrome", Args: chromium,
		Settings: append(slices.Clone(chromiumArgs), "-AppleLanguages"), AddressRole: "AXTextField", AddressLabel: "Address and search bar"},
	{Name: "Edge", Bundle: "com.microsoft.edgemac", App: "Microsoft Edge.app", Directory: "agent-edge", Args: chromium,
		Settings: append(slices.Clone(chromiumArgs), "-AppleLanguages"), AddressRole: "AXTextField", AddressLabel: "Address and search bar"},
	// Firefox keeps its window working while covered without a flag. Its
	// address bar is the toolbar's only combo box, and its name follows the
	// search engine, so the role alone finds it.
	{Name: "Firefox", Bundle: "org.mozilla.firefox", App: "Firefox.app", Directory: "agent-firefox",
		Args:     func(profile string) []string { return []string{"-profile", profile, "-no-remote"} },
		Settings: []string{"-no-remote"}, AddressRole: "AXComboBox",
		Prepare: func(profile string) error {
			return privatefs.WriteFile(filepath.Join(profile, "user.js"), []byte(firefoxPrefs), false)
		}},
	// Safari keeps one instance with the user's data, so it comes last: the
	// Computer opens a window of its own in it.
	{Name: "Safari", Bundle: "com.apple.Safari", App: "Safari.app", AddressRole: "AXTextField", AddressID: "WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD", Shared: true},
}

// agentBrowserInstalled reports whether the app of b is in Applications.
var agentBrowserInstalled = func(b agentBrowser) bool {
	folders := []string{"/Applications", "/System/Cryptexes/App/System/Applications"}
	if home, err := os.UserHomeDir(); err == nil {
		folders = append(folders, filepath.Join(home, "Applications"))
	}
	for _, folder := range folders {
		if _, err := os.Stat(filepath.Join(folder, b.App)); err == nil {
			return true
		}
	}
	return false
}

// pickAgentBrowser returns the browser launch_app named by bundle id, or
// with none the first installed one, so a user without Chrome is served by
// the browser they have.
func pickAgentBrowser(bundle string) (agentBrowser, error) {
	names := make([]string, 0, len(agentBrowsers))
	for _, b := range agentBrowsers {
		names = append(names, b.Bundle)
		if bundle == b.Bundle || bundle == "" && agentBrowserInstalled(b) {
			return b, nil
		}
	}
	if bundle != "" {
		return agentBrowser{}, errors.New("launch_app agent_browser takes bundle_id " + strings.Join(names, ", ") + ", or none to use the first one installed")
	}
	return agentBrowser{}, errors.New("COMPUTER_BROWSER_UNAVAILABLE: none of Google Chrome, Microsoft Edge, Firefox or Safari was found; ask the user to install one of them")
}

// agentBrowserApp reports whether a launch_app call names an app that runs
// as one of the Computer's own browsers.
func agentBrowserApp(bundle, name string) bool {
	for _, b := range agentBrowsers {
		if bundle == b.Bundle || name != "" && strings.Contains(strings.ToLower(b.App), strings.ToLower(name)) {
			return true
		}
	}
	return false
}

// startedWith reports whether a running instance's command line carries
// every setting the Computer starts b with.
func (b agentBrowser) startedWith(command string) bool {
	for _, setting := range b.Settings {
		if !strings.Contains(command, setting) {
			return false
		}
	}
	return true
}

// launchAgentSafari opens urls in the Computer's own window of the user's
// Safari: the window this task or an earlier one opened there, or a new one.
// Each URL opens in a new tab of that window, as in the other browsers, and
// the window's first tab stays as its spare tab.
// agentSafariWindowWait bounds the wait for a new Safari window to become
// readable.
var agentSafariWindowWait = 30 * time.Second

func (c *cuaSession) launchAgentSafari(ctx context.Context, b agentBrowser, urls []string) (json.RawMessage, error) {
	m := c.op.manager
	pid, _ := lsappPID(ctx, b.Bundle)
	started := pid == 0
	if started {
		if output, err := exec.CommandContext(ctx, "/usr/bin/open", "-g", "-b", b.Bundle).CombinedOutput(); err != nil {
			return nil, fmt.Errorf("launch_app: %s: %w", strings.TrimSpace(string(output)), err)
		}
	}
	windows, pid, err := c.waitSafariWindows(ctx, b, pid, func([]listedWindow) bool { return true })
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	own := m.agentSafariWindow
	if m.agentSafariPID != pid {
		own = 0
	}
	m.mu.Unlock()
	index := slices.IndexFunc(windows, func(w listedWindow) bool { return w.WindowID == own })
	if index < 0 {
		before := map[float64]bool{}
		for _, w := range windows {
			before[w.WindowID] = true
		}
		if len(windows) == 0 {
			// Opening the app again makes Safari show a window.
			if output, err := exec.CommandContext(ctx, "/usr/bin/open", "-g", "-b", b.Bundle).CombinedOutput(); err != nil {
				return nil, fmt.Errorf("launch_app: %s: %w", strings.TrimSpace(string(output)), err)
			}
		} else {
			largest := slices.MaxFunc(windows, func(a, b listedWindow) int {
				return cmp.Compare(a.Bounds.Width*a.Bounds.Height, b.Bounds.Width*b.Bounds.Height)
			})
			if result, err := c.agentChromeKey(ctx, pid, largest.WindowID, "hotkey", map[string]any{"keys": []string{"cmd", "n"}}); err != nil || failed(result) {
				return nil, fmt.Errorf("COMPUTER_INPUT_NOT_SENT: Safari refused the key for a new window: %w", errors.Join(err, errNotSent))
			}
		}
		if windows, pid, err = c.waitSafariWindows(ctx, b, pid, func(listed []listedWindow) bool {
			return slices.ContainsFunc(listed, func(w listedWindow) bool { return !before[w.WindowID] })
		}); err != nil {
			return nil, err
		}
		index = slices.IndexFunc(windows, func(w listedWindow) bool { return !before[w.WindowID] })
		started = true
		// A window Safari opened in the background has no accessibility
		// window until Safari is shown once, so Cua cannot read or key it.
		// Activating Safari brings the new window forward this one time.
		if output, err := exec.CommandContext(ctx, "/usr/bin/open", "-b", b.Bundle).CombinedOutput(); err != nil {
			return nil, fmt.Errorf("launch_app: %s: %w", strings.TrimSpace(string(output)), err)
		}
	}
	window := windows[index]
	if started {
		// Safari can take longer than a Chromium start before the new
		// window's accessibility tree resolves; opening a tab waits for it.
		c.agentChromeTabsUntil(ctx, pid, window.WindowID, agentSafariWindowWait, func(n int) bool { return n > 0 })
	}
	m.mu.Lock()
	m.agentSafariPID, m.agentSafariWindow = pid, window.WindowID
	m.mu.Unlock()
	for _, url := range urls {
		if err := c.agentChromeOpenTab(ctx, b, pid, window.WindowID, offSpace(window), url); err != nil {
			return nil, err
		}
	}
	tabs := c.agentChromeTabs(ctx, pid, window.WindowID)
	c.op.mu.Lock()
	c.op.chromeTabs, c.op.chromePID, c.op.chromeWindow = tabs, pid, window.WindowID
	c.op.mu.Unlock()
	note := "This is the Computer's own window in the user's Safari. Safari has no separate profile, so this window has the user's Safari sign-ins; work only in this window, never in the user's other Safari windows. It works while other windows cover it, but only on the desktop (Space) the user is on. Keys without an element go to this window in the background. Type into a page field with type_text and the field's element_token. Close a tab with its tab's close action, not cmd+w."
	if started {
		note = "Opened a new Safari window for the Computer. " + note
	}
	opened := "No URL was opened, so no tab is this task's."
	if len(urls) > 0 {
		opened = "The last one is this task's and in front."
	}
	text := fmt.Sprintf("Opened %d URL(s) in the Computer's own Safari window (pid %d), window %q [window_id: %v]. The window has %d tab(s). %s\n%s", len(urls), pid, window.Title, window.WindowID, tabs, opened, note)
	return json.Marshal(map[string]any{"content": []any{map[string]string{"type": "text", "text": text}},
		"structuredContent": map[string]any{"browser": b.Name, "pid": pid, "windows": []map[string]any{{"window_id": window.WindowID, "title": window.Title, "on_screen": window.IsOnScreen}}, "tabs": tabs, "note": note}})
}

// waitSafariWindows reads Safari's windows until done accepts them, for
// agentChromeWait at most, and returns them with Safari's pid.
func (c *cuaSession) waitSafariWindows(ctx context.Context, b agentBrowser, pid int, done func([]listedWindow) bool) ([]listedWindow, int, error) {
	deadline := time.Now().Add(agentChromeWait)
	for {
		if pid == 0 {
			pid, _ = lsappPID(ctx, b.Bundle)
		}
		if pid > 0 {
			windows, err := c.appWindows(ctx, pid)
			if err != nil {
				return nil, 0, err
			}
			if done(windows) {
				return windows, pid, nil
			}
		}
		if time.Now().After(deadline) {
			return nil, 0, errors.New("launch_app: Safari did not open a window for the Computer")
		}
		if err := sleepContext(ctx, 200*time.Millisecond); err != nil {
			return nil, 0, err
		}
	}
}
