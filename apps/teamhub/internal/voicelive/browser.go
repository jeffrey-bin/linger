package voicelive

import (
	"regexp"
	"strings"
)

// ToolComputerBrowser drives the Chrome on the owner's Local Computer. It is
// offered only when the session's Agent has one.
const ToolComputerBrowser = "computer_browser"

// MaxBrowserCallsPerTurn bounds how long the live voice keeps trying on its
// own within one user turn before it must ask the user or hand the work over.
const MaxBrowserCallsPerTurn = 6

// MaxBrowserPageRunes bounds the page text read to the live model.
const MaxBrowserPageRunes = 6000

// BrowserTool describes the native browser operations offered to Live.
var BrowserTool = Tool{
	Name: ToolComputerBrowser,
	Description: "Operate the Chrome on the user's own Local Computer yourself while you keep talking, like sitting next to them; they can watch it on their own desktop. " +
		"Use it when the user wants to open, browse, search or read a website together with you or asks what is on that page; a site the user names is opened here, not answered with web search. " +
		"action: open (url), look (read the page as text with refs), click (ref), type (ref, text, submit to press Enter), back. Every result is the page as text with refs; read it before you click or type and never guess what a page says. " +
		"Say only what you found and what comes next, never each step. A login, QR code or CAPTCHA is the user's: stop and ask them to take over on their own desktop, then look again when they say they are done. " +
		"Set commits=true on a click that sends, submits, posts, pays, orders, transfers, confirms or deletes something in the user's name, judged by what it does in any language; it and every Enter return needs_confirmation: restate it, and call again with confirmed=true only after the user says yes. " +
		"If a few tries make no progress (an element that will not respond, a page that will not load), stop and tell the user where it is stuck. Long work across many pages or that ends in a document is start_task: say in its goal what is done and the page to go on from. still_working means a slow step goes on while you keep talking; you are told when its page arrives.",
	Parameters: objectSchema([]string{"action", "commits"}, map[string]any{
		"action":    map[string]any{"type": "string", "enum": []string{"open", "look", "click", "type", "back"}},
		"url":       stringProperty("For open: the address"),
		"ref":       stringProperty("For click and type: the element ref from the latest page text"),
		"text":      stringProperty("For type: the text to enter"),
		"submit":    map[string]any{"type": "boolean", "description": "For type: press Enter after typing"},
		"commits":   map[string]any{"type": "boolean", "description": "For click: whether it sends, submits, pays, orders or deletes something in the user's name; false for anything else"},
		"confirmed": map[string]any{"type": "boolean", "description": "Only after the user said yes to this exact click or Enter"},
	}),
}

// BrowserConnectionDetail tells the live model what to say when the owner's
// Chrome is not connected or is busy, so nothing ran: the user connects it
// once under Settings, Computers, or the work goes to a background task,
// which can use their Chrome through the desktop.
func BrowserConnectionDetail(code string) (string, bool) {
	switch code {
	case "browser_connection_required":
		return "Nothing was done: the user's Chrome is not connected to you yet. Tell them so in one sentence and that they can connect it once in Settings under Computers; until then offer to do it as a background task with start_task (surface web). Never call this tool again in this call until they say it is connected, and never blame Chrome, sleep or a frozen window.", true
	case "browser_connection_invalid":
		return "Nothing was done: the saved connection to the user's Chrome no longer works. Tell them so in one sentence and that they can reconnect it in Settings under Computers; until then offer to do it as a background task with start_task (surface web). Never call this tool again in this call until they say it is reconnected.", true
	case "browser_busy":
		return "Nothing was done: a background task is using the user's Chrome right now. Tell them so in one sentence and offer to try again when that task finishes; do not call this tool again right away.", true
	}
	return "", false
}

// BrowserArguments holds one browser action and its explicit confirmation.
type BrowserArguments struct {
	Action string `json:"action"`
	URL    string `json:"url"`
	Ref    string `json:"ref"`
	Text   string `json:"text"`
	Submit bool   `json:"submit"`
	// Commits is the model's word that a click acts in the user's name.
	Commits LooseBool `json:"commits"`
	// Confirmed is the model's word that the user said yes; TeamHub
	// checks it against the prompt the user heard.
	Confirmed LooseBool `json:"confirmed"`
}

var refLinePattern = regexp.MustCompile(`"([^"]{1,80})"[^\n]*\[ref=([A-Za-z0-9_-]+)\]`)

// BrowserRisk says what a browser action would do in the user's name when
// it may send, pay or delete: pressing Enter in a field, or a click the
// model marks as commits. lastPage is the page text the ref came from.
func BrowserRisk(args BrowserArguments, lastPage string) (string, bool) {
	ref := strings.TrimSpace(args.Ref)
	switch args.Action {
	case "type":
		if args.Submit {
			return "Will type “" + Snippet(args.Text) + "” into field " + ref + " on the local browser and press Enter", true
		}
	case "click":
		if args.Commits {
			label := "element " + ref
			for _, match := range refLinePattern.FindAllStringSubmatch(lastPage, -1) {
				if match[2] == ref {
					label = "“" + match[1] + "”"
					break
				}
			}
			return "Will click " + label + " on the local browser", true
		}
	}
	return "", false
}

// BrowserCall maps a live browser action to the Computer's browser tool, or
// reports the arguments invalid.
func BrowserCall(args BrowserArguments) (string, map[string]any, bool) {
	ref := strings.TrimSpace(args.Ref)
	switch args.Action {
	case "open":
		url := strings.TrimSpace(args.URL)
		if url == "" {
			return "", nil, false
		}
		if !strings.Contains(url, "://") {
			url = "https://" + url
		}
		return "browser_navigate", map[string]any{"url": url}, true
	case "look":
		return "browser_snapshot", map[string]any{}, true
	case "click":
		if ref == "" {
			return "", nil, false
		}
		return "browser_click", map[string]any{"target": ref, "element": "element " + ref}, true
	case "type":
		if ref == "" {
			return "", nil, false
		}
		return "browser_type", map[string]any{"target": ref, "element": "field " + ref, "text": args.Text, "submit": args.Submit}, true
	case "back":
		return "browser_navigate_back", map[string]any{}, true
	}
	return "", nil, false
}

var (
	ranCodePattern = regexp.MustCompile("(?s)### Ran Playwright code\n```[a-z]*\n.*?```\n*")
	urlLinePattern = regexp.MustCompile(`(?m)^\s*- /url: .*\n`)
)

var pageURLPattern = regexp.MustCompile(`(?m)Page URL: (\S+)`)

// BrowserPageURL is the address of a browser page text, or "" when it has
// none.
func BrowserPageURL(page string) string {
	if match := pageURLPattern.FindStringSubmatch(page); match != nil {
		return match[1]
	}
	return ""
}

// BrowserPage trims a browser tool result to what a voice model needs: the
// page and its refs, without the code that ran or every link target.
func BrowserPage(text string) (string, bool) {
	text = ranCodePattern.ReplaceAllString(text, "")
	text = urlLinePattern.ReplaceAllString(text, "")
	return Truncate(strings.TrimSpace(text), MaxBrowserPageRunes)
}
