package permissionreview

import (
	"encoding/json"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
)

// Card budgets. The card is part of every timeline load, so the full call and
// its evidence are bounded; the judge still saw them whole.
const (
	maxCardTitle     = 120
	maxCardInput     = 8000
	maxCardEvidence  = 20000
	maxTitleFragment = 60
)

// Card is what the approver reads: a title built by rules from the call and
// the host's evidence, the judge's rationale, and the full call with its
// evidence for the card's details.
func Card(action Action, evidence Evidence, workspace, rationale string) typedcard.RuntimePermissionCard {
	input := action.Input
	if input == "" {
		input = action.Command
	}
	card := typedcard.RuntimePermissionCard{
		Kind:      "code",
		Title:     truncateRunes(Title(action, evidence, workspace), maxCardTitle),
		Rationale: truncateRunes(rationale, 2000),
		Tool:      action.Tool,
		Input:     truncateRunes(input, maxCardInput),
		Patch:     truncateRunes(cardPatch(action, evidence), maxCardEvidence),
	}
	if action.Surface == "browser" || action.Surface == "computer" {
		card.Kind = "gui"
	}
	if script := evidence.Script; script != nil {
		card.Script = &typedcard.RuntimePermissionScript{
			Path: script.Path, SHA256: script.SHA256, Body: truncateRunes(script.Body, maxCardEvidence),
		}
	}
	if screenshot := evidence.Screenshot; screenshot != nil {
		card.Screenshot = &typedcard.RuntimePermissionScreenshot{Width: screenshot.Width, Height: screenshot.Height}
	}
	if browser := evidence.Browser; browser != nil && browser.URL != "" {
		card.Page = &typedcard.RuntimePermissionPage{
			URL: browser.URL, Title: browser.Title, TargetRole: browser.TargetRole, TargetName: browser.TargetName,
		}
	}
	return card
}

// Title names the action in a few words, from the call and host evidence only:
// "Edit deploy/values.yaml", "Run scripts/clean.sh", `Click "Merge" · GitLab
// (git.example.com)`. Text the Agent wrote about its own call (a browser
// element description, a command description) never names the target.
func Title(action Action, evidence Evidence, workspace string) string {
	switch action.Surface {
	case "browser":
		return browserTitle(action, evidence.Browser)
	case "computer":
		return computerTitle(action, evidence.Desktop)
	case "file_edit":
		return fileTitle(action, evidence, workspace)
	case "web":
		return webTitle(action)
	}
	if evidence.Script != nil {
		return "Run " + displayPath(evidence.Script.Path, workspace)
	}
	if action.Command != "" {
		return "Run " + commandHead(action.Command)
	}
	if server, tool, ok := mcpTool(action.Tool); ok {
		return "Use " + server + " " + tool
	}
	return "Use " + action.Tool
}

var browserVerbs = map[string]string{
	"click":         "Click",
	"type":          "Type in",
	"fill_form":     "Fill in a form",
	"select_option": "Choose an option",
	"press_key":     "Press a key",
	"drag":          "Drag",
	"file_upload":   "Upload a file",
	"handle_dialog": "Answer a dialog",
	"evaluate":      "Run JavaScript",
	"run_code":      "Run code",
	"navigate_back": "Go back",
	"tabs":          "Change tabs",
	"close":         "Close the browser",
}

func browserTitle(action Action, page *BrowserEvidence) string {
	name := strings.TrimPrefix(action.Tool, "mcp__browser__browser_")
	if name == "navigate" {
		if host := urlHost(inputString(action.Input, "url")); host != "" {
			return "Open " + host
		}
		return "Open a page"
	}
	verb, ok := browserVerbs[name]
	if !ok {
		verb = "Use the browser"
	}
	if page == nil || urlHost(page.URL) == "" {
		if !ok {
			return verb
		}
		return verb + " in the browser"
	}
	title := verb
	if page.TargetName != "" {
		title += ` "` + fragment(page.TargetName) + `"`
	}
	return title + " · " + pagePlace(page)
}

// pagePlace is the page's host, with the site name the page title ends with
// when there is one ("… · GitLab"). The page writes its own title, so the host
// always stays in view.
func pagePlace(page *BrowserEvidence) string {
	host := urlHost(page.URL)
	title := page.Title
	site := ""
	for _, separator := range []string{" · ", " | ", " - ", " — "} {
		if index := strings.LastIndex(title, separator); index >= 0 {
			site = strings.TrimSpace(title[index+len(separator):])
			break
		}
	}
	if site == "" || utf8.RuneCountInString(site) > 40 || strings.EqualFold(site, host) {
		return host
	}
	return site + " (" + host + ")"
}

var computerVerbs = map[string]string{
	"click":         "Click",
	"click_element": "Click",
	"double_click":  "Double-click",
	"right_click":   "Right-click",
	"drag":          "Drag",
	"type_text":     "Type",
	"set_value":     "Fill in",
	"press_key":     "Press keys",
	"hotkey":        "Press keys",
	"screenshot":    "Take a screenshot",
}

// computerTitle names a desktop action by its verb, the element its token
// names and the app: `Click "Send" in Mail`. run_actions takes the verb of
// its first step.
func computerTitle(action Action, desktop *DesktopEvidence) string {
	name := strings.TrimPrefix(action.Tool, "mcp__computer__")
	if name == "run_actions" {
		var steps struct {
			Actions []struct {
				Tool string `json:"tool"`
			} `json:"actions"`
		}
		if json.Unmarshal([]byte(action.Input), &steps) == nil && len(steps.Actions) > 0 {
			name = steps.Actions[0].Tool
		}
	}
	if verb, ok := computerVerbs[name]; ok && desktop != nil {
		target := ""
		if len(desktop.Targets) > 0 && desktop.Targets[0].Name != "" {
			target = ` "` + fragment(desktop.Targets[0].Name) + `"`
		}
		place := desktop.App
		if place == "" {
			place = desktop.WindowTitle
		}
		switch {
		case place != "":
			return verb + target + " in " + fragment(place)
		case target != "":
			return verb + target + " on the desktop"
		}
	}
	switch name {
	case "open_url":
		if host := urlHost(inputString(action.Input, "url")); host != "" {
			return "Open " + host
		}
	case "run_command":
		if command := inputString(action.Input, "command"); command != "" {
			return "Run " + commandHead(command)
		}
	}
	if verb, ok := computerVerbs[name]; ok {
		return verb + " on the desktop"
	}
	return "Use the desktop"
}

func webTitle(action Action) string {
	switch action.Tool {
	case "WebFetch":
		if host := urlHost(inputString(action.Input, "url")); host != "" {
			return "Fetch " + host
		}
		return "Fetch a page"
	case "WebSearch":
		if query := inputString(action.Input, "query"); query != "" {
			return `Search the web for "` + fragment(query) + `"`
		}
	}
	return "Search the web"
}

var patchHeaders = []struct{ prefix, verb string }{
	{"*** Update File: ", "Edit"},
	{"*** Add File: ", "Create"},
	{"*** Delete File: ", "Delete"},
}

// fileTitle names the edited files from the patch headers (apply_patch) or
// the tool input (Edit, Write). A path keeps its directories, so
// prod/values.yaml and staging/values.yaml never read the same.
func fileTitle(action Action, evidence Evidence, workspace string) string {
	type change struct{ verb, path string }
	var changes []change
	for _, line := range strings.Split(evidence.Patch, "\n") {
		for _, header := range patchHeaders {
			if path, ok := strings.CutPrefix(line, header.prefix); ok {
				changes = append(changes, change{header.verb, strings.TrimSpace(path)})
			}
		}
	}
	if len(changes) == 0 {
		path := inputString(action.Input, "file_path")
		if path == "" {
			path = inputString(action.Input, "notebook_path")
		}
		verb := "Edit"
		if action.Tool == "Write" {
			verb = "Write"
		}
		if path == "" {
			return verb + " files"
		}
		return verb + " " + displayPath(path, workspace)
	}
	first := changes[0]
	if len(changes) == 1 {
		return first.verb + " " + displayPath(first.path, workspace)
	}
	more := " and 1 more file"
	if len(changes) > 2 {
		more = " and " + strconv.Itoa(len(changes)-1) + " more files"
	}
	return "Edit " + displayPath(first.path, workspace) + more
}

// cardPatch is the diff the details show: the host's patch, or one built from
// an Edit or Write input.
func cardPatch(action Action, evidence Evidence) string {
	if evidence.Patch != "" {
		return evidence.Patch
	}
	if action.Surface != "file_edit" {
		return ""
	}
	var input struct {
		FilePath  string `json:"file_path"`
		OldString string `json:"old_string"`
		NewString string `json:"new_string"`
		Content   string `json:"content"`
		Edits     []struct {
			OldString string `json:"old_string"`
			NewString string `json:"new_string"`
		} `json:"edits"`
	}
	if json.Unmarshal([]byte(action.Input), &input) != nil || input.FilePath == "" {
		return ""
	}
	var b strings.Builder
	b.WriteString("--- " + input.FilePath + "\n+++ " + input.FilePath + "\n")
	edits := input.Edits
	if input.OldString != "" || input.NewString != "" {
		edits = append(edits, struct {
			OldString string `json:"old_string"`
			NewString string `json:"new_string"`
		}{input.OldString, input.NewString})
	}
	for _, edit := range edits {
		b.WriteString("@@\n")
		writeLines(&b, "-", edit.OldString)
		writeLines(&b, "+", edit.NewString)
	}
	if action.Tool == "Write" {
		writeLines(&b, "+", input.Content)
	}
	return strings.TrimSuffix(b.String(), "\n")
}

func writeLines(b *strings.Builder, mark, text string) {
	if text == "" {
		return
	}
	for _, line := range strings.Split(strings.TrimSuffix(text, "\n"), "\n") {
		b.WriteString(mark + line + "\n")
	}
}

// displayPath shows a path relative to the workspace, cut from the left when
// long so the file name stays.
func displayPath(path, workspace string) string {
	if workspace != "" && filepath.IsAbs(path) {
		if relative, err := filepath.Rel(workspace, path); err == nil && !strings.HasPrefix(relative, "..") {
			path = relative
		}
	}
	runes := []rune(path)
	if len(runes) <= maxTitleFragment {
		return path
	}
	return "…" + string(runes[len(runes)-maxTitleFragment+1:])
}

// commandHead is the command's first line, cut to a title's length.
func commandHead(command string) string {
	line := strings.TrimSpace(command)
	if index := strings.IndexByte(line, '\n'); index >= 0 {
		line = strings.TrimSpace(line[:index]) + " …"
	}
	return fragment(strings.Join(strings.Fields(line), " "))
}

func fragment(value string) string {
	value = strings.TrimSpace(value)
	if utf8.RuneCountInString(value) <= maxTitleFragment {
		return value
	}
	return string([]rune(value)[:maxTitleFragment-1]) + "…"
}

func mcpTool(tool string) (string, string, bool) {
	rest, ok := strings.CutPrefix(tool, "mcp__")
	if !ok {
		return "", "", false
	}
	server, name, ok := strings.Cut(rest, "__")
	return server, name, ok && server != "" && name != ""
}

func inputString(input, key string) string {
	var fields map[string]any
	if json.Unmarshal([]byte(input), &fields) != nil {
		return ""
	}
	value, _ := fields[key].(string)
	return strings.TrimSpace(value)
}

func urlHost(raw string) string {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return ""
	}
	return parsed.Hostname()
}
