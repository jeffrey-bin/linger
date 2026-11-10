package localtools

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
)

// playwrightExtensionID is the official Playwright Extension in the Chrome
// Web Store. Computer installs no extension of its own.
const playwrightExtensionID = "mmlmfjhmonkocbjadbfplnigmagldckm"

var (
	extensionTokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{20,256}$`)
	chromeProfilePattern  = regexp.MustCompile(`^(Default|Profile [1-9][0-9]{0,3}|Guest Profile)$`)
)

// Browser connection states this Daemon reports, from BrowserConnectionStatus
// in the Runner Gateway contract.
const (
	browserIsolated     = "isolated"
	browserNotConnected = "not_connected"
	browserConnected    = "connected"
	browserTokenInvalid = "token_invalid"
	browserUnsupported  = "unsupported"
)

// browserConnection is one owner's everyday Chrome on this Computer. Token is
// a credential: only the controlled Playwright child receives it, through its
// environment, and no status or log contains it.
type browserConnection struct {
	TenantID     string    `json:"tenant_id"`
	OwnerActorID string    `json:"owner_actor_id"`
	Profile      string    `json:"profile"`
	Token        string    `json:"extension_token"`
	State        string    `json:"state"`
	Message      string    `json:"message,omitempty"`
	ConfiguredAt time.Time `json:"configured_at"`
	VerifiedAt   time.Time `json:"verified_at,omitzero"`
}

// BrowserStatus is the token-free BrowserConnectionStatus wire object.
type BrowserStatus struct {
	Mode         string     `json:"mode"`
	State        string     `json:"state"`
	Platform     string     `json:"platform"`
	Browser      string     `json:"browser,omitempty"`
	Profile      string     `json:"profile,omitempty"`
	ConfiguredAt *time.Time `json:"configured_at,omitempty"`
	VerifiedAt   *time.Time `json:"verified_at,omitempty"`
	Message      string     `json:"message,omitempty"`
}

// BrowserCommandError is a user-facing, retry-classified failure.
type BrowserCommandError struct {
	Code, Message string
	Retryable     bool
}

func (e *BrowserCommandError) Error() string { return e.Code + ": " + e.Message }

// ConnectsEverydayBrowser reports whether this Computer can attach the
// user's everyday Chrome. Linux cannot, so it does not declare the capability.
func (m *Manager) ConnectsEverydayBrowser() bool { return m.userChromeSupported() }

func (m *Manager) userChromeSupported() bool {
	return m.journal != nil && !m.noEverydayChrome
}

// everydayChrome reports that the user's default browser is an installed
// Google Chrome, so browser tasks belong in it rather than in the Agent profile.
// An unknown default keeps the Agent profile: Safari often records no handler.
func (m *Manager) everydayChrome() bool {
	if !m.userChromeSupported() {
		return false
	}
	name := defaultBrowserName(m.env)
	return (name == "chrome" || name == "chromium") && chromeExecutable(m.env) != ""
}

func (m *Manager) browserConnectionPath(tenantID, ownerActorID string) string {
	sum := sha256.Sum256([]byte(tenantID + "\x00" + ownerActorID))
	return filepath.Join(m.options.StateDirectory, "computer-tools", "browser-connections", hex.EncodeToString(sum[:])+".json")
}

func (m *Manager) loadBrowserConnection(tenantID, ownerActorID string) (*browserConnection, error) {
	if tenantID == "" || ownerActorID == "" || !m.userChromeSupported() {
		return nil, nil
	}
	data, err := privatefs.ReadFile(m.browserConnectionPath(tenantID, ownerActorID), 64*1024)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var stored browserConnection
	if json.Unmarshal(data, &stored) != nil || stored.TenantID != tenantID || stored.OwnerActorID != ownerActorID ||
		!extensionTokenPattern.MatchString(stored.Token) || !chromeProfilePattern.MatchString(stored.Profile) {
		return nil, errors.New("the saved browser connection is invalid; reconnect the browser")
	}
	return &stored, nil
}

func (m *Manager) storeBrowserConnection(connection *browserConnection) error {
	data, err := json.Marshal(connection)
	if err != nil {
		return err
	}
	return privatefs.WriteFile(m.browserConnectionPath(connection.TenantID, connection.OwnerActorID), data, false)
}

// markBrowserConnection records a task-time verdict on the saved token, so
// status shows reconnect guidance without exposing the token itself.
func (m *Manager) markBrowserConnection(connection *browserConnection, state, message string) {
	m.browserMu.Lock()
	defer m.browserMu.Unlock()
	current, err := m.loadBrowserConnection(connection.TenantID, connection.OwnerActorID)
	// A newer token replaced this one; its own verification decides its state.
	if err != nil || current == nil || current.Token != connection.Token {
		return
	}
	current.State, current.Message = state, message
	if state == browserConnected {
		current.VerifiedAt = time.Now().UTC()
	}
	_ = m.storeBrowserConnection(current)
}

func (m *Manager) browserStatus(connection *browserConnection) BrowserStatus {
	status := BrowserStatus{Mode: "isolated", State: browserIsolated, Platform: runtime.GOOS}
	if !m.userChromeSupported() {
		status.State = browserUnsupported
		status.Message = "This Computer has no everyday browser to connect; Agents use their own browser without the user's sign-ins."
		return status
	}
	if connection == nil {
		if m.everydayChrome() {
			status.State = browserNotConnected
			status.Message = "Chrome is the everyday browser. Agents wait for the user to connect it before using a browser."
		} else if note := defaultBrowserNote(m.env); note != "" {
			status.Message = note
		}
		return status
	}
	configured := connection.ConfiguredAt
	status.Mode, status.State, status.Browser, status.Profile = "user_chrome", connection.State, "chrome", connection.Profile
	status.ConfiguredAt, status.Message = &configured, connection.Message
	if !connection.VerifiedAt.IsZero() {
		verified := connection.VerifiedAt
		status.VerifiedAt = &verified
	}
	return status
}

// BrowserConnection answers execute browser_connect for one owner. Only
// this dedicated command accepts a credential; Operation requests cannot.
func (m *Manager) BrowserConnection(ctx context.Context, tenantID, ownerActorID, action, profile, token string) (BrowserStatus, error) {
	if tenantID == "" || ownerActorID == "" {
		return BrowserStatus{}, &BrowserCommandError{"INVALID_REQUEST", "browser connection owner is incomplete", false}
	}
	m.browserMu.Lock()
	defer m.browserMu.Unlock()
	// Another owner's configure may have held the records past this deadline.
	if ctx.Err() != nil {
		return BrowserStatus{}, &BrowserCommandError{"BROWSER_CONNECTION_TIMEOUT", "the Computer was busy with another browser connection; try again", true}
	}
	if action != "status" && !m.userChromeSupported() {
		return m.browserStatus(nil), &BrowserCommandError{"BROWSER_CONNECTION_UNSUPPORTED", "this Computer cannot connect an everyday browser", false}
	}
	switch action {
	case "status":
		connection, err := m.loadBrowserConnection(tenantID, ownerActorID)
		if err != nil {
			return BrowserStatus{}, &BrowserCommandError{"BROWSER_CONNECTION_INVALID", err.Error(), false}
		}
		return m.browserStatus(connection), nil
	case "disconnect":
		// An idle relay of an earlier task stays connected to the Chrome
		// the owner disconnects: stop it too.
		owner := browserOwner(tenantID, ownerActorID)
		m.closeIdleUserChrome(func(s *userChromeSession) bool { return s.owner == owner })
		err := os.Remove(m.browserConnectionPath(tenantID, ownerActorID))
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return BrowserStatus{}, err
		}
		return m.browserStatus(nil), nil
	case "configure":
	default:
		return BrowserStatus{}, &BrowserCommandError{"INVALID_REQUEST", "unknown browser connection action", false}
	}
	if !extensionTokenPattern.MatchString(token) || (profile != "" && !chromeProfilePattern.MatchString(profile)) {
		return BrowserStatus{}, &BrowserCommandError{"INVALID_BROWSER_TOKEN", "paste the token shown by the Playwright Extension", false}
	}
	chrome, err := findUserChrome(m.env, profile)
	if err != nil {
		return BrowserStatus{}, err
	}
	// A running task owns this profile's extension connection. Verifying now
	// would open a second relay into it, so ask the owner to retry instead.
	release, admitted := m.tryChromeProfile(chrome.profile)
	if !admitted {
		return BrowserStatus{}, &BrowserCommandError{"BROWSER_BUSY", "an Agent task is using this Chrome; try again after it finishes", true}
	}
	defer release()
	// An idle relay of an earlier task still holds this profile's extension
	// connection; stop it before verifying opens another.
	m.closeIdleUserChrome(func(s *userChromeSession) bool { return s.profile == chrome.profile })
	connection := &browserConnection{TenantID: tenantID, OwnerActorID: ownerActorID, Profile: chrome.profile, Token: token, State: browserConnected, ConfiguredAt: time.Now().UTC()}
	// The token is accepted only after the extension really connects; a
	// rejected one is never stored, so nothing switches silently.
	if err := m.verifyUserChrome(ctx, connection); err != nil {
		return BrowserStatus{}, err
	}
	if ctx.Err() != nil {
		return BrowserStatus{}, &BrowserCommandError{"BROWSER_CONNECTION_TIMEOUT", "Chrome did not answer in time; keep Chrome open and try again", true}
	}
	connection.VerifiedAt = time.Now().UTC()
	if err := m.storeBrowserConnection(connection); err != nil {
		return BrowserStatus{}, err
	}
	return m.browserStatus(connection), nil
}

// verifyUserChrome lists tabs through a short-lived Playwright child. That
// child owns only its relay; the user's Chrome stays open afterwards.
func (m *Manager) verifyUserChrome(ctx context.Context, connection *browserConnection) error {
	directory, err := os.MkdirTemp(filepath.Join(m.options.StateDirectory, "computer-tools"), "browser-verify-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(directory)
	op := &operation{manager: m, directory: directory, spec: provider.OperationSpec{WorkingDirectory: directory}}
	defer op.releaseSocketsDir()
	verifyCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	client, err := op.startUserChromeBrowser(verifyCtx, connection)
	if err == nil {
		var result json.RawMessage
		result, err = client.request(verifyCtx, "tools/call", map[string]any{"name": "browser_tabs", "arguments": map[string]string{"action": "list"}})
		if err == nil {
			err = toolResultError(result)
		}
		err = errors.Join(err, client.close())
	}
	if err != nil {
		return classifyUserChromeError(err)
	}
	return nil
}

// classifyUserChromeError maps Playwright's extension relay failures. The
// relay reports a wrong token only as an unanswered connect page, so a token
// is judged invalid after its installed extension stays silent.
func classifyUserChromeError(err error) *BrowserCommandError {
	var classified *BrowserCommandError
	if errors.As(err, &classified) {
		return classified
	}
	text := err.Error()
	switch {
	case strings.Contains(text, "did not connect within"):
		return &BrowserCommandError{"BROWSER_TOKEN_REJECTED", "the Playwright Extension did not accept this token; copy the current token from the extension and try again", false}
	case errors.Is(err, context.DeadlineExceeded):
		return &BrowserCommandError{"BROWSER_CONNECTION_TIMEOUT", "Chrome did not answer in time; keep Chrome open and try again", true}
	}
	return &BrowserCommandError{"BROWSER_CONNECTION_FAILED", "the everyday Chrome could not be connected", true}
}

func toolResultError(result json.RawMessage) error {
	var reply struct {
		IsError bool `json:"isError"`
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
	}
	if json.Unmarshal(result, &reply) != nil || !reply.IsError {
		return nil //nolint:nilerr // only a well-formed tool error result is reported
	}
	var text []string
	for _, item := range reply.Content {
		text = append(text, item.Text)
	}
	return errors.New(strings.Join(text, "\n"))
}
