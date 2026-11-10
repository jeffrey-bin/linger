package memoryclient

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestClientSendsPublishedRevision(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/internal/v1/published-wiki-graph-updates" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer graph-token" {
			t.Fatal("unexpected authorization header")
		}
		if r.Header.Get("X-Internal-Deadline-Ms") != "" {
			t.Fatal("Memory reads no deadline header")
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if len(body) != 3 || body["tenant_id"] != "tenant_a" || body["owner_actor_id"] != "owner_a" || body["wiki_revision_id"] != "wiki_a" {
			t.Fatalf("published revision scope lost: %+v", body)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	client, err := New(server.URL, "graph-token")
	if err != nil {
		t.Fatal(err)
	}
	if err := client.UpdatePublishedWiki(t.Context(), "tenant_a", "owner_a", "wiki_a"); err != nil {
		t.Fatal(err)
	}
}

func TestClientRejectsInvalidConfiguration(t *testing.T) {
	for _, test := range []struct {
		name, baseURL, token string
	}{
		{name: "URL with path", baseURL: "https://memory.test/path", token: "token"},
		{name: "missing token", baseURL: "https://memory.test", token: ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := New(test.baseURL, test.token); err == nil {
				t.Fatal("New accepted invalid configuration")
			}
		})
	}
}

func TestClientReadsActorScopedVisualization(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/internal/v1/personal-knowledge-graph-visualization" {
			t.Fatalf("unexpected request: %s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("Authorization") != "Bearer graph-token" || request.Header.Get("Accept") != "text/html" {
			t.Fatal("unexpected graph visualization request headers")
		}
		var body map[string]string
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["tenant_id"] != "tenant_acme" || body["owner_actor_id"] != "actor_alice" {
			t.Fatalf("unexpected request body: %#v", body)
		}
		response.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = response.Write([]byte("<!doctype html><title>Knowledge Graph</title>"))
	}))
	defer server.Close()

	client, err := New(server.URL, "graph-token")
	if err != nil {
		t.Fatal(err)
	}
	html, err := client.GetPersonalKnowledgeGraphVisualization(context.Background(), "tenant_acme", "actor_alice")
	if err != nil {
		t.Fatal(err)
	}
	if string(html) != "<!doctype html><title>Knowledge Graph</title>" {
		t.Fatalf("unexpected visualization: %q", html)
	}
}

func TestClientMapsMissingVisualization(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		response.WriteHeader(http.StatusNotFound)
		_, _ = response.Write([]byte(`{"error":{"code":"graph_not_found","message":"not found"}}`))
	}))
	defer server.Close()

	client, err := New(server.URL, "graph-token")
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.GetPersonalKnowledgeGraphVisualization(context.Background(), "tenant_acme", "actor_alice")
	if !errors.Is(err, ErrVisualizationNotFound) {
		t.Fatalf("GetPersonalKnowledgeGraphVisualization error=%v want ErrVisualizationNotFound", err)
	}
}

func TestClientForwardsKnowledgeWithinItsResponseLimit(t *testing.T) {
	body := `{"items":[]}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths := map[string]bool{
			"/internal/v1/query":                       true,
			"/internal/v1/personal-knowledge/evidence": true,
		}
		if !paths[r.URL.Path] || r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer token" {
			t.Errorf("unexpected knowledge request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
	defer server.Close()
	client, err := New(server.URL, "token")
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range []string{"search_knowledge", "read_knowledge"} {
		status, result, err := client.Knowledge(t.Context(), tool, []byte(`{}`))
		if err != nil || status != http.StatusOK || string(result) != body {
			t.Fatalf("%s: status=%d body=%q err=%v", tool, status, result, err)
		}
	}
	body = `"` + strings.Repeat("a", knowledgeResponseLimit) + `"`
	if _, _, err := client.Knowledge(t.Context(), "search_knowledge", []byte(`{}`)); err == nil {
		t.Fatal("a knowledge answer over 4 MiB was accepted")
	}
	if _, _, err := client.Knowledge(t.Context(), "list_tracking_items", []byte(`{}`)); err == nil {
		t.Fatal("an unknown knowledge tool was forwarded")
	}
}

func TestClientNeverFollowsARedirectWithItsToken(t *testing.T) {
	elsewhere := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("the Memory token followed a redirect")
	}))
	defer elsewhere.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, elsewhere.URL, http.StatusTemporaryRedirect)
	}))
	defer server.Close()
	client, err := New(server.URL, "token")
	if err != nil {
		t.Fatal(err)
	}
	status, _, err := client.Knowledge(t.Context(), "search_knowledge", []byte(`{}`))
	if err != nil || status != http.StatusTemporaryRedirect {
		t.Fatalf("status=%d err=%v", status, err)
	}
}
