package externalsource

import "testing"

func TestNotionConnectionSupportsAgentTools(t *testing.T) {
	service := &Service{managed: configuredManagedCatalog(t)}
	if _, supported := service.agentToolsApp("notion"); !supported {
		t.Fatal("Notion connection cannot be delegated to an Agent")
	}
	if toolkit := toolkitForApp("notion"); toolkit != "notion" {
		t.Fatalf("toolkit=%q", toolkit)
	}
}
