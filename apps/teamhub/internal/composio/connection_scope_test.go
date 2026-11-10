package composio

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestProxyUsesAuthorizedConnectionOwner(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body proxyRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.UserID != "trusted-owner" || body.ConnectedAccountID != "owned-account" {
			t.Fatalf("unexpected proxy binding: %+v", body)
		}
		if body.Endpoint == "/auth.test" {
			_, _ = w.Write([]byte(`{"status":200,"data":{"ok":true,"team_id":"T1","team":"Team","url":"https://team.slack.com/","user_id":"U1"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"status":200,"data":{"emailAddress":"owner@example.test","historyId":"1"}}`))
	}))
	defer server.Close()
	client, err := New(Config{BaseURL: server.URL, APIKey: "test", EnvironmentKey: "ci"})
	if err != nil {
		t.Fatal(err)
	}
	client.SetConnectionAuthority(func(_ context.Context, id string) (ConnectionBinding, error) {
		if id != "owned-account" {
			return ConnectionBinding{}, ErrConnectionScope
		}
		return ConnectionBinding{UserID: "trusted-owner"}, nil
	})
	if _, err := client.IdentifyGmail(context.Background(), "owned-account"); err != nil {
		t.Fatal(err)
	}
	// Slack calls bypass proxy's retries but still need the owner.
	if _, err := client.IdentifySlack(context.Background(), "owned-account"); err != nil {
		t.Fatal(err)
	}
}

func TestEnvironmentScopeFencesEveryConnectedAccountOperation(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(http.StatusInternalServerError) }))
	defer server.Close()
	client, err := New(Config{BaseURL: server.URL, APIKey: "test", EnvironmentKey: "ci"})
	if err != nil {
		t.Fatal(err)
	}
	client.SetConnectionAuthority(func(context.Context, string) (ConnectionBinding, error) {
		return ConnectionBinding{}, ErrConnectionScope
	})
	ctx := context.Background()
	checks := []struct {
		name string
		call func() error
	}{
		{"status", func() error { _, err := client.GetConnectionStatus(ctx, "foreign"); return err }},
		{"execute", func() error {
			_, err := client.ExecuteTool(ctx, "foreign", "user", "APP_WRITE", "20260915_00", map[string]any{})
			return err
		}},
		{"search", func() error {
			_, err := client.SearchTools(ctx, ToolSearchRequest{ConnectedAccountID: "foreign", UserID: "user", ToolkitSlug: "hubspot", Query: "find contacts", Limit: 5})
			return err
		}},
		{"revoke", func() error { return client.RevokeConnection(ctx, "foreign") }},
		{"import", func() error { _, err := client.IdentifyGmail(ctx, "foreign"); return err }},
		{"discord identity", func() error { _, err := client.IdentifyDiscord(ctx, "foreign"); return err }},
	}
	for _, check := range checks {
		t.Run(check.name, func(t *testing.T) {
			if err := check.call(); !errors.Is(err, ErrConnectionScope) {
				t.Fatalf("got %v", err)
			}
		})
	}
	if calls != 0 {
		t.Fatalf("foreign connection caused %d provider calls", calls)
	}
}

func TestEnvironmentUserIdentityIsStableAndDistinct(t *testing.T) {
	ci, _ := New(Config{APIKey: "test", EnvironmentKey: "ci"})
	owner, _ := New(Config{APIKey: "test", EnvironmentKey: "example-owner-test"})
	if ci.UserIDForAccount("same-account") == owner.UserIDForAccount("same-account") {
		t.Fatal("environments share user identity")
	}
	if got := ci.UserIDForAccount("same-account"); got != "co_workspace:ci:account:same-account" {
		t.Fatal(got)
	}
	for _, invalid := range []string{"CI", "../ci", "ci:account:foreign", " ci"} {
		if _, err := New(Config{APIKey: "test", EnvironmentKey: invalid}); err == nil {
			t.Fatalf("accepted %q", invalid)
		}
	}
}

func TestStatusRequiresExactUpstreamReceipt(t *testing.T) {
	for _, body := range []string{
		`{"status":"ACTIVE","user_id":"other","toolkit":{"slug":"hubspot"},"auth_config":{"id":"ac_1"}}`,
		`{"status":"ACTIVE","user_id":"expected","toolkit":{"slug":"gmail"},"auth_config":{"id":"ac_1"}}`,
		`{"status":"ACTIVE","user_id":"expected","toolkit":{"slug":"hubspot"},"auth_config":{"id":"other"}}`,
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(body)) }))
		client, _ := New(Config{BaseURL: server.URL, APIKey: "test", EnvironmentKey: "ci"})
		client.SetConnectionAuthority(func(context.Context, string) (ConnectionBinding, error) {
			return ConnectionBinding{UserID: "expected", ToolkitSlug: "hubspot", AuthConfigID: "ac_1"}, nil
		})
		_, err := client.GetConnectionStatus(context.Background(), "ca_1")
		server.Close()
		if !errors.Is(err, ErrConnectionScope) {
			t.Fatalf("mismatched upstream receipt accepted: %v", err)
		}
	}
}

// newTestClient builds a client for one test environment whose connection
// authority accepts every connected account, as TeamHub's does for its own.
func newTestClient(cfg Config) (*Client, error) {
	if cfg.EnvironmentKey == "" {
		cfg.EnvironmentKey = "test"
	}
	client, err := New(cfg)
	if err != nil {
		return nil, err
	}
	client.SetConnectionAuthority(func(context.Context, string) (ConnectionBinding, error) {
		return ConnectionBinding{}, nil
	})
	return client, nil
}
