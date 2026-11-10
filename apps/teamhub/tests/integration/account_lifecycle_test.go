package integration_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/account"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
)

func newAccountLifecycleEnv(t *testing.T) *testEnv {
	t.Helper()
	settings := config.ForTest(func(c *config.Config) {
		c.DatabaseURL = newIntegrationDatabase(t)
		c.ArtifactStorageRoot = integrationArtifactRoot(t)
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
	})
	application, err := newIntegrationApp(context.Background(), settings)
	if err != nil {
		t.Fatalf("new app: %v", err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	pool, err := pgxpool.New(context.Background(), settings.DatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return &testEnv{t: t, databaseURL: settings.DatabaseURL, pool: pool, server: server}
}

func TestOwnerAccountLifecycle(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newAccountLifecycleEnv(t)
	ctx := context.Background()

	created, err := account.CreateOwner(ctx, env.pool, " New.Member@Example.com ", "correct-horse-battery")
	if err != nil || !created {
		t.Fatalf("create owner created=%t err=%v", created, err)
	}
	created, err = account.CreateOwner(ctx, env.pool, "new.member@example.com", "other-password")
	if err != nil || created {
		t.Fatalf("repeated create owner created=%t err=%v", created, err)
	}
	// The owner has no Another Me until their Computer comes online.
	var anotherMes int
	if err := env.pool.QueryRow(ctx, `
		select count(*)
		from agent_registrations registration
		join actors human on human.id=registration.represented_human_actor_id
		join accounts account on account.id=human.account_id
		where lower(account.email)=lower($1)
	`, "new.member@example.com").Scan(&anotherMes); err != nil {
		t.Fatal(err)
	}
	if anotherMes != 0 {
		t.Fatalf("Another Mes before a Computer=%d want=0", anotherMes)
	}

	client := newClient(t)
	status, headers, body := env.request(client, http.MethodPost, "/v0/auth/login", map[string]any{
		"identifier": "new.member@example.com", "password": "correct-horse-battery",
	}, "")
	if status != http.StatusOK {
		t.Fatalf("owner login status=%d body=%s", status, body)
	}
	assertCookieSecurity(t, headers)
	status, _, body = env.request(client, http.MethodGet, "/v0/me", nil, "")
	if status != http.StatusOK || !containsJSONText(body, "new.member@example.com") || !containsJSONText(body, `"display_name":"new.member"`) {
		t.Fatalf("owner identity status=%d body=%s", status, body)
	}
	status, _, body = env.request(client, http.MethodGet, "/v0/tenants", nil, "")
	if status != http.StatusOK || !containsJSONText(body, "new.member's Workspace") {
		t.Fatalf("owner Tenant status=%d body=%s", status, body)
	}
	secondDevice := newClient(t)
	status, _, body = env.request(secondDevice, http.MethodPost, "/v0/auth/login", map[string]any{
		"identifier": "new.member@example.com", "password": "correct-horse-battery",
	}, "")
	if status != http.StatusOK {
		t.Fatalf("second-device login=%d %s", status, body)
	}

	if err := account.SetPassword(ctx, env.pool, "missing@example.com", "new-correct-horse-battery"); !errors.Is(err, account.ErrAccountNotFound) {
		t.Fatalf("set password for missing Account err=%v", err)
	}
	if err := account.SetPassword(ctx, env.pool, "new.member@example.com", "new-correct-horse-battery"); err != nil {
		t.Fatal(err)
	}
	for _, device := range []*http.Client{client, secondDevice} {
		status, _, body = env.request(device, http.MethodPost, "/v0/session", nil, "")
		if status != http.StatusUnauthorized {
			t.Fatalf("renewal after set-password=%d %s", status, body)
		}
	}
	status, _, _ = env.request(newClient(t), http.MethodPost, "/v0/auth/login", map[string]any{
		"identifier": "new.member@example.com", "password": "correct-horse-battery",
	}, "")
	if status != http.StatusUnauthorized {
		t.Fatalf("old password login status=%d want=401", status)
	}
	status, _, body = env.request(newClient(t), http.MethodPost, "/v0/auth/login", map[string]any{
		"identifier": "new.member@example.com", "password": "new-correct-horse-battery",
	}, "")
	if status != http.StatusOK {
		t.Fatalf("new password login status=%d body=%s", status, body)
	}
}

// TestDeploymentOwnerRefusesAnotherAccount checks create-owner on a database
// that already has its Account: the same email is a no-op that keeps the
// password, and another email is refused.
func TestDeploymentOwnerRefusesAnotherAccount(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newAccountLifecycleEnv(t)
	ctx := context.Background()
	if created, err := account.CreateDeploymentOwner(ctx, env.pool, "ALICE@example.com", "replacement-password"); err != nil || created {
		t.Fatalf("same-email create-owner created=%t err=%v", created, err)
	}
	var existing *account.ExistingAccountError
	created, err := account.CreateDeploymentOwner(ctx, env.pool, "second.owner@example.com", "correct-horse-battery")
	if created || !errors.As(err, &existing) || existing.Email != "alice@example.com" {
		t.Fatalf("another Account created=%t err=%v", created, err)
	}
	if got := countRows(t, env, `select count(*) from accounts where email='second.owner@example.com'`); got != 0 {
		t.Fatalf("refused Account rows=%d", got)
	}
	if _, err := account.CreateDeploymentOwner(ctx, env.pool, strings.Repeat("a", 101)+"@example.com", "correct-horse-battery"); !errors.Is(err, account.ErrInvalidOwner) {
		t.Fatalf("long local part err=%v", err)
	}
	env.login("alice", alicePassword)
}
