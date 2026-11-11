package localtools

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/mcpproxy"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/process"
)

type nativeBrowser struct {
	endpoint          string
	webSocketEndpoint string
	stop              context.CancelFunc
	done              chan struct{}
	err               error
}

// nativeBrowserFor returns the Agent's running Chrome or starts it. Only
// calls in the Agent's browser lane start it, so one Agent never starts two;
// m.mu guards just the table, and a start does not hold up other Agents.
func (m *Manager) nativeBrowserFor(ctx context.Context, agentID string) (*nativeBrowser, error) {
	m.mu.Lock()
	if existing := m.browsers[agentID]; existing != nil {
		select {
		case <-existing.done:
			if err := existing.cleanupError(); err != nil {
				m.mu.Unlock()
				return existing, err
			}
			delete(m.browsers, agentID)
		default:
			m.mu.Unlock()
			return existing, nil
		}
	}
	m.mu.Unlock()
	// This is a dedicated Agent profile, never the user's default Chrome
	// profile. Cua observes the same native window Playwright attaches to.
	executable := chromeExecutable(m.env)
	if executable == "" {
		return nil, errors.New("BROWSER_UNAVAILABLE: install Google Chrome or Chromium to use the managed browser")
	}
	if err := checkBrowserDisplay(m.env); err != nil {
		return nil, err
	}
	sum := sha256.Sum256([]byte(agentID))
	root := filepath.Join(m.options.StateDirectory, "computer-tools", "browser-profiles")
	if snap := snapProfileRoot(executable, environmentValue(m.env, "HOME")); snap != "" {
		root = snap
	}
	profile := filepath.Join(root, hex.EncodeToString(sum[:]))
	if err := privatefs.EnsureDir(profile); err != nil {
		return nil, err
	}
	if err := reclaimProfile(profile); err != nil {
		return nil, errors.New("BROWSER_UNAVAILABLE: " + err.Error())
	}
	portFile := filepath.Join(profile, "DevToolsActivePort")
	// A surviving Chrome from an earlier daemon must not be adopted using a
	// stale port file. Chrome exits its new launcher when the profile is owned;
	// only the live, newly owned process may publish a new discovery file.
	if err := os.Remove(portFile); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	processCtx, stop := context.WithCancel(context.Background())
	// Playwright's launcher sets the same three flags. Without them, an
	// occluded window stops animation frames and clicks wait forever for a
	// "stable" element. --use-mock-keychain keeps the profile's sign-ins
	// when the macOS login keychain is locked (see agentChromeArgs).
	cmd := exec.Command(executable, "--user-data-dir="+profile, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--disable-background-mode", "--use-mock-keychain",
		"--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "about:blank")
	cmd.Env = m.env
	// Stdio stays on /dev/null. A pipe would stay open in Chrome's detached
	// crashpad handler and turn every clean stop into a WaitDelay error.
	browser := &nativeBrowser{stop: stop, done: make(chan struct{})}
	go func() { browser.err = process.RunWindowed(processCtx, cmd, time.Second); close(browser.done) }()
	return m.awaitNativeBrowser(ctx, agentID, browser, portFile)
}

// awaitNativeBrowser publishes the started browser, or retains a process
// whose stop is unconfirmed, under m.mu.
func (m *Manager) awaitNativeBrowser(ctx context.Context, agentID string, browser *nativeBrowser, portFile string) (*nativeBrowser, error) {
	readyCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	for {
		select {
		case <-browser.done:
			err := errors.New("BROWSER_UNAVAILABLE: managed Chrome exited; close an older Computer-owned Chrome before retrying")
			if cleanupErr := browser.cleanupError(); cleanupErr != nil {
				m.publishBrowser(agentID, browser)
				return browser, errors.Join(err, cleanupErr)
			}
			return nil, err
		default:
		}
		data, err := os.ReadFile(portFile)
		lines := strings.Split(string(data), "\n")
		if err == nil && len(data) < 4096 && len(lines) >= 2 && strings.HasPrefix(lines[1], "/devtools/browser/") {
			port, parseErr := strconv.Atoi(lines[0])
			if parseErr == nil && port > 0 && port < 65536 {
				browser.endpoint = fmt.Sprintf("http://127.0.0.1:%d", port)
				browser.webSocketEndpoint = fmt.Sprintf("ws://127.0.0.1:%d%s", port, lines[1])
				request, _ := http.NewRequestWithContext(readyCtx, http.MethodGet, browser.endpoint+"/json/version", nil)
				response, requestErr := (&http.Client{Timeout: time.Second}).Do(request)
				if requestErr == nil {
					_ = response.Body.Close()
					if response.StatusCode == http.StatusOK {
						m.publishBrowser(agentID, browser)
						return browser, nil
					}
				}
			}
		}
		select {
		case <-readyCtx.Done():
			err := errors.New("BROWSER_UNAVAILABLE: managed Chrome did not become ready")
			if cleanupErr := browser.close(); cleanupErr != nil {
				m.publishBrowser(agentID, browser)
				return browser, errors.Join(err, cleanupErr)
			}
			return nil, err
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func (m *Manager) publishBrowser(agentID string, browser *nativeBrowser) {
	m.mu.Lock()
	m.browsers[agentID] = browser
	m.mu.Unlock()
}

// snapProfileRoot returns where a Snap browser keeps Agent profiles. Snap
// confinement denies hidden folders in the home folder, such as the Computer's
// state folder, so Chromium could not lock a profile there and exited.
func snapProfileRoot(executable, home string) string {
	if filepath.Dir(executable) != "/snap/bin" || home == "" {
		return ""
	}
	return filepath.Join(home, "snap", filepath.Base(executable), "common", "linger-browser-profiles")
}

// stopNativeBrowser stops an Agent's Chrome. A later call for the Agent
// starts a new one with the same profile.
func (m *Manager) stopNativeBrowser(agentID string, browser *nativeBrowser) error {
	if err := browser.close(); err != nil {
		return err
	}
	m.mu.Lock()
	if m.browsers[agentID] == browser {
		delete(m.browsers, agentID)
	}
	m.mu.Unlock()
	return nil
}

func (b *nativeBrowser) close() error {
	if b == nil {
		return nil
	}
	select {
	case <-b.done:
		return b.cleanupError()
	default:
	}
	// A process-group signal can kill Chrome's Network Service before its
	// Cookie store flushes. Ask the owned browser to exit first, then retain
	// the original whole-tree termination and ten-second cleanup boundary.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	graceful, stopGraceful := context.WithTimeout(ctx, 2*time.Second)
	b.closeGracefully(graceful)
	stopGraceful()
	select {
	case <-b.done:
		return b.cleanupError()
	default:
	}
	b.stop()
	select {
	case <-b.done:
		return b.cleanupError()
	case <-ctx.Done():
		return mcpproxy.ErrCleanupUnconfirmed
	}
}

func (b *nativeBrowser) closeGracefully(ctx context.Context) {
	if b.webSocketEndpoint == "" {
		return
	}
	// Keep the startup-owned browser path. Never rediscover or adopt a browser
	// at shutdown using a port file that another process may have replaced.
	socket, _, err := (&websocket.Dialer{}).DialContext(ctx, b.webSocketEndpoint, nil) //nolint:bodyclose // gorilla/websocket documents that the handshake response body needs no Close
	if err != nil {
		return
	}
	defer socket.Close()
	deadline, _ := ctx.Deadline()
	_ = socket.SetWriteDeadline(deadline)
	if socket.WriteJSON(map[string]any{"id": 1, "method": "Browser.close"}) != nil {
		return
	}
	// Neither a CDP acknowledgment nor a closed socket is an exit receipt.
	select {
	case <-b.done:
	case <-ctx.Done():
	}
}

// Read only after done closes: Run reports success only after its whole-tree
// check. A nonzero process exit also has that check; other errors may not.
func (b *nativeBrowser) cleanupError() error {
	if b.err == nil || errors.Is(b.err, context.Canceled) {
		return nil
	}
	var exited *exec.ExitError
	if errors.As(b.err, &exited) {
		return nil
	}
	return errors.Join(mcpproxy.ErrCleanupUnconfirmed, b.err)
}
