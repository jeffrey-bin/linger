package composio

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClientCanStartBeforeAnyManagedAuthConfigExists(t *testing.T) {
	if _, err := New(Config{APIKey: "test-key", EnvironmentKey: "test"}); err != nil {
		t.Fatalf("a project key must support catalog discovery and first-use auth provisioning: %v", err)
	}
}

func TestFindAuthConfigRequiresCompletePagesAndSelectsLowestMatchingID(t *testing.T) {
	for _, incomplete := range []bool{false, true} {
		t.Run(map[bool]string{false: "complete", true: "incomplete"}[incomplete], func(t *testing.T) {
			requests := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests++
				if r.URL.Query().Get("cursor") == "last" && incomplete {
					_, _ = w.Write([]byte(`{"unexpected":"missing items"}`))
					return
				}
				item := AuthConfig{ID: "ac_z", Name: "stable-name", AuthScheme: "OAUTH2", Managed: true, Status: "ENABLED"}
				item.Toolkit.Slug = "hubspot"
				items, next := []AuthConfig{item}, "last"
				if r.URL.Query().Get("cursor") == "last" {
					item.ID = "ac_b"
					items, next = []AuthConfig{item}, ""
					item.ID, item.Name = "ac_a", "foreign-name"
					items = append(items, item)
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"items": items, "next_cursor": next})
			}))
			t.Cleanup(server.Close)
			client, err := newTestClient(Config{APIKey: "test-key", BaseURL: server.URL, HTTPClient: server.Client()})
			if err != nil {
				t.Fatal(err)
			}
			config, found, err := client.FindAuthConfig(t.Context(), "hubspot", "stable-name", "OAUTH2", true)
			if requests != 2 {
				t.Fatalf("must read all pages, got %d requests", requests)
			}
			if incomplete {
				if err == nil || found || config.ID != "" {
					t.Fatalf("partial matches cannot select an auth config: %+v %t %v", config, found, err)
				}
			} else if err != nil || !found || config.ID != "ac_b" {
				t.Fatalf("expected lowest matching ID across pages: %+v %t %v", config, found, err)
			}
		})
	}
}
