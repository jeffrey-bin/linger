package integration_test

import (
	"net/http"
	"reflect"
	"testing"

	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

// The Agent Service runs background model calls on the Computer of each live
// Another Me; revoked ones and other Agents are not listed, and the optional
// filters narrow the list to one tenant or owner.
func TestAgentServiceListsAnotherMePlacements(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, _ := newAgentRegistrationEnv(t, &recordingAgentManagement{})
	for _, agent := range []struct{ actorID, tenantID, status, runtime, human, agentType string }{
		{"actor_models_alice_anotherme", acmeTenant, "active", "claude", "actor_acme_alice", "anotherme"},
		{"actor_models_alice_revoked", acmeTenant, "revoked", "codex", "actor_acme_alice", "anotherme"},
		{"actor_models_general", acmeTenant, "active", "codex", "", "general"},
	} {
		if _, err := env.pool.Exec(t.Context(), `INSERT INTO actors(id,tenant_id,kind,display_name,handle) VALUES($1,$2,'agent',$1,'@'||replace($1,'_','-'))`, agent.actorID, agent.tenantID); err != nil {
			t.Fatal(err)
		}
		if _, err := env.pool.Exec(t.Context(), `INSERT INTO agent_registrations(actor_id,tenant_id,agent_management_id,status,description,instructions,runtime_model,created_by_actor_id,visibility_scope,agent_type,represented_human_actor_id,computer_id,local_runtime_type,workspace_grant_id)
VALUES($1,$2,'management-'||$1,$3,'Models','Work safely','gpt-5',coalesce(nullif($5,''),'actor_acme_alice'),'sponsor',$6,nullif($5,''),'computer_fixture',$4,'grant_files')`,
			agent.actorID, agent.tenantID, agent.status, agent.runtime, agent.human, agent.agentType); err != nil {
			t.Fatal(err)
		}
	}
	handler := env.server.Config.Handler
	list := func(query string) []teamhubinternal.AnotherMePlacement {
		t.Helper()
		status, body := agentRuntimeStateRequest(t, handler, http.MethodGet, "/v0/agent-runtime/another-me-placements"+query, teamHubInternalToken, nil)
		if status != http.StatusOK {
			t.Fatalf("list Another Me placements%s status=%d body=%s", query, status, body)
		}
		var placements teamhubinternal.AnotherMePlacementList
		decode(t, body, &placements)
		return placements.Items
	}
	if status, body := agentRuntimeStateRequest(t, handler, http.MethodGet, "/v0/agent-runtime/another-me-placements", "", nil); status != http.StatusUnauthorized {
		t.Fatalf("unauthenticated list status=%d body=%s", status, body)
	}
	placement := func(tenantID, owner, actorID, runtime, status string) teamhubinternal.AnotherMePlacement {
		return teamhubinternal.AnotherMePlacement{
			TenantId: tenantID, OwnerActorId: owner, AgentId: "management-" + actorID, AgentActorId: actorID,
			ComputerId: "computer_fixture", LocalRuntimeType: teamhubinternal.LocalRuntimeType(runtime),
			Status: teamhubinternal.AnotherMePlacementStatus(status),
		}
	}
	want := []teamhubinternal.AnotherMePlacement{
		placement(acmeTenant, "actor_acme_alice", "actor_models_alice_anotherme", "claude", "active"),
	}
	if got := list("?tenant_id=" + acmeTenant); !reflect.DeepEqual(got, want) {
		t.Fatalf("tenant placements=%+v want=%+v", got, want)
	}
	if got := list("?tenant_id=" + acmeTenant + "&owner_actor_id=actor_acme_alice"); !reflect.DeepEqual(got, want) {
		t.Fatalf("owner placements=%+v", got)
	}
	all := list("")
	for _, item := range want {
		found := false
		for _, listed := range all {
			found = found || listed == item
		}
		if !found {
			t.Fatalf("unfiltered list misses %+v: %+v", item, all)
		}
	}
}
