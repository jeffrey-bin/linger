package integration_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
)

func TestConnectedAppsAgentGrantIsExplicitAccountScopedAndRevokedOnDisconnect(t *testing.T) {
	allowParallelIntegrationTest(t)
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(t.Context(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	composioFake := newFakeComposio(t)
	cfg := config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.ArtifactStorageRoot = t.TempDir()
	})
	composioFake.configure(&cfg)
	application, err := newIntegrationApp(t.Context(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
	alice := env.login("alice", alicePassword)

	const agentActorID = "actor_anotherme_connected_apps_grant"
	const connectionID = "connection_connected_apps_grant"
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(t.Context()) }()
	if _, err := tx.Exec(t.Context(), `
		INSERT INTO actors(id,tenant_id,kind,display_name,handle)
		VALUES($1,$2,'agent','Alice''s AnotherMe','@alice-connected-apps-grant')
	`, agentActorID, acmeTenant); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `
		INSERT INTO agent_registrations(
			actor_id,tenant_id,agent_management_id,status,description,instructions,
			runtime_model,created_by_actor_id,visibility_scope,agent_type,represented_human_actor_id,
			computer_id,local_runtime_type,workspace_grant_id
		) VALUES($1,$2,'management-connected-apps-grant','active','Private delegate',
			'Delegate safely','openai/gpt-5.4','actor_acme_alice','sponsor','anotherme','actor_acme_alice','computer_fixture','codex','grant_files')
	`, agentActorID, acmeTenant); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `
		INSERT INTO external_connections(
			id,account_id,provider,upstream_connection_id,status,identity_label,toolkit_slug
		) VALUES($1,'account_alice','gmail','upstream-connected-apps-grant','active','alice@example.test','gmail')
	`, connectionID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	path := "/v0/external-connections/" + connectionID + "/agent-grants"
	status, _, body := env.request(alice, http.MethodGet, path, nil, "")
	if status != http.StatusOK {
		t.Fatalf("list Agent grants status=%d body=%s", status, body)
	}
	var listed struct {
		Agents []struct {
			AgentActorID string `json:"agent_actor_id"`
			Granted      bool   `json:"granted"`
			Revision     int64  `json:"revision"`
		} `json:"agents"`
	}
	decode(t, body, &listed)
	if len(listed.Agents) != 1 || listed.Agents[0].AgentActorID != agentActorID ||
		listed.Agents[0].Granted || listed.Agents[0].Revision != 0 {
		t.Fatalf("unexpected default Agent grant projection: %+v", listed.Agents)
	}

	// A general Agent that shares a Room with Alice may use her connections only
	// after she approves; first activation grants only her AnotherMe.
	roomID := createPrivateRoom(t, env, alice, "Connected apps grant", "connected-apps-grant-room")
	if code, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); code != http.StatusOK {
		t.Fatalf("member: %d %s", code, body)
	}
	const pendingConnectionID = "connection_connected_apps_grant_pending"
	const pendingUpstreamID = "upstream-connected-apps-grant-pending"
	if _, err := pool.Exec(t.Context(), `
		INSERT INTO external_connections(
			id,account_id,provider,upstream_connection_id,status,identity_label,toolkit_slug,connect_expires_at,next_status_check_at
		) VALUES($1,'account_alice','gmail',$2,'pending','Gmail account','gmail',now()+interval '10 minutes',now()+interval '1 minute')
	`, pendingConnectionID, pendingUpstreamID); err != nil {
		t.Fatal(err)
	}
	composioFake.seedAccount(t, pool, pendingUpstreamID, "account_alice", "gmail", composio.ConnectionActive)
	startExternalJobs(t, pool, composioFake.externalSources(t, pool, &fakeGmailProvider{identityEmail: "alice-pending@example.test"}))
	// The popup returns: only Alice's pending upstream is hers to complete.
	complete := func() {
		t.Helper()
		// A completion leaves a running check alone; the sweep would retry it.
		if !waitForExternalSource(func() bool {
			return countRows(t, env, `SELECT count(*) FROM river_job WHERE kind='external.connection_reconcile' AND state='running'`) == 0
		}) {
			t.Fatal("previous connection check did not finish")
		}
		if status, _, body := env.request(alice, http.MethodPost, "/v0/external-connection-completions", map[string]any{"connected_account_id": pendingUpstreamID}, ""); status != http.StatusNoContent {
			t.Fatalf("completion status=%d body=%s", status, body)
		}
		if !waitForExternalSource(func() bool {
			var current string
			return pool.QueryRow(t.Context(), `SELECT status FROM external_connections WHERE id=$1`, pendingConnectionID).Scan(&current) == nil && current == "active"
		}) {
			t.Fatal("completed connection did not become active")
		}
	}
	complete()
	grantsOf := func() map[string]bool {
		t.Helper()
		status, _, body := env.request(alice, http.MethodGet, "/v0/external-connections/"+pendingConnectionID+"/agent-grants", nil, "")
		if status != http.StatusOK {
			t.Fatalf("list first-active Agent grants status=%d body=%s", status, body)
		}
		decode(t, body, &listed)
		granted := map[string]bool{}
		for _, agent := range listed.Agents {
			granted[agent.AgentActorID] = agent.Granted
		}
		return granted
	}
	if granted := grantsOf(); len(granted) != 2 || !granted[agentActorID] || granted["actor_acme_official"] {
		t.Fatalf("first activation grants=%v; want only the AnotherMe", granted)
	}
	if got := countRows(t, env, `SELECT count(*) FROM river_job WHERE kind='typedcard.connection_auth_settle' AND args->>'connection_id'=$1`, pendingConnectionID); got != 1 {
		t.Fatalf("activation queued %d card settlements", got)
	}
	if status, _, body = env.request(
		alice,
		http.MethodPut,
		"/v0/external-connections/"+pendingConnectionID+"/agent-grants/"+agentActorID,
		map[string]any{"granted": false},
		"",
	); status != http.StatusOK {
		t.Fatalf("revoke first-active Agent grant status=%d body=%s", status, body)
	}
	// A replayed first activation must not restore what Alice revoked.
	if _, err := pool.Exec(t.Context(), `UPDATE external_connections SET status='pending' WHERE id=$1`, pendingConnectionID); err != nil {
		t.Fatal(err)
	}
	complete()
	if granted := grantsOf(); granted[agentActorID] || granted["actor_acme_official"] {
		t.Fatalf("revoked Agent grant was reapplied: %v", granted)
	}

	grantPath := path + "/" + agentActorID
	for attempt := 0; attempt < 2; attempt++ {
		status, _, body = env.request(alice, http.MethodPut, grantPath, map[string]any{"granted": true}, "")
		if status != http.StatusOK {
			t.Fatalf("grant Agent access attempt=%d status=%d body=%s", attempt+1, status, body)
		}
		var granted struct {
			Granted  bool  `json:"granted"`
			Revision int64 `json:"revision"`
		}
		decode(t, body, &granted)
		if !granted.Granted || granted.Revision != 1 {
			t.Fatalf("grant attempt=%d result=%+v", attempt+1, granted)
		}
	}
	toolService := composioFake.externalSources(t, pool, nil)
	toolTx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	connections, err := toolService.ListGrantedAgentToolConnectionsInTx(
		t.Context(), toolTx, agentActorID, acmeTenant, "", "",
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(connections) != 1 || connections[0].ID != connectionID || connections[0].AccountID != "account_alice" {
		t.Fatalf("granted MCP connections=%+v", connections)
	}
	locked, err := toolService.LockGrantedAgentToolConnectionInTx(
		t.Context(), toolTx, agentActorID, acmeTenant, connectionID,
	)
	if err != nil || locked.ID != connectionID {
		t.Fatalf("locked MCP connection=%+v err=%v", locked, err)
	}
	if err := toolTx.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	}

	var revision int64
	status, _, body = env.request(alice, http.MethodGet, "/v0/external-connections/"+connectionID, nil, "")
	if status != http.StatusOK {
		t.Fatalf("get connection status=%d body=%s", status, body)
	}
	var connection struct {
		Revision int64 `json:"revision"`
	}
	decode(t, body, &connection)
	revision = connection.Revision
	status, _, body = env.request(
		alice, http.MethodPost, "/v0/external-connections/"+connectionID+"/disconnects",
		map[string]any{"expected_revision": revision},
		"disconnect-connected-apps-grant",
	)
	if status != http.StatusAccepted {
		t.Fatalf("disconnect status=%d body=%s", status, body)
	}
	var disconnected struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	decode(t, body, &disconnected)
	if disconnected.ID != connectionID || disconnected.Status != "disconnecting" {
		t.Fatalf("disconnect response=%s want the disconnecting connection", body)
	}
	var grantStatus string
	if err := pool.QueryRow(context.Background(), `
		SELECT status FROM external_connection_agent_grants
		WHERE connection_id=$1 AND agent_actor_id=$2
	`, connectionID, agentActorID).Scan(&grantStatus); err != nil {
		t.Fatal(err)
	}
	if grantStatus != "revoked" {
		t.Fatalf("grant status after disconnect=%q want revoked", grantStatus)
	}
	toolTx, err = pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = toolTx.Rollback(t.Context()) }()
	connections, err = toolService.ListGrantedAgentToolConnectionsInTx(
		t.Context(), toolTx, agentActorID, acmeTenant, "", "",
	)
	if err != nil || len(connections) != 0 {
		t.Fatalf("MCP connections after disconnect=%+v err=%v", connections, err)
	}
}
