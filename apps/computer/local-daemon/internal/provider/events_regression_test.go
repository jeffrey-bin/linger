package provider

import (
	"fmt"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

func TestFailedToolRemainsFailed(t *testing.T) {
	for _, status := range []string{"failed", "error"} {
		event := normalizeMessage(native.Event{Kind: native.EventToolOutput, InvocationID: "call-1", ToolName: "write_file", Status: status, Output: "permission denied"}, "operation-1").(map[string]any)
		if event["is_error"] != true {
			t.Fatal("failed provider tool was mapped to success")
		}
	}
}

func TestFirstTurnPublishesNativeSessionBeforeExecution(t *testing.T) {
	event := normalizeMessage(native.Event{Kind: native.EventStatus, TurnID: "turn-first", SessionID: "thread-created"}, "operation-first").(map[string]any)
	session, ok := event["session"].(map[string]any)
	if !ok || session["threadId"] != "thread-created" || event["type"] != "run.started" {
		t.Fatal("first Turn lost the native Session checkpoint")
	}
}

func TestEventProjectionPreservesToolIdentityAndActivityOutcome(t *testing.T) {
	projection := eventProjection{operationID: "operation"}
	started := projection.project(native.Event{Kind: native.EventToolCall, InvocationID: "tool-1", ToolName: "write_file"})
	finished := projection.project(native.Event{Kind: native.EventToolOutput, InvocationID: "tool-1", Status: "failed", Output: "permission denied"})
	if len(started) != 2 || len(finished) != 2 {
		t.Fatal("tool activity was not paired")
	}
	if finished[0].(map[string]any)["tool_name"] != "write_file" || finished[1].(map[string]any)["outcome"] != "failed" {
		t.Fatal("tool identity or failure was lost")
	}
}

func TestEventProjectionSplitsLongUnicodeRepliesWithoutLosingContent(t *testing.T) {
	projection := eventProjection{operationID: "operation"}
	content := strings.Repeat("\u4e2d", 100_000)
	events := projection.project(native.Event{Kind: native.EventText, Body: content})
	var restored strings.Builder
	for _, event := range events {
		delta := event.(map[string]any)["delta"].(string)
		if len(delta) > 64*1024 || !utf8.ValidString(delta) {
			t.Fatal("reply exceeds the wire budget or splits a character")
		}
		restored.WriteString(delta)
	}
	if restored.String() != content {
		t.Fatal("reply content was lost")
	}
}

func TestEventProjectionOnlyUpdatesActiveToolActivity(t *testing.T) {
	projection := eventProjection{operationID: "operation"}
	progress := native.Event{Kind: native.EventToolProgress, InvocationID: "tool-1", Body: "Still running"}
	if events := projection.project(progress); len(events) != 0 {
		t.Fatal("unknown tool progress created an activity")
	}
	started := projection.project(native.Event{Kind: native.EventToolCall, InvocationID: "tool-1", ToolName: "Bash"})
	updated := projection.project(progress)
	if len(updated) != 1 {
		t.Fatal("active tool progress was lost")
	}
	update := updated[0].(map[string]any)
	if update["type"] != "activity.updated" || update["activity_id"] != started[1].(map[string]any)["activity_id"] || update["detail"] != "Still running" {
		t.Fatal("tool progress lost activity identity or detail")
	}
	projection.project(native.Event{Kind: native.EventToolOutput, InvocationID: "tool-1", Status: "succeeded"})
	if events := projection.project(progress); len(events) != 0 {
		t.Fatal("late tool progress revived a finished activity")
	}
}

func TestEventProjectionPublishesThinkingTitlesLikeCloud(t *testing.T) {
	projection := eventProjection{operationID: "operation"}
	// Codex titles its summaries itself; its raw reasoning carries no text.
	thinking := func(title string) []any {
		event := native.Event{Kind: native.EventReasoning, Title: title}
		if title != "" {
			event.Body = "raw reasoning"
		}
		return projection.project(event)
	}
	first := thinking("Checking the diff")
	if len(first) != 1 || first[0].(map[string]any)["title"] != "Checking the diff" {
		t.Fatalf("thinking title was not published: %v", first)
	}
	if len(thinking("")) != 0 || len(thinking("Checking the diff")) != 0 {
		t.Fatal("repeated thinking was published again")
	}
	for _, event := range first {
		for _, value := range event.(map[string]any) {
			if value == "raw reasoning" {
				t.Fatal("raw reasoning leaked into the wire event")
			}
		}
	}
	events := projection.project(native.Event{Kind: native.EventToolCall, InvocationID: "tool-1", ToolName: "exec_command"})
	if len(events) != 3 || events[0].(map[string]any)["status"] != "working" || events[1].(map[string]any)["type"] != "tool.called" {
		t.Fatalf("working was not restored before the tool call: %v", events)
	}
	if again := thinking("Checking the diff"); len(again) != 1 {
		t.Fatal("thinking after work was dropped")
	}
	events = projection.project(native.Event{Kind: native.EventToolOutput, InvocationID: "tool-1", Output: "ok"})
	if len(events) != 3 || events[0].(map[string]any)["status"] != "working" || events[1].(map[string]any)["type"] != "tool.returned" {
		t.Fatalf("working was not restored before the tool result: %v", events)
	}
}

func TestRunStartedReportsProcessReuseOnlyWhenReported(t *testing.T) {
	for _, reused := range []bool{false, true} {
		event := normalizeMessage(native.Event{Kind: native.EventStatus, TurnID: "turn-1", ProcessReused: &reused}, "operation-1").(map[string]any)
		if got, ok := event["process_reused"].(bool); !ok || got != reused {
			t.Fatalf("run.started process_reused = %v, want %v", event["process_reused"], reused)
		}
	}
	event := normalizeMessage(native.Event{Kind: native.EventStatus, TurnID: "turn-1"}, "operation-1").(map[string]any)
	if _, present := event["process_reused"]; present {
		t.Fatal("unreported process reuse must leave process_reused absent")
	}
}

func TestProviderTimesAreReportedOnlyWhenKnown(t *testing.T) {
	at := time.UnixMilli(1_700_000_000_123)
	started := normalizeMessage(native.Event{Kind: native.EventStatus, TurnID: "turn-1", SentAt: at}, "operation-1").(map[string]any)
	if started["dispatched_at_unix_ms"] != at.UnixMilli() {
		t.Fatalf("run.started = %v", started)
	}
	for _, message := range []native.Event{
		{Kind: native.EventText, Body: "hi", ObservedAt: at},
		{Kind: native.EventToolCall, ToolName: "read", InvocationID: "call-1", ObservedAt: at},
	} {
		event := normalizeMessage(message, "operation-1").(map[string]any)
		if event["observed_at_unix_ms"] != at.UnixMilli() {
			t.Fatalf("%s = %v", message.Kind, event)
		}
		message.ObservedAt = time.Time{}
		if _, present := normalizeMessage(message, "operation-1").(map[string]any)["observed_at_unix_ms"]; present {
			t.Fatalf("unknown %s observation time must be absent", message.Kind)
		}
	}
	if _, present := normalizeMessage(native.Event{Kind: native.EventStatus, TurnID: "turn-1"}, "operation-1").(map[string]any)["dispatched_at_unix_ms"]; present {
		t.Fatal("unknown dispatch time must be absent")
	}
	projection := eventProjection{operationID: "operation-1"}
	chunks := projection.project(native.Event{Kind: native.EventText, Body: strings.Repeat("a", 64*1024+1), ObservedAt: at})
	if len(chunks) != 2 {
		t.Fatalf("chunks = %d, want 2", len(chunks))
	}
	for _, chunk := range chunks {
		if chunk.(map[string]any)["observed_at_unix_ms"] != at.UnixMilli() {
			t.Fatalf("split delta lost its observation time: %v", chunk.(map[string]any)["observed_at_unix_ms"])
		}
	}
}

func TestEventProjectionPublishesAdapterActivityKinds(t *testing.T) {
	projection := eventProjection{operationID: "operation"}
	started := projection.project(native.Event{Kind: native.EventToolCall, InvocationID: "read-1", ToolName: "Read", ActivityKind: native.ActivityRead, Input: map[string]any{"file_path": "/work/notes.md"}})
	if activity := started[1].(map[string]any); activity["kind"] != "read" || activity["title"] != "Read" {
		t.Fatalf("adapter kind was not published: %v", activity)
	}
	listing := projection.project(native.Event{Kind: native.EventToolCall, InvocationID: "list-1", ToolName: "exec_command", ActivityKind: native.ActivitySearch, Input: map[string]any{"command": "/bin/bash -lc 'ls -la'"}})
	if content := listing[1].(map[string]any)["content"]; !strings.Contains(fmt.Sprint(content), `"command":"ls -la"`) {
		t.Fatalf("a classified Codex command kept its shell wrapper: %v", content)
	}
	unknown := projection.project(native.Event{Kind: native.EventToolCall, InvocationID: "tool-1", ToolName: "write_file"})
	if unknown[1].(map[string]any)["kind"] != "tool" {
		t.Fatal("a tool without a kind did not fall back to tool")
	}
}

func TestEventProjectionKeepsQuietToolCallsOutOfActivities(t *testing.T) {
	projection := eventProjection{operationID: "operation"}
	called := projection.project(native.Event{Kind: native.EventToolCall, InvocationID: "todo-1", ToolName: "TodoWrite", ActivityKind: native.ActivityNone})
	if len(called) != 1 || called[0].(map[string]any)["type"] != "tool.called" {
		t.Fatalf("quiet tool call started an activity: %v", called)
	}
	if progress := projection.project(native.Event{Kind: native.EventToolProgress, InvocationID: "todo-1", Body: "Saving"}); len(progress) != 0 {
		t.Fatal("quiet tool call reported progress")
	}
	returned := projection.project(native.Event{Kind: native.EventToolOutput, InvocationID: "todo-1", Status: "completed"})
	if len(returned) != 1 || returned[0].(map[string]any)["tool_name"] != "TodoWrite" {
		t.Fatalf("quiet tool result lost its tool or finished an activity: %v", returned)
	}
}

func TestEventProjectionReportsModelRequestsAndToolResultTimes(t *testing.T) {
	projection := eventProjection{operationID: "operation"}
	projection.project(native.Event{Kind: native.EventReasoning, Title: "Planning"})
	started := time.UnixMilli(1_000)
	response := native.ModelResponse{Model: "m", MessageID: "msg_1", StartedAt: started, FirstItemAt: started.Add(time.Second),
		Granularity: native.GranularityBlock, Usage: native.TokenCount{Input: 3, Output: 2, Reasoning: 1}, Agent: "toolu_1", ParentCallID: "toolu_1"}
	events := projection.project(native.Event{Kind: native.EventModelResponse, ObservedAt: started.Add(2 * time.Second), Response: &response})
	if len(events) != 1 {
		t.Fatalf("events = %v", events)
	}
	event := events[0].(map[string]any)
	usage := event["usage"].(map[string]any)
	agent := event["agent"].(map[string]any)
	if event["type"] != "model.responded" || event["started_at_unix_ms"] != int64(1_000) || event["first_item_at_unix_ms"] != int64(2_000) ||
		event["responded_at_unix_ms"] != int64(3_000) || event["granularity"] != "block" || event["model"] != "m" || event["message_id"] != "msg_1" ||
		usage["input"] != int64(3) || usage["reasoning"] != int64(1) || agent["id"] != "toolu_1" || agent["parent_call_id"] != "toolu_1" {
		t.Fatalf("event = %v", event)
	}
	// A model record does not end the thinking state a Room shows.
	if !projection.thinking {
		t.Fatal("model record cleared thinking")
	}
	unknown := native.ModelResponse{StartedAt: started, Granularity: native.GranularityItem, MessageID: "bad id", Agent: "bad id"}
	event = projection.project(native.Event{Kind: native.EventModelResponse, ObservedAt: started, Response: &unknown})[0].(map[string]any)
	if _, ok := event["message_id"]; ok {
		t.Fatalf("invalid identifiers were kept: %v", event)
	}
	if _, ok := event["agent"]; ok {
		t.Fatalf("invalid identifiers were kept: %v", event)
	}
	returned := normalizeMessage(native.Event{Kind: native.EventToolOutput, InvocationID: "call-1", ObservedAt: started}, "operation").(map[string]any)
	if returned["observed_at_unix_ms"] != int64(1_000) {
		t.Fatalf("tool result = %v", returned)
	}
}
