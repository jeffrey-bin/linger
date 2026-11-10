package permission

import (
	"context"
	"encoding/json"
)

// CodexHook is what a reviewed Codex Run needs: the Daemon-wide endpoint its
// thread registers with, and the `hooks` configuration pointing Codex at it.
type CodexHook struct {
	Endpoint *CodexEndpoint
	Config   map[string]any
}

// CodexReview judges one PermissionRequest of a Codex thread. A patch that only
// edits ordinary workspace files is allowed as Claude's acceptEdits would;
// everything else goes to the Reviewer with the thread's recent history.
// taskLink is the Context's own shared Task link, or empty.
func CodexReview(ctx context.Context, reviewer *Reviewer, event CodexHookEvent, workspace, codexHome string, taskLink CodexTaskLink) Verdict {
	if event.ToolName == "apply_patch" {
		if patch, _ := event.ToolInput["command"].(string); CodexPatchAllowed(patch, event.Cwd, workspace, taskLink) {
			return Verdict{Decision: Allow}
		}
	}
	request := CodexRequest(event, workspace)
	request.Transcript = CodexTranscript(ctx, codexHome, event.SessionID)
	return reviewer.Review(ctx, request)
}

// CodexPromptMCPTools makes Codex ask about every tool of the managed MCP servers,
// as Claude does, instead of trusting a server's own read-only annotations.
// The Daemon's read-only local tools are then allowed by the Reviewer.
func CodexPromptMCPTools(mcpConfig json.RawMessage) (json.RawMessage, error) {
	if len(mcpConfig) == 0 {
		return mcpConfig, nil
	}
	var parsed map[string]any
	if err := json.Unmarshal(mcpConfig, &parsed); err != nil {
		return nil, err
	}
	servers, _ := parsed["mcpServers"].(map[string]any)
	for _, server := range servers {
		if settings, ok := server.(map[string]any); ok {
			settings["default_tools_approval_mode"] = "prompt"
		}
	}
	return json.Marshal(parsed)
}
