package integration_test

import (
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
)

func TestPersonalKnowledgeUsesOnlyTheAgentsHumanOwner(t *testing.T) {
	allowParallelIntegrationTest(t)
	pool, err := pgxpool.New(t.Context(), newIntegrationDatabase(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	aliceSubject := seedPersonalKnowledgeAgent(t, pool, "alice_subject", acmeTenant, "actor_acme_alice", "anotherme")

	contexts := agentauth.New(pool)
	credentials := agentcredential.New(pool)
	var aliceToken string
	for _, entry := range []struct{ name, tenantID, ownerID, subjectID string }{
		{"alice_first", acmeTenant, "actor_acme_alice", aliceSubject},
		{"alice_second", acmeTenant, "actor_acme_alice", aliceSubject},
	} {
		t.Run(entry.name, func(t *testing.T) {
			agentID := seedPersonalKnowledgeAgent(t, pool, entry.name, entry.tenantID, entry.ownerID, "general")
			issued, err := credentials.IssueManaged(t.Context(), agentID, "knowledge-owner-test")
			if err != nil {
				t.Fatal(err)
			}
			for _, tool := range []string{"search_knowledge", "read_knowledge"} {
				authorization, err := contexts.Authorize(t.Context(), issued.AccessToken, tool)
				if err != nil {
					t.Fatal(err)
				}
				identity := authorization
				if identity.AgentID != agentID || identity.TenantID != entry.tenantID || identity.UserArtifactOwnerActorID != entry.ownerID || identity.PersonalKnowledgeAgentID != entry.subjectID {
					t.Fatalf("wrong personal knowledge authority: %+v", identity)
				}
			}
			if entry.name == "alice_first" {
				aliceToken = issued.AccessToken
			}
		})
	}
	t.Run("AnotherMe keeps its own subject", func(t *testing.T) {
		issued, err := credentials.IssueManaged(t.Context(), aliceSubject, "knowledge-subject-test")
		if err != nil {
			t.Fatal(err)
		}
		authorization, err := contexts.Authorize(t.Context(), issued.AccessToken, "search_knowledge")
		if err != nil || authorization.PersonalKnowledgeAgentID != aliceSubject {
			t.Fatalf("AnotherMe subject=%q err=%v", authorization.PersonalKnowledgeAgentID, err)
		}
	})
	t.Run("an Agent without a Human owner cannot read personal knowledge", func(t *testing.T) {
		agentID := seedPersonalKnowledgeAgent(t, pool, "ownerless", acmeTenant, "actor_pk_alice_subject", "general")
		issued, err := credentials.IssueManaged(t.Context(), agentID, "knowledge-ownerless-test")
		if err != nil {
			t.Fatal(err)
		}
		for _, tool := range []string{"search_knowledge", "read_knowledge"} {
			if _, err := contexts.Authorize(t.Context(), issued.AccessToken, tool); !errors.Is(err, agentauth.ErrForbidden) {
				t.Fatalf("ownerless %s authorization: %v", tool, err)
			}
		}
	})
	t.Run("removing the owner's source never falls back to another owner's graph", func(t *testing.T) {
		if _, err := pool.Exec(t.Context(), `UPDATE agent_registrations SET status='revoked' WHERE agent_management_id=$1`, aliceSubject); err != nil {
			t.Fatal(err)
		}
		authorization, err := contexts.Authorize(t.Context(), aliceToken, "read_knowledge")
		if err != nil || authorization.PersonalKnowledgeAgentID != "" {
			t.Fatalf("unavailable source authority=%q err=%v", authorization.PersonalKnowledgeAgentID, err)
		}
	})
}

func seedPersonalKnowledgeAgent(t *testing.T, pool *pgxpool.Pool, suffix, tenantID, ownerID, agentType string) string {
	t.Helper()
	actorID, agentID := "actor_pk_"+suffix, "agent_pk_"+suffix
	if _, err := pool.Exec(t.Context(), `INSERT INTO actors(id,tenant_id,kind,display_name,handle)
		VALUES($1,$2,'agent','Personal Knowledge Agent',$3)`, actorID, tenantID, "@pk-"+suffix); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `INSERT INTO agent_registrations(
		actor_id,tenant_id,agent_management_id,status,description,instructions,runtime_model,created_by_actor_id,agent_type,represented_human_actor_id,visibility_scope,computer_id,local_runtime_type,workspace_grant_id)
		VALUES($1,$2,$3,'active','Knowledge test','Use authorized knowledge','test-model',$4,$5,
		CASE WHEN $5='anotherme' THEN $4 ELSE NULL END,CASE WHEN $5='anotherme' THEN 'sponsor' ELSE 'workspace' END,'computer_fixture','codex','grant_files')`, actorID, tenantID, agentID, ownerID, agentType); err != nil {
		t.Fatal(err)
	}
	return agentID
}
