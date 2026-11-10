package integration_test

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentconnectedapps"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
)

func TestConnectedAppsExecutionDoesNotHoldContextLeaseDuringProviderCalls(t *testing.T) {
	serialIntegrationTest(t, serialWallClockBound)
	env, alice := newTaskWorkerEnv(t)
	roomID := createPrivateRoom(t, env, alice, "Connected tools lease", "connected-lease")
	if code, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); code != http.StatusOK {
		t.Fatalf("add Agent: %d %s", code, body)
	}
	issued, err := agentcredential.New(env.pool).IssueManaged(t.Context(), acmeOfficialAgentManagementID, "Connected tools authorization")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `
 INSERT INTO external_connections(id,account_id,provider,upstream_connection_id,status,identity_label,toolkit_slug) VALUES('connection_lease_test','account_alice','gmail','upstream_lease_test','active','alice@example.test','gmail');
 INSERT INTO external_connection_agent_grants(id,connection_id,tenant_id,agent_actor_id,represented_human_actor_id,status) VALUES('grant_lease_test','connection_lease_test','tenant_acme','actor_acme_official','actor_acme_alice','active')`); err != nil {
		t.Fatal(err)
	}
	contexts := agentauth.New(env.pool)
	authorizedContext := agentauth.WithTarget(t.Context(), "room", roomID)
	phases := []string{}
	provider := &leaseProbeToolProvider{probe: func(phase string) {
		phases = append(phases, phase)
		ctx, cancel := context.WithTimeout(t.Context(), time.Second)
		defer cancel()
		if _, err := env.pool.Exec(ctx, `UPDATE agent_access_credentials SET label=label WHERE id=$1`, issued.CredentialID); err != nil {
			t.Fatalf("provider phase %s blocked credential mutation: %v", phase, err)
		}
		if _, err := env.pool.Exec(ctx, `UPDATE external_connection_agent_grants SET revision=revision WHERE id='grant_lease_test'`); err != nil {
			t.Fatalf("provider phase %s blocked grant mutation: %v", phase, err)
		}
	}}
	sources := newFakeComposio(t).externalSources(t, env.pool, nil)
	// Each metadata-race scenario needs a cache miss so the provider callback
	// actually revokes access before the second authorization check.
	newService := func() *agentconnectedapps.Service {
		return agentconnectedapps.New(env.pool, contexts, sources, provider)
	}
	service := newService()
	input := agentconnectedapps.ExecuteInput{ConnectionID: "connection_lease_test", ToolSlug: "GMAIL_FETCH_EMAILS", ToolVersion: "20260721_00", Arguments: map[string]any{}}
	result, err := service.Execute(authorizedContext, issued.AccessToken, input)
	if err != nil || result.Data == nil || len(phases) != 3 {
		t.Fatalf("execute=%+v phases=%v err=%v", result, phases, err)
	}
	// Revocation during metadata lookup must be checked again before dispatch.
	service = newService()
	dispatched := false
	provider.probe = func(phase string) {
		if phase == "get_tool" {
			if _, err := env.pool.Exec(t.Context(), `UPDATE external_connection_agent_grants SET status='revoked',revoked_at=clock_timestamp(),revision=revision+1 WHERE id='grant_lease_test'`); err != nil {
				t.Fatal(err)
			}
		}
		if phase == "execute" {
			dispatched = true
		}
	}
	_, err = service.Execute(authorizedContext, issued.AccessToken, input)
	if err == nil || dispatched {
		t.Fatalf("revoked tool dispatched=%t err=%v", dispatched, err)
	}
	// A dispatched operation with an uncertain outcome is still never retryable.
	if _, err := env.pool.Exec(t.Context(), `UPDATE external_connection_agent_grants SET status='active',revoked_at=NULL,revision=revision+1 WHERE id='grant_lease_test'`); err != nil {
		t.Fatal(err)
	}
	provider.probe = func(string) {}
	provider.executeError = errors.New("response lost")
	_, err = service.Execute(authorizedContext, issued.AccessToken, input)
	var toolError *agentconnectedapps.Error
	if !errors.As(err, &toolError) || toolError.Retryable {
		t.Fatalf("uncertain execution became retryable: %v", err)
	}
	// A route change during metadata lookup cannot reuse the earlier verification.
	service = newService()
	provider.executeError = nil
	dispatched = false
	provider.probe = func(phase string) {
		if phase == "get_tool" {
			if _, err := env.pool.Exec(t.Context(), `UPDATE external_connections SET revision=revision+1,upstream_connection_id='rotated' WHERE id='connection_lease_test'`); err != nil {
				t.Fatal(err)
			}
		}
		if phase == "execute" {
			dispatched = true
		}
	}
	if _, err := service.Execute(authorizedContext, issued.AccessToken, input); err == nil || dispatched {
		t.Fatalf("changed connection dispatched=%t err=%v", dispatched, err)
	}
	// In-flight admitted calls may complete; revoke itself must not wait for them.
	provider.probe = func(phase string) {
		if phase == "execute" {
			ctx, cancel := context.WithTimeout(t.Context(), time.Second)
			defer cancel()
			if _, err := env.pool.Exec(ctx, `UPDATE external_connection_agent_grants SET status='revoked',revoked_at=clock_timestamp(),revision=revision+1 WHERE id='grant_lease_test'`); err != nil {
				t.Fatalf("in-flight provider blocked revocation: %v", err)
			}
		}
	}
	if _, err := service.Execute(authorizedContext, issued.AccessToken, input); err != nil {
		t.Fatalf("admitted call lost known result: %v", err)
	}
	if _, err := env.pool.Exec(t.Context(), `UPDATE external_connection_agent_grants SET status='active',revoked_at=NULL,revision=revision+1 WHERE id='grant_lease_test'`); err != nil {
		t.Fatal(err)
	}
	// Expiring the credential during metadata work also prevents dispatch.
	service = newService()
	dispatched = false
	provider.probe = func(phase string) {
		if phase == "get_tool" {
			if err := revokeAgentCredential(t.Context(), env.pool, issued.CredentialID); err != nil {
				t.Fatal(err)
			}
		}
		if phase == "execute" {
			dispatched = true
		}
	}
	if _, err := service.Execute(authorizedContext, issued.AccessToken, input); err == nil || dispatched {
		t.Fatalf("revoked credential dispatched=%t err=%v", dispatched, err)
	}

	if count := countRows(t, env, `SELECT count(*) FROM agent_local_runs`); count != 0 {
		t.Fatalf("business execution created %d Runs", count)
	}
}

type leaseProbeToolProvider struct {
	probe        func(string)
	executeError error
}

func (p *leaseProbeToolProvider) SearchTools(context.Context, composio.ToolSearchRequest) ([]composio.Tool, error) {
	return nil, nil
}
func (p *leaseProbeToolProvider) GetConnectionStatusForToolkit(context.Context, string, string) (composio.ConnectionStatus, error) {
	p.probe("connection_status")
	return composio.ConnectionActive, nil
}
func (p *leaseProbeToolProvider) GetTool(context.Context, string, string) (composio.Tool, error) {
	p.probe("get_tool")
	var tool composio.Tool
	tool.Slug = "GMAIL_FETCH_EMAILS"
	tool.Version = "20260721_00"
	tool.Toolkit.Slug = "gmail"
	return tool, nil
}
func (p *leaseProbeToolProvider) ExecuteTool(context.Context, string, string, string, string, map[string]any) (composio.ToolExecution, error) {
	p.probe("execute")
	return composio.ToolExecution{Successful: true, Data: map[string]any{"done": true}}, p.executeError
}
