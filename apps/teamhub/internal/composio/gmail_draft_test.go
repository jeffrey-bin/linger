package composio

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

type proxiedDraftCall struct{ Method, Endpoint, Raw, ID string }

func TestClientSavesGmailDraftThroughProxyWithoutSending(t *testing.T) {
	var calls []proxiedDraftCall
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v3.1/tools/execute/proxy" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		var request struct {
			Endpoint string `json:"endpoint"`
			Method   string `json:"method"`
			Body     struct {
				ID      string `json:"id"`
				Message struct {
					Raw string `json:"raw"`
				} `json:"message"`
			} `json:"body"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatal(err)
		}
		calls = append(calls, proxiedDraftCall{request.Method, request.Endpoint, request.Body.Message.Raw, request.Body.ID})
		_, _ = w.Write([]byte(`{"status":200,"data":{"id":"r-1","message":{"id":"m-1","threadId":"t-1"}},"headers":{}}`))
	}))
	defer server.Close()
	client, err := newTestClient(Config{BaseURL: server.URL, APIKey: "restricted-key", HTTPClient: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	created, err := client.SaveGmailDraft(context.Background(), "ca_1", "", "cmF3")
	if err != nil || created != (GmailDraft{DraftID: "r-1", MessageID: "m-1", ThreadID: "t-1"}) {
		t.Fatalf("created=%+v error=%v", created, err)
	}
	if _, err := client.SaveGmailDraft(context.Background(), "ca_1", "r-1", "cmF3Mg"); err != nil {
		t.Fatal(err)
	}
	if _, err := client.SaveGmailDraft(context.Background(), "ca_1", "r-other", "cmF3Mg"); err == nil {
		t.Fatal("a response for another draft was accepted")
	}
	want := []proxiedDraftCall{
		{http.MethodPost, "/gmail/v1/users/me/drafts", "cmF3", ""},
		{http.MethodPut, "/gmail/v1/users/me/drafts/r-1", "cmF3Mg", "r-1"},
		{http.MethodPut, "/gmail/v1/users/me/drafts/r-other", "cmF3Mg", "r-other"},
	}
	if len(calls) != len(want) {
		t.Fatalf("calls=%+v", calls)
	}
	for index := range want {
		if calls[index] != want[index] {
			t.Fatalf("call %d=%+v want %+v", index, calls[index], want[index])
		}
	}
}
