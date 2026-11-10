package permission

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/runtimehistory"
)

// codexTranscriptRecords is how many of the newest rollout records are read; the
// review budget then cuts them further.
const codexTranscriptRecords = 120

// CodexTranscript reads the newest assistant messages and tool calls/results of a
// Codex thread from its redacted rollout. User and developer messages are
// left out: TeamHub supplies the trusted user messages. An unreadable
// rollout yields no entries rather than failing the review.
func CodexTranscript(ctx context.Context, codexHome, threadID string) []TranscriptEntry {
	if codexHome == "" || threadID == "" {
		return nil
	}
	page := runtimehistory.Inspect(ctx, runtimehistory.Request{CodexHome: codexHome, ThreadID: threadID, Limit: codexTranscriptRecords})
	if page.Status != "available" {
		return nil
	}
	toolNames := map[string]string{}
	var entries []TranscriptEntry
	for _, record := range page.Records {
		native, _ := record.NativeRecord.(map[string]any)
		if kind, _ := native["type"].(string); kind != "response_item" {
			// event_msg repeats the response items for clients.
			continue
		}
		payload, _ := native["payload"].(map[string]any)
		name, _ := payload["name"].(string)
		callID, _ := payload["call_id"].(string)
		switch payloadType, _ := payload["type"].(string); payloadType {
		case "message":
			if role, _ := payload["role"].(string); role == "assistant" {
				if text := messageText(payload["content"]); strings.TrimSpace(text) != "" {
					entries = append(entries, TranscriptEntry{Kind: "assistant", Text: text})
				}
			}
		case "function_call", "custom_tool_call":
			toolNames[callID] = name
			entries = append(entries, TranscriptEntry{Kind: "tool_call", Tool: name, Text: first(payload["arguments"], payload["input"])})
		case "function_call_output", "custom_tool_call_output":
			entries = append(entries, TranscriptEntry{Kind: "tool_result", Tool: toolNames[callID], Text: first(payload["output"])})
		}
	}
	return Trim(entries)
}

func messageText(content any) string {
	items, _ := content.([]any)
	var parts []string
	for _, item := range items {
		block, _ := item.(map[string]any)
		if text, ok := block["text"].(string); ok {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, "\n")
}

// first renders the first present value: strings as they are, anything else
// as JSON.
func first(values ...any) string {
	for _, value := range values {
		switch typed := value.(type) {
		case nil:
			continue
		case string:
			return typed
		default:
			encoded, _ := json.Marshal(typed)
			return string(encoded)
		}
	}
	return ""
}
