package document

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf16"
)

func TestHTTPWikiCandidateGeneratorUsesGeneratedWireAndRejectsInvalidResults(t *testing.T) {
	markdown := []byte("# Index\n")
	digest := sha256.Sum256(markdown)
	var requestCount int
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requestCount++
		if request.URL.Path != "/internal/v1/wiki-refreshes/refresh-a/candidates" ||
			request.Method != http.MethodPost || request.Header.Get("Authorization") != "Bearer candidate-token" ||
			request.Header.Get("Accept") != "application/json" {
			t.Errorf("request method=%s path=%s authorization=%q accept=%q", request.Method,
				request.URL.Path, request.Header.Get("Authorization"), request.Header.Get("Accept"))
		}
		var body map[string]any
		decoder := json.NewDecoder(request.Body)
		if err := decoder.Decode(&body); err != nil {
			t.Errorf("decode request: %v", err)
		}
		if len(body) != 6 || body["wiki_refresh_id"] != "refresh-a" ||
			body["tenant_id"] != "tenant-a" || body["generator_agent_actor_id"] != "agent-a" {
			t.Errorf("request body=%v", body)
		}
		if body["mode"] != "initialize" {
			t.Errorf("request mode=%v", body["mode"])
		}
		writer.Header().Set("Content-Type", "application/json")
		switch requestCount {
		case 1:
			_ = json.NewEncoder(writer).Encode(map[string]any{
				"wiki_refresh_id": "refresh-a",
				"pages": []map[string]any{{
					"page_key": "index.md", "markdown_content": markdown,
					"markdown_sha256": hex.EncodeToString(digest[:]),
				}},
				"unsettled_sources": []map[string]any{{
					"document_id": "document-a", "document_version_id": "version-a", "filename": "source.txt",
				}},
				"deferred_sources": []map[string]any{{
					"document_id": "document-b", "document_version_id": "version-b", "filename": "later.txt",
				}},
			})
		case 2:
			_ = json.NewEncoder(writer).Encode(map[string]any{
				"wiki_refresh_id": "refresh-a", "pages": []map[string]any{{
					"page_key": "index.md", "markdown_content": markdown,
					"markdown_sha256": hex.EncodeToString(digest[:]), "settlement_target": "forbidden",
				}},
			})
		case 3:
			_ = json.NewEncoder(writer).Encode(map[string]any{
				"wiki_refresh_id": "refresh-a", "pages": []map[string]any{{
					"page_key": "index.md", "markdown_content": markdown,
					"markdown_sha256": "0" + hex.EncodeToString(digest[:])[1:],
				}},
			})
		default:
			writer.WriteHeader(http.StatusServiceUnavailable)
			_, _ = writer.Write([]byte(`{"error":{"code":"WIKI_OPERATION_RETRYABLE","disposition":"retryable","message":"temporary"}}`))
		}
	}))
	defer server.Close()

	generator, err := NewHTTPWikiCandidateGenerator(server.URL, "candidate-token", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	request := WikiCandidateGenerationRequest{
		RefreshID: "refresh-a", TenantID: "tenant-a",
		GeneratorAgentActorID: "agent-a", Mode: "initialize",
		Changes: WikiCandidateSourceChanges{Added: []WikiCandidateSource{{
			DocumentID: "document-a", DocumentVersionID: "version-a", Filename: "source.txt", SizeBytes: 6,
			SHA256: func() string {
				hash := sha256.Sum256([]byte("source"))
				return hex.EncodeToString(hash[:])
			}(), Content: []byte("source"),
		}}},
	}

	result, err := generator.GenerateWikiCandidates(context.Background(), request)
	if err != nil || result.RefreshID != "refresh-a" || len(result.Pages) != 1 ||
		result.Pages[0].PageKey != "index.md" || string(result.Pages[0].Markdown) != string(markdown) ||
		len(result.Unsettled) != 1 || result.Unsettled[0] != (WikiCandidateSourceReference{
		DocumentID: "document-a", DocumentVersionID: "version-a", Filename: "source.txt",
	}) || len(result.Deferred) != 1 || result.Deferred[0].DocumentID != "document-b" {
		t.Fatalf("result=%+v error=%v", result, err)
	}
	for attempt := 0; attempt < 3; attempt++ {
		_, err := generator.GenerateWikiCandidates(context.Background(), request)
		if !errors.Is(err, ErrRuntimeUnavailable) {
			t.Fatalf("invalid response attempt=%d error=%v", attempt, err)
		}
	}
}

func TestHTTPWikiCandidateGeneratorPreservesFailureDisposition(t *testing.T) {
	for _, tc := range []struct {
		name           string
		status         int
		body           string
		invalidRequest bool
		terminal       bool
	}{
		{"invalid generation", 500, `{"error":{"code":"WIKI_REFRESH_GENERATION_INVALID","disposition":"terminal","message":"private source content"}}`, false, true},
		{"invalid input", 400, `{"error":{"code":"WIKI_REFRESH_CANDIDATE_REQUEST_INVALID","disposition":"terminal","message":"private source content"}}`, true, true},
		{"oversize input", 413, `{"error":{"code":"WIKI_REFRESH_CANDIDATE_REQUEST_INVALID","disposition":"terminal","message":"private source content"}}`, true, true},
		{"temporary provider failure", 503, `{"error":{"code":"WIKI_REFRESH_GENERATION_UNAVAILABLE","disposition":"retryable","message":"private source content"}}`, false, false},
		{"legacy error", 503, `{"error":{"code":"unavailable","message":"private source content"}}`, false, false},
		{"invalid upstream response", 502, `upstream unavailable`, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			generator, err := NewHTTPWikiCandidateGenerator(server.URL, "candidate-token", server.Client())
			if err != nil {
				t.Fatal(err)
			}
			digest := sha256.Sum256([]byte("source"))
			_, err = generator.GenerateWikiCandidates(context.Background(), WikiCandidateGenerationRequest{
				RefreshID: "refresh-a", TenantID: "tenant-a", GeneratorAgentActorID: "agent-a", Mode: "initialize",
				Changes: WikiCandidateSourceChanges{Added: []WikiCandidateSource{{
					DocumentID: "document-a", DocumentVersionID: "version-a", Filename: "source.txt", SizeBytes: 6,
					SHA256: hex.EncodeToString(digest[:]), Content: []byte("source"),
				}}},
			})
			if err == nil ||
				errors.Is(err, ErrWikiCandidateInvalidRequest) != tc.invalidRequest ||
				errors.Is(err, ErrWikiCandidateTerminal) != (tc.terminal && !tc.invalidRequest) ||
				errors.Is(err, ErrRuntimeUnavailable) == tc.terminal ||
				strings.Contains(err.Error(), "private source content") {
				t.Fatalf("terminal=%t invalidRequest=%t error=%v", tc.terminal, tc.invalidRequest, err)
			}
		})
	}
}

// LLM Wiki takes up to 10,000 base pages and rejects filenames with control
// characters or more than 255 UTF-16 code units, so TeamHub sends only that.
func TestHTTPWikiCandidateGeneratorSendsLargeUpdatesWithSafeFilenames(t *testing.T) {
	markdown := []byte("# Index\n")
	digest := sha256.Sum256(markdown)
	pageDigest := hex.EncodeToString(digest[:])
	sourceDigest := sha256.Sum256([]byte("source"))
	longName := strings.Repeat("€", 90) + "\t€€.md"
	var basePages int
	var filenames []string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var body struct {
			BasePages []json.RawMessage `json:"base_pages"`
			Changes   struct {
				Added, Removed []struct {
					Filename string `json:"filename"`
				}
			} `json:"changes"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Errorf("decode request: %v", err)
		}
		basePages, filenames = len(body.BasePages), nil
		for _, source := range append(body.Changes.Added, body.Changes.Removed...) {
			filenames = append(filenames, source.Filename)
		}
		writer.Header().Set("Content-Type", "application/json")
		for _, filename := range filenames {
			if len(utf16.Encode([]rune(filename))) > 255 ||
				strings.ContainsFunc(filename, func(character rune) bool { return character <= 0x1f || character == 0x7f }) {
				writer.WriteHeader(http.StatusBadRequest)
				_, _ = writer.Write([]byte(`{"error":{"code":"WIKI_REFRESH_CANDIDATE_REQUEST_INVALID","disposition":"terminal","message":"invalid"}}`))
				return
			}
		}
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"wiki_refresh_id": "refresh-a",
			"pages":           []map[string]any{{"page_key": "index.md", "markdown_content": markdown, "markdown_sha256": pageDigest}},
		})
	}))
	defer server.Close()
	generator, err := NewHTTPWikiCandidateGenerator(server.URL, "candidate-token", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	request := WikiCandidateGenerationRequest{
		RefreshID: "refresh-a", TenantID: "tenant-a", GeneratorAgentActorID: "agent-a", Mode: "update",
		BasePages: make([]WikiCandidateBasePage, 1001),
		Changes: WikiCandidateSourceChanges{
			Added: []WikiCandidateSource{{
				DocumentID: "document-a", DocumentVersionID: "version-a", Filename: longName, SizeBytes: 6,
				SHA256: hex.EncodeToString(sourceDigest[:]), Content: []byte("source"),
			}},
			Removed: []WikiCandidateSourceReference{{DocumentID: "document-b", DocumentVersionID: "version-b", Filename: "old\tsource.txt"}},
		},
	}
	for index := range request.BasePages {
		request.BasePages[index] = WikiCandidateBasePage{
			PageKey: fmt.Sprintf("topics/page-%04d.md", index), SHA256: pageDigest,
			SizeBytes: int64(len(markdown)), Content: markdown,
		}
	}

	result, err := generator.GenerateWikiCandidates(context.Background(), request)
	if err != nil || len(result.Pages) != 1 || basePages != 1001 ||
		len(filenames) != 2 || filenames[0] != strings.Repeat("€", 84)+".md" || filenames[1] != "old source.txt" {
		t.Fatalf("result=%+v base pages=%d filenames=%q error=%v", result, basePages, filenames, err)
	}

	// An over-limit request is never sent.
	tooLarge := request
	tooLarge.BasePages = make([]WikiCandidateBasePage, 10001)
	basePages = 0
	if _, err := generator.GenerateWikiCandidates(context.Background(), tooLarge); !errors.Is(err, ErrInvalidInput) || basePages != 0 {
		t.Fatalf("10,001 base pages error=%v sent=%d", err, basePages)
	}
}
