package integration_test

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
)

func newAgentCLIIdentity(t *testing.T, options ...appOption) (*testEnv, *http.Client, agentcredential.Issued, string) {
	t.Helper()
	env, alice := newTaskWorkerEnv(t, options...)
	roomID := createPrivateRoom(t, env, alice, "Independent Agent CLI", "agent-cli-room")
	if code, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); code != http.StatusOK {
		t.Fatalf("add Agent: %d %s", code, body)
	}
	issued, err := agentcredential.New(env.pool).IssueManaged(t.Context(), acmeOfficialAgentManagementID, "independent CLI")
	if err != nil {
		t.Fatalf("issue Agent credential: %v", err)
	}
	return env, alice, issued, roomID
}

// revokeAgentCredential ends one credential now, as a replacing issuance, a
// placement change or an expired in-process lifetime would.
func revokeAgentCredential(ctx context.Context, pool *pgxpool.Pool, credentialID string) error {
	_, err := pool.Exec(ctx, `UPDATE agent_access_credentials SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, credentialID)
	return err
}

func TestAgentCLIIdentityHasNoExecutionPrerequisite(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, _, issued, roomID := newAgentCLIIdentity(t)
	ctx := agentauth.WithTarget(t.Context(), "room", roomID)
	contexts := agentauth.New(env.pool)
	for range 2 {
		authority, err := contexts.Authorize(ctx, issued.AccessToken, "send_message")
		if err != nil {
			t.Fatal(err)
		}
		if authority.Principal == nil || authority.RoomID != roomID || authority.Target != (agentauth.Target{Kind: "room", ID: roomID}) {
			t.Fatalf("authority retained execution prerequisite: %#v", authority)
		}
	}
	verifyAtomicAgentMessageCommit(t, env, issued.AccessToken, roomID)
	var count int
	if err := env.pool.QueryRow(ctx, `SELECT count(*) FROM agent_local_runs`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("created lifecycle state: count=%d err=%v", count, err)
	}
	if _, err := contexts.Authorize(agentauth.WithTarget(ctx, "room", "not-my-room"), issued.AccessToken, "send_message"); !errors.Is(err, agentauth.ErrForbidden) {
		t.Fatalf("unauthorized target: %v", err)
	}
	// There is no Agent-wide Context; the CLI sends a resource Context or none.
	if _, err := contexts.Authorize(agentauth.WithTarget(ctx, "agent", issued.AgentID), issued.AccessToken, "send_message"); !errors.Is(err, agentauth.ErrInvalid) {
		t.Fatalf("Agent-wide Context: %v", err)
	}
	if err := revokeAgentCredential(ctx, env.pool, issued.CredentialID); err != nil {
		t.Fatal(err)
	}
	if _, err := contexts.Authorize(ctx, issued.AccessToken, "send_message"); !errors.Is(err, agentauth.ErrCredentialInvalid) {
		t.Fatalf("expired credential: %v", err)
	}
}
