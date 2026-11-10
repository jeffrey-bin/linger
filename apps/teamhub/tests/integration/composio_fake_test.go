package integration_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
)

// Connected apps run only through managed Composio auth configs. Tests point
// TeamHub at fakeComposio, which serves the connected-account endpoints of one
// environment, while the injected app providers still answer identity and
// import calls.
const fakeComposioEnvironment = "test"

// fakeComposioAuthConfigs is the managed auth config of each app the tests
// connect, keyed by Composio toolkit.
var fakeComposioAuthConfigs = map[string]string{
	"gmail": "ac_gmail", "slack": "ac_slack", "discordbot": "ac_discordbot",
	"github": "ac_github", "googlecalendar": "ac_googlecalendar", "notion": "ac_notion", "googledrive": "ac_googledrive",
}

type fakeComposioAccount struct {
	userID, toolkit, authConfigID string
	status                        composio.ConnectionStatus
}

type fakeComposio struct {
	t              *testing.T
	server         *httptest.Server
	mu             sync.Mutex
	accounts       map[string]*fakeComposioAccount
	links          int
	revoked        []string
	statusRequests map[string]int
	// intercept may answer a request before the default handling.
	intercept func(http.ResponseWriter, *http.Request) bool
}

func newFakeComposio(t *testing.T) *fakeComposio {
	t.Helper()
	fake := &fakeComposio{t: t, accounts: map[string]*fakeComposioAccount{}, statusRequests: map[string]int{}}
	fake.server = httptest.NewServer(http.HandlerFunc(fake.serveHTTP))
	registerIntegrationServerCleanup(t, fake.server)
	return fake
}

func (f *fakeComposio) serveHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	intercept := f.intercept
	f.mu.Unlock()
	if intercept != nil && intercept(w, r) {
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	accountID := strings.TrimPrefix(r.URL.Path, "/api/v3.1/connected_accounts/")
	switch {
	case r.URL.Path == "/api/v3.1/auth_configs" && r.Method == http.MethodGet:
		// Each app's managed auth config already exists under its stable name.
		toolkit := r.URL.Query().Get("toolkit_slug")
		items := []any{}
		if id := fakeComposioAuthConfigs[toolkit]; id != "" {
			items = append(items, map[string]any{
				"id": id, "name": r.URL.Query().Get("search"), "auth_scheme": "OAUTH2",
				"is_composio_managed": true, "status": "ENABLED", "toolkit": map[string]any{"slug": toolkit},
			})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"items": items, "next_cursor": ""})
	case r.URL.Path == "/api/v3.1/connected_accounts/link" && r.Method == http.MethodPost:
		var input struct {
			AuthConfigID string `json:"auth_config_id"`
			UserID       string `json:"user_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		f.links++
		id := fmt.Sprintf("ca_link_%d", f.links)
		// The account is authorized as soon as the link exists.
		f.accounts[id] = &fakeComposioAccount{userID: input.UserID, toolkit: fakeComposioToolkit(input.AuthConfigID), authConfigID: input.AuthConfigID, status: composio.ConnectionActive}
		_ = json.NewEncoder(w).Encode(map[string]any{"connected_account_id": id, "redirect_url": "https://connect.example.test/authorize", "expires_at": time.Now().Add(time.Hour).Format(time.RFC3339)})
	case accountID != r.URL.Path && r.Method == http.MethodDelete:
		f.revoked = append(f.revoked, accountID)
		if f.accounts[accountID] == nil {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		delete(f.accounts, accountID)
		_, _ = w.Write([]byte(`{"success":true}`))
	case accountID != r.URL.Path && r.Method == http.MethodGet:
		f.statusRequests[accountID]++
		account := f.accounts[accountID]
		if account == nil {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status": fakeComposioStatus(account.status), "user_id": account.userID,
			"toolkit": map[string]string{"slug": account.toolkit}, "auth_config": map[string]string{"id": account.authConfigID},
		})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func fakeComposioToolkit(authConfigID string) string {
	for toolkit, id := range fakeComposioAuthConfigs {
		if id == authConfigID {
			return toolkit
		}
	}
	return ""
}

func fakeComposioStatus(status composio.ConnectionStatus) string {
	switch status {
	case composio.ConnectionActive:
		return "ACTIVE"
	case composio.ConnectionPending:
		return "INITIATED"
	case composio.ConnectionExpired:
		return "EXPIRED"
	default:
		return "FAILED"
	}
}

// configure points an App at the fake.
func (f *fakeComposio) configure(cfg *config.Config) {
	cfg.ExternalApps.ComposioAPIKey, cfg.ExternalApps.ComposioBaseURL = "test-key", f.server.URL
	cfg.ExternalApps.ComposioEnvironmentKey = fakeComposioEnvironment
}

// externalSources returns a managed service whose Gmail identity and imports
// use provider.
func (f *fakeComposio) externalSources(t *testing.T, pool *pgxpool.Pool, provider externalsource.Provider) *externalsource.Service {
	t.Helper()
	client, err := composio.New(composio.Config{BaseURL: f.server.URL, APIKey: "test-key", EnvironmentKey: fakeComposioEnvironment, HTTPClient: f.server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	service := externalsource.New(pool, provider)
	if err := service.ConfigureManagedApps(t.Context(), client, nil); err != nil {
		t.Fatal(err)
	}
	return service
}

// seedAccount records upstreamID as accountID's connected account for toolkit,
// as a connect link would, for a connection a test inserts directly.
func (f *fakeComposio) seedAccount(t *testing.T, pool *pgxpool.Pool, upstreamID, accountID, toolkit string, status composio.ConnectionStatus) {
	t.Helper()
	userID := "co_workspace:" + fakeComposioEnvironment + ":account:" + accountID
	if _, err := pool.Exec(t.Context(), `INSERT INTO external_connection_upstreams(upstream_id,account_id,user_id,toolkit_slug,auth_config_id) VALUES($1,$2,$3,$4,$5)`,
		upstreamID, accountID, userID, toolkit, fakeComposioAuthConfigs[toolkit]); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.accounts[upstreamID] = &fakeComposioAccount{userID: userID, toolkit: toolkit, authConfigID: fakeComposioAuthConfigs[toolkit], status: status}
}

func (f *fakeComposio) setStatus(upstreamID string, status composio.ConnectionStatus) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.accounts[upstreamID].status = status
}

func (f *fakeComposio) setIntercept(intercept func(http.ResponseWriter, *http.Request) bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.intercept = intercept
}

func (f *fakeComposio) revokedAccounts() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.revoked...)
}

func (f *fakeComposio) statusRequestCount(upstreamID string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.statusRequests[upstreamID]
}

// completeAuthorizations stands in for the OAuth popup returning to TeamHub:
// it makes the session account's pending authorizations due at once.
func completeAuthorizations(t *testing.T, env *testEnv, session *http.Client) {
	t.Helper()
	if status, _, body := env.request(session, http.MethodPost, "/v0/external-connection-completions", map[string]any{}, ""); status != http.StatusNoContent {
		t.Fatalf("complete authorizations status=%d body=%s", status, body)
	}
}
