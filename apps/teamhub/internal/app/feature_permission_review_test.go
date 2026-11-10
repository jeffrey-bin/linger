package app

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentregistry"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/permissionreview"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

type allowingJudge struct{}

func (allowingJudge) Judge(context.Context, permissionreview.Request) (permissionreview.Verdict, error) {
	return permissionreview.Verdict{}, nil
}

// The Agent Runtime configuration tells the Agent Service whether a judge
// exists; the flag is a deployment fact, so it never changes content_hash.
func TestRuntimeConfigSnapshotCarriesPermissionReview(t *testing.T) {
	registration := store.GetMaterializableAgentRuntimeRegistrationByManagementIDRow{
		ActorID: "actor_test", TenantID: "tenant_test", AgentManagementID: textValue("agent_test"),
		ConfigurationRevision: 1, DisplayName: "Test Agent", Instructions: "Test instructions",
		RuntimeModel: "gpt-5.6-sol", AssignmentRevision: 1, CreatedByActorID: "actor_owner",
		ComputerID: textValue("computer_test"), LocalRuntimeType: textValue("codex"),
		WorkspaceGrantID: textValue("grant_test"),
	}
	snapshot, err := agentregistry.ProjectAgentRuntimeConfigSnapshot(registration)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name string
		app  *App
		want bool
	}{
		{"no review service", &App{}, false},
		{"no judge", &App{permissionReviews: &permissionreview.Service{}}, false},
		{"judge", &App{permissionReviews: &permissionreview.Service{Judge: allowingJudge{}}}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.app.permissionReviewEnabled(); got != tc.want {
				t.Fatalf("permissionReviewEnabled() = %v, want %v", got, tc.want)
			}
			withFlag := snapshot
			withFlag.PermissionReview = tc.app.permissionReviewEnabled()
			encoded, err := json.Marshal(withFlag)
			if err != nil {
				t.Fatal(err)
			}
			var fields map[string]json.RawMessage
			if err := json.Unmarshal(encoded, &fields); err != nil {
				t.Fatal(err)
			}
			if want := map[bool]string{true: "true", false: "false"}[tc.want]; string(fields["permission_review"]) != want {
				t.Fatalf("permission_review = %s, want %s", fields["permission_review"], want)
			}
			if withFlag.ContentHash != snapshot.ContentHash {
				t.Fatal("permission_review must not change content_hash")
			}
		})
	}
}
