package native

import "testing"

func TestActivityForNamedTool(t *testing.T) {
	table := map[string]string{"Read": ActivityRead}
	for name, want := range map[string]string{
		"mcp__browser__navigate":     ActivityBrowse,
		"mcp__computer__run_actions": ActivityTool,
		"mcp__browser":               ActivityBrowse,
		"Read":                       ActivityRead,
		"Skill":                      ActivityTool,
	} {
		if got := activityForNamedTool(name, table); got != want {
			t.Fatalf("%s = %q, want %q", name, got, want)
		}
	}
	if activityForMCPServer("browser") != ActivityBrowse || activityForMCPServer("") != ActivityTool {
		t.Fatal("MCP server rule")
	}
}
