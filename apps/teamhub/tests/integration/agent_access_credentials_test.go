package integration_test

import (
	"crypto/sha256"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
)

func TestAgentAccessCredentialLifecycle(t *testing.T) {
	allowParallelIntegrationTest(t)
	t.Run("a revoked credential ends without an execution prerequisite", func(t *testing.T) {
		env, _, issued, _ := newAgentCLIIdentity(t)
		ctx := t.Context()
		principal, err := agentcredential.Authenticate(ctx, env.pool, issued.AccessToken)
		if err != nil {
			t.Fatal(err)
		}
		if err = revokeAgentCredential(ctx, env.pool, issued.CredentialID); err != nil {
			t.Fatal(err)
		}
		if _, err = agentcredential.Authenticate(ctx, env.pool, issued.AccessToken); !errors.Is(err, agentcredential.ErrInvalid) {
			t.Fatalf("revoked authentication=%v", err)
		}
		tx, err := env.pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if err = agentcredential.RevalidateInTx(ctx, tx, principal); !errors.Is(err, agentcredential.ErrInvalid) {
			t.Fatalf("revoked commit=%v", err)
		}
		_ = tx.Rollback(ctx)

		var executions int
		if err = env.pool.QueryRow(ctx, `SELECT count(*) FROM agent_local_runs`).Scan(&executions); err != nil || executions != 0 {
			t.Fatalf("credential lifecycle created execution authority: %d %v", executions, err)
		}
	})
	t.Run("in-process credentials are independent identities that expire", func(t *testing.T) {
		env, _, ordinary, _ := newAgentCLIIdentity(t)
		ctx := t.Context()
		service := agentcredential.New(env.pool)
		code, _ := requestMcpJSON(t, env, ordinary.AccessToken, "/internal/agents/"+ordinary.AgentID+"/access-credentials", map[string]any{"label": "not a service"})
		if code != http.StatusUnauthorized {
			t.Fatalf("business token requested trusted credential issuance: %d", code)
		}
		first, err := service.IssueManaged(ctx, ordinary.AgentID, "hosted run one")
		if err != nil {
			t.Fatal(err)
		}
		second, err := service.IssueManaged(ctx, ordinary.AgentID, "hosted run two")
		if err != nil {
			t.Fatal(err)
		}
		if first.CredentialID == second.CredentialID || first.AccessToken == second.AccessToken {
			t.Fatal("managed credential issuance reused an identity")
		}
		var bounded bool
		if err = env.pool.QueryRow(ctx, `SELECT expires_at<=clock_timestamp()+interval '48 hours' FROM agent_access_credentials WHERE id=$1`, second.CredentialID).Scan(&bounded); err != nil {
			t.Fatal(err)
		}
		if !bounded {
			t.Fatal("an in-process credential outlives its bound")
		}
		if _, err = service.IssueManagedFor(ctx, ordinary.AgentID, "too long", 49*time.Hour); !errors.Is(err, agentcredential.ErrInvalid) {
			t.Fatalf("an in-process credential beyond the bound was issued: %v", err)
		}
		for _, credential := range []agentcredential.Issued{ordinary, first, second} {
			if _, err = agentcredential.Authenticate(ctx, env.pool, credential.AccessToken); err != nil {
				t.Fatalf("independent credential %s: %v", credential.CredentialID, err)
			}
		}
		if _, err = env.pool.Exec(ctx, `UPDATE agent_registrations SET status='revoked' WHERE agent_management_id=$1`, ordinary.AgentID); err != nil {
			t.Fatal(err)
		}
		if _, err = agentcredential.Authenticate(ctx, env.pool, second.AccessToken); !errors.Is(err, agentcredential.ErrInvalid) {
			t.Fatalf("disabled Agent authenticated: %v", err)
		}
		if _, err = service.IssueManaged(ctx, ordinary.AgentID, "disabled Agent"); !errors.Is(err, agentcredential.ErrForbidden) {
			t.Fatalf("disabled Agent issued a new credential: %v", err)
		}
	})
	t.Run("a placement credential is the Agent's one Computer token until its placement changes", func(t *testing.T) {
		env, _, ordinary, _ := newAgentCLIIdentity(t)
		ctx := t.Context()
		service := agentcredential.New(env.pool)
		var placement agentcredential.ExpectedPlacement
		if err := env.pool.QueryRow(ctx, `SELECT computer_id,workspace_grant_id FROM agent_registrations WHERE agent_management_id=$1`, ordinary.AgentID).Scan(&placement.ComputerID, &placement.WorkspaceGrantID); err != nil {
			t.Fatal(err)
		}
		first, _, err := service.EnsureManagedForPlacement(ctx, ordinary.AgentID, "Managed Agent CLI", placement, nil)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = agentcredential.Authenticate(ctx, env.pool, first.AccessToken); err != nil {
			t.Fatalf("placement credential: %v", err)
		}
		// The live held token is confirmed without a new issuance.
		firstHash := sha256.Sum256([]byte(first.AccessToken))
		if confirmed, current, err := service.EnsureManagedForPlacement(ctx, ordinary.AgentID, "Managed Agent CLI", placement, firstHash[:]); err != nil || !current || confirmed.AccessToken != "" {
			t.Fatalf("held live token: current=%v token issued=%v err=%v", current, confirmed.AccessToken != "", err)
		}
		if _, err = agentcredential.Authenticate(ctx, env.pool, first.AccessToken); err != nil {
			t.Fatalf("confirmed placement credential: %v", err)
		}
		// A held token TeamHub no longer accepts leads to a new one.
		staleHash := sha256.Sum256([]byte("th_agent_" + strings.Repeat("A", 43)))
		second, current, err := service.EnsureManagedForPlacement(ctx, ordinary.AgentID, "Managed Agent CLI", placement, staleHash[:])
		if err != nil || current {
			t.Fatalf("stale held token: current=%v err=%v", current, err)
		}
		if _, err = agentcredential.Authenticate(ctx, env.pool, first.AccessToken); !errors.Is(err, agentcredential.ErrInvalid) {
			t.Fatalf("a replaced Computer token authenticated: %v", err)
		}
		principal, err := agentcredential.Authenticate(ctx, env.pool, second.AccessToken)
		if err != nil {
			t.Fatalf("current Computer token: %v", err)
		}
		// An in-process credential is not the Computer token and survives.
		if _, err = agentcredential.Authenticate(ctx, env.pool, ordinary.AccessToken); err != nil {
			t.Fatalf("unbound credential after issuance: %v", err)
		}
		// Any new Runtime Assignment ends the token in the row change itself.
		if _, err = env.pool.Exec(ctx, `UPDATE agent_registrations SET assignment_revision=assignment_revision+1 WHERE agent_management_id=$1`, ordinary.AgentID); err != nil {
			t.Fatal(err)
		}
		if _, err = agentcredential.Authenticate(ctx, env.pool, second.AccessToken); !errors.Is(err, agentcredential.ErrInvalid) {
			t.Fatalf("a token of an earlier assignment authenticated: %v", err)
		}
		tx, err := env.pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if err = agentcredential.RevalidateInTx(ctx, tx, principal); !errors.Is(err, agentcredential.ErrInvalid) {
			t.Fatalf("a token of an earlier assignment committed: %v", err)
		}
		_ = tx.Rollback(ctx)
		deleted, err := service.DeleteExpired(ctx)
		if err != nil || deleted != 2 {
			t.Fatalf("cleanup of replaced and moved tokens count=%d err=%v", deleted, err)
		}
	})
	t.Run("manual revocation ends every credential of the Agent at once", func(t *testing.T) {
		env, _, ordinary, _ := newAgentCLIIdentity(t)
		ctx := t.Context()
		service := agentcredential.New(env.pool)
		var placement agentcredential.ExpectedPlacement
		if err := env.pool.QueryRow(ctx, `SELECT computer_id,workspace_grant_id FROM agent_registrations WHERE agent_management_id=$1`, ordinary.AgentID).Scan(&placement.ComputerID, &placement.WorkspaceGrantID); err != nil {
			t.Fatal(err)
		}
		bound, _, err := service.EnsureManagedForPlacement(ctx, ordinary.AgentID, "Managed Agent CLI", placement, nil)
		if err != nil {
			t.Fatal(err)
		}
		revoked, err := service.RevokeAgent(ctx, ordinary.AgentID)
		if err != nil || revoked < 2 {
			t.Fatalf("revoked=%d err=%v", revoked, err)
		}
		for _, credential := range []agentcredential.Issued{ordinary, bound} {
			if _, err = agentcredential.Authenticate(ctx, env.pool, credential.AccessToken); !errors.Is(err, agentcredential.ErrInvalid) {
				t.Fatalf("revoked credential %s authenticated: %v", credential.CredentialID, err)
			}
		}
		// The Computer's next check finds its token revoked and gets a new one.
		boundHash := sha256.Sum256([]byte(bound.AccessToken))
		renewed, current, err := service.EnsureManagedForPlacement(ctx, ordinary.AgentID, "Managed Agent CLI", placement, boundHash[:])
		if err != nil || current {
			t.Fatalf("revoked held token: current=%v err=%v", current, err)
		}
		if _, err = agentcredential.Authenticate(ctx, env.pool, renewed.AccessToken); err != nil {
			t.Fatalf("renewed credential: %v", err)
		}
	})
	t.Run("expiry cleanup drains multiple batches and preserves business audit", func(t *testing.T) {
		env, _, external, _ := newAgentCLIIdentity(t)
		ctx := t.Context()
		service := agentcredential.New(env.pool)
		unused, err := service.IssueManaged(ctx, external.AgentID, "unused")
		if err != nil {
			t.Fatal(err)
		}
		retained, err := service.IssueManaged(ctx, external.AgentID, "retained")
		if err != nil {
			t.Fatal(err)
		}
		_, err = env.pool.Exec(ctx, `INSERT INTO command_replays(scope,operation,key,state,credential_id,request_hash,resource_id,response_status,response_body)
          SELECT 'agent:'||agent_actor_id,'send_message','cleanup-receipt','completed',id,decode(repeat('00',32),'hex'),'message_retained',200,'{}'
          FROM agent_access_credentials WHERE id=$1`, retained.CredentialID)
		if err != nil {
			t.Fatal(err)
		}
		_, err = env.pool.Exec(ctx, `UPDATE agent_access_credentials SET expires_at=clock_timestamp()-interval '1 second' WHERE id=ANY($1)`, []string{unused.CredentialID, retained.CredentialID})
		if err != nil {
			t.Fatal(err)
		}
		// More than two batches must be drained in one scheduled cleanup.
		_, err = env.pool.Exec(ctx, `INSERT INTO agent_access_credentials(id,token_hash,tenant_id,agent_actor_id,agent_management_id,label,expires_at)
          SELECT 'expired-batch-'||n,decode(lpad(to_hex(n),64,'0'),'hex'),tenant_id,agent_actor_id,agent_management_id,'expired',clock_timestamp()-interval '1 second'
          FROM agent_access_credentials CROSS JOIN generate_series(1,205) n WHERE id=$1`, unused.CredentialID)
		if err != nil {
			t.Fatal(err)
		}
		deleted, err := service.DeleteExpired(ctx)
		if err != nil || deleted != 206 {
			t.Fatalf("cleanup count=%d err=%v", deleted, err)
		}
		var retainedCount int
		if err = env.pool.QueryRow(ctx, `SELECT count(*) FROM agent_access_credentials WHERE id=ANY($1)`, []string{external.CredentialID, retained.CredentialID}).Scan(&retainedCount); err != nil || retainedCount != 2 {
			t.Fatalf("live/audit credentials count=%d err=%v", retainedCount, err)
		}
		if _, err = agentcredential.Authenticate(ctx, env.pool, retained.AccessToken); !errors.Is(err, agentcredential.ErrInvalid) {
			t.Fatalf("retained audit row authenticated: %v", err)
		}
		deleted, err = service.DeleteExpired(ctx)
		if err != nil || deleted != 0 {
			t.Fatalf("repeated cleanup count=%d err=%v", deleted, err)
		}
	})

}
