package native

import "strings"

// Activity kinds are the Runtime-neutral classes of a tool call that the
// Daemon publishes as Room activity. Adapters set Event.ActivityKind; an
// empty value means ActivityTool.
const (
	ActivityCommand    = "command"
	ActivityTool       = "tool"
	ActivityFileChange = "file_change"
	ActivitySearch     = "search"
	ActivityRead       = "read"
	ActivityBrowse     = "browse"
	ActivityDelegation = "delegation"
	// The Daemon refines commands into the next two; adapters never set
	// them.
	ActivityMessage     = "message"
	ActivityMessageRead = "message_read"
	// ActivityNone keeps the call in history without Room activity.
	ActivityNone = "none"
)

// browserMCPServer is the MCP server whose tools drive a browser.
const browserMCPServer = "browser"

// activityForMCPServer classifies a call routed to an MCP server.
func activityForMCPServer(server string) string {
	if server == browserMCPServer {
		return ActivityBrowse
	}
	return ActivityTool
}

// activityForMCPToolName classifies a qualified MCP tool name such as
// mcp__browser__navigate. ok is false when name is not an MCP tool.
func activityForMCPToolName(name string) (kind string, ok bool) {
	rest, found := strings.CutPrefix(name, "mcp__")
	if !found {
		return "", false
	}
	server, _, _ := strings.Cut(rest, "__")
	return activityForMCPServer(server), true
}

// activityForNamedTool classifies a tool by its exact name: MCP tools by
// their server, built-ins through table, anything else as a generic tool.
func activityForNamedTool(name string, table map[string]string) string {
	if kind, ok := activityForMCPToolName(name); ok {
		return kind
	}
	if kind, ok := table[name]; ok {
		return kind
	}
	return ActivityTool
}
