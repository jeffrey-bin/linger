package permission

// The Codex adapter maps the Runtime permission hook to Codex: its execpolicy
// rules, its PermissionRequest hook, and its session rollout.

import (
	"encoding/json"
)

// CodexHookEvent is the part of Codex's PermissionRequest hook input the review
// uses. Codex sends shell commands as Bash {command, description}, patches as
// apply_patch {command: <patch>}, MCP calls under their tool name with their
// arguments, and write_stdin / request_permissions under those names.
type CodexHookEvent struct {
	ToolName       string         `json:"tool_name"`
	ToolInput      map[string]any `json:"tool_input"`
	Cwd            string         `json:"cwd"`
	SessionID      string         `json:"session_id"`
	TurnID         string         `json:"turn_id"`
	TranscriptPath string         `json:"transcript_path"`
}

// CodexRequest builds the review for one PermissionRequest. The hook reports the
// turn's working directory, not a command's own workdir; the judge sees it as
// the environment workspace.
func CodexRequest(event CodexHookEvent, workspace string) Request {
	command, _ := event.ToolInput["command"].(string)
	encoded, _ := json.Marshal(event.ToolInput)
	request := Request{Action: Action{
		Runtime: "codex", Surface: Surface(event.ToolName, command), Tool: event.ToolName,
		Input: string(encoded),
	}}
	switch event.ToolName {
	case "Bash":
		request.Action.Command = command
		request.Evidence = ScriptEvidence(command, workspace)
	case "apply_patch":
		request.Evidence = &Evidence{Patch: command}
	default:
		request.Evidence = RunScriptEvidence(event.ToolName, event.ToolInput)
	}
	return request
}

// CodexHookOutput encodes a verdict as the PermissionRequest hook's answer. A call
// that does not run returns the verdict's message to the model.
func CodexHookOutput(verdict Verdict) string {
	decision := map[string]any{"behavior": "allow"}
	if verdict.Decision != Allow {
		decision = map[string]any{"behavior": "deny", "message": verdict.Message}
	}
	encoded, _ := json.Marshal(map[string]any{"hookSpecificOutput": map[string]any{
		"hookEventName": "PermissionRequest", "decision": decision,
	}})
	return string(encoded)
}
