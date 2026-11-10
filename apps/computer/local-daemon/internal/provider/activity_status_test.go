package provider

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

// Scripts Agents ran in Rooms, named the same for every Runtime's shell tool.
func TestShellScriptsAreNamedByTheirSteps(t *testing.T) {
	for _, test := range []struct {
		command, kind string
		steps         []string
	}{
		{"teamhub room protocol --json 2>&1 | head -60", "tool", []string{"Reading the room protocol"}},
		{"teamhub knowledge search 'GTA6 datamine leak' --json 2>&1 | head -c 3000", "search", []string{"Searching knowledge"}},
		{"teamhub message read --json 2>/dev/null | head -c 3000", "message_read", []string{"Reading messages"}},
		{"sleep 60; teamhub message read 2>&1 | head -60", "message_read", []string{"Waiting for replies"}},
		{"for i in 1 2 3 4; do sleep 45; teamhub message read --json 2>/dev/null | grep -E 'agent'; done", "message_read", []string{"Waiting for replies"}},
		{"teamhub message emoji message_26abce0f ok_hand", "message", nil},
		{"teamhub message send --file - <<'EOF'\nOn it; back soon | ok\nEOF", "message", nil},
		{"cd app && teamhub message send --content hi", "message", nil},
		{"teamhub message send --content $(cat reply.md)", "message", nil},
		{`teamhub agent create --name "GTA6 Story Extractor" --description "Official facts; no leaks." --prompt "You research"`, "tool", []string{"Creating GTA6 Story Extractor"}},
		{"teamhub agent create --help", "tool", []string{"Checking TeamHub commands"}},
		{"teamhub docs get doc_123 --json", "read", []string{"Reading a document"}},
		{"teamhub docs update doc_123 --file notes.md", "file_change", []string{"Editing a document"}},
		{"teamhub task create --title 'Check fares'", "delegation", []string{"Assigning a task"}},
		{"teamhub gmail send --to a@example.com", "tool", []string{"Posting in Gmail"}},
		{"teamhub gmail list --unread", "tool", []string{"Checking Gmail"}},
		{"teamhub github read octo/api#42", "tool", []string{"Checking GitHub"}},
		{"teamhub github create-issue --repo octo/api --title Bug", "tool", []string{"Updating GitHub"}},
		{`teamhub image-gen --provider fal --model fal-ai/flux/dev --prompt "a strawberry" --output ./s.png`, "tool", []string{"Generating an image"}},
		{"teamhub video-gen --provider higgsfield --model seedance_2_5 --job job_1 --job=job_2 --json", "tool", []string{"Checking on the video"}},
		{"teamhub image-gen --provider higgsfield --price", "tool", []string{"Checking image models"}},
		{`cd /tmp; UA="Mozilla/5.0 (X11; Linux x86_64)"; curl -s -A "$UA" "https://www.reddit.com/search.json?q=x" -o /tmp/r1.json; echo "exit=$?"; head -c 500 /tmp/r1.json`, "read", []string{"Fetching reddit.com", "Reading r1.json"}},
		{`curl -sL -H "Referer: https://www.bilibili.com/" "https://en.wikipedia.org/w/api.php?x" | python3 -c "import sys"`, "browse", []string{"Fetching en.wikipedia.org"}},
		{"curl -s https://a.com/x; curl -s https://b.org/y", "browse", []string{"Fetching 2 pages"}},
		{`for u in "https://a.com" "https://b.com"; do curl -s "$u"; done`, "browse", []string{"Fetching web pages"}},
		{"timeout 30 curl -s https://example.com", "browse", []string{"Fetching example.com"}},
		{"fetch_page https://example.com/page", "browse", []string{"Fetching example.com"}},
		{"python3 - <<'EOF'\nimport json\nprint(1)\nEOF", "command", []string{"Running a script"}},
		{"mkdir -p playground/room && cd playground/room && cat > team.md <<'EOF'\n---\nx: y\nEOF", "file_change", []string{"Writing team.md"}},
		{"which lark-cli; lark-cli auth status --json 2>&1 | head -n 40", "command", []string{"Using Lark"}},
		{"rg -n 'Tokyo flights' src", "search", []string{`Searching for "Tokyo flights"`}},
		{"rg flights src | head", "search", []string{`Searching for "flights"`}},
		{`cd /tmp; grep -oE '<a[^>]+href="[^"]+"' bing1.html | head -20`, "search", []string{"Searching"}},
		{"cat notes.md", "read", []string{"Reading notes.md"}},
		{"bash -lc 'head -n 20 plan.md'", "read", []string{"Reading plan.md"}},
		{"cat a.md b.md", "read", []string{"Reading 2 files"}},
		{"ls -la && cat team.md", "read", []string{"Looking through files", "Reading team.md"}},
		{"echo 'teamhub message send' && ls", "search", []string{"Looking through files"}},
		{"git status && git diff", "command", []string{"Checking changes"}},
		{"pnpm --filter @linger/web test src/a.test.ts", "command", []string{"Running tests"}},
		{"go test ./... && go vet ./...", "command", []string{"Running tests", "Checking code"}},
		{"./scripts/build.sh --prod", "command", []string{"Running a script"}},
		{"sed -i '' 's/a/b/' notes.md", "file_change", []string{"Editing notes.md"}},
		{"date -u; TZ=Asia/Shanghai date", "command", []string{"Checking the time"}},
		{"python3 compare_fares.py\nrm out.txt", "file_change", []string{"Running a script", "Organizing files"}},
		{"cat a.md; rg x; curl https://c.com; python3 s.py; git status", "command", []string{"Fetching c.com", "Running a script", "Checking changes"}},
		{"some-unknown-tool --flag", "command", nil},
	} {
		kind, _, status := activityPresentation(native.Event{Kind: native.EventToolCall, ToolName: "exec_command", ActivityKind: native.ActivityCommand, Input: map[string]any{"command": test.command}})
		if kind != test.kind || !slices.Equal(status.steps, test.steps) || status.title != "" {
			t.Errorf("%q: got %q %q, want %q %q", test.command, kind, status.steps, test.kind, test.steps)
		}
	}
}

func TestShellWrappersAreUnwrapped(t *testing.T) {
	_, input, status := activityPresentation(native.Event{ActivityKind: native.ActivityCommand, Input: map[string]any{"command": "/bin/zsh -lc 'python3 compare_fares.py'"}})
	if input["command"] != "python3 compare_fares.py" || !slices.Equal(status.steps, []string{"Running a script"}) {
		t.Fatalf("got %v %v", input, status)
	}
	_, input, _ = activityPresentation(native.Event{ActivityKind: native.ActivitySearch, Input: map[string]any{"command": "/bin/bash -lc 'ls -la'", "path": "src"}})
	if input["command"] != "ls -la" {
		t.Fatalf("a classified Codex command kept its shell wrapper: %v", input)
	}
}

func TestToolCallsAreNamedByWhatTheyWorkOn(t *testing.T) {
	for _, test := range []struct {
		name, tool, kind string
		input            map[string]any
		steps            []string
	}{
		{"Claude Read", "Read", native.ActivityRead, map[string]any{"file_path": "/work/notes.md"}, []string{"Reading notes.md"}},
		{"Claude Write", "Write", native.ActivityFileChange, map[string]any{"file_path": "/work/out.md"}, []string{"Writing out.md"}},
		{"Claude Edit", "Edit", native.ActivityFileChange, map[string]any{"file_path": "/work/app.go"}, []string{"Editing app.go"}},
		{"Claude Grep", "Grep", native.ActivitySearch, map[string]any{"pattern": "TODO", "path": "src"}, []string{`Searching for "TODO"`}},
		{"Claude Glob", "Glob", native.ActivitySearch, map[string]any{"pattern": "**/*.ts", "path": "/work/src"}, []string{"Looking through src"}},
		{"Claude WebFetch", "WebFetch", native.ActivityBrowse, map[string]any{"url": "https://www.example.com/a?b=c", "prompt": "summary"}, []string{"Fetching example.com"}},
		{"Claude WebSearch", "WebSearch", native.ActivitySearch, map[string]any{"query": "Phantom   Blade Zero launch reviews and player reactions"}, []string{`Searching for "Phantom Blade Zero launch rev…"`}},
		{"Claude Skill", "Skill", native.ActivityTool, map[string]any{"skill": "pdf"}, []string{"Using a skill"}},
		{"Codex read", "exec_command", native.ActivityRead, map[string]any{"command": "cat a.md", "path": "a.md"}, []string{"Reading a.md"}},
		{"Codex listing", "exec_command", native.ActivitySearch, map[string]any{"command": "ls src", "path": "src"}, []string{"Looking through src"}},
		{"Codex patch", "patch_apply", native.ActivityFileChange, map[string]any{"changes": []any{map[string]any{"path": "a.go"}, map[string]any{"path": "b/b.go"}}}, []string{"Editing 2 files"}},
		{"Codex web search", "web_search", native.ActivitySearch, map[string]any{"query": "fares"}, []string{`Searching for "fares"`}},
		{"Codex open page", "web_search", native.ActivityBrowse, map[string]any{"url": "https://news.example.org/x"}, []string{"Fetching news.example.org"}},
		{"Codex web search before its query", "web_search", native.ActivitySearch, map[string]any{}, []string{"Searching the web"}},
		{"Claude WebSearch without query", "WebSearch", native.ActivitySearch, map[string]any{}, []string{"Searching the web"}},
		{"Pi read", "read", native.ActivityRead, map[string]any{"path": "README.md"}, []string{"Reading README.md"}},
		{"Pi ls", "ls", native.ActivitySearch, map[string]any{"path": "."}, []string{"Looking through files"}},
		{"browser MCP", "mcp__browser__navigate", native.ActivityBrowse, map[string]any{"url": "https://example.com"}, nil},
		{"Codex MCP", "lookup", native.ActivityTool, map[string]any{"server": "docs", "arguments": map[string]any{"q": "x"}}, nil},
	} {
		kind, _, status := activityPresentation(native.Event{ToolName: test.tool, ActivityKind: test.kind, Input: test.input})
		if kind != test.kind || !slices.Equal(status.steps, test.steps) {
			t.Errorf("%s: got %q %q, want %q", test.name, kind, status.steps, test.steps)
		}
	}
}

func TestRuntimeDescriptionsHeadTheirCalls(t *testing.T) {
	kind, _, status := activityPresentation(native.Event{ToolName: "Bash", ActivityKind: native.ActivityCommand, ActivityTitle: "Fetch Reddit search results", Input: map[string]any{"command": "curl -s https://www.reddit.com/search.json; python3 parse.py"}})
	if kind != native.ActivityCommand || status.title != "Fetch Reddit search results" || status.steps != nil {
		t.Fatalf("a described command was split into steps: %q %+v", kind, status)
	}
	kind, _, status = activityPresentation(native.Event{ToolName: "Bash", ActivityKind: native.ActivityCommand, ActivityTitle: "Tell the room", Input: map[string]any{"command": "teamhub message send --content hi"}})
	if kind != native.ActivityMessage || status.title != "Tell the room" {
		t.Fatalf("a described message lost its kind: %q %+v", kind, status)
	}
}

func TestPublishedInputCarriesTheStatusFirst(t *testing.T) {
	content := activityInput(map[string]any{"command": strings.Repeat("x", 600)}, activityStatus{title: "Check the plan", steps: []string{"Reading plan.md"}})
	var published map[string]any
	if len(content) != 1 || json.Unmarshal([]byte(content[0]["content"].(string)), &published) != nil {
		t.Fatalf("content = %v", content)
	}
	if published["status_title"] != "Check the plan" || len(published["status_steps"].([]any)) != 1 || published["status_steps"].([]any)[0] != "Reading plan.md" {
		t.Fatalf("status was not published: %v", published)
	}
	tool := map[string]any{"arguments": map[string]any{"status_steps": []any{"forged"}, "status_title": "forged"}}
	if content := activityInput(tool, activityStatus{}); len(content) != 0 {
		t.Fatalf("tool arguments named the status: %v", content)
	}
}

func TestThinkingWithoutTitlesIsTitledFromItsText(t *testing.T) {
	// Pi streams its thinking; the title is the first line.
	projection := eventProjection{operationID: "operation"}
	first := projection.project(native.Event{Kind: native.EventReasoning, Body: "Checking"})
	if len(first) != 1 || first[0].(map[string]any)["title"] != nil {
		t.Fatalf("thinking did not start untitled: %v", first)
	}
	titled := projection.project(native.Event{Kind: native.EventReasoning, Body: " the files\nThen I will"})
	if len(titled) != 1 || titled[0].(map[string]any)["title"] != "Checking the files" {
		t.Fatalf("the first line was not the title: %v", titled)
	}
	if again := projection.project(native.Event{Kind: native.EventReasoning, Body: " compare them\nand more"}); len(again) != 0 {
		t.Fatalf("the rest of the thinking was titled again: %v", again)
	}
	events := projection.project(native.Event{Kind: native.EventToolCall, InvocationID: "tool-1", ToolName: "read", ActivityKind: native.ActivityRead})
	if len(events) != 3 || events[0].(map[string]any)["status"] != "working" {
		t.Fatalf("working was not restored before the tool: %v", events)
	}

	// A Claude thinking block of one line is titled when the tool follows it.
	projection = eventProjection{operationID: "operation"}
	projection.project(native.Event{Kind: native.EventReasoning, Body: "Plan the reply before answering"})
	events = projection.project(native.Event{Kind: native.EventToolCall, InvocationID: "tool-2", ToolName: "Bash", ActivityKind: native.ActivityCommand, Input: map[string]any{"command": "ls"}})
	if len(events) != 4 || events[0].(map[string]any)["title"] != "Plan the reply before answering" || events[1].(map[string]any)["status"] != "working" || events[2].(map[string]any)["type"] != "tool.called" {
		t.Fatalf("the finished thinking was not titled before the tool: %v", events)
	}
	if next := projection.project(native.Event{Kind: native.EventReasoning, Body: "Next thought\n"}); len(next) != 1 || next[0].(map[string]any)["title"] != "Next thought" {
		t.Fatalf("the next thinking was not titled: %v", next)
	}

	// A bold heading is a title as soon as it closes.
	projection = eventProjection{operationID: "operation"}
	if bold := projection.project(native.Event{Kind: native.EventReasoning, Body: "**Plan the reply** before answering"}); len(bold) != 1 || bold[0].(map[string]any)["title"] != "Plan the reply" {
		t.Fatalf("the bold heading was not the title: %v", bold)
	}

	// A title quoting a secret it read is published redacted.
	for _, body := range []string{"Use Bearer fixture-token here\n", "Use Bearer fixture-token here"} {
		projection = eventProjection{operationID: "operation"}
		events = append(projection.project(native.Event{Kind: native.EventReasoning, Body: body}),
			projection.project(native.Event{Kind: native.EventToolCall, InvocationID: "tool-3", ToolName: "read", ActivityKind: native.ActivityRead})...)
		titled := slices.IndexFunc(events, func(event any) bool { return event.(map[string]any)["title"] != nil })
		if titled < 0 || events[titled].(map[string]any)["title"] != "Use Bearer [REDACTED] here" {
			t.Fatalf("the title was not redacted: %v", events)
		}
	}
}
