package localtools

import (
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/permission"
)

// The permission review allows the read-only local tools without asking; each
// must be a tool these catalogs actually expose under its MCP server name.
func TestPermissionReadOnlyToolsAreCatalogTools(t *testing.T) {
	for _, name := range permission.ReadOnlyLocalToolNames() {
		switch {
		case strings.HasPrefix(name, "mcp__browser__") && browserTools[strings.TrimPrefix(name, "mcp__browser__")]:
		case strings.HasPrefix(name, "mcp__computer__") && (cuaTools[strings.TrimPrefix(name, "mcp__computer__")] || name == "mcp__computer__"+checkPermissionsTool || name == "mcp__computer__report_blocker"):
		default:
			t.Errorf("%s is not a local tool", name)
		}
	}
}
