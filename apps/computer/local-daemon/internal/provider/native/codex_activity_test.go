//go:build !windows

package native

import (
	"encoding/json"
	"testing"
)

func codexStartedItem(item map[string]any) map[string]any {
	return map[string]any{"method": "item/started", "params": map[string]any{"threadId": "$THREAD", "turnId": "$TURN", "item": item}}
}

func codexCompletedItem(item map[string]any) map[string]any {
	return map[string]any{"method": "item/completed", "params": map[string]any{"threadId": "$THREAD", "turnId": "$TURN", "item": item}}
}

func TestCodexActivityKinds(t *testing.T) {
	read := map[string]any{"type": "read", "command": "cat notes.md", "name": "notes.md", "path": "/work/notes.md"}
	search := map[string]any{"type": "search", "command": "rg flights", "query": "flights"}
	unknown := map[string]any{"type": "unknown", "command": "make"}
	turn := codexFakeTurn{Status: "completed", Items: []map[string]any{
		codexStartedItem(map[string]any{"id": "read", "type": "commandExecution", "command": "cat notes.md", "commandActions": []any{read}}),
		codexStartedItem(map[string]any{"id": "search", "type": "commandExecution", "command": "rg flights", "commandActions": []any{search}}),
		codexStartedItem(map[string]any{"id": "mixed", "type": "commandExecution", "command": "cat a && make", "commandActions": []any{read, unknown}}),
		codexStartedItem(map[string]any{"id": "plain", "type": "commandExecution", "command": "ls"}),
		codexCompletedItem(map[string]any{"id": "plain", "type": "commandExecution", "status": "completed", "exitCode": 0}),
		codexStartedItem(map[string]any{"id": "patch", "type": "fileChange", "changes": []any{}}),
		codexCompletedItem(map[string]any{"id": "patch", "type": "fileChange", "status": "completed", "changes": []any{}}),
		codexStartedItem(map[string]any{"id": "browser", "type": "mcpToolCall", "server": "browser", "tool": "navigate", "arguments": map[string]any{}}),
		codexCompletedItem(map[string]any{"id": "browser", "type": "mcpToolCall", "server": "browser", "tool": "navigate", "status": "completed"}),
		codexStartedItem(map[string]any{"id": "dynamic", "type": "dynamicToolCall", "tool": "lookup", "arguments": map[string]any{}}),
		codexStartedItem(map[string]any{"id": "web", "type": "webSearch", "query": "", "action": map[string]any{"type": "search", "query": "Tokyo flights"}}),
		codexCompletedItem(map[string]any{"id": "web", "type": "webSearch", "query": "Tokyo flights", "action": map[string]any{"type": "search", "query": "Tokyo flights"}}),
		codexStartedItem(map[string]any{"id": "page", "type": "webSearch", "query": "", "action": map[string]any{"type": "openPage", "url": "https://example.com/fares"}}),
		codexAgentMessage("m1", "done", nil),
	}}
	fake := newCodexFake(t, []codexFakeTurn{turn}, nil)
	out, events := codexDrain(t, fake.runtime(nil), "go", fake.spec())
	if out.Status != statusCompleted || out.Output != "done" {
		t.Fatalf("outcome = %+v", out)
	}
	byKey := map[string]Event{}
	for _, event := range events {
		byKey[string(event.Kind)+"/"+event.InvocationID] = event
	}
	checks := []struct {
		key, kind string
		input     map[string]any
	}{
		{"tool-use/read", ActivityRead, map[string]any{"command": "cat notes.md", "path": "/work/notes.md"}},
		{"tool-use/search", ActivitySearch, map[string]any{"command": "rg flights", "query": "flights"}},
		{"tool-use/mixed", ActivityCommand, nil},
		{"tool-use/plain", ActivityCommand, map[string]any{"command": "ls"}},
		{"tool-result/plain", "", nil},
		{"tool-use/patch", ActivityFileChange, nil},
		{"tool-result/patch", ActivityFileChange, nil},
		{"tool-use/browser", ActivityBrowse, nil},
		{"tool-result/browser", ActivityBrowse, nil},
		{"tool-use/dynamic", ActivityTool, nil},
		{"tool-use/web", ActivitySearch, map[string]any{"query": "Tokyo flights"}},
		{"tool-result/web", ActivitySearch, nil},
		{"tool-use/page", ActivityBrowse, map[string]any{"url": "https://example.com/fares"}},
	}
	for _, check := range checks {
		event, ok := byKey[check.key]
		if !ok || event.ActivityKind != check.kind {
			t.Fatalf("%s = %+v (present %v)", check.key, event, ok)
		}
		if check.input != nil {
			got, _ := json.Marshal(event.Input)
			want, _ := json.Marshal(check.input)
			if string(got) != string(want) {
				t.Fatalf("%s input = %s, want %s", check.key, got, want)
			}
		}
	}
	if path := byKey["tool-use/mixed"].Input["path"]; path != "/work/notes.md" {
		t.Fatalf("keys added before the scan stopped must stay: %v", byKey["tool-use/mixed"].Input)
	}
	if e := byKey["tool-use/dynamic"]; e.ToolName != "lookup" {
		t.Fatalf("dynamic = %+v", e)
	}
	if e := byKey["tool-result/web"]; e.ToolName != "web_search" || e.Output != "Tokyo flights" || e.Input != nil {
		t.Fatalf("web result = %+v", e)
	}
}

func TestCodexCommandActivityRules(t *testing.T) {
	cases := []struct {
		actions string
		kind    string
	}{
		{`[]`, ActivityCommand},
		{`"nope"`, ActivityCommand},
		{`[{"type":"read","path":"a"},{"type":"read","path":"b"}]`, ActivityRead},
		{`[{"type":"listFiles","path":"src"},{"type":"search","query":"x"}]`, ActivitySearch},
		{`[{"type":"read"},{"type":"search"}]`, ActivityCommand},
		{`[{"path":"a"}]`, ActivityCommand},
		{`["read"]`, ActivityCommand},
	}
	for _, tc := range cases {
		input := map[string]any{"command": "x"}
		if got := codexCommandActivity(json.RawMessage(tc.actions), input); got != tc.kind {
			t.Fatalf("%s = %s, want %s", tc.actions, got, tc.kind)
		}
	}
	input := map[string]any{"command": "x"}
	codexCommandActivity(json.RawMessage(`[{"type":"read","path":"a"},{"type":"read","path":"b"}]`), input)
	if input["path"] != "a" {
		t.Fatalf("first path must win: %v", input)
	}
	input = map[string]any{"command": "x"}
	codexCommandActivity(json.RawMessage(`[{"type":"listFiles","path":"src"},{"type":"search","query":"x","path":"lib"}]`), input)
	if input["path"] != "src" || input["query"] != "x" {
		t.Fatalf("search input = %v", input)
	}
}
