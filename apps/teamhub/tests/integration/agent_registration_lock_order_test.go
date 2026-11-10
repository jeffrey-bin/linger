package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func registrationLockPayload() map[string]any {
	return map[string]any{"name": "Concurrent Agent", "instructions": "Verify registration transaction boundaries.",
		"runtime": fixtureRuntime("gpt-5")}
}

// A storage failure inside the creation transaction leaves nothing behind,
// and the same request then creates the Agent once.
func TestAgentRegistrationStorageFailureRecovery(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newAgentRegistrationEnv(t, &recordingAgentManagement{})
	if _, err := env.pool.Exec(t.Context(), `CREATE FUNCTION reject_registration_storage() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'storage failure' USING ERRCODE='40P01'; END $$;
		CREATE TRIGGER storage_failure BEFORE INSERT ON agent_registrations FOR EACH ROW EXECUTE FUNCTION reject_registration_storage()`); err != nil {
		t.Fatal(err)
	}
	endpoint := "/v0/tenants/" + acmeTenant + "/agents"
	response, _, body := env.request(alice, http.MethodPost, endpoint, registrationLockPayload(), "storage-registration")
	if response != http.StatusInternalServerError || !containsJSONText(body, "INTERNAL_ERROR") {
		t.Fatalf("storage failure=%d body=%s", response, body)
	}
	if got := countRows(t, env, `SELECT count(*) FROM actors WHERE display_name=$1`, "Concurrent Agent"); got != 0 {
		t.Fatalf("Actors after storage failure=%d want=0", got)
	}
	if _, err := env.pool.Exec(t.Context(), `DROP TRIGGER storage_failure ON agent_registrations; DROP FUNCTION reject_registration_storage()`); err != nil {
		t.Fatal(err)
	}
	response, _, body = env.request(alice, http.MethodPost, endpoint, registrationLockPayload(), "storage-registration")
	if response != http.StatusCreated {
		t.Fatalf("recovery=%d body=%s", response, body)
	}
	if got := countRows(t, env, `SELECT count(*) FROM actors WHERE display_name=$1`, "Concurrent Agent"); got != 1 {
		t.Fatalf("Actors after recovery=%d want=1", got)
	}
}

// lockAgentRegistrations holds a table lock that blocks every registration
// insert until the returned transaction ends.
func lockAgentRegistrations(t *testing.T, env *testEnv) pgx.Tx {
	t.Helper()
	tx, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	if _, err := tx.Exec(t.Context(), `LOCK TABLE agent_registrations IN SHARE MODE`); err != nil {
		t.Fatal(err)
	}
	return tx
}

// waitForLockWaiter observes any backend blocked on a lock, regardless of
// whether a query or a business-write trigger requested it.
func waitForLockWaiter(t *testing.T, env *testEnv) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		var waiting bool
		if err := env.pool.QueryRow(t.Context(), `SELECT EXISTS (
		 SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
		 AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0
		)`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("timed out waiting for lock contention")
}

func TestAgentRegistrationCancellationRollsBackReservation(t *testing.T) {
	allowParallelIntegrationTest(t)
	management := &recordingAgentManagement{}
	env, alice := newAgentRegistrationEnv(t, management)
	tx := lockAgentRegistrations(t, env)
	payload, err := json.Marshal(registrationLockPayload())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, env.server.URL+"/v0/tenants/"+acmeTenant+"/agents", bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", "canceled-registration")
	done := make(chan error, 1)
	go func() {
		response, requestErr := alice.Do(req)
		if response != nil {
			_ = response.Body.Close()
		}
		done <- requestErr
	}()
	waitForLockWaiter(t, env)
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("request error=%v want canceled", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("request cancellation did not return")
	}
	// Keep the table locked until the canceled server transaction has released
	// its locks, so a client disconnect cannot race with an admitted reservation.
	deadline := time.Now().Add(30 * time.Second)
	for {
		var waiters int
		if err := env.pool.QueryRow(t.Context(), `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`).Scan(&waiters); err != nil {
			t.Fatal(err)
		}
		if waiters == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("canceled transaction still holds locks")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	if got := countRows(t, env, `SELECT count(*) FROM actors WHERE display_name=$1`, "Concurrent Agent"); got != 0 {
		t.Fatalf("canceled Actors=%d want=0", got)
	}
	if got := countRows(t, env, `SELECT count(*) FROM command_replays WHERE key=$1`, "canceled-registration"); got != 0 {
		t.Fatalf("canceled commands=%d want=0", got)
	}
	if len(management.notifiedSnapshot()) != 0 {
		t.Fatal("canceled registration called Agent Service")
	}
}
