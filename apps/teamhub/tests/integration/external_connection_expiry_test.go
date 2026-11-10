package integration_test

import (
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
)

// TestExternalConnectionExpiredLinkSettlesAttempts covers authorizations whose
// Connect Link expired. A first attempt Composio reports ACTIVE still connects;
// an INITIATED or vanished account is abandoned and revoked; an unavailable
// Composio leaves the attempt pending. An expired reauthorization revokes only
// its candidate account and keeps the Connection it was replacing.
func TestExternalConnectionExpiredLinkSettlesAttempts(t *testing.T) {
	allowParallelIntegrationTest(t)
	pool, err := pgxpool.New(t.Context(), newIntegrationDatabase(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	fake := newFakeComposio(t)
	fake.setIntercept(func(w http.ResponseWriter, r *http.Request) bool {
		if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/upstream_unavailable") {
			w.WriteHeader(http.StatusServiceUnavailable)
			return true
		}
		return false
	})
	for upstream, status := range map[string]composio.ConnectionStatus{
		"upstream_late": composio.ConnectionActive, "upstream_initiated": composio.ConnectionPending,
		"upstream_unavailable": composio.ConnectionPending, "upstream_gone": composio.ConnectionPending,
		"upstream_current": composio.ConnectionActive, "upstream_candidate": composio.ConnectionPending,
	} {
		fake.seedAccount(t, pool, upstream, "account_alice", "gmail", status)
	}
	// Composio no longer has this account.
	fake.mu.Lock()
	delete(fake.accounts, "upstream_gone")
	fake.mu.Unlock()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(t.Context(), query, args...); err != nil {
			t.Fatal(err)
		}
	}
	count := func(query string) (got int) {
		_ = pool.QueryRow(t.Context(), query).Scan(&got)
		return got
	}
	for _, name := range []string{"late", "initiated", "unavailable", "gone"} {
		exec(`INSERT INTO external_connections(id,account_id,provider,upstream_connection_id,status,connect_url,connect_expires_at,next_status_check_at) VALUES($1,'account_alice','gmail',$2,'pending','https://connect.example.test/authorize',now()-interval '1 minute',now())`, "gmail_"+name, "upstream_"+name)
	}
	exec(`INSERT INTO external_connections(id,account_id,provider,upstream_connection_id,status,active_since,identity_label,remote_principal_key,next_status_check_at) VALUES('gmail_current','account_alice','gmail','upstream_current','active',now(),'current@example.test','gmail:current@example.test',now()+interval '1 day')`)
	exec(`UPDATE external_connections SET reauthorization_upstream_id='upstream_candidate',reauthorization_connect_url='https://connect.example.test/authorize',reauthorization_connect_expires_at=now()-interval '1 minute' WHERE id='gmail_current'`)
	exec(`INSERT INTO river_job(kind,queue,args,max_attempts) VALUES('external.reauthorization','external','{"connection_id":"gmail_current"}',25)`)
	startConnectionScheduler(t, pool, fake, &countedConnectionGmail{fakeGmailProvider: &fakeGmailProvider{identityEmail: "late@example.test"}})

	type connectionState struct {
		status, code string
		connectURL   bool
	}
	want := map[string]connectionState{
		"gmail_late":        {status: "active"},
		"gmail_initiated":   {status: "revoked"},
		"gmail_gone":        {status: "revoked"},
		"gmail_unavailable": {status: "pending", code: "provider_status_unavailable", connectURL: true},
		"gmail_current":     {status: "active"},
	}
	got := map[string]connectionState{}
	var reauthorization connectionState
	settled := func() bool {
		rows, err := pool.Query(t.Context(), `SELECT id,status,coalesce(status_error_code,''),connect_url IS NOT NULL FROM external_connections WHERE account_id='account_alice'`)
		if err != nil {
			return false
		}
		defer rows.Close()
		for rows.Next() {
			var id string
			var state connectionState
			if rows.Scan(&id, &state.status, &state.code, &state.connectURL) != nil {
				return false
			}
			got[id] = state
		}
		if pool.QueryRow(t.Context(), `SELECT CASE WHEN reauthorization_upstream_id IS NULL THEN 'ended' ELSE 'pending' END,coalesce(reauthorization_error_code,''),reauthorization_connect_url IS NOT NULL FROM external_connections WHERE id='gmail_current'`).Scan(&reauthorization.status, &reauthorization.code, &reauthorization.connectURL) != nil {
			return false
		}
		for id, state := range want {
			if got[id] != state {
				return false
			}
		}
		return reauthorization == connectionState{status: "ended", code: "connect_link_expired"} &&
			count(`SELECT count(*) FROM external_connection_upstreams WHERE revoke_requested_at IS NOT NULL`) == 3 &&
			len(fake.revokedAccounts()) == 3
	}
	if !waitForExternalSource(settled) {
		t.Fatalf("connections=%+v reauthorization=%+v", got, reauthorization)
	}
	rows, err := pool.Query(t.Context(), `SELECT upstream_id FROM external_connection_upstreams WHERE revoke_requested_at IS NOT NULL ORDER BY upstream_id`)
	if err != nil {
		t.Fatal(err)
	}
	cleaned, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(cleaned, []string{"upstream_candidate", "upstream_gone", "upstream_initiated"}) {
		t.Fatalf("cleaned upstreams=%v", cleaned)
	}
	revoked := fake.revokedAccounts()
	slices.Sort(revoked)
	if !slices.Equal(revoked, cleaned) {
		t.Fatalf("revoked upstreams=%v", revoked)
	}
}
