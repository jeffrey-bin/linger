package roomagent

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHTTPGatewayConfiguresOwnedLocalBrowser(t *testing.T) {
	token := "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U_-"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.URL.Path != "/v1/tenants/tenant_1/owners/actor_owner/local-computers/computer_1/browser-connection" {
			t.Fatalf("request=%s %s", r.Method, r.URL.Path)
		}
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if len(body) != 2 || body["extension_token"] != token || body["profile"] != "Profile 1" {
			t.Fatalf("body keys=%d profile=%q", len(body), body["profile"])
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"mode":"user_chrome","state":"connected","platform":"darwin","browser":"chrome","profile":"Profile 1","verified_at":"2026-10-22T10:00:00Z"}`))
	}))
	t.Cleanup(server.Close)
	gateway, err := NewHTTPGateway(server.URL, "service-secret", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	status, err := gateway.ConnectLocalBrowser(context.Background(), LocalBrowserConnectionCommand{
		TenantID: "tenant_1", OwnerActorID: "actor_owner", ComputerID: "computer_1",
		Action: LocalBrowserConnectionConfigure, Profile: "Profile 1", ExtensionToken: token,
	})
	if err != nil || status.State != "connected" || status.Mode != "user_chrome" || status.Browser != "chrome" ||
		status.Profile != "Profile 1" || status.VerifiedAt == nil {
		t.Fatalf("status=%+v err=%v", status, err)
	}
}

func TestHTTPGatewayMapsLocalBrowserConnectionFailures(t *testing.T) {
	for _, test := range []struct {
		status int
		body   string
		want   error
	}{
		{http.StatusNotFound, `{"error":{"code":"LOCAL_COMPUTER_NOT_FOUND","message":"x","request_id":"r"}}`, ErrLocalComputerNotFound},
		{http.StatusConflict, `{"error":{"code":"BROWSER_CONNECTION_CAPABILITY_UNAVAILABLE","message":"x","request_id":"r"}}`, ErrLocalBrowserUnsupported},
		{http.StatusBadGateway, `{"error":{"code":"BROWSER_FAILED","message":"x","request_id":"r"}}`, ErrLocalBrowserConnectionFailed},
		{http.StatusBadGateway, `{"error":{"code":"BROWSER_TOKEN_REJECTED","message":"x","request_id":"r"}}`, &LocalBrowserConnectionError{Code: "BROWSER_TOKEN_REJECTED"}},
		{http.StatusServiceUnavailable, `{"error":{"code":"LOCAL_COMPUTER_OFFLINE","message":"x","request_id":"r"}}`, ErrLocalComputerOffline},
		{http.StatusServiceUnavailable, `{"error":{"code":"BROWSER_CONNECTION_TIMEOUT","message":"x","request_id":"r"}}`, ErrLocalBrowserConnectionTimeout},
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodGet {
				t.Fatalf("method=%s", r.Method)
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(test.status)
			_, _ = w.Write([]byte(test.body))
		}))
		gateway, err := NewHTTPGateway(server.URL, "service-secret", server.Client())
		if err != nil {
			t.Fatal(err)
		}
		_, err = gateway.ConnectLocalBrowser(context.Background(), LocalBrowserConnectionCommand{
			TenantID: "tenant_1", OwnerActorID: "actor_owner", ComputerID: "computer_1", Action: LocalBrowserConnectionStatusAction,
		})
		server.Close()
		var typed *LocalBrowserConnectionError
		if errors.As(test.want, &typed) {
			var got *LocalBrowserConnectionError
			if !errors.As(err, &got) || got.Code != typed.Code || !errors.Is(err, ErrLocalBrowserConnectionFailed) {
				t.Fatalf("status=%d err=%v want code %s", test.status, err, typed.Code)
			}
			continue
		}
		if !errors.Is(err, test.want) {
			t.Fatalf("status=%d err=%v want %v", test.status, err, test.want)
		}
	}
}
