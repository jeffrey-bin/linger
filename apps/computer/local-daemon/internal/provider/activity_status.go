package provider

import (
	"fmt"
	"maps"
	"net/url"
	"path/filepath"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

// maxStatusSteps is how many steps of one tool call the Room status line
// plays; a longer script shows its last ones.
const maxStatusSteps = 3

// activityStatus is how the Room status line names one tool call: the
// Runtime's own description of it, or else the steps the Daemon reads from
// its input. Neither is set when nothing could be recognized.
type activityStatus struct {
	title string
	steps []string
}

// activityPresentation completes the kind an adapter gave a tool call and
// names it for the Room status line. A shell script gets the kind of its
// last shown step, the same for every Runtime's shell tool, and its input
// carries the script rather than the shell wrapper Codex reports around it.
func activityPresentation(message native.Event) (string, map[string]any, activityStatus) {
	kind, input := message.ActivityKind, message.Input
	if kind == "" {
		kind = native.ActivityTool
	}
	key := "command"
	command, _ := input[key].(string)
	if command == "" {
		key = "cmd"
		command, _ = input[key].(string)
	}
	if script := shellScript(command); script != command {
		input = maps.Clone(input)
		input[key], command = script, script
	}
	var steps []step
	if kind == native.ActivityCommand {
		steps = scriptSteps(command)
	} else if next, ok := toolStep(kind, message.ToolName, input); ok {
		steps = []step{next}
	}
	shown := slices.DeleteFunc(slices.Clone(steps), func(step step) bool { return step.quiet })
	switch {
	case len(shown) > 0:
		kind = shown[len(shown)-1].kind
	case len(steps) > 0:
		kind = steps[len(steps)-1].kind
	}
	// The Runtime's description already says what the call is for.
	if message.ActivityTitle != "" {
		return kind, input, activityStatus{title: message.ActivityTitle}
	}
	status := activityStatus{}
	for _, step := range shown[max(0, len(shown)-maxStatusSteps):] {
		status.steps = append(status.steps, step.phrase())
	}
	return kind, input, status
}

// step is one thing a tool call does, as the Room status line names it.
type step struct {
	kind string
	// text is a fixed phrase. Without it, the phrase names the step's
	// objects after verb ("Reading notes.md", "Reading 2 files"), or is
	// general when they cannot be named.
	text    string
	verb    string
	objects []string
	plural  string
	general string
	// quiet steps decide the kind but are not shown, like a message the
	// Room shows itself.
	quiet bool
}

func (s step) phrase() string {
	switch {
	case s.text != "":
		return s.text
	case len(s.objects) == 1:
		return s.verb + " " + s.objects[0]
	case len(s.objects) > 1 && s.plural != "":
		return fmt.Sprintf("%s %d %s", s.verb, len(s.objects), s.plural)
	}
	return s.general
}

// appendStep adds next, merging it into the last step when both do the same:
// reading two files is one step that reads 2 files.
func appendStep(steps []step, next step) []step {
	if len(steps) == 0 {
		return append(steps, next)
	}
	last := &steps[len(steps)-1]
	if last.quiet != next.quiet {
		return append(steps, next)
	}
	if last.verb != "" && last.verb == next.verb && last.text == "" && next.text == "" {
		if len(last.objects) > 0 && len(next.objects) > 0 {
			for _, object := range next.objects {
				if !slices.Contains(last.objects, object) {
					last.objects = append(last.objects, object)
				}
			}
		} else {
			last.objects = nil
		}
		last.kind = next.kind
		return steps
	}
	if last.phrase() == next.phrase() {
		last.kind = next.kind
		return steps
	}
	return append(steps, next)
}

// listingTools list files by name patterns rather than search contents.
var listingTools = map[string]bool{"Glob": true, "find": true, "ls": true}

// webSearchTools search the web, never the workspace.
var webSearchTools = map[string]bool{"web_search": true, "WebSearch": true}

// toolStep names a classified tool call that is not a shell command by what
// it works on. MCP tools keep their kind's general phrase.
func toolStep(kind, tool string, input map[string]any) (step, bool) {
	if strings.HasPrefix(tool, "mcp__") || input["server"] != nil {
		return step{}, false
	}
	switch kind {
	case native.ActivityRead:
		return readStep(inputPaths(input)), true
	case native.ActivityFileChange:
		if tool == "Write" || tool == "write" {
			return writeStep(inputPaths(input)), true
		}
		return editStep(inputPaths(input)), true
	case native.ActivitySearch:
		query, _ := firstValue(input, "query", "pattern", "q").(string)
		if query != "" && !listingTools[tool] {
			return searchStep(query), true
		}
		// Codex starts a web search before it reports the query.
		if webSearchTools[tool] {
			return step{kind: native.ActivitySearch, text: "Searching the web"}, true
		}
		return listStep(inputPaths(input)), true
	case native.ActivityBrowse:
		address, _ := input["url"].(string)
		return fetchStep(address), true
	}
	if tool == "Skill" {
		return step{kind: kind, text: "Using a skill"}, true
	}
	return step{}, false
}

func readStep(paths []string) step {
	return step{kind: native.ActivityRead, verb: "Reading", objects: fileNames(paths), plural: "files", general: "Reading files"}
}

func writeStep(paths []string) step {
	return step{kind: native.ActivityFileChange, verb: "Writing", objects: fileNames(paths), plural: "files", general: "Writing files"}
}

func editStep(paths []string) step {
	return step{kind: native.ActivityFileChange, verb: "Editing", objects: fileNames(paths), plural: "files", general: "Editing files"}
}

func listStep(paths []string) step {
	return step{kind: native.ActivitySearch, verb: "Looking through", objects: folderNames(paths), plural: "folders", general: "Looking through files"}
}

// searchStep quotes what is searched for. A regular expression or two
// searches are just searching.
func searchStep(query string) step {
	query = strings.Join(strings.Fields(query), " ")
	search := step{kind: native.ActivitySearch, verb: "Searching for", general: "Searching"}
	if query != "" && !strings.ContainsAny(query, `[]\^$*+{}|()<>`) {
		search.objects = []string{`"` + clip(query, 30) + `"`}
	}
	return search
}

// fetchStep names the site of address, without its path or query.
func fetchStep(addresses ...string) step {
	var hosts []string
	for _, address := range addresses {
		if host := siteName(address); host != "" && !slices.Contains(hosts, host) {
			hosts = append(hosts, host)
		}
	}
	return step{kind: native.ActivityBrowse, verb: "Fetching", objects: hosts, plural: "pages", general: "Fetching web pages"}
}

// inputPaths are the files a tool input names.
func inputPaths(input map[string]any) []string {
	var paths []string
	for _, key := range []string{"file_path", "notebook_path", "path", "filename"} {
		if path, ok := input[key].(string); ok && path != "" {
			paths = append(paths, path)
		}
	}
	entries, _ := input["paths"].([]any)
	if changes, ok := input["changes"].([]any); ok {
		entries = append(entries, changes...)
	}
	for _, entry := range entries {
		switch value := entry.(type) {
		case string:
			paths = append(paths, value)
		case map[string]any:
			if path, ok := value["path"].(string); ok {
				paths = append(paths, path)
			}
		}
	}
	return paths
}

func firstValue(input map[string]any, keys ...string) any {
	for _, key := range keys {
		if value, ok := input[key]; ok {
			return value
		}
	}
	return nil
}

// fileNames keeps the names of paths, without their directories.
func fileNames(paths []string) []string {
	var names []string
	for _, path := range paths {
		name := filepath.Base(strings.TrimRight(path, "/"))
		if name == "." || name == "/" || name == "~" || strings.ContainsAny(name, "*?[$") {
			continue
		}
		if name = clip(name, 40); !slices.Contains(names, name) {
			names = append(names, name)
		}
	}
	return names
}

// folderNames keeps the last folder of each listed path.
func folderNames(paths []string) []string {
	var folders []string
	for _, path := range paths {
		if strings.ContainsAny(path, "*?[$") {
			continue
		}
		folders = append(folders, path)
	}
	return fileNames(folders)
}

// siteName is the host of an http(s) address without "www.".
func siteName(address string) string {
	if !strings.HasPrefix(address, "http://") && !strings.HasPrefix(address, "https://") {
		return ""
	}
	parsed, err := url.Parse(address)
	if err != nil || parsed.Hostname() == "" || strings.Contains(parsed.Hostname(), "$") {
		return ""
	}
	return clip(strings.TrimPrefix(parsed.Hostname(), "www."), 40)
}

func clip(value string, limit int) string {
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	return strings.TrimRight(string([]rune(value)[:limit-1]), " ") + "…"
}
