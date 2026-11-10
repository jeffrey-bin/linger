package composio

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestIdentifyGoogleDrive(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request proxyRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
			return
		}
		var data any
		switch request.Endpoint {
		case "https://www.googleapis.com/drive/v3/about":
			data = map[string]any{"user": map[string]string{"permissionId": "drive-human", "emailAddress": "person@example.test"}}
		default:
			t.Errorf("unexpected endpoint %s", request.Endpoint)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		raw, _ := json.Marshal(data)
		_ = json.NewEncoder(w).Encode(proxyResponse{Status: 200, Data: raw})
	}))
	defer server.Close()
	client, err := newTestClient(Config{BaseURL: server.URL, APIKey: "key", HTTPClient: server.Client(), RetryLimit: -1})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	identity, err := client.IdentifyGoogleDrive(ctx, "account")
	if err != nil || identity.ID != "drive-human" {
		t.Fatalf("identity=%+v err=%v", identity, err)
	}
}
