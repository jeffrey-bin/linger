package localtools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/mcpproxy"
)

// nativeDesktop reports a platform whose browser and desktop tools act on
// the logged-in user's own desktop rather than on a Personal Cloud container.
func nativeDesktop() bool {
	return runtime.GOOS == "darwin" || runtime.GOOS == "windows" || runtime.GOOS == "linux"
}

// profileWait bounds how long a task waits for another task that holds the
// same everyday Chrome profile, below the MCP client's tool timeout.
var profileWait = 40 * time.Second

// liveProfileWait is shorter: the user is waiting on the line, and the voice
// model answers that the browser is busy instead of falling silent.
var liveProfileWait = 8 * time.Second

var errBrowserBusy = errors.New("BROWSER_BUSY: the user's Chrome is in use by another task or browser call. No action was taken; retry after it finishes")

// nativeBrowserCall runs one browser tool in the Agent Chrome profile or in
// the owner's connected Chrome. It never depends on the desktop driver and
// runs in its Agent's browser lane, beside desktop input and other Agents'
// browser calls.
func (op *operation) nativeBrowserCall(ctx context.Context, name string, args json.RawMessage) (output json.RawMessage, callErr error) {
	op.manager.retryCleanup()
	// Calls of one task take turns from here on: switching to the owner's
	// Chrome below ends the session an earlier call may still be using.
	release, err := op.holdBrowserCalls(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	chrome, err := op.resolveUserChrome(ctx)
	if err != nil {
		return nil, err
	}
	seat := ""
	if chrome != nil {
		if seat, err = op.holdUserChromeProfile(ctx, chrome.Profile); err != nil {
			return nil, err
		}
	}
	ctx, releaseLane, err := op.manager.holdLane(ctx, browserLane(op.spec.AgentID))
	if err != nil {
		return nil, err
	}
	defer releaseLane()
	ctx, releaseFocus, err := op.manager.holdBrowserFocus(ctx)
	if err != nil {
		return nil, err
	}
	defer releaseFocus()
	if chrome == nil {
		if err := op.dropExitedBrowser(); err != nil {
			return nil, err
		}
	}
	// This task holds one unknown action at a time: an Agent Chrome action
	// left before the owner connected their Chrome settles when the task
	// ends, and a second one would take its place.
	op.mu.Lock()
	unknown := op.browserUnknown != nil
	op.mu.Unlock()
	if unknown {
		return nil, fmt.Errorf("COMPUTER_ACTION_UNKNOWN: an earlier browser action of this task has no verified cleanup receipt; the browser stays blocked until the task ends: %w", errNotSent)
	}
	// An Agent Chrome action is recorded for that Agent; one in the owner's
	// Chrome for the seat this task holds, which another task may take next.
	journalName := browserLane(op.spec.AgentID)
	if chrome != nil {
		journalName = chromeProfileJournal(seat)
		// The seat follows the installed extension. An action left on the
		// whole profile before an upgrade may still reach this Agent's tabs.
		if seat != chrome.Profile {
			whole, err := op.manager.namedJournal(chromeProfileJournal(chrome.Profile))
			if err != nil {
				return nil, err
			}
			if unknown := whole.unknownAction(); unknown != "" {
				return nil, fmt.Errorf("COMPUTER_ACTION_UNKNOWN: an earlier action in this Chrome profile has no verified cleanup receipt; %s: %w", unknown, errNotSent)
			}
		}
	}
	journal, err := op.manager.namedJournal(journalName)
	if err != nil {
		return nil, err
	}
	receipt, err := journal.begin(ctx, actionIdentity{AgentID: op.spec.AgentID, OperationID: op.identity.OperationID, Session: op.label + "-browser"})
	if err != nil {
		return nil, err
	}
	confirmed := true
	defer func() {
		if op.nativeProxy != nil && !op.nativeProxy.pause() {
			confirmed = false
		}
		if !confirmed {
			op.markBrowserUnknown(receipt, chrome != nil)
		}
		if err := receipt.finish(confirmed); err != nil {
			op.markBrowserUnknown(receipt, chrome != nil)
			callErr = errors.Join(callErr, mcpproxy.ErrCleanupUnconfirmed, err)
		}
	}()
	if chrome != nil {
		return op.userChromeCall(ctx, chrome, name, args, &confirmed)
	}
	if op.nativeBrowser == nil {
		op.nativeBrowser, err = op.manager.nativeBrowserFor(ctx, op.spec.AgentID)
		if err != nil {
			confirmed = !errors.Is(err, mcpproxy.ErrCleanupUnconfirmed)
			return nil, err
		}
	}
	// Browser startup can succeed before binding the private CDP listener
	// fails. A later call must retry that listener, not dereference nil.
	if op.nativeProxy == nil {
		op.nativeProxy, err = openNativeCDPProxy(op.nativeBrowser.endpoint)
		if err != nil {
			return nil, err
		}
	}
	op.nativeProxy.resume()
	if op.browser == nil {
		op.browser, err = op.startBrowser(ctx, op.nativeProxy.endpoint, "active")
		if err != nil {
			confirmed = !errors.Is(err, mcpproxy.ErrCleanupUnconfirmed)
			return nil, err
		}
	}
	result, err := op.requestBrowser(ctx, name, args)
	confirmed = !errors.Is(err, errOutcomeUnknown)
	return result, err
}

// userChromeCall drives the owner's own Chrome. Computer never launches or
// closes that browser; it owns only the Playwright child behind the extension,
// which later tasks of the same Agent reuse.
// A rejected token fails the call: it never falls back to the Agent profile.
func (op *operation) userChromeCall(ctx context.Context, chrome *browserConnection, name string, args json.RawMessage, confirmed *bool) (json.RawMessage, error) {
	var err error
	if op.browser == nil {
		session, err := op.manager.checkoutUserChrome(ctx, op, chrome)
		if session != nil {
			op.browser, op.userChromeSession = session.client, session
		}
		if err != nil {
			*confirmed = !errors.Is(err, mcpproxy.ErrCleanupUnconfirmed)
			return nil, err
		}
	}
	result, err := op.requestBrowser(ctx, name, args)
	*confirmed = !errors.Is(err, errOutcomeUnknown)
	failure := err
	if failure == nil {
		failure = toolResultError(result)
	}
	if failure != nil && strings.Contains(failure.Error(), "did not connect within") {
		op.userChromeRejected.Store(true)
		op.manager.markBrowserConnection(chrome, browserTokenInvalid, "The Playwright Extension rejected the saved token; reconnect the browser.")
		// Free the profile now: the owner's reconnect must not find it busy.
		return nil, errors.Join(errUserChromeRejected, op.dropBrowserSession())
	}
	if failure == nil && !op.userChromeVerified {
		op.userChromeVerified = true
		if chrome.State != browserConnected {
			op.manager.markBrowserConnection(chrome, browserConnected, "")
		}
	}
	return result, err
}

// holdBrowserCalls admits one browser call of this Operation at a time. The
// calls share op.browser, op.nativeBrowser, op.nativeProxy and the owner's
// Chrome session, which a call replaces when the owner connects mid-task.
func (op *operation) holdBrowserCalls(ctx context.Context) (func(), error) {
	op.browserCallsOnce.Do(func() { op.browserCalls = make(chan struct{}, 1) })
	select {
	case op.browserCalls <- struct{}{}:
		return func() { <-op.browserCalls }, nil
	case <-ctx.Done():
		return nil, fmt.Errorf("COMPUTER_BUSY: another browser call of this task was running until this call ended (%v): %w", ctx.Err(), errNotSent) //nolint:errorlint // the wait's end is detail; the call classifies as not sent only
	}
}

// holdUserChromeProfile admits this Operation to its seat in the everyday
// Chrome profile for the rest of the task and returns the seat. It waits
// outside the browser lane: another task of the same Agent may hold the seat
// and wait for that lane.
func (op *operation) holdUserChromeProfile(ctx context.Context, profile string) (string, error) {
	op.profileMu.Lock()
	defer op.profileMu.Unlock()
	if op.releaseProfile != nil {
		return op.chromeSeat, nil
	}
	if op.live {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeoutCause(ctx, liveProfileWait, errBrowserBusy)
		defer cancel()
	}
	seat := userChromeSeat(op.manager.env, profile, op.spec.AgentID)
	release, err := op.manager.acquireChromeProfile(ctx, seat)
	if err != nil {
		return "", err
	}
	op.releaseProfile, op.chromeSeat = release, seat
	return seat, nil
}

var errUserChromeRequired = errors.New("BROWSER_CONNECTION_REQUIRED: the user has not connected their everyday Chrome. Run `teamhub browser connect` to post a connection card for them in this chat, then end your turn; the card result wakes you when they connect or decline. Do not use another browser or tool instead, and never ask for the token in a message")

// resolveUserChrome returns the owner's connection for this call. It rereads
// the saved connection whenever this Operation has none or holds a rejected
// one, so a task continues once the owner connects through the chat card.
func (op *operation) resolveUserChrome(ctx context.Context) (*browserConnection, error) {
	op.connectMu.Lock()
	defer op.connectMu.Unlock()
	rejected := op.userChromeRejected.Load()
	if op.userChrome != nil && !rejected {
		return op.userChrome, nil
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	connection, err := op.manager.loadBrowserConnection(op.spec.TenantID, op.spec.OwnerActorID)
	switch {
	case err != nil:
		return nil, errUserChromeRejected
	case connection == nil && op.userChrome == nil:
		if op.chromeRequired {
			return nil, errUserChromeRequired
		}
		return nil, nil
	// Each configure writes a new ConfiguredAt, even with the same token;
	// a verdict on the old one does not.
	case connection == nil, connection.State == browserTokenInvalid,
		rejected && !connection.ConfiguredAt.After(op.userChrome.ConfiguredAt):
		return nil, errUserChromeRejected
	}
	// The owner connected: end the session this Operation ran before, either
	// the rejected relay or the Agent profile, and verify the new connection
	// on its first call.
	if err := op.dropBrowserSession(); err != nil {
		return nil, err
	}
	op.userChromeVerified = false
	op.userChromeRejected.Store(false)
	op.chromeRequired = false
	op.userChrome = connection
	return connection, nil
}

// dropBrowserSession ends this Operation's Playwright child and frees the
// everyday Chrome profile, so the owner can reconnect while the task waits.
// An everyday Chrome session leaves the shared table and stops; this task
// keeps its handle until the stop is confirmed, so cleanup retries reach it.
// The profile is freed even when the child does not confirm its exit.
func (op *operation) dropBrowserSession() error {
	var err error
	if session := op.userChromeSession; session != nil {
		if err = op.manager.releaseUserChrome(session, false); err == nil {
			op.browser, op.userChromeSession = nil, nil
			op.mu.Lock()
			userUnknown := op.browserUnknownUser
			op.mu.Unlock()
			if userUnknown {
				err = op.settleBrowserUnknown()
			}
		}
	} else if err = op.browser.close(); err == nil {
		// A child whose exit is unconfirmed stays for the cleanup retries.
		op.browser = nil
	}
	op.releaseChromeProfile()
	return err
}

// releaseChromeProfile passes the everyday Chrome profile this task holds,
// if any, to the next task or Live call.
func (op *operation) releaseChromeProfile() {
	op.profileMu.Lock()
	defer op.profileMu.Unlock()
	if op.releaseProfile != nil {
		op.releaseProfile()
		op.releaseProfile, op.chromeSeat = nil, ""
	}
}

var errUserChromeRejected = errors.New("BROWSER_CONNECTION_INVALID: the saved connection to the user's Chrome no longer works. Run `teamhub browser connect` to ask them to reconnect through a chat card, then end your turn. Do not use another browser or tool instead, and never ask for the token in a message")

// BrowserCallNotRun names a browser call that never reached the owner's
// Chrome because it is not connected, its saved connection no longer works,
// or another task or call holds it; "" for any other failure.
func BrowserCallNotRun(err error) string {
	switch {
	case errors.Is(err, errBrowserBusy):
		return "browser_busy"
	case errors.Is(err, errUserChromeRequired):
		return "browser_connection_required"
	case errors.Is(err, errUserChromeRejected):
		return "browser_connection_invalid"
	}
	return ""
}

// acquireChromeProfile admits a task to one seat in an everyday Chrome
// profile; see userChromeSeat.
func (m *Manager) acquireChromeProfile(ctx context.Context, seat string) (func(), error) {
	m.mu.Lock()
	slot := m.chromeProfiles[seat]
	if slot == nil {
		slot = make(chan struct{}, 1)
		m.chromeProfiles[seat] = slot
	}
	m.mu.Unlock()
	waitCtx, cancel := context.WithTimeout(ctx, profileWait)
	defer cancel()
	retry := time.NewTicker(time.Second)
	defer retry.Stop()
	for {
		select {
		case slot <- struct{}{}:
			return releaseOnce(slot), nil
		default:
		}
		// A Live call between turns gives the seat up to a task.
		m.releaseIdleLiveChrome(seat)
		select {
		case slot <- struct{}{}:
			return releaseOnce(slot), nil
		case <-retry.C:
		case <-waitCtx.Done():
			if ctx.Err() != nil {
				return nil, context.Cause(ctx)
			}
			return nil, errBrowserBusy
		}
	}
}

// tryChromeProfile admits a caller only when no task holds the whole
// profile, as it does while the extension keeps one client.
func (m *Manager) tryChromeProfile(profile string) (func(), bool) {
	m.mu.Lock()
	slot := m.chromeProfiles[profile]
	if slot == nil {
		slot = make(chan struct{}, 1)
		m.chromeProfiles[profile] = slot
	}
	m.mu.Unlock()
	select {
	case slot <- struct{}{}:
		return releaseOnce(slot), true
	default:
	}
	m.releaseIdleLiveChrome(profile)
	select {
	case slot <- struct{}{}:
		return releaseOnce(slot), true
	default:
		return nil, false
	}
}

// releaseOnce frees a profile slot exactly once. Concurrent cleanup retries
// may both release an Operation; a second receive would block forever.
func releaseOnce(slot chan struct{}) func() {
	var once sync.Once
	return func() { once.Do(func() { <-slot }) }
}

// unavailableComputerTools keeps the computer server bound when the desktop
// driver is missing, so the Agent sees why instead of a missing server.
func unavailableComputerTools() []tool {
	return []tool{{Name: checkPermissionsTool, Description: "Report why desktop control is unavailable on this Computer. Browser and file tools do not need it.", InputSchema: schema(map[string]any{})}}
}

func (op *operation) computerUnavailable() error {
	return errors.New("COMPUTER_UNAVAILABLE: desktop control is unavailable on this Computer; browser and file tools still work. " + op.computerErr.Error())
}

// dropExitedBrowser forgets an Agent Chrome that exited, closed by the user
// or crashed, with this task's Playwright child and CDP proxy, which point at
// its dead port, so the call starts the browser again. Nothing still runs in
// a Chrome that exited, so an earlier unknown browser action is settled.
func (op *operation) dropExitedBrowser() error {
	if op.nativeBrowser == nil {
		return nil
	}
	select {
	case <-op.nativeBrowser.done:
	default:
		return nil
	}
	if err := op.browser.close(); err != nil {
		return err
	}
	op.browser = nil
	if op.nativeProxy != nil {
		// Commands that were pending when Chrome exited can no longer run.
		_ = op.nativeProxy.close()
		op.nativeProxy = nil
	}
	op.nativeBrowser = nil
	return op.settleBrowserUnknown()
}

// closeNativeProxy stops relaying commands to the Agent Chrome. A command
// still pending there belongs to the browser action already recorded as
// unknown, which settleBrowserUnknown then settles by stopping that Chrome.
func (op *operation) closeNativeProxy() error {
	if op.nativeProxy == nil {
		return nil
	}
	err := op.nativeProxy.close()
	op.mu.Lock()
	unknown := op.browserUnknown != nil
	op.mu.Unlock()
	if unknown {
		return nil
	}
	return err
}

// markBrowserUnknown records a browser action whose outcome is unknown and
// which browser ran it, since each is settled differently.
func (op *operation) markBrowserUnknown(receipt *actionReceipt, userChrome bool) {
	op.mu.Lock()
	op.browserUnknown, op.browserUnknownUser = receipt, userChrome
	op.mu.Unlock()
}

// settleBrowserUnknown completes a browser action whose outcome is unknown,
// which otherwise blocks later calls to the same Agent browser or everyday
// Chrome seat, and desktop input that needs the front window or the clipboard. Only a stopped
// sender proves that none of its commands still runs. For the Agent Chrome
// this stops that browser; the next call starts it again with the same
// profile. The owner's everyday Chrome is never stopped: its action settles
// once this task's Playwright child, the only sender, has confirmed its exit.
func (op *operation) settleBrowserUnknown() error {
	op.mu.Lock()
	receipt, userChrome := op.browserUnknown, op.browserUnknownUser
	op.mu.Unlock()
	if receipt == nil {
		return nil
	}
	if op.userChromeSession != nil || !userChrome && op.nativeBrowser == nil {
		return mcpproxy.ErrCleanupUnconfirmed
	}
	if !userChrome {
		if err := op.manager.stopNativeBrowser(op.spec.AgentID, op.nativeBrowser); err != nil {
			return errors.Join(mcpproxy.ErrCleanupUnconfirmed, err)
		}
	}
	if err := receipt.finish(true); err != nil {
		return errors.Join(mcpproxy.ErrCleanupUnconfirmed, err)
	}
	op.mu.Lock()
	op.browserUnknown = nil
	op.mu.Unlock()
	return nil
}

// retryCleanup retries retained Operations whose earlier cleanup had no
// receipt. Only their original transports can confirm it.
func (m *Manager) retryCleanup() {
	m.mu.Lock()
	var retained []*operation
	for op := range m.operations {
		op.mu.Lock()
		// Every browser call starts a retry; one retry per Operation at a
		// time touches its transports.
		closing := op.closing && op.cleanupFinished && !op.retrying
		if closing {
			op.retrying = true
		}
		op.mu.Unlock()
		if closing {
			retained = append(retained, op)
		}
	}
	m.mu.Unlock()
	_ = m.retryStrayUserChrome()
	for _, op := range retained {
		op.retryClose()
	}
}

// retryClose retries one retained Operation's cleanup.
func (op *operation) retryClose() {
	defer func() { op.mu.Lock(); op.retrying = false; op.mu.Unlock() }()
	// A recovered Cua session alone does not confirm that the original
	// browser helper or its CDP transport has stopped.
	var browserErr error
	if op.userChromeSession != nil {
		// The everyday Chrome session owns op.browser.
		if browserErr = op.userChromeSession.close(); browserErr == nil {
			op.browser, op.userChromeSession = nil, nil
			op.releaseChromeProfile()
		}
	} else {
		browserErr = op.browser.close()
	}
	cleanupErr := errors.Join(op.browserCatalog.close(), browserErr, op.closeNativeProxy())
	if op.cua != nil {
		cleanupErr = errors.Join(cleanupErr, op.cua.close())
	}
	cleanupErr = errors.Join(cleanupErr, op.closeLinux())
	if cleanupErr == nil {
		cleanupErr = op.settleBrowserUnknown()
	}
	if cleanupErr == nil {
		op.releaseDirectories()
	}
}

// snapshotLink matches the file link Playwright MCP prints in place of the
// page snapshot after an action: the line right under the Snapshot heading.
var snapshotLink = regexp.MustCompile(`### Snapshot\n- \[Snapshot\]\(([^)\n]+\.yml)\)`)

// requestBrowser calls one Playwright tool. After an action, Playwright
// saves the page snapshot to a file and links it. The result carries the
// snapshot itself instead, so the model sees the changed page without
// spending a call on browser_snapshot.
func (op *operation) requestBrowser(ctx context.Context, name string, args json.RawMessage) (json.RawMessage, error) {
	result, err := op.browser.request(ctx, "tools/call", map[string]any{"name": name, "arguments": args})
	if err != nil {
		return result, err
	}
	output := op.browserOutput()
	if op.userChromeSession != nil {
		output = op.userChromeSession.output
	}
	result = inlineSnapshot(result, op.spec.WorkingDirectory, output)
	op.pages.observe(result)
	return result, nil
}

// inlineSnapshot replaces a snapshot link with the file's text and removes
// the file. Only a regular file directly inside output qualifies.
func inlineSnapshot(result json.RawMessage, workspace, output string) json.RawMessage {
	if !strings.Contains(string(result), "[Snapshot](") {
		return result
	}
	var reply map[string]any
	if json.Unmarshal(result, &reply) != nil {
		return result
	}
	content, _ := reply["content"].([]any)
	for _, item := range content {
		part, _ := item.(map[string]any)
		text, ok := part["text"].(string)
		if !ok {
			continue
		}
		part["text"] = snapshotLink.ReplaceAllStringFunc(text, func(link string) string {
			path := filepath.Join(workspace, filepath.FromSlash(snapshotLink.FindStringSubmatch(link)[1]))
			if filepath.Dir(path) != filepath.Clean(output) {
				return link
			}
			if info, err := os.Lstat(path); err != nil || !info.Mode().IsRegular() {
				return link
			}
			data, err := os.ReadFile(path)
			if err != nil {
				return link
			}
			_ = os.Remove(path)
			return "### Snapshot\n```yaml\n" + strings.TrimRight(string(data), "\n") + "\n```"
		})
	}
	encoded, _ := json.Marshal(reply)
	return encoded
}
