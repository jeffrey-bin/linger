package agentregistry

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func TestRuntimeConfigSnapshotPreservesReasoningEffort(t *testing.T) {
	for _, effort := range []string{"", "low", "high", "ultra", "invalid"} {
		t.Run(effort, func(t *testing.T) {
			registration := store.GetMaterializableAgentRuntimeRegistrationByManagementIDRow{
				ActorID: "actor_test", TenantID: "tenant_test", AgentManagementID: textValue("agent_test"),
				ConfigurationRevision: 1, DisplayName: "Test Agent", Instructions: "Test instructions",
				RuntimeModel: "gpt-5.6-sol", AssignmentRevision: 1, CreatedByActorID: "actor_owner",
				ComputerID: textValue("computer_test"), LocalRuntimeType: textValue("codex"),
				WorkspaceGrantID: textValue("grant_test"),
			}
			if effort != "" {
				registration.RuntimeReasoningEffort = textValue(effort)
			}
			snapshot, err := ProjectAgentRuntimeConfigSnapshot(registration)
			if effort == "invalid" {
				if !errors.Is(err, agentruntimestate.ErrConflict) {
					t.Fatalf("expected invalid reasoning to be rejected, got %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			encoded, err := json.Marshal(snapshot.Runtime)
			if err != nil {
				t.Fatal(err)
			}
			var runtime map[string]json.RawMessage
			if err := json.Unmarshal(encoded, &runtime); err != nil {
				t.Fatal(err)
			}
			if effort == "" {
				if _, exists := runtime["reasoning_effort"]; exists {
					t.Fatal("unset reasoning must remain omitted")
				}
			} else if string(runtime["reasoning_effort"]) != `"`+effort+`"` {
				t.Fatalf("reasoning not preserved: %s", runtime["reasoning_effort"])
			}
		})
	}
}
