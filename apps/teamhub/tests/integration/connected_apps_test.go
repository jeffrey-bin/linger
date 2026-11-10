package integration_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
)

type retryingGoogleCalendarIdentityProvider struct {
	fakeGoogleCalendarProvider
	identityCalls atomic.Int32
}

func (p *retryingGoogleCalendarIdentityProvider) IdentifyGoogleCalendar(context.Context, string) (composio.GoogleCalendarIdentity, error) {
	if p.identityCalls.Add(1) == 1 {
		return composio.GoogleCalendarIdentity{}, errors.New("temporary Google Calendar identity failure")
	}
	return composio.GoogleCalendarIdentity{CalendarID: "primary@example.test", Label: "Alice", TimeZone: "Asia/Shanghai"}, nil
}

func TestGoogleCalendarIdentityFailureSchedulesRetryAndRecovers(t *testing.T) {
	allowParallelIntegrationTest(t)
	artifactRoot := integrationArtifactRoot(t)
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	provider := &retryingGoogleCalendarIdentityProvider{}
	cfg := config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.ArtifactStorageRoot = artifactRoot
		c.ArtifactMaxBytes = 2 << 20
	})
	newFakeComposio(t).configure(&cfg)
	application, err := newIntegrationApp(context.Background(), cfg, withComposio(provider), starting(app.JobQueue))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
	alice := env.login("alice", alicePassword)

	statusCode, _, body := env.request(alice, http.MethodPost, "/v0/external-connections", map[string]any{"app_key": "google_calendar"}, "calendar-identity-retry")
	if statusCode != http.StatusCreated {
		t.Fatalf("create Google Calendar status=%d body=%s", statusCode, body)
	}
	var connection struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	decode(t, body, &connection)
	completeAuthorizations(t, env, alice)

	var errorCode string
	var nextCheck time.Time
	if !waitForExternalSource(func() bool {
		err = pool.QueryRow(context.Background(), `SELECT coalesce(status_error_code,''),next_status_check_at FROM external_connections WHERE id=$1`, connection.ID).Scan(&errorCode, &nextCheck)
		return err == nil && errorCode == "provider_identity_unavailable" && nextCheck.After(time.Now())
	}) {
		t.Fatalf("identity failure was not persisted with a retry: error=%v code=%q next=%s", err, errorCode, nextCheck)
	}
	if _, err = pool.Exec(context.Background(), `UPDATE external_connections SET next_status_check_at=now() WHERE id=$1`, connection.ID); err != nil {
		t.Fatal(err)
	}
	makeExternalJobDue(t, pool, "external.connection_reconcile", "connection_id", connection.ID)
	if !waitForExternalSource(func() bool {
		statusCode, _, body = env.request(alice, http.MethodGet, "/v0/external-connections/"+connection.ID, nil, "")
		if statusCode != http.StatusOK {
			return false
		}
		decode(t, body, &connection)
		return connection.Status == "active"
	}) {
		t.Fatalf("Google Calendar connection did not recover after retry: %s", body)
	}
	if calls := provider.identityCalls.Load(); calls < 2 {
		t.Fatalf("identity calls=%d want at least 2", calls)
	}
}

func TestConnectedAppsCatalogAndGenericConnection(t *testing.T) {
	allowParallelIntegrationTest(t)
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	gmail := &fakeGmailProvider{}
	composioFake := newFakeComposio(t)
	cfg := config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.ArtifactStorageRoot = t.TempDir()
		c.ArtifactMaxBytes = 2 << 20
	})
	composioFake.configure(&cfg)
	application, err := newIntegrationApp(context.Background(), cfg, withComposio(gmailAndSlack{fakeGmailProvider: gmail, slack: &fakeSlackProvider{}}), starting(app.JobQueue))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
	alice := env.login("alice", alicePassword)

	statusCode, _, body := env.request(alice, http.MethodGet, "/v0/external-apps", nil, "")
	if statusCode != http.StatusOK {
		t.Fatalf("list apps status=%d body=%s", statusCode, body)
	}
	var catalog struct {
		Apps []struct {
			Key          string   `json:"key"`
			Availability string   `json:"availability"`
			Capabilities []string `json:"capabilities"`
		} `json:"apps"`
	}
	decode(t, body, &catalog)
	wantKeys := []string{"gmail", "outlook", "googledrive", "slack", "discord", "facebook", "github", "google_meet", "google_calendar", "notion", "linear", "figma", "canva", "higgsfield", "fal_ai", "granola", "calendly", "outlook_calendar"}
	if len(catalog.Apps) != len(wantKeys) {
		t.Fatalf("catalog apps=%d want=%d body=%s", len(catalog.Apps), len(wantKeys), body)
	}
	for index, want := range wantKeys {
		if catalog.Apps[index].Key != want {
			t.Fatalf("catalog[%d]=%q want=%q", index, catalog.Apps[index].Key, want)
		}
		// A configured Composio key makes every app in the fixed list available.
		if catalog.Apps[index].Availability != "available" {
			t.Fatalf("catalog[%s] availability=%q", want, catalog.Apps[index].Availability)
		}
		if !slices.Contains(catalog.Apps[index].Capabilities, "agent_tools") {
			t.Fatalf("catalog[%s] agent_tools missing, capabilities=%v", want, catalog.Apps[index].Capabilities)
		}
	}

	statusCode, _, body = env.request(alice, http.MethodPost, "/v0/external-connections", map[string]any{"app_key": "gmail"}, "connected-app-create")
	if statusCode != http.StatusCreated {
		t.Fatalf("generic create status=%d body=%s", statusCode, body)
	}
	var connection struct {
		ID         string `json:"id"`
		Provider   string `json:"provider"`
		Status     string `json:"status"`
		ConnectURL string `json:"connect_url"`
	}
	decode(t, body, &connection)
	if connection.ID == "" || connection.Provider != "gmail" || connection.Status != "pending" || connection.ConnectURL == "" {
		t.Fatalf("unexpected connection: %s", body)
	}
	for _, forbidden := range []string{"upstream_connection_id", "remote_team_id", "remote_user_id", "auth_config_id", "toolkit_slug"} {
		if strings.Contains(string(body), forbidden) {
			t.Fatalf("public connection leaked %q: %s", forbidden, body)
		}
	}
	var toolkit, authConfigID string
	if err := pool.QueryRow(context.Background(), `SELECT toolkit_slug,auth_config_id FROM external_connections WHERE id=$1`, connection.ID).Scan(&toolkit, &authConfigID); err != nil {
		t.Fatal(err)
	}
	if toolkit != "gmail" || authConfigID != fakeComposioAuthConfigs["gmail"] {
		t.Fatalf("connection provenance toolkit=%q auth_config_id=%q", toolkit, authConfigID)
	}

	statusCode, _, body = env.request(alice, http.MethodPost, "/v0/external-connections", map[string]any{"app_key": "facebook"}, "facebook-create")
	if statusCode != http.StatusServiceUnavailable || !strings.Contains(string(body), "APP_CONNECTION_UNAVAILABLE") {
		t.Fatalf("unavailable app create status=%d body=%s", statusCode, body)
	}

	completeAuthorizations(t, env, alice)
	if !waitForExternalSource(func() bool {
		statusCode, _, body = env.request(alice, http.MethodGet, "/v0/external-connections/"+connection.ID, nil, "")
		if statusCode != http.StatusOK {
			return false
		}
		decode(t, body, &connection)
		return connection.Status == "active"
	}) {
		t.Fatalf("first Gmail connection did not become active: %s", body)
	}
	statusCode, _, body = env.request(alice, http.MethodPost, "/v0/external-connections", map[string]any{"app_key": "gmail"}, "duplicate-gmail-create")
	if statusCode != http.StatusCreated {
		t.Fatalf("second Gmail create status=%d body=%s", statusCode, body)
	}
	var duplicate struct {
		ID              string `json:"id"`
		Status          string `json:"status"`
		StatusErrorCode string `json:"status_error_code"`
	}
	decode(t, body, &duplicate)
	completeAuthorizations(t, env, alice)
	if !waitForExternalSource(func() bool {
		statusCode, _, body = env.request(alice, http.MethodGet, "/v0/external-connections/"+duplicate.ID, nil, "")
		if statusCode != http.StatusOK {
			return false
		}
		decode(t, body, &duplicate)
		return duplicate.Status == "failed" && duplicate.StatusErrorCode == "duplicate_remote_principal"
	}) {
		t.Fatalf("duplicate Gmail connection was not rejected: %s", body)
	}
	if !waitForExternalSource(func() bool {
		return len(composioFake.revokedAccounts()) > 0
	}) {
		t.Fatal("duplicate Gmail upstream authorization was not revoked")
	}
	blockedCandidateID := "external_connection_revoked_blocked_candidate"
	blockedCandidateUpstream := "upstream_revoke_blocked_candidate"
	composioFake.seedAccount(t, pool, blockedCandidateUpstream, "account_alice", "gmail", composio.ConnectionActive)
	// Publish the due candidate and its job only after every prerequisite exists.
	// Otherwise River can reconcile before the fake account or upstream receipt is ready.
	fixtureTx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer fixtureTx.Rollback(t.Context())
	if _, err = fixtureTx.Exec(t.Context(), `INSERT INTO external_connections(id,account_id,provider,upstream_connection_id,status,revision,identity_label,status_error_code,next_status_check_at) VALUES($1,'account_alice','gmail',$2,'failed',1,'alice@example.test','duplicate_remote_principal',now())`, blockedCandidateID, blockedCandidateUpstream); err != nil {
		t.Fatal(err)
	}
	// TeamHub already gave this upstream up, so recovery must never adopt it.
	if _, err = fixtureTx.Exec(t.Context(), `UPDATE external_connection_upstreams SET revoke_requested_at=now() WHERE upstream_id=$1`, blockedCandidateUpstream); err != nil {
		t.Fatal(err)
	}
	if _, err = fixtureTx.Exec(t.Context(), `UPDATE external_connections SET status='expired',next_status_check_at=now()+interval '1 hour' WHERE id=$1`, connection.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = fixtureTx.Exec(t.Context(), `INSERT INTO river_job(kind,queue,args,max_attempts) VALUES('external.connection_reconcile','external',jsonb_build_object('connection_id',$1::text),25)`, blockedCandidateID); err != nil {
		t.Fatal(err)
	}
	if err = fixtureTx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	if !waitForExternalSource(func() bool {
		var nextCheck time.Time
		queryErr := pool.QueryRow(context.Background(), `SELECT next_status_check_at FROM external_connections WHERE id=$1`, blockedCandidateID).Scan(&nextCheck)
		return queryErr == nil && nextCheck.After(time.Now().Add(5*time.Hour))
	}) {
		t.Fatal("given-up duplicate was not reconciled")
	}
	var blockedCanonicalStatus, blockedCanonicalUpstream, blockedCandidateStatus, blockedCandidateError string
	var blockedRevokeRequested bool
	if err = pool.QueryRow(context.Background(), `SELECT canonical.status,canonical.upstream_connection_id,candidate.status,coalesce(candidate.status_error_code,''),upstream.revoke_requested_at IS NOT NULL FROM external_connections canonical,external_connections candidate,external_connection_upstreams upstream WHERE canonical.id=$1 AND candidate.id=$2 AND upstream.upstream_id=$3`, connection.ID, blockedCandidateID, blockedCandidateUpstream).Scan(&blockedCanonicalStatus, &blockedCanonicalUpstream, &blockedCandidateStatus, &blockedCandidateError, &blockedRevokeRequested); err != nil {
		t.Fatal(err)
	}
	if blockedCanonicalStatus != "expired" || blockedCanonicalUpstream == blockedCandidateUpstream || blockedCandidateStatus != "failed" || blockedCandidateError != "duplicate_remote_principal" || !blockedRevokeRequested {
		t.Fatalf("given-up upstream recovery changed canonical=%q/%q candidate=%q/%q revoke_requested=%t",
			blockedCanonicalStatus, blockedCanonicalUpstream, blockedCandidateStatus, blockedCandidateError, blockedRevokeRequested)
	}
	var canonicalUpstream string
	if err = pool.QueryRow(context.Background(), `SELECT upstream_connection_id FROM external_connections WHERE id=$1`, connection.ID).Scan(&canonicalUpstream); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(context.Background(), `UPDATE external_connections SET status='expired',next_status_check_at=now()+interval '1 hour' WHERE id=$1`, connection.ID); err != nil {
		t.Fatal(err)
	}
	pendingReauthorizationUpstream := "upstream_pending_reauthorization"
	statusCheckStarted := make(chan struct{}, 1)
	statusCheckDone := make(chan struct{}, 1)
	statusCheckRelease := make(chan struct{})
	releaseStatusCheck := func() {
		select {
		case <-statusCheckRelease:
		default:
			close(statusCheckRelease)
		}
	}
	t.Cleanup(releaseStatusCheck)
	composioFake.seedAccount(t, pool, pendingReauthorizationUpstream, "account_alice", "gmail", composio.ConnectionPending)
	gmail.mu.Lock()
	gmail.identityErrs = map[string]error{canonicalUpstream: composio.RemoteStatusError("identify Gmail account", http.StatusUnauthorized)}
	gmail.identityStart = map[string]chan struct{}{canonicalUpstream: statusCheckStarted}
	gmail.identityDone = map[string]chan struct{}{canonicalUpstream: statusCheckDone}
	gmail.identityWait = map[string]chan struct{}{canonicalUpstream: statusCheckRelease}
	gmail.mu.Unlock()
	// A reauthorization and a requested status check are in progress on the
	// expired canonical Connection when another upstream recovers it.
	if _, err = pool.Exec(context.Background(), `UPDATE external_connections SET reauthorization_upstream_id=$2,reauthorization_connect_url='https://connect.example.test/gmail',reauthorization_connect_expires_at=now()+interval '1 hour',status_check_requested_at=now(),next_status_check_at=now() WHERE id=$1`, connection.ID, pendingReauthorizationUpstream); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(context.Background(), `INSERT INTO river_job(kind,queue,args,max_attempts) VALUES('external.reauthorization','external',jsonb_build_object('connection_id',$1::text),25),('external.connection_reconcile','external',jsonb_build_object('connection_id',$1::text),25)`, connection.ID); err != nil {
		t.Fatal(err)
	}
	select {
	case <-statusCheckStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("old status check did not enter the provider call")
	}
	startExternalJobs(t, pool, composioFake.externalSources(t, pool, gmail))
	statusCode, _, body = env.request(alice, http.MethodPost, "/v0/external-connections", map[string]any{"app_key": "gmail"}, "recover-expired-duplicate-gmail")
	if statusCode != http.StatusCreated {
		t.Fatalf("replacement Gmail create status=%d body=%s", statusCode, body)
	}
	var replacement struct {
		ID, Status string
	}
	decode(t, body, &replacement)
	completeAuthorizations(t, env, alice)
	if !waitForExternalSource(func() bool {
		var canonicalStatus, replacementStatus, currentUpstream string
		var canonicalRevision int64
		queryErr := pool.QueryRow(context.Background(), `SELECT canonical.status,canonical.revision,canonical.upstream_connection_id,replacement.status FROM external_connections canonical,external_connections replacement WHERE canonical.id=$1 AND replacement.id=$2`, connection.ID, replacement.ID).Scan(&canonicalStatus, &canonicalRevision, &currentUpstream, &replacementStatus)
		return queryErr == nil && canonicalStatus == "active" && canonicalRevision == 2 && currentUpstream != canonicalUpstream && replacementStatus == "revoked"
	}) {
		t.Fatalf("expired canonical Gmail connection did not adopt the replacement authorization")
	}
	var reauthorizationUpstream, reauthorizationError string
	var statusCheckRequested, candidateRevokeRequested bool
	if err = pool.QueryRow(context.Background(), `SELECT coalesce(connection.reauthorization_upstream_id,''),coalesce(connection.reauthorization_error_code,''),connection.status_check_requested_at IS NOT NULL,upstream.revoke_requested_at IS NOT NULL FROM external_connections connection,external_connection_upstreams upstream WHERE connection.id=$1 AND upstream.upstream_id=$2`, connection.ID, pendingReauthorizationUpstream).Scan(&reauthorizationUpstream, &reauthorizationError, &statusCheckRequested, &candidateRevokeRequested); err != nil {
		t.Fatal(err)
	}
	if reauthorizationUpstream != "" || reauthorizationError != "stale_revision" || !candidateRevokeRequested {
		t.Fatalf("superseded reauthorization upstream=%q error=%q candidate_revoke_requested=%t", reauthorizationUpstream, reauthorizationError, candidateRevokeRequested)
	}
	if statusCheckRequested {
		t.Fatal("recovery left the superseded status check requested")
	}
	releaseStatusCheck()
	select {
	case <-statusCheckDone:
	case <-time.After(2 * time.Second):
		t.Fatal("old status check did not return after release")
	}
	var recoveredStatus string
	var recoveredRevision int64
	lateWriteDeadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(lateWriteDeadline) {
		if err = pool.QueryRow(context.Background(), `SELECT status,revision FROM external_connections WHERE id=$1`, connection.ID).Scan(&recoveredStatus, &recoveredRevision); err != nil {
			t.Fatal(err)
		}
		if recoveredStatus != "active" || recoveredRevision != 2 {
			t.Fatalf("late old status check changed the recovered connection to %q revision %d", recoveredStatus, recoveredRevision)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !waitForExternalSource(func() bool {
		revokedIDs := composioFake.revokedAccounts()
		return slices.Contains(revokedIDs, canonicalUpstream) && slices.Contains(revokedIDs, pendingReauthorizationUpstream)
	}) {
		t.Fatalf("superseded upstreams were not revoked: canonical=%q reauthorization=%q", canonicalUpstream, pendingReauthorizationUpstream)
	}
	var recoveredUpstream string
	if err = pool.QueryRow(context.Background(), `SELECT upstream_connection_id FROM external_connections WHERE id=$1`, connection.ID).Scan(&recoveredUpstream); err != nil {
		t.Fatal(err)
	}
	if revokedIDs := composioFake.revokedAccounts(); slices.Contains(revokedIDs, recoveredUpstream) {
		t.Fatalf("replacement upstream %q was revoked: %v", recoveredUpstream, revokedIDs)
	}
	statusRecoveryCandidateID := "external_connection_status_recovery_candidate"
	statusRecoveryCandidateUpstream := "upstream_status_recovery_candidate"
	if _, err = pool.Exec(context.Background(), `UPDATE external_connections SET status='expired',next_status_check_at=now()+interval '1 hour' WHERE id=$1`, connection.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(context.Background(), `INSERT INTO external_connections(id,account_id,provider,upstream_connection_id,status,revision,identity_label,status_error_code,next_status_check_at) VALUES($1,'account_alice','gmail',$2,'failed',1,'alice@example.test','provider_auth_failed',now()+interval '1 hour')`, statusRecoveryCandidateID, statusRecoveryCandidateUpstream); err != nil {
		t.Fatal(err)
	}
	composioFake.seedAccount(t, pool, statusRecoveryCandidateUpstream, "account_alice", "gmail", composio.ConnectionActive)
	statusCode, _, body = env.request(alice, http.MethodPost, "/v0/external-connections/"+statusRecoveryCandidateID+"/status-checks", map[string]any{"expected_revision": 1}, "recover-duplicate-status-check")
	if statusCode != http.StatusAccepted {
		t.Fatalf("recovery status check status=%d body=%s", statusCode, body)
	}
	var recoveryCheck struct {
		ID                     string `json:"id"`
		Status                 string `json:"status"`
		StatusCheckRequestedAt string `json:"status_check_requested_at"`
	}
	decode(t, body, &recoveryCheck)
	if recoveryCheck.ID != statusRecoveryCandidateID || recoveryCheck.Status != "failed" || recoveryCheck.StatusCheckRequestedAt == "" {
		t.Fatalf("recovery status check response=%s", body)
	}
	if !waitForExternalSource(func() bool {
		var candidateStatus string
		var requested bool
		queryErr := pool.QueryRow(context.Background(), `SELECT status,status_check_requested_at IS NOT NULL FROM external_connections WHERE id=$1`, statusRecoveryCandidateID).Scan(&candidateStatus, &requested)
		return queryErr == nil && candidateStatus == "revoked" && !requested
	}) {
		t.Fatal("recovery status check did not settle the candidate as revoked")
	}
	var statusRecoveryCanonicalStatus, statusRecoveryCanonicalUpstream, statusRecoveryCandidateStatus string
	if err = pool.QueryRow(context.Background(), `SELECT canonical.status,canonical.upstream_connection_id,candidate.status FROM external_connections canonical,external_connections candidate WHERE canonical.id=$1 AND candidate.id=$2`, connection.ID, statusRecoveryCandidateID).Scan(&statusRecoveryCanonicalStatus, &statusRecoveryCanonicalUpstream, &statusRecoveryCandidateStatus); err != nil {
		t.Fatal(err)
	}
	if statusRecoveryCanonicalStatus != "active" || statusRecoveryCanonicalUpstream != statusRecoveryCandidateUpstream || statusRecoveryCandidateStatus != "revoked" {
		t.Fatalf("status-check recovery canonical=%q/%q candidate=%q",
			statusRecoveryCanonicalStatus, statusRecoveryCanonicalUpstream, statusRecoveryCandidateStatus)
	}
}

func TestAppImportAdaptersUseInternalBindingsWithoutLeakingProviderIdentifiers(t *testing.T) {
	allowParallelIntegrationTest(t)
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	cfg := config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.ArtifactStorageRoot = t.TempDir()
		c.ArtifactMaxBytes = 2 << 20
	})
	newFakeComposio(t).configure(&cfg)
	application, err := newIntegrationApp(context.Background(), cfg, withComposio(calendarAlongside{Provider: fakeDiscordProvider{}, calendar: fakeGoogleCalendarProvider{}}), starting(app.JobQueue))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
	alice := env.login("alice", alicePassword)

	statusCode, _, body := env.request(alice, http.MethodGet, "/v0/external-apps", nil, "")
	if statusCode != http.StatusOK {
		t.Fatalf("list configured apps status=%d body=%s", statusCode, body)
	}
	var configuredCatalog struct {
		Apps []struct {
			Key, Availability string
		} `json:"apps"`
	}
	decode(t, body, &configuredCatalog)
	for _, appKey := range []string{"discord", "google_calendar"} {
		available := false
		for _, definition := range configuredCatalog.Apps {
			if definition.Key == appKey && definition.Availability == "available" {
				available = true
			}
		}
		if !available {
			t.Fatalf("configured catalog did not publish %s as available: %s", appKey, body)
		}
	}

	for _, testCase := range []struct {
		appKey, toolkit string
	}{
		{appKey: "discord", toolkit: "discordbot"},
		{appKey: "google_calendar", toolkit: "googlecalendar"},
	} {
		statusCode, _, body = env.request(alice, http.MethodPost, "/v0/external-connections", map[string]any{"app_key": testCase.appKey}, "create-"+testCase.appKey)
		if statusCode != http.StatusCreated {
			t.Fatalf("create %s status=%d body=%s", testCase.appKey, statusCode, body)
		}
		var connection struct {
			ID string `json:"id"`
		}
		decode(t, body, &connection)
		for _, forbidden := range []string{"ca_link_", fakeComposioAuthConfigs[testCase.toolkit], "auth_config_id", "toolkit_slug", "upstream_connection_id"} {
			if strings.Contains(string(body), forbidden) {
				t.Fatalf("%s public response leaked %q: %s", testCase.appKey, forbidden, body)
			}
		}
		var toolkit, binding string
		if err := pool.QueryRow(context.Background(), `SELECT toolkit_slug,auth_config_id FROM external_connections WHERE id=$1`, connection.ID).Scan(&toolkit, &binding); err != nil {
			t.Fatal(err)
		}
		if toolkit != testCase.toolkit || binding != fakeComposioAuthConfigs[testCase.toolkit] {
			t.Fatalf("%s provenance toolkit=%q binding=%q", testCase.appKey, toolkit, binding)
		}
	}
}

// TestConnectReportsARejectedComposioKey covers a saved or configured key that
// Composio no longer accepts: Connect names the key, so the Web can ask for a
// new one, and no Connection is recorded.
func TestConnectReportsARejectedComposioKey(t *testing.T) {
	allowParallelIntegrationTest(t)
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	composioFake := newFakeComposio(t)
	composioFake.setIntercept(func(w http.ResponseWriter, _ *http.Request) bool {
		w.WriteHeader(http.StatusUnauthorized)
		return true
	})
	cfg := config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.ArtifactStorageRoot = t.TempDir()
		c.ArtifactMaxBytes = 2 << 20
	})
	composioFake.configure(&cfg)
	application, err := newIntegrationApp(context.Background(), cfg, withComposio(&fakeGmailProvider{}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
	alice := env.login("alice", alicePassword)

	statusCode, _, body := env.request(alice, http.MethodPost, "/v0/external-connections", map[string]any{"app_key": "gmail"}, "connect-rejected-key")
	if statusCode != http.StatusConflict || !strings.Contains(string(body), `"COMPOSIO_KEY_REJECTED"`) {
		t.Fatalf("connect status=%d body=%s", statusCode, body)
	}
	composioFake.setIntercept(func(w http.ResponseWriter, _ *http.Request) bool {
		w.WriteHeader(http.StatusForbidden)
		return true
	})
	statusCode, _, body = env.request(alice, http.MethodPost, "/v0/external-connections", map[string]any{"app_key": "gmail"}, "connect-forbidden-key")
	if statusCode != http.StatusForbidden || !strings.Contains(string(body), `"COMPOSIO_CONNECTION_FORBIDDEN"`) {
		t.Fatalf("forbidden connect status=%d body=%s", statusCode, body)
	}
	var connections int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM external_connections`).Scan(&connections); err != nil || connections != 0 {
		t.Fatalf("connections=%d err=%v", connections, err)
	}
}
