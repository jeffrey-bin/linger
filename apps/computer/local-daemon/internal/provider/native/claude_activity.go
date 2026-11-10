package native

import "strings"

// claudeTodoTool is the built-in tool whose calls carry the model's plan.
const claudeTodoTool = "TodoWrite"

// claudeActivityKinds classifies Claude's built-in tools by exact name. MCP
// tools and unknown names go through activityForNamedTool's own rules.
var claudeActivityKinds = map[string]string{
	"Read":         ActivityRead,
	"Write":        ActivityFileChange,
	"Edit":         ActivityFileChange,
	"MultiEdit":    ActivityFileChange,
	"NotebookEdit": ActivityFileChange,
	"Grep":         ActivitySearch,
	"Glob":         ActivitySearch,
	"WebSearch":    ActivitySearch,
	"WebFetch":     ActivityBrowse,
	"Bash":         ActivityCommand,
	"Agent":        ActivityDelegation,
	claudeTodoTool: ActivityNone,
}

// claudeActivityTitle is the description the model wrote for a Bash command
// or a subagent, which already says what the call is for.
func claudeActivityTitle(name string, input map[string]any) string {
	if name != "Bash" && name != "Agent" {
		return ""
	}
	description, _ := input["description"].(string)
	return strings.TrimSpace(description)
}

// claudeTodoSteps turns a TodoWrite input into plan steps. ok is false when
// input.todos is not an array; todos without content are skipped.
func claudeTodoSteps(input map[string]any) (steps []any, ok bool) {
	todos, ok := input["todos"].([]any)
	if !ok {
		return nil, false
	}
	steps = []any{}
	for _, raw := range todos {
		todo, _ := raw.(map[string]any)
		content, _ := todo["content"].(string)
		if content == "" {
			continue
		}
		status, _ := todo["status"].(string)
		if status != "in_progress" && status != "completed" {
			status = "pending"
		}
		steps = append(steps, map[string]any{"content": content, "status": status})
	}
	return steps, true
}
