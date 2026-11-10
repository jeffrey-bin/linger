package localtools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func paceFixture(t *testing.T) (*Manager, *cuaSession) {
	t.Helper()
	pause := agentChromePause
	agentChromePause = func() time.Duration { return 0 }
	t.Cleanup(func() { agentChromePause = pause })
	m := &Manager{options: Options{StateDirectory: t.TempDir()}}
	return m, &cuaSession{op: &operation{manager: m}}
}

func TestAgentChromePaceCountsInputsAndStopsAfterAReportedCheck(t *testing.T) {
	m, c := paceFixture(t)
	if left, err := c.paceAgentChrome(context.Background(), 1); err != nil || left != agentChromeTaskInputs-1 {
		t.Fatalf("left %d, err %v", left, err)
	}
	if record := m.loadPace(time.Now()); record.Inputs != 1 || c.op.chromeInputs != 1 {
		t.Fatalf("record %+v, task %d", record, c.op.chromeInputs)
	}
	// A script's inputs count from its call log, failed ones included.
	c.countScriptInputs(json.RawMessage(`{"structuredContent":{"calls":[{"op":"click","ok":true},{"op":"get_window_state","ok":true},{"op":"set_value","ok":false}]}}`))
	if record := m.loadPace(time.Now()); record.Inputs != 3 || c.op.chromeInputs != 3 {
		t.Fatalf("record %+v, task %d", record, c.op.chromeInputs)
	}
	// An item that cannot be viewed only skips that item.
	if _, err := c.reportBlocker(json.RawMessage(`{"kind":"content_unavailable","url":"https://www.example.com/p/1"}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := c.paceAgentChrome(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
	if _, err := c.reportBlocker(json.RawMessage(`{"kind":"captcha","url":"https://www.example.com/p/2"}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := c.paceAgentChrome(context.Background(), 1); !errors.Is(err, errNotSent) || !strings.Contains(err.Error(), "COMPUTER_SITE_BLOCKED") {
		t.Fatalf("got %v", err)
	}
	// A captcha stops only its own task.
	other := &cuaSession{op: &operation{manager: m}}
	if _, err := other.paceAgentChrome(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
	if _, err := c.reportBlocker(json.RawMessage(`{"kind":"guess","url":"https://www.example.com/"}`)); err == nil {
		t.Fatal("an unknown kind was accepted")
	}
	if _, err := c.reportBlocker(json.RawMessage(`{"kind":"captcha","url":"about:blank"}`)); err == nil {
		t.Fatal("a blocker without a web address was accepted")
	}
}

func TestAgentChromePaceKeepsEveryTaskOffARateLimitedSite(t *testing.T) {
	m, c := paceFixture(t)
	if _, err := c.reportBlocker(json.RawMessage(`{"kind":"rate_limited","url":"https://edith.example.com/feed"}`)); err != nil {
		t.Fatal(err)
	}
	// Another task on the same site, on any of its hosts, is held.
	same := &cuaSession{op: &operation{manager: m}}
	same.op.addChromeSites([]string{siteOf("https://www.example.com/")})
	if _, err := same.paceAgentChrome(context.Background(), 1); !errors.Is(err, errNotSent) || !strings.Contains(err.Error(), "COMPUTER_SITE_COOLDOWN") {
		t.Fatalf("got %v", err)
	}
	// A task that opened no URL may be on that site, so it is held too.
	unknown := &cuaSession{op: &operation{manager: m}}
	if _, err := unknown.paceAgentChrome(context.Background(), 1); !strings.Contains(fmt.Sprint(err), "COMPUTER_SITE_COOLDOWN") {
		t.Fatalf("got %v", err)
	}
	// A task on another site goes on.
	elsewhere := &cuaSession{op: &operation{manager: m}}
	elsewhere.op.addChromeSites([]string{siteOf("https://shop.example.org/")})
	if _, err := elsewhere.paceAgentChrome(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
	if err := m.coolingSite([]string{"example.com"}); err == nil {
		t.Fatal("launch on the cooling site was allowed")
	}
}

func TestAgentChromePaceRefusesPastTheBudgets(t *testing.T) {
	m, c := paceFixture(t)
	c.op.chromeInputs = agentChromeTaskInputs
	if _, err := c.paceAgentChrome(context.Background(), 1); !errors.Is(err, errNotSent) || !strings.Contains(err.Error(), "COMPUTER_INPUT_BUDGET") {
		t.Fatalf("got %v", err)
	}
	if err := m.savePace(paceRecord{Day: time.Now().Format(time.DateOnly), Inputs: agentChromeDailyInputs}); err != nil {
		t.Fatal(err)
	}
	other := &cuaSession{op: &operation{manager: m}}
	if _, err := other.paceAgentChrome(context.Background(), 0); !strings.Contains(err.Error(), "COMPUTER_INPUT_BUDGET") {
		t.Fatalf("got %v", err)
	}
	// A new day starts a new count.
	if err := m.savePace(paceRecord{Day: "2000-01-01", Inputs: agentChromeDailyInputs}); err != nil {
		t.Fatal(err)
	}
	if _, err := other.paceAgentChrome(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
}

func TestAgentChromePaceWaitsBetweenInputs(t *testing.T) {
	_, c := paceFixture(t)
	agentChromePause = func() time.Duration { return 150 * time.Millisecond }
	if _, err := c.paceAgentChrome(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	if _, err := c.paceAgentChrome(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
	if waited := time.Since(started); waited < 100*time.Millisecond {
		t.Fatalf("waited only %v", waited)
	}
}

func TestBrowserToolsStayOffOnlyTheSitesOfTheComputersChrome(t *testing.T) {
	m, c := paceFixture(t)
	navigate := func(op *operation, address string) error {
		return op.refuseBrowserOnChromeSite("browser_navigate", json.RawMessage(`{"url":"`+address+`"}`))
	}
	c.op.addChromeSites([]string{siteOf("https://www.example.com/")})
	if err := navigate(c.op, "https://m.example.com/note/1"); err == nil || !strings.Contains(err.Error(), "COMPUTER_BROWSER_REFUSED") {
		t.Fatalf("got %v", err)
	}
	if err := navigate(c.op, "https://docs.example.org/"); err != nil {
		t.Fatal(err)
	}
	if err := c.op.refuseBrowserOnChromeSite("browser_snapshot", json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}
	// Nor may the task open that site in another app, such as the user's Chrome.
	if err := c.op.refuseOtherBrowserOnChromeSite([]string{"https://www.example.com/feed"}); !errors.Is(err, errNotSent) {
		t.Fatalf("got %v", err)
	}
	if err := c.op.refuseOtherBrowserOnChromeSite([]string{"https://docs.example.org/", "/tmp/file.txt"}); err != nil {
		t.Fatal(err)
	}
	// A site in its cooldown is off the browser tools for every task.
	if err := m.savePace(paceRecord{Day: time.Now().Format(time.DateOnly), Cooldowns: map[string]time.Time{"example.net": time.Now().Add(time.Minute)}}); err != nil {
		t.Fatal(err)
	}
	other := &operation{manager: m}
	if err := navigate(other, "https://www.example.net/"); err == nil || !strings.Contains(err.Error(), "COMPUTER_SITE_COOLDOWN") {
		t.Fatalf("got %v", err)
	}
}

func TestSiteOfTakesTheRegistrableDomain(t *testing.T) {
	for address, want := range map[string]string{
		"https://www.Example.co.uk/a": "example.co.uk",
		"http://127.0.0.1:8766/s/x":   "127.0.0.1",
		"http://localhost:3000/":      "localhost",
		"about:blank":                 "",
		"not a url":                   "",
	} {
		if got := siteOf(address); got != want {
			t.Errorf("siteOf(%q) = %q, want %q", address, got, want)
		}
	}
}
