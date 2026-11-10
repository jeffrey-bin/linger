package integration_test

import (
	"context"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
)

// countedConnectionGmail counts Gmail identity lookups.
type countedConnectionGmail struct {
	*fakeGmailProvider
	identities atomic.Int32
}

func (p *countedConnectionGmail) IdentifyGmail(ctx context.Context, id string) (composio.GmailIdentity, error) {
	p.identities.Add(1)
	return p.fakeGmailProvider.IdentifyGmail(ctx, id)
}

// startExternalJobs runs River's External Source workers, which own status
// checks and imports, for service. It returns the stop function.
func startExternalJobs(t *testing.T, pool *pgxpool.Pool, service *externalsource.Service) func() {
	t.Helper()
	workers := river.NewWorkers()
	externalsource.AddJobWorkers(workers, service, service.ProviderConfigured)
	client, err := jobs.NewClient(pool, jobs.Options{Workers: workers, PollInterval: riverTestPollInterval, TestOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Start(t.Context()); err != nil {
		t.Fatal(err)
	}
	stop := func() {
		stopCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = client.Stop(stopCtx)
	}
	t.Cleanup(stop)
	return stop
}

// blockStatusRequests makes each connected-account status request signal
// started and wait for release before the fake answers it.
func blockStatusRequests(fake *fakeComposio, started, release chan struct{}) {
	fake.setIntercept(func(_ http.ResponseWriter, r *http.Request) bool {
		if r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/v3.1/connected_accounts/") {
			select {
			case started <- struct{}{}:
			default:
			}
			select {
			case <-release:
			case <-r.Context().Done():
			}
		}
		return false
	})
}

func startConnectionScheduler(t *testing.T, pool *pgxpool.Pool, fake *fakeComposio, provider *countedConnectionGmail) func() {
	t.Helper()
	service := fake.externalSources(t, pool, provider)
	stopJobs := startExternalJobs(t, pool, service)
	// Tests insert Connections directly, so the repair sweep stands in for their creation job.
	if err := service.EnqueueDueConnectionReconciles(t.Context()); err != nil {
		t.Fatal(err)
	}
	return stopJobs
}
func TestExternalConnectionGmailConfirmedIdentityAndConcurrentChecks(t *testing.T) {
	allowParallelIntegrationTest(t)
	pool, err := pgxpool.New(t.Context(), newIntegrationDatabase(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	_, err = pool.Exec(t.Context(), `INSERT INTO external_connections(id,account_id,provider,upstream_connection_id,status,identity_label,remote_principal_key) VALUES('gmail_checked','account_alice','gmail','upstream_checked','active','alice@example.test','gmail:alice@example.test')`)
	if err != nil {
		t.Fatal(err)
	}
	fake := newFakeComposio(t)
	fake.seedAccount(t, pool, "upstream_checked", "account_alice", "gmail", composio.ConnectionActive)
	started, release := make(chan struct{}, 4), make(chan struct{})
	blockStatusRequests(fake, started, release)
	provider := &countedConnectionGmail{fakeGmailProvider: &fakeGmailProvider{}}
	stop1 := startConnectionScheduler(t, pool, fake, provider)
	select {
	case <-started:
	case <-time.After(30 * time.Second):
		t.Fatal("status never started")
	}
	stop2 := startConnectionScheduler(t, pool, fake, provider)
	select {
	case <-started:
		t.Error("second replica issued concurrent status call")
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	if !waitForExternalSource(func() bool {
		var checked bool
		_ = pool.QueryRow(t.Context(), `SELECT status_checked_at IS NOT NULL FROM external_connections WHERE id='gmail_checked'`).Scan(&checked)
		return checked
	}) {
		t.Fatal("status check never persisted")
	}
	stop1()
	stop2()
	if provider.identities.Load() != 0 {
		t.Fatalf("confirmed identity triggered %d profile calls", provider.identities.Load())
	}
	if calls := fake.statusRequestCount("upstream_checked"); calls != 1 {
		t.Fatalf("status calls=%d", calls)
	}

	// Old active rows with a missing identity label still require profile recovery.
	if _, err = pool.Exec(t.Context(), `UPDATE external_connections SET identity_label=NULL,status_checked_at=NULL,next_status_check_at=now() WHERE id='gmail_checked'`); err != nil {
		t.Fatal(err)
	}
	stop := startConnectionScheduler(t, pool, fake, provider)
	if !waitForExternalSource(func() bool {
		var label string
		_ = pool.QueryRow(t.Context(), `SELECT coalesce(identity_label,'') FROM external_connections WHERE id='gmail_checked'`).Scan(&label)
		return label != ""
	}) {
		t.Fatal("missing identity was not repaired")
	}
	stop()
	if provider.identities.Load() != 1 {
		t.Fatalf("missing identity profile calls=%d", provider.identities.Load())
	}
}
func TestExternalConnectionGmailRateLimitSurvivesSchedulerRestart(t *testing.T) {
	allowParallelIntegrationTest(t)
	pool, err := pgxpool.New(t.Context(), newIntegrationDatabase(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	_, err = pool.Exec(t.Context(), `INSERT INTO external_connections(id,account_id,provider,upstream_connection_id,status) VALUES('gmail_retry','account_alice','gmail','upstream_retry','pending')`)
	if err != nil {
		t.Fatal(err)
	}
	fake := newFakeComposio(t)
	fake.seedAccount(t, pool, "upstream_retry", "account_alice", "gmail", composio.ConnectionActive)
	provider := &countedConnectionGmail{fakeGmailProvider: &fakeGmailProvider{identityErrs: map[string]error{"upstream_retry": &composio.RateLimitError{RetryAfter: time.Hour}}}}
	stop := startConnectionScheduler(t, pool, fake, provider)
	var next time.Time
	if !waitForExternalSource(func() bool {
		var code string
		_ = pool.QueryRow(t.Context(), `SELECT coalesce(status_error_code,''),next_status_check_at FROM external_connections WHERE id='gmail_retry'`).Scan(&code, &next)
		return code != ""
	}) {
		t.Fatal("rate limit not persisted")
	}
	stop()
	if time.Until(next) < 59*time.Minute {
		t.Fatalf("RetryAfter lost: next=%s", next)
	}
	// The reconcile job snoozes for the provider's Retry-After, so it does not
	// spend an attempt while the upstream is limited.
	var scheduledIn time.Duration
	var attempt int
	if err = pool.QueryRow(t.Context(), `SELECT extract(epoch FROM scheduled_at-now())::bigint*1000000000,attempt FROM river_job WHERE kind='external.connection_reconcile' AND args->>'connection_id'='gmail_retry' ORDER BY id DESC LIMIT 1`).Scan(&scheduledIn, &attempt); err != nil {
		t.Fatal(err)
	}
	if scheduledIn < 59*time.Minute || attempt != 0 {
		t.Fatalf("reconcile snooze scheduledIn=%s attempt=%d", scheduledIn, attempt)
	}
}
func makeExternalJobDue(t *testing.T, pool *pgxpool.Pool, kind, argKey, id string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		tag, err := pool.Exec(t.Context(), `UPDATE river_job SET state='available',scheduled_at=now(),finalized_at=NULL WHERE kind=$1 AND state IN ('scheduled','retryable','available') AND args->>$2=$3`, kind, argKey, id)
		if err != nil {
			t.Fatal(err)
		}
		if tag.RowsAffected() > 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	var state string
	var attempt int
	_ = pool.QueryRow(t.Context(), `SELECT state,attempt FROM river_job WHERE kind=$1 AND args->>$2=$3 ORDER BY id DESC LIMIT 1`, kind, argKey, id).Scan(&state, &attempt)
	t.Fatalf("%s job for %s never became due: state=%q attempt=%d", kind, id, state, attempt)
}

func TestExternalConnectionCheckCrashReservationAndRecovery(t *testing.T) {
	allowParallelIntegrationTest(t)
	pool, err := pgxpool.New(t.Context(), newIntegrationDatabase(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	_, err = pool.Exec(t.Context(), `INSERT INTO external_connections(id,account_id,provider,upstream_connection_id,status) VALUES('gmail_crash','account_alice','gmail','upstream_crash','pending')`)
	if err != nil {
		t.Fatal(err)
	}
	fake := newFakeComposio(t)
	fake.seedAccount(t, pool, "upstream_crash", "account_alice", "gmail", composio.ConnectionActive)
	started, release := make(chan struct{}, 4), make(chan struct{})
	blockStatusRequests(fake, started, release)
	provider := &countedConnectionGmail{fakeGmailProvider: &fakeGmailProvider{}}
	stop := startConnectionScheduler(t, pool, fake, provider)
	select {
	case <-started:
	case <-time.After(30 * time.Second):
		t.Fatal("status never started")
	}
	var terminated int
	if err = pool.QueryRow(t.Context(), `SELECT count(*) FROM (SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype='advisory' AND granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid=((hashtextextended('external-connection-check:upstream_crash',0)>>32)&4294967295)::oid AND objid=(hashtextextended('external-connection-check:upstream_crash',0)&4294967295)::oid) stopped`).Scan(&terminated); err != nil {
		t.Fatal(err)
	}
	if terminated != 1 {
		t.Fatalf("terminated %d check sessions", terminated)
	}
	// Release before stopping, or Stop waits its whole budget for the blocked
	// call; the released attempt still settles on a fresh connection.
	close(release)
	stop()
	// The interrupted attempt left its job retryable or running. A restarted worker
	// makes that job due and reruns the check from the durable Connection row.
	stop = startConnectionScheduler(t, pool, fake, provider)
	if !waitForExternalSource(func() bool {
		var active bool
		_ = pool.QueryRow(t.Context(), `SELECT status='active' FROM external_connections WHERE id='gmail_crash'`).Scan(&active)
		return active
	}) {
		var status, state string
		var attempt int
		_ = pool.QueryRow(t.Context(), `SELECT status FROM external_connections WHERE id='gmail_crash'`).Scan(&status)
		_ = pool.QueryRow(t.Context(), `SELECT state,attempt FROM river_job WHERE kind='external.connection_reconcile' AND args->>'connection_id'='gmail_crash' ORDER BY id DESC LIMIT 1`).Scan(&state, &attempt)
		t.Fatalf("check did not recover: connection=%q job=%q attempt=%d", status, state, attempt)
	}
	stop()
	if provider.identities.Load() != 1 {
		t.Fatalf("recovery identity=%d", provider.identities.Load())
	}
}

func TestExternalConnectionReconcileSweepSkipsRetryableJob(t *testing.T) {
	allowParallelIntegrationTest(t)
	pool, err := pgxpool.New(t.Context(), newIntegrationDatabase(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err = pool.Exec(t.Context(), `INSERT INTO external_connections(id,account_id,provider,upstream_connection_id,status,next_status_check_at) VALUES('gmail_retryable_unique','account_alice','gmail','upstream_retryable_unique','active',now())`); err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if err = jobs.InsertTx(t.Context(), tx, externalsource.ConnectionReconcileArgs{ConnectionID: "gmail_retryable_unique"}, nil); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	var jobID int64
	if err = pool.QueryRow(t.Context(), `SELECT id FROM river_job WHERE kind='external.connection_reconcile' AND args->>'connection_id'='gmail_retryable_unique'`).Scan(&jobID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(t.Context(), `UPDATE river_job SET state='retryable',scheduled_at=now()+interval '1 hour',attempt=5 WHERE id=$1`, jobID); err != nil {
		t.Fatal(err)
	}
	if err = newFakeComposio(t).externalSources(t, pool, nil).EnqueueDueConnectionReconciles(t.Context()); err != nil {
		t.Fatal(err)
	}
	var count int
	var gotID int64
	var gotAttempt int
	if err = pool.QueryRow(t.Context(), `SELECT count(*),max(id),max(attempt) FROM river_job WHERE kind='external.connection_reconcile' AND args->>'connection_id'='gmail_retryable_unique'`).Scan(&count, &gotID, &gotAttempt); err != nil {
		t.Fatal(err)
	}
	if count != 1 || gotID != jobID || gotAttempt != 5 {
		t.Fatalf("sweep inserted a new job: count=%d id=%d/%d attempt=%d", count, gotID, jobID, gotAttempt)
	}
}
