package voicelive

import (
	"strings"
	"testing"
)

func TestBrowserActionsMapToTheComputersBrowserTools(t *testing.T) {
	for _, check := range []struct {
		args BrowserArguments
		tool string
		ok   bool
	}{
		{BrowserArguments{Action: "open", URL: "news.ycombinator.com"}, "browser_navigate", true},
		{BrowserArguments{Action: "open"}, "", false},
		{BrowserArguments{Action: "look"}, "browser_snapshot", true},
		{BrowserArguments{Action: "click", Ref: "e61"}, "browser_click", true},
		{BrowserArguments{Action: "click"}, "", false},
		{BrowserArguments{Action: "type", Ref: "e47", Text: "Anthropic", Submit: true}, "browser_type", true},
		{BrowserArguments{Action: "back"}, "browser_navigate_back", true},
		{BrowserArguments{Action: "run_code"}, "", false},
	} {
		tool, arguments, ok := BrowserCall(check.args)
		if tool != check.tool || ok != check.ok {
			t.Fatalf("%+v: got %q %v", check.args, tool, ok)
		}
		if tool == "browser_navigate" && arguments["url"] != "https://news.ycombinator.com" {
			t.Fatalf("url not completed: %v", arguments)
		}
		if tool == "browser_type" && (arguments["target"] != "e47" || arguments["submit"] != true) {
			t.Fatalf("type arguments: %v", arguments)
		}
	}
	if len(BrowserTool.Description) > 2000 || BrowserTool.Parameters["type"] != "object" {
		t.Fatal("browser tool spec is invalid")
	}
}

func TestBrowserPageKeepsThePageAndDropsNoise(t *testing.T) {
	page, truncated := BrowserPage("### Ran Playwright code\n```js\nawait page.goto('x');\n```\n### Page\n- Page URL: https://x\n- link \"News\" [ref=e1]:\n  - /url: https://x/news\n")
	if truncated || strings.Contains(page, "page.goto") || strings.Contains(page, "/url:") || !strings.Contains(page, `link "News" [ref=e1]`) {
		t.Fatalf("page: %q", page)
	}
	if _, truncated := BrowserPage(strings.Repeat("x", MaxBrowserPageRunes+10)); !truncated {
		t.Fatal("long pages are truncated")
	}
}

func TestBrowserRiskCatchesSendsAndPaymentsOnly(t *testing.T) {
	page := "- textbox \"Search\" [ref=e3]\n- button \"Passer la commande\" [ref=e7]\n- link \"Sony WH-1000XM5\" [ref=e9]\n- button \"Send\" [ref=e11]"
	for _, check := range []struct {
		args  BrowserArguments
		risky bool
	}{
		// The model marks a click that acts in the user's name, in any language.
		{BrowserArguments{Action: "click", Ref: "e7", Commits: true}, true},
		{BrowserArguments{Action: "click", Ref: "e11", Commits: true}, true},
		{BrowserArguments{Action: "click", Ref: "e99", Commits: true}, true},
		{BrowserArguments{Action: "click", Ref: "e7"}, false},
		{BrowserArguments{Action: "click", Ref: "e9"}, false},
		{BrowserArguments{Action: "type", Ref: "e3", Text: "headphones"}, false},
		{BrowserArguments{Action: "type", Ref: "e3", Text: "headphones", Submit: true}, true},
		{BrowserArguments{Action: "open", URL: "jd.com"}, false},
	} {
		if summary, risky := BrowserRisk(check.args, page); risky != check.risky || risky && summary == "" {
			t.Fatalf("%+v: risky=%v summary=%q", check.args, risky, summary)
		}
	}
}

func TestBrowserRiskNamesTheClickedElement(t *testing.T) {
	page := "- button \"Place order\" [ref=e7]"
	if summary, _ := BrowserRisk(BrowserArguments{Action: "click", Ref: "e7", Commits: true}, page); summary != "Will click “Place order” on the local browser" {
		t.Fatalf("summary=%q", summary)
	}
	if summary, _ := BrowserRisk(BrowserArguments{Action: "click", Ref: "e8", Commits: true}, page); summary != "Will click element e8 on the local browser" {
		t.Fatalf("summary=%q", summary)
	}
}

func TestBrowserPageURLReadsWhereThePageIs(t *testing.T) {
	page := "### Page state\n- Page URL: https://cart.jd.com/cart\n- Page Title: Cart\n- button \"Passer la commande\" [ref=e7]"
	if got := BrowserPageURL(page); got != "https://cart.jd.com/cart" {
		t.Fatalf("url=%q", got)
	}
	if got := BrowserPageURL("no page"); got != "" {
		t.Fatalf("url=%q", got)
	}
}

func TestBrowserConnectionDetailSendsTheUserToConnectChrome(t *testing.T) {
	for _, code := range []string{"browser_connection_required", "browser_connection_invalid"} {
		detail, ok := BrowserConnectionDetail(code)
		if !ok || !strings.Contains(detail, "Settings under Computers") || !strings.Contains(detail, "start_task") {
			t.Fatalf("%s: %q", code, detail)
		}
	}
	if _, ok := BrowserConnectionDetail("outcome_unknown"); ok {
		t.Fatal("an unknown outcome is not a missing connection")
	}
}
