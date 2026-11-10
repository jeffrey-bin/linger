package document_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func TestUnifiedWikiCandidateRoutesOnlyTheFrozenOperation(t *testing.T) {
	request := wikiCandidateRequest()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, incoming *http.Request) {
		if incoming.Method != http.MethodPost || incoming.URL.Path != "/internal/v1/wiki-refreshes/document_wiki_refresh_test/candidates" {
			t.Fatalf("request=%s %s", incoming.Method, incoming.URL.Path)
		}
		if incoming.Header.Get("Authorization") != "Bearer normalizer-token" {
			t.Fatalf("authorization=%q", incoming.Header.Get("Authorization"))
		}
		var body map[string]any
		if err := json.NewDecoder(incoming.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["wiki_refresh_id"] != request.RefreshID || body["generator_agent_actor_id"] != request.GeneratorAgentActorID {
			t.Fatalf("body=%v want frozen refresh authority", body)
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"wiki_refresh_id": request.RefreshID,
			"pages":           []map[string]any{{"page_key": "index.md", "markdown_content": []byte("# Index\n"), "markdown_sha256": hashHex([]byte("# Index\n"))}},
		})
	}))
	t.Cleanup(server.Close)
	generator, err := document.NewHTTPWikiCandidateGenerator(server.URL, "normalizer-token", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	result, err := generator.GenerateWikiCandidates(context.Background(), request)
	if err != nil || result.RefreshID != request.RefreshID || len(result.Pages) != 1 {
		t.Fatalf("result=%+v error=%v", result, err)
	}
}

func TestUnifiedWikiCandidateClassifiesGeneratorFailures(t *testing.T) {
	for _, test := range []struct {
		name   string
		status int
		body   string
	}{
		{name: "terminal source failure", status: http.StatusUnprocessableEntity, body: `{"error":{"code":"DOCUMENT_SOURCE_INVALID","disposition":"terminal","message":"invalid"}}`},
		{name: "retryable converter failure", status: http.StatusServiceUnavailable, body: `{"error":{"code":"DOCUMENT_NORMALIZATION_TIMEOUT","disposition":"retryable","message":"retry"}}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				writer.WriteHeader(test.status)
				_, _ = writer.Write([]byte(test.body))
			}))
			t.Cleanup(server.Close)
			generator, err := document.NewHTTPWikiCandidateGenerator(server.URL, "normalizer-token", server.Client())
			if err != nil {
				t.Fatal(err)
			}
			if _, err := generator.GenerateWikiCandidates(context.Background(), wikiCandidateRequest()); !errors.Is(err, document.ErrRuntimeUnavailable) {
				t.Fatalf("error=%v want unavailable", err)
			}
		})
	}
}
