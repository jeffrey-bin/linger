package native

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/permission"
)

// ClaudeToolPolicy is the product limit on what a Claude Run may call. It is
// enforced on both the can_use_tool and the PreToolUse hook paths.
type ClaudeToolPolicy struct {
	// Workspace is the working directory. The adapter keeps it for callers.
	Workspace string
	// SkillNames are the Skills the Skill tool may invoke, by exact name.
	SkillNames []string
	// MCPToolNames are the authorized MCP tools; only mcp__ names count.
	MCPToolNames []string
	// ReviewPermissions leaves calls Claude cannot prove safe to the Room
	// permission review instead of allowing them at the hook.
	ReviewPermissions bool
	// AllowRules are managed Claude permission allow rules.
	AllowRules []string
}

// claudeBuiltinTools are the only tools --tools names. MCP tools are not
// filtered there; can_use_tool and the hook authorize them. ToolSearch lets
// Claude defer MCP tool definitions: each request carries only their names,
// and the model loads a definition when it needs that tool, as with Skills.
// Without it every request carries every MCP tool definition.
var claudeBuiltinTools = []string{"Read", "Glob", "Grep", "Write", "Edit", "Bash", "TodoWrite", "Skill", "Agent", "WebSearch", "WebFetch", "ToolSearch"}

const (
	claudeInitializeRequestID = "linger-session-restore"
	claudeInterruptPrefix     = "linger-interrupt-"
	claudeHookCallbackID      = "hook_0"
)

// authorizedTools is the built-in list followed by qualifying MCP tools in
// their given order, without duplicates.
func (p *ClaudeToolPolicy) authorizedTools() []string {
	tools := append([]string(nil), claudeBuiltinTools...)
	seen := map[string]bool{}
	for _, name := range tools {
		seen[name] = true
	}
	for _, name := range p.MCPToolNames {
		if strings.HasPrefix(name, "mcp__") && !seen[name] {
			seen[name] = true
			tools = append(tools, name)
		}
	}
	return tools
}

// denyReason returns why the policy refuses a call, or "" when it allows it.
func (p *ClaudeToolPolicy) denyReason(tool string, input map[string]any, agentID string) string {
	authorized := false
	for _, name := range p.authorizedTools() {
		if name == tool {
			authorized = true
			break
		}
	}
	if !authorized {
		return "tool not authorized: " + tool
	}
	if tool == "Agent" && agentID != "" {
		return "recursive subagents disabled"
	}
	if (tool == "Agent" || tool == "Bash") && (input["run_in_background"] == true || input["background"] == true) {
		return "background execution disabled"
	}
	if tool == "Skill" {
		name, _ := input["skill"].(string)
		for _, allowed := range p.SkillNames {
			if name != "" && name == allowed {
				return ""
			}
		}
		return "Skill not authorized"
	}
	return ""
}

// claudeReservedFlags are owned by the adapter; user argv may not set them.
var claudeReservedFlags = map[string]flagArity{
	"--session-id": flagTakesValue, "--output-format": flagTakesValue, "--input-format": flagTakesValue,
	"--permission-mode": flagTakesValue, "--mcp-config": flagTakesValue, "--effort": flagTakesValue,
	"--settings": flagTakesValue, "--tools": flagTakesValue, "--allowedTools": flagTakesValue,
	"--allowed-tools": flagTakesValue, "--disallowedTools": flagTakesValue, "--disallowed-tools": flagTakesValue,
	"--managed-settings": flagTakesValue, "--setting-sources": flagTakesValue, "--permission-prompt-tool": flagTakesValue,
	"--plugin-dir": flagTakesValue, "--agents": flagTakesValue, "--append-system-prompt": flagTakesValue,
	"--system-prompt": flagTakesValue, "--thinking": flagTakesValue,
	"--resume": flagOptionalValue, "-r": flagOptionalValue,
	"--continue": flagStandalone, "-c": flagStandalone, "-p": flagStandalone, "--print": flagStandalone,
	"--dangerously-skip-permissions": flagStandalone, "--allow-dangerously-skip-permissions": flagStandalone,
	"--strict-mcp-config": flagStandalone, "--replay-user-messages": flagStandalone,
}

var claudeEfforts = map[string]bool{"": true, "none": true, "low": true, "medium": true, "high": true, "xhigh": true, "max": true}

func claudeCheckEffort(effort string) error {
	if !claudeEfforts[effort] {
		return fmt.Errorf("Claude effort %q is unsupported", effort)
	}
	return nil
}

func claudeManagedSettings(policy *ClaudeToolPolicy) string {
	permissions := map[string]any{"disableBypassPermissionsMode": "disable"}
	if len(policy.AllowRules) > 0 {
		permissions["allow"] = append([]string(nil), policy.AllowRules...)
	}
	encoded, _ := json.Marshal(map[string]any{"allowManagedPermissionRulesOnly": true, "permissions": permissions})
	return string(encoded)
}

// claudeLongContextWindow is the window of Claude's [1m] model variants.
const claudeLongContextWindow = 1_000_000

// claudeSettings sizes Claude by the model's context window; zero is unknown.
func claudeSettings(contextWindow int) string {
	settingsEnv := map[string]string{"CLAUDE_CODE_DISABLE_BACKGROUND_TASKS": "1"}
	settings := map[string]any{
		"disableBundledSkills": true, "syncClaudeAiSkills": false, "syncClaudeAiPlugins": false,
		"disableAgentView": true, "disableRemoteControl": true, "autoMemoryEnabled": false,
		"cleanupPeriodDays": 36500, "autoCompactWindow": 200000, "env": settingsEnv,
	}
	if contextWindow > 0 {
		// Claude takes a model it does not know for a 200k one and a [1m]
		// variant for a 1M one, so on a smaller model it would compact only
		// after the request overflowed. autoCompactWindow refuses values
		// below 100k; this variable is Claude's setting for an unknown
		// model's real window, and without 1M context the [1m] variants
		// fall back to it.
		settingsEnv["CLAUDE_CODE_MAX_CONTEXT_TOKENS"] = strconv.Itoa(contextWindow)
		if contextWindow < claudeLongContextWindow {
			settingsEnv["CLAUDE_CODE_DISABLE_1M_CONTEXT"] = "1"
		}
	}
	if limit := toolOutputTokenLimit(contextWindow); limit < toolOutputTokens {
		// One tool result keeps the share of the window Codex gives it.
		// Claude measures Bash output in characters, and one character can be
		// a whole token, so the token limit bounds characters too. Longer
		// Bash output is saved to a file the model reads from, a longer Read
		// is refused so the model reads a range, and longer MCP output is cut
		// with a note to page.
		settings["bashOutputMaxChars"] = limit
		settingsEnv["CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS"] = strconv.Itoa(limit)
		settingsEnv["MAX_MCP_OUTPUT_TOKENS"] = strconv.Itoa(limit)
	}
	encoded, _ := json.Marshal(settings)
	return string(encoded)
}

// claudeBuildArgv returns the launch argv without --mcp-config, and the
// shaped argv a parked process keeps for life: the same words without the
// session flags.
func claudeBuildArgv(logger *slog.Logger, spec RunSpec) (shaped, launch []string) {
	policy := spec.ClaudePolicy
	head := []string{
		"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
		"--permission-mode", "acceptEdits", "--disallowedTools", "AskUserQuestion", "--replay-user-messages",
		"--permission-prompt-tool", "stdio",
		"--tools", strings.Join(claudeBuiltinTools, ","),
		"--strict-mcp-config",
		"--setting-sources", "project,user",
		"--managed-settings", claudeManagedSettings(policy),
		"--settings", claudeSettings(spec.ContextWindow),
	}
	if spec.Model != "" {
		head = append(head, "--model", spec.Model)
	}
	var session []string
	if spec.AssignSessionID != "" {
		session = []string{"--session-id", spec.AssignSessionID}
	} else if spec.ResumeID != "" {
		session = []string{"--resume", spec.ResumeID}
	}
	var tail []string
	switch spec.Effort {
	case "":
	case "none":
		tail = append(tail, "--thinking", "disabled")
	default:
		tail = append(tail, "--effort", spec.Effort, "--thinking", "adaptive")
	}
	tail = append(tail, filterAdapterArgs(logger, claudeReservedFlags, spec.ComputerArgs, spec.AgentArgs)...)
	shaped = append(append([]string(nil), head...), tail...)
	launch = append(append(append([]string(nil), head...), session...), tail...)
	return shaped, launch
}

// claudeInitializeFrame is the first frame of every spawned process. Its
// exact bytes are part of the resident shape.
func claudeInitializeFrame(spec RunSpec) []byte {
	skills := append([]string{}, spec.ClaudePolicy.SkillNames...)
	encoded, _ := json.Marshal(map[string]any{
		"type":       "control_request",
		"request_id": claudeInitializeRequestID,
		"request": map[string]any{
			"subtype":              "initialize",
			"skills":               skills,
			"hooks":                map[string]any{"PreToolUse": []any{map[string]any{"hookCallbackIds": []string{claudeHookCallbackID}}}},
			"appendSystemPrompt":   spec.AppendPrompt,
			"systemPromptSnapshot": false,
		},
	})
	return encoded
}

func claudeUserFrame(nativeTurnID, prompt string) []byte {
	encoded, _ := json.Marshal(map[string]any{
		"uuid": nativeTurnID, "type": "user", "parent_tool_use_id": nil,
		"message": map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": prompt}}},
	})
	return encoded
}

// claudeControlRefusal answers a control request with an error.
func claudeControlRefusal(requestID, message string) []byte {
	encoded, _ := json.Marshal(map[string]any{
		"type":     "control_response",
		"response": map[string]any{"request_id": requestID, "subtype": "error", "error": message},
	})
	return encoded
}

func claudeControlReply(requestID string, payload any) []byte {
	encoded, _ := json.Marshal(map[string]any{
		"type":     "control_response",
		"response": map[string]any{"subtype": "success", "request_id": requestID, "response": payload},
	})
	return encoded
}

// claudeControlRequest is the decoded part of a control_request that the
// authorization paths read.
type claudeControlRequest struct {
	Subtype    string          `json:"subtype"`
	ToolName   string          `json:"tool_name"`
	Input      json.RawMessage `json:"input"`
	AgentID    string          `json:"agent_id"`
	ToolUseID  string          `json:"tool_use_id"`
	CallbackID string          `json:"callback_id"`
}

type claudeHookInput struct {
	HookEventName string          `json:"hook_event_name"`
	ToolName      string          `json:"tool_name"`
	ToolInput     json.RawMessage `json:"tool_input"`
	AgentID       string          `json:"agent_id"`
}

// claudeObject decodes a JSON object; null, absent and non-objects fail.
func claudeObject(raw json.RawMessage) (map[string]any, bool) {
	var object map[string]any
	if len(raw) == 0 || json.Unmarshal(raw, &object) != nil || object == nil {
		return nil, false
	}
	return object, true
}

// claudeAuthorizeInline answers one control_request on the inline path. It
// returns the request ID and the response payload, or an error that must
// abort the conversation.
func claudeAuthorizeInline(policy *ClaudeToolPolicy, requestID string, rawRequest json.RawMessage) (any, error) {
	if requestID == "" {
		return nil, errors.New("control request has no request_id")
	}
	var request claudeControlRequest
	if json.Unmarshal(rawRequest, &request) != nil {
		return nil, errors.New("control request is not decodable")
	}
	switch request.Subtype {
	case "can_use_tool":
		input, ok := claudeObject(request.Input)
		if !ok {
			return nil, errors.New("can_use_tool input is not an object")
		}
		if reason := policy.denyReason(request.ToolName, input, request.AgentID); reason != "" {
			return claudeDeny(reason), nil
		}
		return map[string]any{"behavior": "allow", "updatedInput": input, "toolUseID": request.ToolUseID}, nil
	case "hook_callback":
		if request.CallbackID != claudeHookCallbackID {
			return nil, errors.New("hook callback is unknown")
		}
		var hook claudeHookInput
		if json.Unmarshal(request.Input, &hook) != nil || hook.HookEventName != "PreToolUse" {
			return nil, errors.New("hook event is not PreToolUse")
		}
		input, ok := claudeObject(hook.ToolInput)
		if !ok {
			return nil, errors.New("hook tool_input is not an object")
		}
		output := map[string]any{"hookEventName": "PreToolUse"}
		switch reason := policy.denyReason(hook.ToolName, input, hook.AgentID); {
		case reason != "":
			output["permissionDecision"] = "deny"
			output["permissionDecisionReason"] = reason
		case policy.ReviewPermissions:
			encoded, _ := json.Marshal(input)
			if permission.LocalWriteTool(hook.ToolName, string(encoded)) {
				output["permissionDecision"] = "ask"
			}
		default:
			output["permissionDecision"] = "allow"
		}
		return map[string]any{"hookSpecificOutput": output}, nil
	}
	return nil, fmt.Errorf("control request subtype %q is unsupported", request.Subtype)
}

func claudeDeny(reason string) map[string]any {
	return map[string]any{"behavior": "deny", "message": reason, "interrupt": false}
}
