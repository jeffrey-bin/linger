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

func TestUnifiedWikiCandidatePreservesFrozenUTF8SourceBytes(t *testing.T) {
	content := []byte("title\n\nplain text with \u4e2d\u6587\n")
	digest := sha256.Sum256(content)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var body struct {
			Changes struct {
				Added []struct {
					Content []byte `json:"content"`
					SHA256  string `json:"sha256"`
				} `json:"added"`
			} `json:"changes"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if len(body.Changes.Added) != 1 || string(body.Changes.Added[0].Content) != string(content) || body.Changes.Added[0].SHA256 != hex.EncodeToString(digest[:]) {
			t.Fatalf("changes=%+v want exact frozen UTF-8 bytes", body.Changes)
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"wiki_refresh_id": "refresh_utf8",
			"pages":           []map[string]any{{"page_key": "index.md", "markdown_content": []byte("# Index\n"), "markdown_sha256": hashHex([]byte("# Index\n"))}},
		})
	}))
	t.Cleanup(server.Close)
	generator, err := document.NewHTTPWikiCandidateGenerator(server.URL, "service-token", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	_, err = generator.GenerateWikiCandidates(context.Background(), document.WikiCandidateGenerationRequest{
		RefreshID: "refresh_utf8", TenantID: "tenant_test", GeneratorAgentActorID: "agent_generator", Mode: "initialize",
		Changes: document.WikiCandidateSourceChanges{Added: []document.WikiCandidateSource{{DocumentID: "document_source", DocumentVersionID: "version_source", Filename: "notes.txt", SizeBytes: int64(len(content)), SHA256: hex.EncodeToString(digest[:]), Content: content}}},
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestUnifiedWikiCandidateRejectsObjectStoreEquivalentCorruption(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"wiki_refresh_id": "refresh_corrupt",
			"pages":           []map[string]any{{"page_key": "index.md", "markdown_content": []byte("# Corrupt\n"), "markdown_sha256": hashHex([]byte("different"))}},
		})
	}))
	t.Cleanup(server.Close)
	generator, err := document.NewHTTPWikiCandidateGenerator(server.URL, "service-token", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	content := []byte("source")
	digest := sha256.Sum256(content)
	_, err = generator.GenerateWikiCandidates(context.Background(), document.WikiCandidateGenerationRequest{
		RefreshID: "refresh_corrupt", TenantID: "tenant_test", GeneratorAgentActorID: "agent_generator", Mode: "initialize",
		Changes: document.WikiCandidateSourceChanges{Added: []document.WikiCandidateSource{{DocumentID: "document_source", DocumentVersionID: "version_source", Filename: "source.txt", SizeBytes: int64(len(content)), SHA256: hex.EncodeToString(digest[:]), Content: content}}},
	})
	if !errors.Is(err, document.ErrRuntimeUnavailable) {
		t.Fatalf("error=%v want fail-closed invalid candidate", err)
	}
}

func hashHex(content []byte) string {
	digest := sha256.Sum256(content)
	return hex.EncodeToString(digest[:])
}
