package permission

// The Claude adapter maps the Runtime permission hook to Claude Code: its
// permission rules, its can_use_tool requests, and its session transcript.

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/runtimehistory"
)

// claudeTranscriptRecords is how many of the newest session records are read; the
// review budget then cuts them further.
const claudeTranscriptRecords = 120

// ClaudeTranscript reads the newest assistant messages and tool calls/results of a
// Claude session from its redacted session file. User turns are left out:
// TeamHub supplies the trusted user messages. An unreadable session yields no
// entries rather than failing the review.
func ClaudeTranscript(ctx context.Context, home, sessionID string) []TranscriptEntry {
	if home == "" || sessionID == "" {
		return nil
	}
	page := runtimehistory.InspectClaude(ctx, runtimehistory.Request{CodexHome: home, ThreadID: sessionID, Limit: claudeTranscriptRecords})
	if page.Status != "available" {
		return nil
	}
	toolNames := map[string]string{}
	var entries []TranscriptEntry
	for _, record := range page.Records {
		native, _ := record.NativeRecord.(map[string]any)
		message, _ := native["message"].(map[string]any)
		blocks, _ := message["content"].([]any)
		kind, _ := native["type"].(string)
		for _, rawBlock := range blocks {
			block, _ := rawBlock.(map[string]any)
			switch blockType, _ := block["type"].(string); {
			case kind == "assistant" && blockType == "text":
				if text, _ := block["text"].(string); strings.TrimSpace(text) != "" {
					entries = append(entries, TranscriptEntry{Kind: "assistant", Text: text})
				}
			case kind == "assistant" && blockType == "tool_use":
				name, _ := block["name"].(string)
				id, _ := block["id"].(string)
				toolNames[id] = name
				input, _ := json.Marshal(block["input"])
				entries = append(entries, TranscriptEntry{Kind: "tool_call", Tool: name, Text: string(input)})
			case kind == "user" && blockType == "tool_result":
				id, _ := block["tool_use_id"].(string)
				entries = append(entries, TranscriptEntry{Kind: "tool_result", Tool: toolNames[id], Text: resultText(block["content"])})
			}
		}
	}
	return Trim(entries)
}

func resultText(content any) string {
	switch value := content.(type) {
	case string:
		return value
	case []any:
		var parts []string
		for _, item := range value {
			block, _ := item.(map[string]any)
			if text, ok := block["text"].(string); ok {
				parts = append(parts, text)
			} else if blockType, _ := block["type"].(string); blockType != "" {
				parts = append(parts, "["+blockType+"]")
			}
		}
		return strings.Join(parts, "\n")
	}
	return ""
}
