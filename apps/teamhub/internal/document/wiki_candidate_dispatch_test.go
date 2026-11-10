package document_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func TestUnifiedWikiCandidateGeneratorCallsFrozenRefreshOperation(t *testing.T) {
	markdown := []byte("# Index\n")
	markdownHash := sha256.Sum256(markdown)
	var path, authorization string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		path = request.URL.EscapedPath()
		authorization = request.Header.Get("Authorization")
		var body map[string]any
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["wiki_refresh_id"] != "document_wiki_refresh_test" ||
			body["generator_agent_actor_id"] != "agent_generator" {
			t.Fatalf("body=%v want frozen unified refresh authority", body)
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"wiki_refresh_id": "document_wiki_refresh_test",
			"pages": []map[string]any{{
				"page_key": "index.md", "markdown_content": markdown,
				"markdown_sha256": hex.EncodeToString(markdownHash[:]),
			}},
		})
	}))
	defer server.Close()

	generator, err := document.NewHTTPWikiCandidateGenerator(server.URL, "service-token-for-test", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	result, err := generator.GenerateWikiCandidates(context.Background(), wikiCandidateRequest())
	if err != nil {
		t.Fatal(err)
	}
	if path != "/internal/v1/wiki-refreshes/document_wiki_refresh_test/candidates" ||
		authorization != "Bearer service-token-for-test" ||
		result.RefreshID != "document_wiki_refresh_test" || len(result.Pages) != 1 {
		t.Fatalf("path=%q authorization=%q result=%+v", path, authorization, result)
	}
}

func TestUnifiedWikiCandidateGeneratorClassifiesRetryableResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusServiceUnavailable)
		_, _ = writer.Write([]byte(`{"error":{"code":"WIKI_OPERATION_RETRYABLE","disposition":"retryable","message":"retry"}}`))
	}))
	defer server.Close()
	generator, err := document.NewHTTPWikiCandidateGenerator(server.URL, "service-token-for-test", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := generator.GenerateWikiCandidates(context.Background(), wikiCandidateRequest()); !errors.Is(err, document.ErrRuntimeUnavailable) {
		t.Fatalf("error=%v want Runtime unavailable", err)
	}
}

func TestUnifiedWikiCandidateGeneratorClassifiesOfflineComputer(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusServiceUnavailable)
		_, _ = writer.Write([]byte(`{"error":{"code":"WIKI_COMPUTER_OFFLINE","disposition":"retryable","message":"offline"}}`))
	}))
	defer server.Close()
	generator, err := document.NewHTTPWikiCandidateGenerator(server.URL, "service-token-for-test", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	_, err = generator.GenerateWikiCandidates(context.Background(), wikiCandidateRequest())
	if !errors.Is(err, document.ErrWikiCandidateComputerOffline) || errors.Is(err, document.ErrRuntimeUnavailable) {
		t.Fatalf("error=%v want offline Computer", err)
	}
}

func TestUnifiedWikiCandidateGeneratorClassifiesStoppingService(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusServiceUnavailable)
		_, _ = writer.Write([]byte(`{"error":{"code":"WIKI_SERVICE_STOPPING","disposition":"retryable","message":"stopping"}}`))
	}))
	defer server.Close()
	generator, err := document.NewHTTPWikiCandidateGenerator(server.URL, "service-token-for-test", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	_, err = generator.GenerateWikiCandidates(context.Background(), wikiCandidateRequest())
	if !errors.Is(err, document.ErrWikiCandidateServiceStopping) || errors.Is(err, document.ErrRuntimeUnavailable) {
		t.Fatalf("error=%v want stopping LLM Wiki", err)
	}
}

func TestUnifiedWikiCandidateGeneratorRejectsLegacyOrInvalidSettlementShape(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte(`{"wiki_refresh_id":"document_wiki_refresh_test","pages":[],"generation_id":"legacy"}`))
	}))
	defer server.Close()
	generator, err := document.NewHTTPWikiCandidateGenerator(server.URL, "service-token-for-test", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := generator.GenerateWikiCandidates(context.Background(), wikiCandidateRequest()); !errors.Is(err, document.ErrRuntimeUnavailable) {
		t.Fatalf("error=%v want invalid legacy result rejected", err)
	}
}

func wikiCandidateRequest() document.WikiCandidateGenerationRequest {
	content := []byte("source")
	digest := sha256.Sum256(content)
	return document.WikiCandidateGenerationRequest{
		RefreshID: "document_wiki_refresh_test", TenantID: "tenant_test",
		GeneratorAgentActorID: "agent_generator", Mode: "initialize",
		Changes: document.WikiCandidateSourceChanges{Added: []document.WikiCandidateSource{{
			DocumentID: "document_source", DocumentVersionID: "document_version_source",
			Filename:  "source.txt",
			SizeBytes: int64(len(content)), SHA256: hex.EncodeToString(digest[:]), Content: content,
		}}},
	}
}
