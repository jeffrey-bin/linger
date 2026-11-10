package native

import (
	"encoding/json"
	"testing"
)

func TestClaudeToolTimeoutsCarryTheCodexLimit(t *testing.T) {
	config := json.RawMessage(`{"mcpServers":{"computer":{"type":"http","url":"http://127.0.0.1:1/","tool_timeout_sec":180},"relay":{"type":"http","url":"http://127.0.0.1:2/"},"set":{"type":"http","url":"http://127.0.0.1:3/","tool_timeout_sec":180,"timeout":5000}}}`)
	var got struct {
		Servers map[string]map[string]any `json:"mcpServers"`
	}
	if err := json.Unmarshal(claudeToolTimeouts(config), &got); err != nil {
		t.Fatal(err)
	}
	if got.Servers["computer"]["timeout"] != float64(180000) || got.Servers["relay"]["timeout"] != nil || got.Servers["set"]["timeout"] != float64(5000) {
		t.Fatalf("got %v", got.Servers)
	}
	plain := json.RawMessage(`{"mcpServers":{}}`)
	if string(claudeToolTimeouts(plain)) != string(plain) {
		t.Fatal("an unchanged config is rewritten")
	}
}
