package integration_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/secretbox"
)

type managedAuthConfig struct {
	id, toolkit, scheme string
	managed             bool
}

type managedAppsProvider struct {
	mu                            sync.Mutex
	configs                       map[string]managedAuthConfig
	createBodies                  []map[string]any
	links                         map[string]map[string]string
	creates                       int
	uncertainCreate, rejectCreate bool
	requiredKey                   string
}

func (p *managedAppsProvider) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p.mu.Lock()
	defer p.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	if p.requiredKey != "" && r.Header.Get("x-api-key") != p.requiredKey {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	switch {
	case r.URL.Path == "/api/v3.1/auth_configs" && r.Method == http.MethodGet:
		items := []map[string]any{{"id": "ac_foreign", "name": "foreign-environment", "auth_scheme": "OAUTH2", "is_composio_managed": true, "status": "ENABLED", "toolkit": map[string]string{"slug": "linear"}}}
		for name, config := range p.configs {
			items = append(items, map[string]any{"id": config.id, "name": name, "auth_scheme": config.scheme, "is_composio_managed": config.managed, "status": "ENABLED", "toolkit": map[string]string{"slug": config.toolkit}})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"items": items})
	case r.URL.Path == "/api/v3.1/auth_configs" && r.Method == http.MethodPost:
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		p.createBodies = append(p.createBodies, body)
		toolkit, _ := body["toolkit"].(map[string]any)["slug"].(string)
		input, _ := body["auth_config"].(map[string]any)
		name, _ := input["name"].(string)
		config := managedAuthConfig{toolkit: toolkit}
		switch input["type"] {
		case "use_composio_managed_auth":
			config.scheme, _ = input["auth_scheme"].(string)
			config.managed = true
		case "use_custom_auth":
			config.scheme, _ = input["authScheme"].(string)
		}
		if p.rejectCreate || config.scheme == "" || name == "" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		p.creates++
		config.id = fmt.Sprintf("ac_%d", p.creates)
		p.configs[name] = config
		if p.uncertainCreate {
			p.uncertainCreate = false
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"toolkit": map[string]string{"slug": toolkit}, "auth_config": map[string]any{"id": config.id, "auth_scheme": config.scheme, "is_composio_managed": config.managed}})
	case r.URL.Path == "/api/v3.1/connected_accounts/link":
		var input map[string]string
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		id := fmt.Sprintf("ca_%d", len(p.links)+1)
		p.links[id] = input
		_ = json.NewEncoder(w).Encode(map[string]any{"connected_account_id": id, "redirect_url": "https://connect.example/" + id, "expires_at": time.Now().Add(time.Hour).Format(time.RFC3339)})
	case strings.HasPrefix(r.URL.Path, "/api/v3.1/connected_accounts/"):
		input := p.links[strings.TrimPrefix(r.URL.Path, "/api/v3.1/connected_accounts/")]
		if input == nil {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ACTIVE", "user_id": input["user_id"], "toolkit": map[string]string{"slug": "linear"}, "auth_config": map[string]string{"id": input["auth_config_id"]}})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func managedAppsFixture(t *testing.T) (*pgxpool.Pool, *managedAppsProvider, *httptest.Server) {
	t.Helper()
	ctx := t.Context()
	pool, err := pgxpool.New(ctx, newIntegrationDatabase(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	provider := &managedAppsProvider{configs: map[string]managedAuthConfig{}, links: map[string]map[string]string{}}
	server := httptest.NewServer(provider)
	registerIntegrationServerCleanup(t, server)
	return pool, provider, server
}

func managedAppsService(t *testing.T, pool *pgxpool.Pool, server *httptest.Server) *externalsource.Service {
	t.Helper()
	client, err := composio.New(composio.Config{BaseURL: server.URL, APIKey: "test", EnvironmentKey: "ci", CallbackURL: "https://ci.example/oauth/composio-complete", HTTPClient: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	service := externalsource.New(pool, nil)
	if err = service.ConfigureManagedApps(t.Context(), client, nil); err != nil {
		t.Fatal(err)
	}
	return service
}

func TestManagedAppsConcurrentProvisioning(t *testing.T) {
	allowParallelIntegrationTest(t)
	pool, provider, server := managedAppsFixture(t)
	ci := managedAppsService(t, pool, server)
	second := managedAppsService(t, pool, server)
	var wg sync.WaitGroup
	results := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			service := ci
			if i%2 == 0 {
				service = second
			}
			_, err := service.CreateConnection(t.Context(), "account_alice", "linear")
			results <- err
		}(i)
	}
	wg.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatal(err)
		}
	}
	provider.mu.Lock()
	creates := provider.creates
	provider.mu.Unlock()
	if creates != 1 {
		t.Fatalf("concurrent replicas provisioned %d configs", creates)
	}
	connections, err := ci.ListConnections(t.Context(), "account_alice")
	if err != nil || len(connections) != 8 {
		t.Fatalf("connections=%d err=%v", len(connections), err)
	}
	provider.mu.Lock()
	defer provider.mu.Unlock()
	link := provider.links[connections[0].UpstreamConnectionID]
	if link["user_id"] != "linger:ci:account:account_alice" {
		t.Fatalf("upstream user %q", link["user_id"])
	}
	if link["auth_config_id"] == "ac_foreign" {
		t.Fatal("adopted an auth config of another name")
	}
}

func TestManagedAppsRecoversUnknownCreate(t *testing.T) {
	allowParallelIntegrationTest(t)
	pool, provider, server := managedAppsFixture(t)
	service := managedAppsService(t, pool, server)
	provider.mu.Lock()
	provider.uncertainCreate = true
	provider.mu.Unlock()
	if _, err := service.CreateConnection(t.Context(), "account_alice", "linear"); err == nil {
		t.Fatal("expected ambiguous provider failure")
	}
	restarted := managedAppsService(t, pool, server)
	connection, err := restarted.CreateConnection(t.Context(), "account_alice", "linear")
	if err != nil {
		t.Fatal(err)
	}
	provider.mu.Lock()
	creates := provider.creates
	provider.mu.Unlock()
	if creates != 1 {
		t.Fatalf("uncertain creation was retried: %d", creates)
	}
	if _, err := pool.Exec(t.Context(), `UPDATE external_connections SET status='expired' WHERE id=$1`, connection.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := restarted.CreateReauthorization(context.Background(), "account_alice", connection.ID, 1); !errors.Is(err, externalsource.ErrUnavailable) {
		t.Fatalf("generic identity must not inherit an old grant on reauthorization: %v", err)
	}
}

// An app outside the fixed list and an auth config Composio refuses to create
// are both unavailable, and a refused creation is tried again on the next use.
func TestManagedAppsUnavailableForUnknownAppOrRefusedCreation(t *testing.T) {
	allowParallelIntegrationTest(t)
	pool, provider, server := managedAppsFixture(t)
	service := managedAppsService(t, pool, server)
	if _, err := service.CreateConnection(t.Context(), "account_alice", "hubspot"); !errors.Is(err, externalsource.ErrUnavailable) {
		t.Fatalf("unknown app error = %v", err)
	}
	provider.mu.Lock()
	provider.rejectCreate = true
	provider.mu.Unlock()
	if _, err := service.CreateConnection(t.Context(), "account_alice", "linear"); !errors.Is(err, externalsource.ErrUnavailable) {
		t.Fatalf("refused creation error = %v", err)
	}
	provider.mu.Lock()
	provider.rejectCreate = false
	provider.mu.Unlock()
	if _, err := service.CreateConnection(t.Context(), "account_alice", "linear"); err != nil {
		t.Fatal(err)
	}
}

// A deployment without COMPOSIO_API_KEY saves one in the product. TeamHub keeps
// only the sealed key, and a restarted instance reads it at start.
func TestManagedAppsSavedProviderKey(t *testing.T) {
	allowParallelIntegrationTest(t)
	pool, provider, server := managedAppsFixture(t)
	const key = "composio-saved-key"
	provider.requiredKey = key
	box, err := secretbox.New(base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{3}, 32)))
	if err != nil {
		t.Fatal(err)
	}
	unconfigured := func() *externalsource.Service {
		client, err := composio.New(composio.Config{BaseURL: server.URL, EnvironmentKey: "ci", HTTPClient: server.Client()})
		if err != nil {
			t.Fatal(err)
		}
		service := externalsource.New(pool, nil)
		if err = service.ConfigureManagedApps(t.Context(), client, box); err != nil {
			t.Fatal(err)
		}
		return service
	}
	service := unconfigured()
	if service.ProviderConfigured() || service.ManagedKey() != (externalsource.ManagedKeyStatus{Source: externalsource.ManagedKeySourceNone, CanSave: true}) {
		t.Fatalf("unsaved key status = %+v configured=%v", service.ManagedKey(), service.ProviderConfigured())
	}
	if err := service.SaveManagedKey(t.Context(), "wrong-key"); !errors.Is(err, externalsource.ErrManagedKeyRejected) {
		t.Fatalf("SaveManagedKey(wrong) = %v", err)
	}
	if err := service.SaveManagedKey(t.Context(), " "+key+" "); err != nil {
		t.Fatal(err)
	}
	if !service.ProviderConfigured() || service.ManagedKey().Source != externalsource.ManagedKeySourceStored {
		t.Fatalf("saved key status = %+v", service.ManagedKey())
	}
	var sealed []byte
	if err := pool.QueryRow(t.Context(), `SELECT api_key_ciphertext FROM composio_settings`).Scan(&sealed); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(sealed, []byte(key)) {
		t.Fatal("composio_settings stores the plaintext key")
	}
	if apps := service.ListApps(); !slicesContainAvailable(apps, "linear") {
		t.Fatal("linear is not available after saving the key")
	}
	if restarted := unconfigured(); !restarted.ProviderConfigured() || restarted.ManagedKey().Source != externalsource.ManagedKeySourceStored {
		t.Fatalf("restarted instance key status = %+v", restarted.ManagedKey())
	}
	environment := managedAppsService(t, pool, server)
	if err := environment.SaveManagedKey(t.Context(), key); !errors.Is(err, externalsource.ErrManagedKeyFromEnvironment) {
		t.Fatalf("SaveManagedKey with COMPOSIO_API_KEY = %v", err)
	}
}

// Higgsfield and fal.ai get custom auth configs without credentials, which
// TeamHub creates once and reuses; a managed app still gets a managed one.
func TestManagedAppsCreateCustomAuthConfigs(t *testing.T) {
	allowParallelIntegrationTest(t)
	pool, provider, server := managedAppsFixture(t)
	service := managedAppsService(t, pool, server)
	for _, app := range []string{"higgsfield", "fal_ai", "linear"} {
		for range 2 {
			if _, err := service.CreateConnection(t.Context(), "account_alice", app); err != nil {
				t.Fatalf("connect %s: %v", app, err)
			}
		}
	}
	provider.mu.Lock()
	bodies := provider.createBodies
	provider.mu.Unlock()
	want := []map[string]any{
		{"toolkit": map[string]any{"slug": "higgsfield_mcp"}, "auth_config": map[string]any{"type": "use_custom_auth", "name": "linger:ci:higgsfield_mcp:DCR_OAUTH:v1", "authScheme": "DCR_OAUTH", "credentials": map[string]any{}}},
		{"toolkit": map[string]any{"slug": "fal_ai"}, "auth_config": map[string]any{"type": "use_custom_auth", "name": "linger:ci:fal_ai:API_KEY:v1", "authScheme": "API_KEY", "credentials": map[string]any{}}},
		{"toolkit": map[string]any{"slug": "linear"}, "auth_config": map[string]any{"type": "use_composio_managed_auth", "name": "linger:ci:linear:OAUTH2:v1", "auth_scheme": "OAUTH2"}},
	}
	if !reflect.DeepEqual(bodies, want) {
		t.Fatalf("auth config requests = %v", bodies)
	}
}

// A custom auth config that already exists under the stable name is adopted;
// a managed one of the same name and scheme is not.
func TestManagedAppsReuseExistingCustomAuthConfig(t *testing.T) {
	allowParallelIntegrationTest(t)
	pool, provider, server := managedAppsFixture(t)
	service := managedAppsService(t, pool, server)
	provider.mu.Lock()
	provider.configs["linger:ci:fal_ai:API_KEY:v1"] = managedAuthConfig{id: "ac_existing", toolkit: "fal_ai", scheme: "API_KEY"}
	provider.configs["linger:ci:higgsfield_mcp:DCR_OAUTH:v1"] = managedAuthConfig{id: "ac_wrong_kind", toolkit: "higgsfield_mcp", scheme: "DCR_OAUTH", managed: true}
	provider.mu.Unlock()
	connection, err := service.CreateConnection(t.Context(), "account_alice", "fal_ai")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.CreateConnection(t.Context(), "account_alice", "higgsfield"); err != nil {
		t.Fatal(err)
	}
	provider.mu.Lock()
	defer provider.mu.Unlock()
	if link := provider.links[connection.UpstreamConnectionID]; link["auth_config_id"] != "ac_existing" {
		t.Fatalf("fal.ai link used auth config %q", link["auth_config_id"])
	}
	if provider.creates != 1 || provider.createBodies[0]["toolkit"].(map[string]any)["slug"] != "higgsfield_mcp" {
		t.Fatalf("creates=%d bodies=%v", provider.creates, provider.createBodies)
	}
}

func slicesContainAvailable(apps []externalsource.ExternalApp, key string) bool {
	for _, app := range apps {
		if app.Key == key {
			return app.Availability == externalsource.AppAvailabilityAvailable
		}
	}
	return false
}
