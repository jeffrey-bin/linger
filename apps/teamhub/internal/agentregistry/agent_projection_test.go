package agentregistry

import (
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func TestAgentAvailabilityProjection(t *testing.T) {
	t.Run("active Tasks aggregate without replacing Runtime availability", func(t *testing.T) {
		availability := listedTenantAgentAvailability(store.ListTenantAgentsForAccountRow{
			ActiveTaskCount:    3,
			AgentKind:          "agent",
			AgentType:          "general",
			Status:             "active",
			VisibilityScope:    "workspace",
			CreatorKind:        "human",
			CreatorDisplayName: "Jenny",
		})
		if availability.Status != "online" || availability.Label != "Online" ||
			availability.ActiveTaskCount != 3 || availability.CurrentActivity != nil {
			t.Fatalf("unexpected aggregate availability: %+v", availability)
		}
	})

	t.Run("an Agent on an offline Computer waits for it", func(t *testing.T) {
		availability := availabilityWithLocalRuntimeStatus(
			listedTenantAgentAvailability(store.ListTenantAgentsForAccountRow{ActiveTaskCount: 1}),
			roomagent.LocalAgentRuntimeStatus{ComputerStatus: "offline", Status: "offline", ConnectionStatus: "connected"},
		)
		if availability.Status != "offline" || availability.ActiveTaskCount != 1 || availability.CurrentActivity == nil ||
			availability.CurrentActivity.Summary != "Waiting for the computer to connect" {
			t.Fatalf("unexpected waiting availability: %+v", availability)
		}
	})
}
