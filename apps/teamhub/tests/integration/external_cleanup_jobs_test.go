package integration_test

import (
	"net/http"
	"slices"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
)

// TestExternalConnectionCleanupJobRetriesRevokeWithoutSpendingAttempts covers the
// River cleanup worker: a failed revoke shows provider_revoke_failed on the
// disconnecting Connection and snoozes the job, the retry revokes and ends the
// Connection, and a job for a missing Connection is a no-op.
func TestExternalConnectionCleanupJobRetriesRevokeWithoutSpendingAttempts(t *testing.T) {
	allowParallelIntegrationTest(t)
	pool, err := pgxpool.New(t.Context(), newIntegrationDatabase(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	composioFake := newFakeComposio(t)
	var revokes atomic.Int32
	composioFake.setIntercept(func(w http.ResponseWriter, r *http.Request) bool {
		if r.Method == http.MethodDelete && revokes.Add(1) == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return true
		}
		return false
	})
	composioFake.seedAccount(t, pool, "upstream_cleanup_job", "account_alice", "gmail", composio.ConnectionActive)
	if _, err = pool.Exec(t.Context(), `INSERT INTO external_connections(id,account_id,provider,upstream_connection_id,status,revision,next_status_check_at) VALUES('gmail_cleanup_job','account_alice','gmail','upstream_cleanup_job','disconnecting',2,now()+interval '1 day')`); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(t.Context(), `UPDATE external_connection_upstreams SET revoke_requested_at=now() WHERE upstream_id='upstream_cleanup_job'`); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(t.Context(), `INSERT INTO river_job(kind,queue,args,max_attempts) VALUES('external.connection_cleanup','external','{"connection_id":"gmail_cleanup_job","upstream_id":"upstream_cleanup_job"}',25),('external.connection_cleanup','external','{"connection_id":"gmail_cleanup_missing","upstream_id":"upstream_cleanup_missing"}',25)`); err != nil {
		t.Fatal(err)
	}
	startExternalJobs(t, pool, composioFake.externalSources(t, pool, nil))

	var scheduledIn time.Duration
	var attempt int
	var connectionStatus, code string
	if !waitForExternalSource(func() bool {
		return pool.QueryRow(t.Context(), `SELECT extract(epoch FROM scheduled_at-now())::bigint*1000000000,attempt FROM river_job WHERE kind='external.connection_cleanup' AND args->>'upstream_id'='upstream_cleanup_job'`).Scan(&scheduledIn, &attempt) == nil && scheduledIn > time.Minute
	}) {
		t.Fatal("cleanup job was not snoozed after the failed revoke")
	}
	if err = pool.QueryRow(t.Context(), `SELECT status,coalesce(status_error_code,'') FROM external_connections WHERE id='gmail_cleanup_job'`).Scan(&connectionStatus, &code); err != nil {
		t.Fatal(err)
	}
	if connectionStatus != "disconnecting" || code != "provider_revoke_failed" || attempt != 0 || scheduledIn < 4*time.Minute {
		t.Fatalf("after failed revoke status=%q code=%q attempt=%d snoozed=%s", connectionStatus, code, attempt, scheduledIn)
	}

	makeExternalJobDue(t, pool, "external.connection_cleanup", "upstream_id", "upstream_cleanup_job")
	if !waitForExternalSource(func() bool {
		return pool.QueryRow(t.Context(), `SELECT status,coalesce(status_error_code,'') FROM external_connections WHERE id='gmail_cleanup_job'`).Scan(&connectionStatus, &code) == nil && connectionStatus == "revoked" && code == ""
	}) {
		t.Fatalf("connection was not revoked: status=%q code=%q", connectionStatus, code)
	}
	if revoked := composioFake.revokedAccounts(); !slices.Equal(revoked, []string{"upstream_cleanup_job"}) {
		t.Fatalf("revoked upstreams=%v", revoked)
	}
	var missing string
	if err = pool.QueryRow(t.Context(), `SELECT state FROM river_job WHERE kind='external.connection_cleanup' AND args->>'connection_id'='gmail_cleanup_missing'`).Scan(&missing); err != nil || missing != "completed" {
		t.Fatalf("missing cleanup job state=%q err=%v", missing, err)
	}
}
