package externalsource

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
)

// fakeManagedComposio serves the managed auth configs.
type fakeManagedComposio struct {
	mu       sync.Mutex
	toolkits []map[string]any
	fail     atomic.Bool
	configs  map[string]string // toolkit -> auth config ID
	finds    atomic.Int32
	creates  atomic.Int32
	onCreate func()
}

func (f *fakeManagedComposio) serve(t *testing.T) *composio.Client {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		switch {
		case r.URL.Path == "/api/v3.1/toolkits":
			if f.fail.Load() {
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"items": f.toolkits, "next_cursor": ""})
		case r.URL.Path == "/api/v3.1/auth_configs" && r.Method == http.MethodGet:
			f.finds.Add(1)
			toolkit := r.URL.Query().Get("toolkit_slug")
			items := []any{}
			if id := f.configs[toolkit]; id != "" {
				items = append(items, map[string]any{
					"id": id, "name": r.URL.Query().Get("search"), "auth_scheme": "OAUTH2",
					"is_composio_managed": true, "status": "ENABLED", "toolkit": map[string]any{"slug": toolkit},
				})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"items": items, "next_cursor": ""})
		case r.URL.Path == "/api/v3.1/auth_configs" && r.Method == http.MethodPost:
			f.creates.Add(1)
			if f.onCreate != nil {
				f.onCreate()
			}
			var request struct {
				Toolkit struct {
					Slug string `json:"slug"`
				} `json:"toolkit"`
				AuthConfig struct {
					Name string `json:"name"`
				} `json:"auth_config"`
			}
			_ = json.NewDecoder(r.Body).Decode(&request)
			id := "ac_" + request.Toolkit.Slug
			f.configs[request.Toolkit.Slug] = id
			_ = json.NewEncoder(w).Encode(map[string]any{
				"toolkit": map[string]any{"slug": request.Toolkit.Slug},
				"auth_config": map[string]any{
					"id": id, "name": request.AuthConfig.Name, "auth_scheme": "OAUTH2",
					"is_composio_managed": true, "status": "ENABLED", "toolkit": map[string]any{"slug": request.Toolkit.Slug},
				},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	client, err := composio.New(composio.Config{APIKey: "test-key", EnvironmentKey: "test", BaseURL: server.URL, HTTPClient: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func managedToolkitItem(slug string) map[string]any {
	return map[string]any{"slug": slug, "name": slug, "composio_managed_auth_schemes": []string{"OAUTH2"}}
}

func TestAuthConfigIsFoundOrCreatedOncePerProcess(t *testing.T) {
	fake := &fakeManagedComposio{toolkits: []map[string]any{managedToolkitItem("gmail")}, configs: map[string]string{"slack": "ac_existing"}}
	service := New(nil, nil)
	if err := service.ConfigureManagedApps(t.Context(), fake.serve(t), nil); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	ids := make([]string, 8)
	for i := range ids {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id, err := service.ensureAuthConfig(t.Context(), "gmail")
			if err != nil {
				t.Error(err)
			}
			ids[i] = id
		}()
	}
	wg.Wait()
	for _, id := range ids {
		if id != "ac_gmail" {
			t.Fatalf("ids=%v", ids)
		}
	}
	if fake.creates.Load() != 1 || fake.finds.Load() != 1 {
		t.Fatalf("concurrent first use must find and create once: finds=%d creates=%d", fake.finds.Load(), fake.creates.Load())
	}
	if id, err := service.ensureAuthConfig(t.Context(), "slack"); err != nil || id != "ac_existing" || fake.creates.Load() != 1 {
		t.Fatalf("an existing auth config must be reused: id=%q err=%v creates=%d", id, err, fake.creates.Load())
	}
}

// An auth config found with the previous key belongs to another Composio
// project, so a lookup the key changed under is not cached.
func TestAuthConfigFoundBeforeAKeyChangeIsNotCached(t *testing.T) {
	fake := &fakeManagedComposio{toolkits: []map[string]any{managedToolkitItem("gmail")}, configs: map[string]string{}}
	service := New(nil, nil)
	if err := service.ConfigureManagedApps(t.Context(), fake.serve(t), nil); err != nil {
		t.Fatal(err)
	}
	fake.onCreate = func() { service.setManagedKey("another-key") }
	if _, err := service.ensureAuthConfig(t.Context(), "gmail"); err == nil {
		t.Fatal("a lookup the key changed under must fail")
	}
	fake.onCreate = nil
	if id, err := service.ensureAuthConfig(t.Context(), "gmail"); err != nil || id != "ac_gmail" || fake.finds.Load() != 2 {
		t.Fatalf("the next lookup must look again: id=%q err=%v finds=%d", id, err, fake.finds.Load())
	}
}
