package integration_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
)

func TestIndependentAccountSessions(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newPersistentSessionEnv(t)
	first := env.login("alice", alicePassword)
	savedCookie := sessionCookie(t, first, env.server.URL)
	second := env.login("alice", alicePassword)
	for _, client := range []*http.Client{first, second} {
		status, _, body := env.request(client, http.MethodGet, "/v0/session", nil, "")
		if status != http.StatusOK {
			t.Fatalf("independent Session status=%d body=%s", status, body)
		}
	}
	status, _, body := env.request(first, http.MethodPost, "/v0/auth/logout", nil, "")
	if status != http.StatusNoContent {
		t.Fatalf("logout=%d %s", status, body)
	}
	// Replay the old cookie: clearing a browser cookie alone is not revocation.
	target, _ := url.Parse(env.server.URL)
	first.Jar.SetCookies(target, []*http.Cookie{savedCookie})
	status, _, body = env.request(first, http.MethodPost, "/v0/session", nil, "")
	if status != http.StatusUnauthorized {
		t.Fatalf("logged-out renewal=%d %s", status, body)
	}
	status, _, body = env.request(second, http.MethodPost, "/v0/session", nil, "")
	if status != http.StatusOK {
		t.Fatalf("other device renewal=%d %s", status, body)
	}
}

func TestConcurrentLoginsKeepBothAccountSessions(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newPersistentSessionEnv(t)
	clients := []*http.Client{newClient(t), newClient(t)}
	start := make(chan struct{})
	results := make(chan concurrentLoginResult, len(clients))
	var wait sync.WaitGroup
	for _, client := range clients {
		wait.Add(1)
		go func(client *http.Client) {
			defer wait.Done()
			<-start
			results <- sendConcurrentLogin(client, env.server.URL)
		}(client)
	}
	close(start)
	waitWithin(t, &wait, 30*time.Second)
	close(results)
	for result := range results {
		if result.err != nil {
			t.Fatal(result.err)
		}
		if result.status != http.StatusOK {
			t.Fatalf("concurrent login=%d %s", result.status, result.body)
		}
	}
	for _, client := range clients {
		status, _, body := env.request(client, http.MethodGet, "/v0/session", nil, "")
		if status != http.StatusOK {
			t.Fatalf("concurrent Session=%d %s", status, body)
		}
	}
}

func TestSessionRenewalPreservesEventsStreamAcrossOldExpiry(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newPersistentSessionEnvWithConfig(t, config.ForTest(func(c *config.Config) {
		c.SSEHeartbeatInterval = 20 * time.Millisecond
	}))
	first := env.login("alice", alicePassword)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := env.createRoom(first, acmeTenant, "Persistent Session "+suffix, "persistent-session-room-"+suffix)
	oldExpiry := time.Now().Add(time.Second)
	if _, err := env.pool.Exec(t.Context(), "update auth_sessions set expires_at=$1 where account_id=$2", oldExpiry, "account_alice"); err != nil {
		t.Fatal(err)
	}
	after := currentEventWatermark(t, env, first, "/v0/rooms/"+roomID+"/events", "latest_room_seq")
	response := openSSE(t, first, eventsStreamURL(env.server.URL, roomID, after), 5*time.Second)
	defer response.Body.Close()
	reader := bufio.NewReader(response.Body)
	if connected := readSSERecord(t, reader); connected.Data != ": connected" {
		t.Fatalf("first record=%+v", connected)
	}
	status, _, body := env.request(first, http.MethodPost, "/v0/session", nil, "")
	if status != http.StatusOK {
		t.Fatalf("renewal=%d %s", status, body)
	}
	second := env.login("alice", alicePassword)
	for time.Now().Before(oldExpiry.Add(100 * time.Millisecond)) {
		if record := readSSERecord(t, reader); record.Event == "session.expired" {
			t.Fatalf("renewed Session expired: %+v", record)
		}
	}
	env.createMessage(second, roomID, "both devices stay connected", "persistent-session-message-"+suffix)
	for {
		record := readSSERecord(t, reader)
		if record.Event == "session.expired" {
			t.Fatalf("second login invalidated first: %+v", record)
		}
		if record.Event == "room.event" {
			break
		}
	}
}

func TestSessionRenewalLifetimeAndReadOnlyPolling(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newPersistentSessionEnv(t)
	client := env.login("alice", alicePassword)
	var id string
	if err := env.pool.QueryRow(t.Context(), "select id from auth_sessions where account_id=$1 and revoked_at is null", "account_alice").Scan(&id); err != nil {
		t.Fatal(err)
	}
	setLifetime := func(created, expiry time.Time) {
		t.Helper()
		if _, err := env.pool.Exec(t.Context(), "update auth_sessions set created_at=$2,expires_at=$3 where id=$1", id, created, expiry); err != nil {
			t.Fatal(err)
		}
	}
	expiry := func() time.Time {
		t.Helper()
		var value time.Time
		if err := env.pool.QueryRow(t.Context(), "select expires_at from auth_sessions where id=$1", id).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	// Simulate returning after the old 24-hour limit, with a still-valid persistent cookie.
	setLifetime(time.Now().Add(-25*time.Hour), time.Now().Add(5*time.Minute))
	before := expiry()
	status, headers, body := env.request(client, http.MethodGet, "/v0/session", nil, "")
	if status != http.StatusOK || !expiry().Equal(before) || headers.Get("Set-Cookie") != "" {
		t.Fatalf("GET extended Session: %d %s", status, body)
	}
	status, headers, body = env.request(client, http.MethodPost, "/v0/session", nil, "")
	if status != http.StatusOK || expiry().Before(time.Now().Add(29*24*time.Hour)) {
		t.Fatalf("renewal failed: %d %s", status, body)
	}
	if !strings.Contains(headers.Get("Set-Cookie"), "HttpOnly") || !strings.Contains(headers.Get("Set-Cookie"), "SameSite=Lax") {
		t.Fatalf("missing protected persistent cookie")
	}
	before = expiry()
	status, _, body = env.request(client, http.MethodPost, "/v0/session", nil, "")
	if status != http.StatusOK || !expiry().Equal(before) {
		t.Fatalf("renewal was not throttled: %d %s", status, body)
	}
	created := time.Now().Add(-89 * 24 * time.Hour).Truncate(time.Microsecond)
	setLifetime(created, time.Now().Add(time.Hour))
	status, _, body = env.request(client, http.MethodPost, "/v0/session", nil, "")
	if status != http.StatusOK || !expiry().Equal(created.Add(90*24*time.Hour)) {
		t.Fatalf("absolute cap not enforced: %d %s expiry=%s", status, body, expiry())
	}
	for _, age := range []time.Duration{31 * 24 * time.Hour, 91 * 24 * time.Hour} {
		setLifetime(time.Now().Add(-age), time.Now().Add(-time.Minute))
		status, _, body = env.request(client, http.MethodPost, "/v0/session", nil, "")
		if status != http.StatusUnauthorized {
			t.Fatalf("expired Session revived: %d %s", status, body)
		}
	}
}

// Hold a real row lock until the renewal is waiting behind revocation. This proves
// that a request admitted before logout cannot resurrect the Session afterward.
func TestSessionRenewalCannotRaceRevocation(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newPersistentSessionEnv(t)
	client := env.login("alice", alicePassword)
	if _, err := env.pool.Exec(t.Context(), "update auth_sessions set expires_at=now()+interval '1 hour' where account_id='account_alice'"); err != nil {
		t.Fatal(err)
	}
	tx, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	if _, err := tx.Exec(t.Context(), "update auth_sessions set revoked_at=now(),revoked_reason='logout' where account_id='account_alice'"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	result := make(chan concurrentLoginResult, 1)
	go func() {
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, env.server.URL+"/v0/session", nil)
		if err != nil {
			result <- concurrentLoginResult{err: err}
			return
		}
		response, err := client.Do(request)
		if err != nil {
			result <- concurrentLoginResult{err: err}
			return
		}
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		result <- concurrentLoginResult{status: response.StatusCode, body: body, err: err}
	}()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		var waiting bool
		err := env.pool.QueryRow(ctx, `select exists(select 1 from pg_stat_activity where datname=current_database()
   and wait_event_type='Lock' and query like '%-- name: RenewSession :one%')`).Scan(&waiting)
		if err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case early := <-result:
			t.Fatalf("renewal did not wait behind revocation: %+v", early)
		case <-ctx.Done():
			t.Fatal("renewal never reached the locked row")
		case <-ticker.C:
		}
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	outcome := <-result
	if outcome.err != nil || outcome.status != http.StatusUnauthorized {
		t.Fatalf("revoked Session renewed: %+v", outcome)
	}
}

func newPersistentSessionEnv(t *testing.T) *testEnv {
	return newPersistentSessionEnvWithConfig(t, config.ForTest())
}

func newPersistentSessionEnvWithConfig(t *testing.T, settings config.Config, options ...appOption) *testEnv {
	t.Helper()
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	settings.DatabaseURL = databaseURL
	settings.ArtifactStorageRoot = integrationArtifactRoot(t)
	settings.SessionTTL = 30 * 24 * time.Hour
	settings.CookieName = "teamhub_session"
	settings.CookieSecure = false
	application, err := newIntegrationApp(context.Background(), settings, options...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	return &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
}

func currentEventWatermark(t *testing.T, env *testEnv, client *http.Client, path, field string) int64 {
	t.Helper()
	status, _, body := env.request(client, http.MethodGet, path, nil, "")
	if status != http.StatusOK {
		t.Fatalf("event watermark %s status=%d body=%s", path, status, body)
	}
	page := map[string]json.RawMessage{}
	if err := json.Unmarshal(body, &page); err != nil {
		t.Fatalf("decode event watermark %s: %v", body, err)
	}
	var watermark int64
	if err := json.Unmarshal(page[field], &watermark); err != nil {
		t.Fatalf("decode %s from %s: %v", field, body, err)
	}
	return watermark
}

type concurrentLoginResult struct {
	status int
	body   []byte
	err    error
}

func sendConcurrentLogin(client *http.Client, serverURL string) concurrentLoginResult {
	payload, err := json.Marshal(map[string]any{
		"identifier": "alice@example.com",
		"password":   alicePassword,
	})
	if err != nil {
		return concurrentLoginResult{err: err}
	}
	request, err := http.NewRequest(http.MethodPost, serverURL+"/v0/auth/login", bytes.NewReader(payload))
	if err != nil {
		return concurrentLoginResult{err: err}
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return concurrentLoginResult{err: err}
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	return concurrentLoginResult{status: response.StatusCode, body: body, err: err}
}
