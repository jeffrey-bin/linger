package provider

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

func TestToolActivityPublishesDisplayInput(t *testing.T) {
	for _, tc := range []struct {
		tool, key string
		value     any
	}{
		{"exec_command", "cmd", "git status --short"},
		{"exec_command", "command", "git diff --stat"},
		{"read_multiple_files", "paths", []any{"src/app.tsx", "src/main.tsx"}},
		{"read_file", "path", "src/app.tsx"},
		{"apply_patch", "path", "src/app.tsx"},
		{"search", "query", "runtime status"},
		{"open_url", "url", "https://example.com"},
		{"send_message", "room_id", "room-1"},
		{"spawn_agent", "task_name", "review"},
		{"view_image", "path", "preview.png"},
		{"sleep", "duration_ms", float64(1000)},
		{"update_plan", "plan", []any{map[string]any{"step": "Verify", "status": "pending"}}},
	} {
		t.Run(tc.tool, func(t *testing.T) {
			projection := eventProjection{operationID: "operation"}
			events := projection.project(native.Event{Kind: native.EventToolCall, InvocationID: "call", ToolName: tc.tool, Input: map[string]any{tc.key: tc.value, "password": "private-value", "body": "private-message"}})
			wire, err := json.Marshal(events[1])
			if err != nil {
				t.Fatal(err)
			}
			var activity struct {
				Content []struct{ Label, Format, Content string }
			}
			if err := json.Unmarshal(wire, &activity); err != nil {
				t.Fatal(err)
			}
			if len(activity.Content) != 1 {
				t.Fatalf("activity lost display input: %s", wire)
			}
			block := activity.Content[0]
			if block.Label != "Input" || block.Format != "json" {
				t.Fatalf("unrecognized block: %+v", block)
			}
			var input map[string]any
			if err := json.Unmarshal([]byte(block.Content), &input); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(input[tc.key], tc.value) {
				t.Fatalf("missing %s: %s", tc.key, block.Content)
			}
			if strings.Contains(block.Content, "private-") {
				t.Fatal("unrelated private input was published")
			}
		})
	}
}

func TestToolActivityInputIsBoundedValidJSONAndRedacted(t *testing.T) {
	projection := eventProjection{operationID: "operation"}
	command := "TOKEN=private-value " + strings.Repeat("€", 5000)
	events := projection.project(native.Event{Kind: native.EventToolCall, InvocationID: "call", ToolName: "exec_command", Input: map[string]any{"cmd": command}})
	wire, _ := json.Marshal(events[1])
	var activity struct{ Content []struct{ Content string } }
	_ = json.Unmarshal(wire, &activity)
	if len(activity.Content) != 1 {
		t.Fatal("long command lost its display input")
	}
	content := activity.Content[0].Content
	if len([]rune(content)) > 4000 || !json.Valid([]byte(content)) {
		t.Fatal("invalid public content budget")
	}
	if strings.Contains(content, "private-value") || !strings.Contains(content, "€") {
		t.Fatal("redaction removed command or leaked token")
	}
}

func TestToolActivityUnwrapsMCPArgumentsAndPatchPaths(t *testing.T) {
	for _, input := range []map[string]any{
		{"arguments": map[string]any{"path": "src/app.tsx", "password": "private-value"}},
		{"arguments": `{"path":"src/app.tsx","password":"private-value"}`},
		{"changes": []any{map[string]any{"path": "src/app.tsx", "diff": "private-value"}}},
	} {
		content := activityInput(input, activityStatus{})
		if len(content) != 1 {
			t.Fatal("native input shape was lost")
		}
		text := content[0]["content"].(string)
		if !strings.Contains(text, "src/app.tsx") || strings.Contains(text, "private-value") {
			t.Fatalf("bad public projection: %s", text)
		}
	}
	if len(activityInput(nil, activityStatus{})) != 0 || len(activityInput(map[string]any{"body": "private-message"}, activityStatus{})) != 0 {
		t.Fatal("invented input for an empty summary")
	}
}
