package localtools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"math/rand/v2"
	"net"
	"net/url"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
	"golang.org/x/net/publicsuffix"
)

// The Computer's own browser is where Agents use sites that watch for
// automated browsing. Every input it receives, from a tool call, a batch step,
// a script or a paged text read, passes the same pace: a pause like a person's
// between inputs, a budget per task and per day, and a stop once the Agent
// reports a check that only the user may pass. The model decides what a page
// shows; the Computer only enforces what follows from that decision.
const (
	// agentChromeTaskInputs bounds the inputs one task sends to that Chrome.
	agentChromeTaskInputs = 300
	// agentChromeDailyInputs bounds the inputs of all tasks in one local day.
	agentChromeDailyInputs = 1500
	// agentChromeScriptInputs bounds the inputs one script sends, so the
	// Agent looks at the window again before a long run continues blind.
	agentChromeScriptInputs = 20
	// agentChromeCooldown is how long a reported rate limit keeps every task
	// off that site in that browser.
	agentChromeCooldown = time.Hour
)

// agentChromePause is the gap kept between two inputs to the Computer's own
// browser; a test replaces it.
var agentChromePause = func() time.Duration {
	return time.Duration(600+rand.IntN(1200)) * time.Millisecond //nolint:gosec // pacing jitter, not a secret
}

// scriptInputPause is the range, in milliseconds, of the pause a paced script
// waits before each input.
const scriptInputPauseMin, scriptInputPauseSpan = 400, 900

// blockerKinds are the checks report_blocker accepts. Every kind but
// content_unavailable stops the task's input to the Computer's own browser.
var blockerKinds = map[string]bool{"captcha": true, "verification": true, "login_required": true, "rate_limited": true, "content_unavailable": true}

// paceRecord is the persisted day count of the Computer's own browser and the
// end of each site's cooldown, shared by every task on this Computer.
type paceRecord struct {
	Day       string               `json:"day"`
	Inputs    int                  `json:"inputs"`
	Cooldowns map[string]time.Time `json:"cooldowns,omitempty"`
}

// coolingError refuses work on the first of sites that is in its cooldown.
func (r paceRecord) coolingError(sites []string, now time.Time) error {
	for _, site := range sites {
		if until := r.Cooldowns[site]; until.After(now) {
			return fmt.Errorf("COMPUTER_SITE_COOLDOWN: %s reported too many requests, so the Computer's own browser takes no input for it until %s; tell the user and end the task: %w", site, until.Local().Format(time.Kitchen), errNotSent)
		}
	}
	return nil
}

// siteOf returns the registrable domain of address, so a cooldown covers
// every host of a site; a host without one, such as an IP address, is its
// own site. It returns "" for anything that is not a web address.
func siteOf(address string) string {
	parsed, err := url.Parse(address)
	if err != nil || !webAddress(parsed) {
		return ""
	}
	host := strings.ToLower(parsed.Hostname())
	if net.ParseIP(host) != nil {
		return host
	}
	if site, err := publicsuffix.EffectiveTLDPlusOne(host); err == nil {
		return site
	}
	return host
}

// coolingSite refuses work on a site in its cooldown.
func (m *Manager) coolingSite(sites []string) error {
	m.paceMu.Lock()
	defer m.paceMu.Unlock()
	now := time.Now()
	return m.loadPace(now).coolingError(sites, now)
}

func (m *Manager) pacePath() string {
	return filepath.Join(m.options.StateDirectory, "computer-tools", "agent-chrome-pace.json")
}

// loadPace reads the record; a missing or unreadable one starts a new day.
// Callers hold paceMu.
func (m *Manager) loadPace(now time.Time) paceRecord {
	var record paceRecord
	if data, err := privatefs.ReadFile(m.pacePath(), 0); err == nil {
		_ = json.Unmarshal(data, &record)
	}
	if day := now.Format(time.DateOnly); record.Day != day {
		record.Day, record.Inputs = day, 0
	}
	return record
}

// savePace writes the record. Callers hold paceMu.
func (m *Manager) savePace(record paceRecord) error {
	if m.options.StateDirectory == "" {
		// A Manager without a state directory keeps no record rather than
		// writing one relative to the working directory.
		return nil
	}
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	return privatefs.WriteFile(m.pacePath(), data, false)
}

// paceAgentChrome admits inputs to the Computer's own browser: it refuses them
// after a reported check, during a cooldown or past a budget, waits out the
// pause since the last input, and counts reserve inputs against both
// budgets. It returns how many inputs the call may still send. A script
// reserves none up front; countScriptInputs adds what it sent.
func (c *cuaSession) paceAgentChrome(ctx context.Context, reserve int) (int, error) {
	op, m := c.op, c.op.manager
	op.mu.Lock()
	blocked, sent, sites := op.chromeBlocked, op.chromeInputs, slices.Collect(maps.Keys(op.chromeSites))
	op.mu.Unlock()
	if blocked != "" {
		return 0, fmt.Errorf("COMPUTER_SITE_BLOCKED: this task reported %s in the Computer's own browser, so it sends that browser no more input; tell the user what the page asks for and end the task: %w", blocked, errNotSent)
	}
	m.paceMu.Lock()
	defer m.paceMu.Unlock()
	now := time.Now()
	record := m.loadPace(now)
	if len(sites) == 0 {
		// A task that opened no URL may be on any page of that browser, so
		// every cooldown holds it.
		sites = slices.Collect(maps.Keys(record.Cooldowns))
	}
	if err := record.coolingError(sites, now); err != nil {
		return 0, err
	}
	left := min(agentChromeTaskInputs-sent, agentChromeDailyInputs-record.Inputs)
	if left < max(reserve, 1) {
		return 0, fmt.Errorf("COMPUTER_INPUT_BUDGET: the Computer's own browser has had its %d inputs for this task or %d for today; report what was done and end the task: %w", agentChromeTaskInputs, agentChromeDailyInputs, errNotSent)
	}
	if wait := time.Until(m.paceLast.Add(agentChromePause())); wait > 0 {
		if err := sleepContext(ctx, wait); err != nil {
			return 0, err
		}
	}
	if reserve > 0 {
		record.Inputs += reserve
		if err := m.savePace(record); err != nil {
			return 0, err
		}
		op.mu.Lock()
		op.chromeInputs += reserve
		op.mu.Unlock()
		m.paceLast = time.Now()
	}
	return left - reserve, nil
}

// countScriptInputs adds the inputs a script sent, as its driver call log
// lists them, to both budgets. A failed call may still have taken effect, so
// every listed input counts.
func (c *cuaSession) countScriptInputs(result json.RawMessage) {
	var reply struct {
		Structured struct {
			Calls []struct {
				Op string `json:"op"`
			} `json:"calls"`
		} `json:"structuredContent"`
	}
	if json.Unmarshal(result, &reply) != nil {
		return
	}
	sent := 0
	for _, call := range reply.Structured.Calls {
		if inputTools[call.Op] || call.Op == "set_value" {
			sent++
		}
	}
	if sent == 0 {
		return
	}
	op, m := c.op, c.op.manager
	op.mu.Lock()
	op.chromeInputs += sent
	op.mu.Unlock()
	m.paceMu.Lock()
	defer m.paceMu.Unlock()
	record := m.loadPace(time.Now())
	record.Inputs += sent
	_ = m.savePace(record)
	m.paceLast = time.Now()
}

const reportBlockerDescription = "Report a check on a page of the Computer's own browser that only the user may pass, as soon as a read or screenshot shows one. kind: captcha (a puzzle, slider or image check), verification (a code by text or mail, a QR scan, an identity check), login_required (a sign-in wall), rate_limited (the site says there were too many requests or asks to try later), content_unavailable (only this item cannot be viewed). url is the page's address as the address bar shows it. Except after content_unavailable, which only skips that item, the Computer sends that browser no more input in this task. Never try to pass the check yourself."

func reportBlockerSchema() json.RawMessage {
	encoded, _ := json.Marshal(schema(map[string]any{
		"kind": map[string]any{"type": "string", "enum": []string{"captcha", "verification", "login_required", "rate_limited", "content_unavailable"}},
		"url":  map[string]any{"type": "string"},
	}, "kind", "url"))
	return encoded
}

// reportBlocker records the check the Agent saw. A rate limit also keeps
// every task off that site in the Computer's own browser for
// agentChromeCooldown.
func (c *cuaSession) reportBlocker(args json.RawMessage) (json.RawMessage, error) {
	var params struct {
		Kind string `json:"kind"`
		URL  string `json:"url"`
	}
	if json.Unmarshal(args, &params) != nil || !blockerKinds[params.Kind] {
		return nil, errors.New("report_blocker takes kind: captcha, verification, login_required, rate_limited or content_unavailable")
	}
	site := siteOf(params.URL)
	if site == "" {
		return nil, errors.New("report_blocker takes url: the page's http or https address")
	}
	text := "Recorded. Skip this item and go on with the next one; say in the result which items could not be viewed."
	if params.Kind != "content_unavailable" {
		op, m := c.op, c.op.manager
		op.mu.Lock()
		op.chromeBlocked = params.Kind
		op.addChromeSites([]string{site})
		op.mu.Unlock()
		text = "Recorded. The Computer's own browser takes no more input in this task. Tell the user in the Room what the page asks for and that they can deal with it in that browser window, report what was done so far, and end the task. When the user replies, a new task reads the page and checks the signed-in account before it goes on."
		if params.Kind == "rate_limited" {
			m.paceMu.Lock()
			record := m.loadPace(time.Now())
			now := time.Now()
			if record.Cooldowns == nil {
				record.Cooldowns = map[string]time.Time{}
			}
			maps.DeleteFunc(record.Cooldowns, func(_ string, until time.Time) bool { return !until.After(now) })
			record.Cooldowns[site] = now.Add(agentChromeCooldown)
			err := m.savePace(record)
			m.paceMu.Unlock()
			if err != nil {
				return nil, err
			}
			text += fmt.Sprintf(" Every task stays off %s in that browser for %d minutes; say so to the user.", site, int(agentChromeCooldown.Minutes()))
		}
	}
	return json.Marshal(map[string]any{"content": []map[string]string{{"type": "text", "text": text}}})
}

// addChromeSites records sites this task opened in the Computer's own
// browser. Callers hold op.mu.
func (op *operation) addChromeSites(sites []string) {
	if op.chromeSites == nil {
		op.chromeSites = map[string]bool{}
	}
	for _, site := range sites {
		op.chromeSites[site] = true
	}
}

// refuseOtherBrowserOnChromeSite keeps a site this task opened in the
// Computer's own browser out of every other app: another browser has the
// user's sign-ins and none of the pace, so a blocked or failing task must not
// carry on there.
func (op *operation) refuseOtherBrowserOnChromeSite(urls []string) error {
	op.mu.Lock()
	defer op.mu.Unlock()
	for _, address := range urls {
		if site := siteOf(address); site != "" && op.chromeSites[site] {
			return fmt.Errorf("COMPUTER_BROWSER_REFUSED: this task uses %s in the Computer's own browser, so it opens that site in no other app; if that browser cannot show the page, tell the user and end the task: %w", site, errNotSent)
		}
	}
	return nil
}

// refuseBrowserOnChromeSite keeps the browser tools off a site that this
// task opened in the Computer's own browser or that is in its cooldown: such
// a site needs the user's sign-in and watches for automated browsers, and
// the browser tools drive Chrome through its debugging protocol, which such
// sites detect. Every other site stays open to the browser tools.
func (op *operation) refuseBrowserOnChromeSite(name string, args json.RawMessage) error {
	var params struct {
		URL string `json:"url"`
	}
	if name != "browser_navigate" && name != "browser_tabs" {
		return nil
	}
	// Arguments that do not decode name no URL, so there is no site to refuse.
	_ = json.Unmarshal(args, &params)
	site := siteOf(params.URL)
	if site == "" {
		return nil
	}
	op.mu.Lock()
	opened := op.chromeSites[site]
	op.mu.Unlock()
	if opened {
		return fmt.Errorf("COMPUTER_BROWSER_REFUSED: this task uses %s in the Computer's own browser, so the browser tools stay off that site; keep working with the computer tools in that browser", site)
	}
	if err := op.manager.coolingSite([]string{site}); err != nil {
		return fmt.Errorf("COMPUTER_BROWSER_REFUSED: %w", err)
	}
	return nil
}
