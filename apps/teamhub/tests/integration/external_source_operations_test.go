package integration_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
)

func TestExternalSourceStatusCheckAndReauthorization(t *testing.T) {
	allowParallelIntegrationTest(t)
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(t.Context(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	provider := &fakeGmailProvider{identityEmail: "alice@example.test"}
	composioFake := newFakeComposio(t)
	cfg := config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.ArtifactStorageRoot = t.TempDir()
		c.ArtifactMaxBytes = 2 << 20
	})
	composioFake.configure(&cfg)
	application, err := newTestApp(t.Context(), cfg, skipping(app.SkillInstall), skipping(app.SkillPackageProbe),
		withComposio(provider), starting(app.JobQueue))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
	alice := env.login("alice", alicePassword)

	createConnection := func(key string) (connection struct {
		ID       string `json:"id"`
		Status   string `json:"status"`
		Revision int64  `json:"revision"`
	}) {
		status, _, body := env.request(alice, http.MethodPost, "/v0/external-connections", map[string]any{"app_key": "gmail"}, key)
		if status != http.StatusCreated {
			t.Fatalf("create connection status=%d body=%s", status, body)
		}
		decode(t, body, &connection)
		completeAuthorizations(t, env, alice)
		if !waitForExternalSource(func() bool {
			status, _, body = env.request(alice, http.MethodGet, "/v0/external-connections/"+connection.ID, nil, "")
			if status == http.StatusOK {
				decode(t, body, &connection)
			}
			return status == http.StatusOK && connection.Status == "active"
		}) {
			t.Fatalf("connection not active: %s", body)
		}
		return
	}
	upstreamOf := func(connectionID string) string {
		var upstream string
		if err := pool.QueryRow(t.Context(), `SELECT upstream_connection_id FROM external_connections WHERE id=$1`, connectionID).Scan(&upstream); err != nil {
			t.Fatal(err)
		}
		return upstream
	}
	type connectionView struct {
		ID                              string `json:"id"`
		Status                          string `json:"status"`
		Revision                        int64  `json:"revision"`
		StatusCheckRequestedAt          string `json:"status_check_requested_at"`
		Reauthorizing                   bool   `json:"reauthorizing"`
		ReauthorizationConnectURL       string `json:"reauthorization_connect_url"`
		ReauthorizationConnectExpiresAt string `json:"reauthorization_connect_expires_at"`
		ReauthorizationErrorCode        string `json:"reauthorization_error_code"`
	}
	getConnection := func(connectionID string) (connection connectionView, ok bool) {
		status, _, body := env.request(alice, http.MethodGet, "/v0/external-connections/"+connectionID, nil, "")
		if status != http.StatusOK {
			return connection, false
		}
		decode(t, body, &connection)
		return connection, true
	}
	// A requested status check makes the reconcile due; the connection shows the
	// request until the reconcile writes its result.
	requestStatusCheck := func(connectionID string, revision int64, key string) connectionView {
		status, _, body := env.request(alice, http.MethodPost,
			"/v0/external-connections/"+connectionID+"/status-checks",
			map[string]any{"expected_revision": revision}, key)
		if status != http.StatusAccepted {
			t.Fatalf("status check status=%d body=%s", status, body)
		}
		var requested connectionView
		decode(t, body, &requested)
		if requested.ID != connectionID || requested.StatusCheckRequestedAt == "" {
			t.Fatalf("status check response=%s", body)
		}
		var checked connectionView
		if !waitForExternalSource(func() bool {
			var ok bool
			checked, ok = getConnection(connectionID)
			return ok && checked.StatusCheckRequestedAt == ""
		}) {
			t.Fatalf("status check did not finish: %+v", checked)
		}
		return checked
	}
	// A reauthorization lives on the connection until its job settles it.
	requestReauthorization := func(connectionID string, revision int64, key string) {
		status, _, body := env.request(alice, http.MethodPost,
			"/v0/external-connections/"+connectionID+"/reauthorizations",
			map[string]any{"expected_revision": revision}, key)
		if status != http.StatusAccepted {
			t.Fatalf("reauthorization status=%d body=%s", status, body)
		}
		var started connectionView
		decode(t, body, &started)
		if started.ID != connectionID || !started.Reauthorizing || started.ReauthorizationConnectURL == "" || started.ReauthorizationConnectExpiresAt == "" || started.ReauthorizationErrorCode != "" {
			t.Fatalf("reauthorization response=%s", body)
		}
	}

	connection := createConnection("operation-connection")
	originalOperationUpstream := upstreamOf(connection.ID)
	composioFake.setStatus(originalOperationUpstream, composio.ConnectionExpired)
	if checked := requestStatusCheck(connection.ID, connection.Revision, "explicit-status-check"); checked.Status != "expired" || checked.Revision != connection.Revision {
		t.Fatalf("status check did not freeze expired state: %+v", checked)
	}

	requestReauthorization(connection.ID, connection.Revision, "reauthorization")
	completeAuthorizations(t, env, alice)
	var reauthorized connectionView
	if !waitForExternalSource(func() bool {
		var ok bool
		reauthorized, ok = getConnection(connection.ID)
		return ok && !reauthorized.Reauthorizing
	}) {
		t.Fatalf("same-identity reauthorization did not settle: %+v", reauthorized)
	}
	// Success requires a compatible identity; a mismatch would fail it.
	if reauthorized.Status != "active" || reauthorized.Revision != connection.Revision+1 || reauthorized.ReauthorizationErrorCode != "" || reauthorized.ReauthorizationConnectURL != "" || upstreamOf(connection.ID) == originalOperationUpstream {
		t.Fatalf("same-identity reauthorization result=%+v", reauthorized)
	}

	provider.mu.Lock()
	provider.identityEmail = "alice+mismatch@example.test"
	provider.mu.Unlock()
	mismatchConnection := createConnection("mismatch-connection")
	originalUpstream := upstreamOf(mismatchConnection.ID)
	composioFake.setStatus(originalUpstream, composio.ConnectionExpired)
	requestStatusCheck(mismatchConnection.ID, mismatchConnection.Revision, "mismatch-status-check")
	provider.mu.Lock()
	provider.identityEmail = "someone-else@example.test"
	provider.mu.Unlock()
	requestReauthorization(mismatchConnection.ID, mismatchConnection.Revision, "mismatch-reauthorization")
	var candidateUpstream string
	if err := pool.QueryRow(t.Context(), `SELECT reauthorization_upstream_id FROM external_connections WHERE id=$1`, mismatchConnection.ID).Scan(&candidateUpstream); err != nil {
		t.Fatal(err)
	}
	completeAuthorizations(t, env, alice)
	var mismatch connectionView
	if !waitForExternalSource(func() bool {
		var ok bool
		mismatch, ok = getConnection(mismatchConnection.ID)
		return ok && !mismatch.Reauthorizing
	}) {
		t.Fatalf("mismatch reauthorization not settled: %+v", mismatch)
	}
	if currentUpstream := upstreamOf(mismatchConnection.ID); mismatch.ReauthorizationErrorCode != "identity_mismatch" || mismatch.Revision != mismatchConnection.Revision || currentUpstream != originalUpstream {
		t.Fatalf("mismatch result=%+v upstream=%q want=%q", mismatch, currentUpstream, originalUpstream)
	}
	var candidateRevokeRequested bool
	if err := pool.QueryRow(t.Context(), `SELECT revoke_requested_at IS NOT NULL FROM external_connection_upstreams WHERE upstream_id=$1`, candidateUpstream).Scan(&candidateRevokeRequested); err != nil || !candidateRevokeRequested {
		t.Fatalf("rejected candidate %q was not given up: err=%v", candidateUpstream, err)
	}
}

func TestMailConnectionResolvesAccountTenant(t *testing.T) {
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
		c.ArtifactMaxBytes = 2 << 20
	})
	composioFake.configure(&cfg)
	application, err := newTestApp(t.Context(), cfg, skipping(app.SkillInstall), skipping(app.SkillPackageProbe),
		withComposio(&fakeGmailProvider{identityEmail: "alice@example.test"}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
	alice := env.login("alice", alicePassword)
	mailJobs := func() (count int, tenants []string) {
		rows, err := pool.Query(t.Context(), `SELECT args->>'tenant_id' FROM river_job WHERE kind='external.mail_connection' ORDER BY id`)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		for rows.Next() {
			var tenant string
			if err := rows.Scan(&tenant); err != nil {
				t.Fatal(err)
			}
			tenants = append(tenants, tenant)
		}
		return len(tenants), tenants
	}
	create := func(appKey, key string) (int, string) {
		status, _, body := env.request(alice, http.MethodPost, "/v0/external-connections", map[string]any{"app_key": appKey}, key)
		var connection struct {
			ID string `json:"id"`
		}
		if status == http.StatusCreated {
			decode(t, body, &connection)
		}
		return status, connection.ID
	}

	status, first := create("gmail", "mail-connect")
	if status != http.StatusCreated {
		t.Fatalf("gmail connect status=%d", status)
	}
	if count, tenants := mailJobs(); count != 1 || tenants[0] != acmeTenant {
		t.Fatalf("mail jobs after connect = %v", tenants)
	}
	// Connect carries no key: a repeat opens a second pending connection with its own import.
	status, second := create("gmail", "mail-connect")
	if status != http.StatusCreated || second == "" || second == first {
		t.Fatalf("second connect status=%d id=%q first %q", status, second, first)
	}
	if count, tenants := mailJobs(); count != 2 || tenants[1] != acmeTenant {
		t.Fatalf("mail jobs after second connect = %v", tenants)
	}
	if status, _ := create("notion", "notion-connect"); status != http.StatusCreated {
		t.Fatalf("notion connect status=%d", status)
	}
	if count, tenants := mailJobs(); count != 2 {
		t.Fatalf("mail jobs after notion connect = %v", tenants)
	}
}
