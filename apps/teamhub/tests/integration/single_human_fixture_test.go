package integration_test

import (
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// bobPassword signs in the peer Human that seedPeerHuman adds.
const bobPassword = "teamhub-dev-bob"

// seedPeerHuman adds a second Human, actor_acme_bob, to tenant_acme and signs
// it in. A deployment has exactly one Human and the shared seed holds only
// that Human. Only tests of the multi-Human mechanisms that are still in the
// product add this peer: Human Room membership and roles, Human direct
// Document sharing and access requests, and @Human comment mentions. Tests of
// an access rule use an Agent instead.
func seedPeerHuman(t *testing.T, env *testEnv) *http.Client {
	t.Helper()
	seedPeerHumanActor(t, env.pool)
	return env.login("bob", bobPassword)
}

// seedPeerHumanActor writes the peer Human of seedPeerHuman without signing it
// in, for tests of a Computer owned by another Human that drive services
// directly.
func seedPeerHumanActor(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	// pgx sends a statement with arguments as one prepared statement, which
	// holds a single command.
	if _, err := pool.Exec(t.Context(), `INSERT INTO accounts(id,email,password_hash)
		VALUES('account_bob','bob@example.com',$1)`,
		lowCostIntegrationPasswordHash("bob@example.com", bobPassword)); err != nil {
		t.Fatalf("seed peer Human account: %v", err)
	}
	if _, err := pool.Exec(t.Context(), `INSERT INTO actors(id,tenant_id,kind,display_name,account_id)
		VALUES('actor_acme_bob','tenant_acme','human','bob','account_bob')`); err != nil {
		t.Fatalf("seed peer Human: %v", err)
	}
}

// agentCanReadDocument reports whether the Agent's current Document authority
// grants read. Tests that guard an access rule use the Agent as the reader,
// because the single Human reads every active Document.
func agentCanReadDocument(t *testing.T, env *testEnv, agentManagementID, documentID string) bool {
	t.Helper()
	var canRead bool
	if err := env.pool.QueryRow(t.Context(), `SELECT coalesce(bool_or(can_read),false)
		FROM resolve_agent_document_access_v2($1,$2)`, agentManagementID, documentID).Scan(&canRead); err != nil {
		t.Fatalf("resolve Agent Document access: %v", err)
	}
	return canRead
}

// seedPeerAgent registers an active general Agent of the deployment's Human on
// the fixture Computer. Tests that need a second participant beside the Human
// and @official use it instead of a second Human.
func seedPeerAgent(t *testing.T, env *testEnv, actorID string) {
	t.Helper()
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO actors(id,tenant_id,kind,display_name,handle)
		VALUES($1,'tenant_acme','agent',$1,'@'||replace($1,'_','-'))`, actorID); err != nil {
		t.Fatalf("seed peer Agent actor: %v", err)
	}
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO agent_registrations(
			actor_id,tenant_id,agent_management_id,status,instructions,runtime_model,created_by_actor_id,
			computer_id,local_runtime_type,workspace_grant_id,visibility_scope
		) VALUES($1,'tenant_acme','management-'||$1,'active','Work safely.','gpt-5','actor_acme_alice',
			'computer_fixture','codex','grant_files','workspace')`, actorID); err != nil {
		t.Fatalf("seed peer Agent: %v", err)
	}
}
