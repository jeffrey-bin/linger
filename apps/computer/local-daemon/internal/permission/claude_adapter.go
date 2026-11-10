package permission

import (
	"encoding/json"
	"path/filepath"
	"strings"
)

// ClaudeAllowRules turns the TeamHub CLI commands that run without review into
// Claude permission allow rules. Claude matches them against each part of a
// compound command itself, so `teamhub message read && curl ...` still asks.
func ClaudeAllowRules(commands []TeamHubCommand) []string {
	rules := make([]string, 0, len(commands))
	for _, command := range commands {
		rules = append(rules, "Bash(teamhub "+strings.Join(command.Path, " ")+":*)")
	}
	return rules
}

// ClaudeSharedTaskRules allows the Runtime's ordinary file tools on its shared Task
// directories: edits and reads in an alter_ego's own Task directory, reads in
// a Meta's Room tasks directory. Claude checks a path reached through a
// workspace link against its real location, which these absolute rules name.
// Nothing else is allowed by them.
func ClaudeSharedTaskRules(writableRoot, readableRoot string) []string {
	var rules []string
	for _, root := range claudeRuleRoots(writableRoot) {
		rules = append(rules, "Read("+root+"/**)", "Edit("+root+"/**)")
	}
	for _, root := range claudeRuleRoots(readableRoot) {
		rules = append(rules, "Read("+root+"/**)")
	}
	return rules
}

// claudeRuleRoots renders a directory and its resolved location as Claude
// absolute path patterns ("//" + POSIX path; a Windows drive C: becomes /c).
func claudeRuleRoots(root string) []string {
	if root == "" {
		return nil
	}
	candidates := []string{filepath.Clean(root)}
	if resolved, err := filepath.EvalSymlinks(root); err == nil && resolved != candidates[0] {
		candidates = append(candidates, resolved)
	}
	patterns := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		posix := filepath.ToSlash(candidate)
		if volume := filepath.VolumeName(candidate); len(volume) == 2 && volume[1] == ':' {
			posix = "/" + strings.ToLower(volume[:1]) + filepath.ToSlash(candidate[2:])
		}
		patterns = append(patterns, "/"+posix)
	}
	return patterns
}

// ClaudeRequest builds the review for one can_use_tool call.
func ClaudeRequest(toolName string, input map[string]any, agentID, workspace string) Request {
	command, _ := input["command"].(string)
	encoded, _ := json.Marshal(input)
	request := Request{Action: Action{
		Runtime: "claude", Surface: Surface(toolName, command), Tool: toolName,
		Command: command, Input: string(encoded), Subagent: agentID,
	}}
	if toolName == "Bash" {
		request.Evidence = ScriptEvidence(command, workspace)
	} else {
		request.Evidence = RunScriptEvidence(toolName, input)
	}
	return request
}

// CanUseToolResponse encodes a verdict as the answer to can_use_tool. A call
// that does not run returns the verdict's message to the model as the tool
// result; the turn continues.
func CanUseToolResponse(verdict Verdict, input map[string]any, toolUseID string) map[string]any {
	if verdict.Decision == Allow {
		return map[string]any{"behavior": "allow", "updatedInput": input, "toolUseID": toolUseID}
	}
	return map[string]any{"behavior": "deny", "message": verdict.Message, "interrupt": false}
}
