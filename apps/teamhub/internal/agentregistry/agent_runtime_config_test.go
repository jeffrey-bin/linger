package agentregistry

import (
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func TestLocalAgentRuntimeSnapshotPreservesReasoningEffort(t *testing.T) {
	textValue := func(value string) pgtype.Text { return pgtype.Text{String: value, Valid: true} }
	registration := store.GetMaterializableAgentRuntimeRegistrationByManagementIDRow{
		AgentManagementID: textValue("agent-local"), ActorID: "actor-local", TenantID: "tenant-local",
		ConfigurationRevision: 1, AssignmentRevision: 1, RuntimeModel: "test-model",
		RuntimeReasoningEffort: textValue("medium"), ComputerID: textValue("computer-local"),
		LocalRuntimeType: textValue("codex"), WorkspaceGrantID: textValue("workspace-local"),
	}
	snapshot, err := ProjectAgentRuntimeConfigSnapshot(registration)
	if err != nil {
		t.Fatal(err)
	}
	runtime := snapshot.Runtime
	if runtime.ReasoningEffort == nil || *runtime.ReasoningEffort != "medium" {
		t.Fatalf("Local snapshot lost reasoning effort: %+v", runtime)
	}
	registration.RuntimeReasoningEffort = textValue("invalid")
	if _, err := ProjectAgentRuntimeConfigSnapshot(registration); err == nil {
		t.Fatal("invalid reasoning effort was accepted")
	}
}

func TestLocalAgentRuntimeConfigPreservesReasoningEffort(t *testing.T) {
	computer, grant := "computer-local", "workspace-local"
	for _, runtimeType := range []httpapi.LocalRuntimeType{httpapi.LocalRuntimeTypeCodex, httpapi.LocalRuntimeTypeClaude, httpapi.LocalRuntimeTypePi} {
		t.Run(string(runtimeType), func(t *testing.T) {
			effort := httpapi.AgentReasoningEffort("medium")
			config := httpapi.AgentRuntimeConfig{Model: "test-model", ReasoningEffort: &effort, Placement: &httpapi.AgentRuntimePlacement{Type: httpapi.Local, ComputerId: &computer, WorkspaceGrantId: &grant, RuntimeType: &runtimeType}}
			if !ValidAgentRuntimeConfig(config) {
				t.Fatal("valid Local model reasoning effort was rejected")
			}
			invalid := httpapi.AgentReasoningEffort("invalid")
			config.ReasoningEffort = &invalid
			if ValidAgentRuntimeConfig(config) {
				t.Fatal("invalid reasoning effort was accepted")
			}
		})
	}
}
