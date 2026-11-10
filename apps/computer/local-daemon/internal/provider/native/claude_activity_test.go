package native

import (
	"fmt"
	"reflect"
	"testing"
)

func claudeDrain(turn *claudeTurn) []Event {
	var events []Event
	for len(turn.events) > 0 {
		events = append(events, <-turn.events)
	}
	return events
}

func TestClaudeToolActivityKinds(t *testing.T) {
	for name, want := range map[string]string{
		"Read": ActivityRead, "Edit": ActivityFileChange, "Write": ActivityFileChange,
		"MultiEdit": ActivityFileChange, "NotebookEdit": ActivityFileChange,
		"Grep": ActivitySearch, "Glob": ActivitySearch, "WebSearch": ActivitySearch,
		"WebFetch": ActivityBrowse, "Bash": ActivityCommand,
		"mcp__browser__navigate": ActivityBrowse, "mcp__computer__run_actions": ActivityTool,
		"mcp__browser": ActivityBrowse, "Skill": ActivityTool, "Agent": ActivityDelegation, "notebook": ActivityTool,
	} {
		turn, _ := claudeHarness(t, RunSpec{})
		claudeFeed(turn, fmt.Sprintf(`{"type":"assistant","message":{"id":"m","content":[{"type":"tool_use","id":"t","name":%q,"input":{}}]}}`, name))
		events := claudeDrain(turn)
		if len(events) != 1 || events[0].Kind != EventToolCall || events[0].ActivityKind != want {
			t.Fatalf("%s: events = %+v, want kind %q", name, events, want)
		}
	}
}

func TestClaudeTodoWriteBecomesPlan(t *testing.T) {
	turn, _ := claudeHarness(t, RunSpec{})
	claudeFeed(turn, `{"type":"assistant","message":{"id":"m","content":[{"type":"tool_use","id":"t","name":"TodoWrite","input":{"todos":[`+
		`{"content":"Find flights","status":"completed"},{"content":"Compare fares","status":"in_progress"},`+
		`{"content":"","status":"pending"},{"content":"Book","status":"blocked"}]}}]}}`)
	events := claudeDrain(turn)
	if len(events) != 2 || events[0].Kind != EventToolCall || events[0].ActivityKind != ActivityNone || events[1].Kind != EventPlan {
		t.Fatalf("events = %+v", events)
	}
	want := []any{
		map[string]any{"content": "Find flights", "status": "completed"},
		map[string]any{"content": "Compare fares", "status": "in_progress"},
		map[string]any{"content": "Book", "status": "pending"},
	}
	if _, hasExplanation := events[1].Input["explanation"]; hasExplanation || !reflect.DeepEqual(events[1].Input["steps"], want) {
		t.Fatalf("plan = %+v", events[1].Input)
	}

	turn, _ = claudeHarness(t, RunSpec{})
	claudeFeed(turn, `{"type":"assistant","message":{"id":"m","content":[{"type":"tool_use","id":"t","name":"TodoWrite","input":{"todos":"x"}}]}}`)
	if events := claudeDrain(turn); len(events) != 1 {
		t.Fatalf("non-array todos = %+v", events)
	}
}
