//go:build voicelivedump

package voicelive

import (
	"encoding/json"
	"os"
	"testing"
)

// TestDumpLiveContext writes the live voice instructions and tools, as TeamHub
// serves them, for Voice Runtime's live scenario acceptance:
// LIVE_CONTEXT_OUT=<file> go test -tags voicelivedump ./internal/voicelive -run TestDumpLiveContext
func TestDumpLiveContext(t *testing.T) {
	path := os.Getenv("LIVE_CONTEXT_OUT")
	if path == "" {
		t.Skip("LIVE_CONTEXT_OUT is not set")
	}
	tools := make([]map[string]any, 0, len(Tools))
	for _, tool := range Tools {
		tools = append(tools, map[string]any{"name": tool.Name, "description": tool.Description, "parameters": tool.Parameters})
	}
	// Shaped like a maintained memory.md, which is what the live voice reads.
	memory := UserMemory{Name: "Zh\u00e8ng", Markdown: `# Memory

## Profile
- Zhèng works in Beijing and speaks Chinese [2026-10-12]

## Career
- Heads product at Linger and leads Live voice mode and Lev8 [2026-10-12]

## Interests
- Follows voice agents and their latency [2026-11-01]

## Communication & Working Style
- Lead with the conclusion, then the details [2026-10-20]

## Milestones
None recorded.`}
	encoded, err := json.MarshalIndent(map[string]any{"instructions": Instructions("Jarvis", "Weekly product sync", memory), "tools": tools}, "", " ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
}
