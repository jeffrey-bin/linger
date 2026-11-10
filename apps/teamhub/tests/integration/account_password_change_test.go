package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/account"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
)

func passwordChangeRequest(current, next string) map[string]any {
	return map[string]any{"current_password": current, "new_password": next}
}

func TestAccountPasswordChange(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newPersistentSessionEnv(t)
	current := env.login("alice", alicePassword)
	other := env.login("alice", alicePassword)
	var expires time.Time
	if err := env.pool.QueryRow(t.Context(), "select expires_at from auth_sessions where account_id='account_alice' order by created_at limit 1").Scan(&expires); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name    string
		client  *http.Client
		payload map[string]any
		want    int
		code    string
	}{
		{"unauthenticated", newClient(t), passwordChangeRequest(alicePassword, "replacement-password"), 401, "UNAUTHENTICATED"},
		{"wrong current", current, passwordChangeRequest("wrong-password", "replacement-password"), 400, "INVALID_CURRENT_PASSWORD"},
		{"short new", current, passwordChangeRequest(alicePassword, "short"), 400, "INVALID_REQUEST"},
		{"missing current", current, map[string]any{"new_password": "replacement-password"}, 400, "INVALID_REQUEST"},
		{"foreign account selector", current, map[string]any{"current_password": alicePassword, "new_password": "replacement-password", "account_id": "account_other"}, 400, "INVALID_REQUEST"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status, _, body := env.request(tc.client, http.MethodPost, "/v0/account/password", tc.payload, "")
			if tc.name == "short new" && !containsJSONText(body, "Password must be between 8 and 1024 bytes") {
				t.Fatalf("missing password policy: %s", body)
			}
			if status != tc.want || !containsJSONText(body, tc.code) {
				t.Fatalf("status=%d body=%s", status, body)
			}
		})
	}
	status, headers, body := env.request(current, http.MethodPost, "/v0/account/password", passwordChangeRequest(alicePassword, "replacement-password"), "")
	if status != 204 || len(body) != 0 || len(headers.Values("Set-Cookie")) != 0 {
		t.Fatalf("change=%d headers=%v body=%s", status, headers, body)
	}
	var remaining int
	var actual time.Time
	if err := env.pool.QueryRow(t.Context(), "select count(*),min(expires_at) from auth_sessions where account_id='account_alice' and revoked_at is null").Scan(&remaining, &actual); err != nil {
		t.Fatal(err)
	}
	if remaining != 1 || !actual.Equal(expires) {
		t.Fatalf("sessions=%d expiry=%s want=%s", remaining, actual, expires)
	}
	for _, tc := range []struct {
		client *http.Client
		want   int
	}{{current, 200}, {other, 401}} {
		status, _, body := env.request(tc.client, http.MethodGet, "/v0/session", nil, "")
		if status != tc.want {
			t.Fatalf("session=%d want=%d body=%s", status, tc.want, body)
		}
	}
	status, _, body = env.request(newClient(t), http.MethodPost, "/v0/auth/login", map[string]any{"identifier": "alice@example.com", "password": alicePassword}, "")
	if status != 401 {
		t.Fatalf("old password login=%d %s", status, body)
	}
	env.login("alice", "replacement-password")
	status, _, body = env.request(current, http.MethodPost, "/v0/account/password", passwordChangeRequest(alicePassword, "replacement-password"), "")
	if status != 400 || !containsJSONText(body, "INVALID_CURRENT_PASSWORD") {
		t.Fatalf("retry=%d %s", status, body)
	}
}

func TestAccountPasswordChangeRateLimitSurvivesRestart(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newPersistentSessionEnv(t)
	current := env.login("alice", alicePassword)
	other := env.login("alice", alicePassword)
	for i := 0; i < 5; i++ {
		status, _, body := env.request(current, http.MethodPost, "/v0/account/password", passwordChangeRequest("incorrect", "replacement-password"), "")
		if status != 400 || !containsJSONText(body, "INVALID_CURRENT_PASSWORD") {
			t.Fatalf("attempt %d=%d %s", i, status, body)
		}
	}
	status, headers, body := env.request(other, http.MethodPost, "/v0/account/password", passwordChangeRequest(alicePassword, "replacement-password"), "")
	if status != 429 || headers.Get("Retry-After") == "" || !containsJSONText(body, "RATE_LIMITED") {
		t.Fatalf("limited=%d %v %s", status, headers, body)
	}
	// Reconstruct the service to prove the bucket is not process-local state.
	service := account.NewLifecycle(env.pool)
	var sessionID string
	if err := env.pool.QueryRow(t.Context(), "select id from auth_sessions where account_id='account_alice' order by created_at limit 1").Scan(&sessionID); err != nil {
		t.Fatal(err)
	}
	err := service.ChangePassword(t.Context(), account.PasswordChange{AccountID: "account_alice", SessionID: sessionID, CurrentPassword: alicePassword, NewPassword: "replacement-password"})
	var limited *account.RateLimitError
	if !errors.As(err, &limited) {
		t.Fatalf("restarted service=%v", err)
	}
	env.login("alice", alicePassword)
	if _, err := env.pool.Exec(t.Context(), "update accounts set password_change_window_started_at=clock_timestamp()-interval '11 minutes' where id='account_alice'"); err != nil {
		t.Fatal(err)
	}
	status, _, body = env.request(other, http.MethodPost, "/v0/account/password", passwordChangeRequest(alicePassword, "replacement-password"), "")
	if status != 204 {
		t.Fatalf("window recovery=%d %s", status, body)
	}
}

func TestAccountPasswordChangeAtomicRollback(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newPersistentSessionEnv(t)
	current := env.login("alice", alicePassword)
	other := env.login("alice", alicePassword)
	// A real database failure after hash replacement must roll back both writes.
	if _, err := env.pool.Exec(t.Context(), `create function reject_test_password_revocation() returns trigger language plpgsql as $$
 begin raise exception 'injected revocation failure'; end $$;
 create trigger reject_test_password_revocation before update on auth_sessions
 for each row when (new.revoked_reason='password_reset') execute function reject_test_password_revocation()`); err != nil {
		t.Fatal(err)
	}
	status, _, body := env.request(current, http.MethodPost, "/v0/account/password", passwordChangeRequest(alicePassword, "replacement-password"), "")
	if status != 500 {
		t.Fatalf("injected failure=%d %s", status, body)
	}
	for _, client := range []*http.Client{current, other} {
		status, _, body := env.request(client, http.MethodGet, "/v0/session", nil, "")
		if status != 200 {
			t.Fatalf("session after rollback=%d %s", status, body)
		}
	}
	env.login("alice", alicePassword)
	if _, err := env.pool.Exec(t.Context(), "drop trigger reject_test_password_revocation on auth_sessions; drop function reject_test_password_revocation()"); err != nil {
		t.Fatal(err)
	}
	status, _, body = env.request(current, http.MethodPost, "/v0/account/password", passwordChangeRequest(alicePassword, "replacement-password"), "")
	if status != 204 {
		t.Fatalf("recovery after rollback=%d %s", status, body)
	}
}

func startPasswordHTTP(ctx context.Context, client *http.Client, serverURL, endpoint string, payload map[string]any) <-chan concurrentLoginResult {
	results := make(chan concurrentLoginResult, 1)
	go func() {
		encoded, err := json.Marshal(payload)
		if err != nil {
			results <- concurrentLoginResult{err: err}
			return
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, serverURL+endpoint, bytes.NewReader(encoded))
		if err != nil {
			results <- concurrentLoginResult{err: err}
			return
		}
		request.Header.Set("Content-Type", "application/json")
		response, err := client.Do(request)
		if err != nil {
			results <- concurrentLoginResult{err: err}
			return
		}
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		results <- concurrentLoginResult{status: response.StatusCode, body: body, err: err}
	}()
	return results
}

func waitForPasswordLock(t *testing.T, env *testEnv, ctx context.Context, fragment string) {
	t.Helper()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		var waiting bool
		if err := env.pool.QueryRow(ctx, `select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and position($1 in query)>0)`, fragment).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal("request did not wait for database lock")
		case <-ticker.C:
		}
	}
}

func TestAccountPasswordChangeRechecksSessionAfterLock(t *testing.T) {
	allowParallelIntegrationTest(t)
	for _, mode := range []string{"logout", "expiry"} {
		t.Run(mode, func(t *testing.T) {
			env := newPersistentSessionEnv(t)
			current := env.login("alice", alicePassword)
			if mode == "expiry" {
				if _, err := env.pool.Exec(t.Context(), "update auth_sessions set expires_at=clock_timestamp()+interval '500 milliseconds' where account_id='account_alice'"); err != nil {
					t.Fatal(err)
				}
			}
			tx, err := env.pool.Begin(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(t.Context())
			if _, err := tx.Exec(t.Context(), "select id from accounts where id='account_alice' for update"); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
			defer cancel()
			result := startPasswordHTTP(ctx, current, env.server.URL, "/v0/account/password", passwordChangeRequest(alicePassword, "replacement-password"))
			waitForPasswordLock(t, env, ctx, "password_change_attempts from accounts")
			switch mode {
			case "logout":
				_, err = tx.Exec(ctx, "update auth_sessions set revoked_at=clock_timestamp(),revoked_reason='logout' where account_id='account_alice'")
			case "expiry":
				_, err = tx.Exec(ctx, "select pg_sleep(greatest(0,extract(epoch from expires_at-clock_timestamp()))+0.02) from auth_sessions where account_id='account_alice'")
			}
			if err != nil {
				t.Fatal(err)
			}
			if err := tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			outcome := <-result
			if outcome.err != nil || outcome.status != 401 {
				t.Fatalf("stale session=%+v", outcome)
			}
			env.login("alice", alicePassword)
		})
	}
}

func TestAccountPasswordChangeCompetingSessionsAndLogin(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newPersistentSessionEnv(t)
	first := env.login("alice", alicePassword)
	second := env.login("alice", alicePassword)
	tx, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	// Pause the first writer only after ChangePassword owns the Account and
	// Session locks. A waiter behind a fixture-held Account lock does not prove
	// which competing HTTP request will acquire authority first.
	if _, err := tx.Exec(t.Context(), "select pg_advisory_xact_lock(725982)"); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `create function pause_test_password_change() returns trigger language plpgsql as $$
 begin perform pg_advisory_xact_lock(725982); return new; end $$;
 create trigger pause_test_password_change before update of password_hash on accounts
 for each row execute function pause_test_password_change()`); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	change := startPasswordHTTP(ctx, first, env.server.URL, "/v0/account/password", passwordChangeRequest(alicePassword, "first-password"))
	waitForPasswordLock(t, env, ctx, "update accounts set password_hash=$2 where id=$1")
	// The login verifies the old password without a lock, then waits on the
	// Account row to recheck the hash it verified.
	login := startPasswordHTTP(ctx, newClient(t), env.server.URL, "/v0/auth/login", map[string]any{"identifier": "alice@example.com", "password": alicePassword})
	waitForPasswordLock(t, env, ctx, "-- name: LockAccountPasswordHash")
	other := startPasswordHTTP(ctx, second, env.server.URL, "/v0/account/password", passwordChangeRequest(alicePassword, "second-password"))
	waitForPasswordLock(t, env, ctx, "password_change_attempts from accounts")
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	outcome := <-change
	if outcome.err != nil || outcome.status != 204 {
		t.Fatalf("first change=%+v", outcome)
	}
	outcome = <-other
	if outcome.err != nil || outcome.status != 401 {
		t.Fatalf("competing change=%+v", outcome)
	}
	outcome = <-login
	if outcome.err != nil || outcome.status != 401 {
		t.Fatalf("competing old-password login=%+v", outcome)
	}
	for _, session := range []struct {
		client *http.Client
		want   int
	}{{first, 200}, {second, 401}} {
		status, _, body := env.request(session.client, http.MethodGet, "/v0/session", nil, "")
		if status != session.want {
			t.Fatalf("session after competing changes=%d want=%d body=%s", status, session.want, body)
		}
	}
	env.login("alice", "first-password")
}

func TestAccountPasswordChangeCompetesWithSetPassword(t *testing.T) {
	allowParallelIntegrationTest(t)
	for _, first := range []string{"change", "set-password"} {
		t.Run(first, func(t *testing.T) {
			env := newPersistentSessionEnv(t)
			current := env.login("alice", alicePassword)
			tx, err := env.pool.Begin(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(t.Context())
			if _, err := tx.Exec(t.Context(), "select id from accounts where id='account_alice' for update"); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			startChange := func() <-chan concurrentLoginResult {
				return startPasswordHTTP(ctx, current, env.server.URL, "/v0/account/password", passwordChangeRequest(alicePassword, "changed-password"))
			}
			startSetPassword := func() <-chan error {
				result := make(chan error, 1)
				go func() { result <- account.SetPassword(ctx, env.pool, "alice@example.com", "operator-password") }()
				return result
			}
			var change <-chan concurrentLoginResult
			var setPassword <-chan error
			if first == "change" {
				change = startChange()
				waitForPasswordLock(t, env, ctx, "password_change_attempts from accounts")
				setPassword = startSetPassword()
				waitForPasswordLock(t, env, ctx, "update accounts set password_hash=$2 where lower(email)")
			} else {
				setPassword = startSetPassword()
				waitForPasswordLock(t, env, ctx, "update accounts set password_hash=$2 where lower(email)")
				change = startChange()
				waitForPasswordLock(t, env, ctx, "password_change_attempts from accounts")
			}
			if err := tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			if err := <-setPassword; err != nil {
				t.Fatalf("set-password=%v", err)
			}
			expected := 204
			if first == "set-password" {
				expected = 401
			}
			outcome := <-change
			if outcome.err != nil || outcome.status != expected {
				t.Fatalf("change=%+v want=%d", outcome, expected)
			}
			status, _, body := env.request(current, http.MethodGet, "/v0/session", nil, "")
			if status != 401 {
				t.Fatalf("set-password must revoke even the changing Session: %d %s", status, body)
			}
			var active int
			if err := env.pool.QueryRow(ctx, "select count(*) from auth_sessions where account_id='account_alice' and revoked_at is null").Scan(&active); err != nil {
				t.Fatal(err)
			}
			if active != 0 {
				t.Fatalf("active after set-password=%d", active)
			}
			env.login("alice", "operator-password")
		})
	}
}

func TestAccountPasswordChangeRevokesEarlierLogin(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newPersistentSessionEnv(t)
	current := env.login("alice", alicePassword)
	tx, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	// Pause login after it owns the Account lock but before it creates its Session.
	if _, err := tx.Exec(t.Context(), "select pg_advisory_xact_lock(725981)"); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `create function pause_test_login() returns trigger language plpgsql as $$
 begin perform pg_advisory_xact_lock(725981); return new; end $$;
 create trigger pause_test_login before insert on auth_sessions for each row execute function pause_test_login()`); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	competing := newClient(t)
	login := startPasswordHTTP(ctx, competing, env.server.URL, "/v0/auth/login", map[string]any{"identifier": "alice@example.com", "password": alicePassword})
	waitForPasswordLock(t, env, ctx, "-- name: CreateSession")
	change := startPasswordHTTP(ctx, current, env.server.URL, "/v0/account/password", passwordChangeRequest(alicePassword, "changed-password"))
	waitForPasswordLock(t, env, ctx, "password_change_attempts from accounts")
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	outcome := <-login
	if outcome.err != nil || outcome.status != 200 {
		t.Fatalf("login first=%+v", outcome)
	}
	outcome = <-change
	if outcome.err != nil || outcome.status != 204 {
		t.Fatalf("change after login=%+v", outcome)
	}
	status, _, body := env.request(competing, http.MethodGet, "/v0/session", nil, "")
	if status != 401 {
		t.Fatalf("old credential created a surviving Session: %d %s", status, body)
	}
	env.login("alice", "changed-password")
}

// TestLoginHashesWithoutHoldingTheAccountRow checks that a login computing its
// password hash leaves the Account row unlocked, so a writer that locks the
// Account row does not wait for it.
func TestLoginHashesWithoutHoldingTheAccountRow(t *testing.T) {
	allowParallelIntegrationTest(t)
	hashing := make(chan struct{})
	finish := make(chan struct{})
	var started sync.Once
	env := newPersistentSessionEnvWithConfig(t, config.ForTest(), withPasswordVerifier(
		func(password, encoded string) (bool, error) {
			started.Do(func() { close(hashing) })
			<-finish
			return account.VerifyPassword(password, encoded)
		}))
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	login := startPasswordHTTP(ctx, newClient(t), env.server.URL, "/v0/auth/login",
		map[string]any{"identifier": "alice@example.com", "password": alicePassword})
	select {
	case <-hashing:
	case <-ctx.Done():
		t.Fatal("login did not reach its password check")
	}
	tx, err := env.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SET LOCAL lock_timeout='1s'`); err != nil {
		t.Fatal(err)
	}
	_, err = tx.Exec(ctx, `SELECT id FROM accounts WHERE id='account_alice' FOR UPDATE`)
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "55P03" {
		t.Fatal("a login hashing its password holds the Account row")
	}
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	close(finish)
	if outcome := <-login; outcome.err != nil || outcome.status != http.StatusOK {
		t.Fatalf("login=%+v", outcome)
	}
}

// TestLoginFailuresAreLimitedPerClientAddress checks the login throttle behind
// a trusted proxy: ten failures from one address return 429 with Retry-After
// for that address only, and a successful login clears its count.
func TestLoginFailuresAreLimitedPerClientAddress(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newPersistentSessionEnvWithConfig(t, config.ForTest(func(c *config.Config) {
		c.TrustedProxies = []string{"127.0.0.1/32", "::1/128"}
	}))
	login := func(address, password string) (int, http.Header) {
		t.Helper()
		payload, err := json.Marshal(map[string]any{"identifier": "alice@example.com", "password": password})
		if err != nil {
			t.Fatal(err)
		}
		request, err := http.NewRequestWithContext(t.Context(), http.MethodPost, env.server.URL+"/v0/auth/login", bytes.NewReader(payload))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Forwarded-For", address)
		response, err := newClient(t).Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		_, _ = io.Copy(io.Discard, response.Body)
		return response.StatusCode, response.Header
	}
	// Without the reset, the second round would reach the limit.
	for round := range 2 {
		for range 9 {
			if status, _ := login("198.51.100.7", "wrong-password"); status != http.StatusUnauthorized {
				t.Fatalf("round %d failed login status=%d want 401", round, status)
			}
		}
		if status, _ := login("198.51.100.7", alicePassword); status != http.StatusOK {
			t.Fatalf("round %d login under the limit status=%d", round, status)
		}
	}
	for range 10 {
		if status, _ := login("198.51.100.8", "wrong-password"); status != http.StatusUnauthorized {
			t.Fatalf("failed login status=%d want 401", status)
		}
	}
	if status, headers := login("198.51.100.8", alicePassword); status != http.StatusTooManyRequests || headers.Get("Retry-After") == "" {
		t.Fatalf("limited address status=%d Retry-After=%q", status, headers.Get("Retry-After"))
	}
	if status, _ := login("198.51.100.9", alicePassword); status != http.StatusOK {
		t.Fatalf("another address must not be limited, status=%d", status)
	}
}
