package document

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"runtime"
	"strings"
	"testing"
)

type wikiMemoryTransport struct {
	bytes int64
}

func (transport *wikiMemoryTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	n, err := io.Copy(io.Discard, request.Body)
	transport.bytes = n
	if err != nil {
		return nil, err
	}
	return &http.Response{
		StatusCode: http.StatusServiceUnavailable,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(`{"error":{"disposition":"retryable"}}`)),
	}, nil
}

func TestHTTPWikiCandidateGeneratorBoundsEncodedRequestAllocations(t *testing.T) {
	content := bytes.Repeat([]byte("x"), 2<<20)
	digest := sha256.Sum256(content)
	request := WikiCandidateGenerationRequest{
		RefreshID: "refresh_memory", TenantID: "tenant_memory", GeneratorAgentActorID: "agent_memory", Mode: "initialize",
	}
	for index := range 16 {
		request.Changes.Added = append(request.Changes.Added, WikiCandidateSource{
			DocumentID: fmt.Sprintf("document_%d", index), DocumentVersionID: fmt.Sprintf("version_%d", index),
			Filename:  "source.txt",
			SizeBytes: int64(len(content)), SHA256: hex.EncodeToString(digest[:]), Content: content,
		})
	}
	transport := &wikiMemoryTransport{}
	generator, err := NewHTTPWikiCandidateGenerator("http://wiki.invalid", "test-token", &http.Client{Transport: transport})
	if err != nil {
		t.Fatal(err)
	}
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	_, _ = generator.GenerateWikiCandidates(t.Context(), request)
	runtime.ReadMemStats(&after)
	if transport.bytes < 42<<20 {
		t.Fatalf("request lost frozen content: transmitted %d bytes", transport.bytes)
	}
	if allocated := after.TotalAlloc - before.TotalAlloc; allocated > 8<<20 {
		t.Fatalf("encoding allocated %d bytes for 32MiB frozen input; want at most 8MiB", allocated)
	}
}

func TestHTTPWikiCandidateGeneratorRejectsOversizeEnvelopeBeforeTransport(t *testing.T) {
	// Each source is valid; their aggregate Base64 envelope exceeds the existing
	// receiver's 256MiB limit. No full-size fixture is needed to prove admission.
	content := bytes.Repeat([]byte("x"), 1<<20)
	digest := sha256.Sum256(content)
	request := WikiCandidateGenerationRequest{
		RefreshID: "refresh_memory", TenantID: "tenant_memory", GeneratorAgentActorID: "agent_memory", Mode: "initialize",
	}
	for index := range 193 {
		request.Changes.Added = append(request.Changes.Added, WikiCandidateSource{
			DocumentID: fmt.Sprintf("document_%d", index), DocumentVersionID: fmt.Sprintf("version_%d", index),
			Filename:  "source.txt",
			SizeBytes: int64(len(content)), SHA256: hex.EncodeToString(digest[:]), Content: content,
		})
	}
	transport := &wikiMemoryTransport{}
	generator, err := NewHTTPWikiCandidateGenerator("http://wiki.invalid", "test-token", &http.Client{Transport: transport})
	if err != nil {
		t.Fatal(err)
	}
	_, err = generator.GenerateWikiCandidates(context.Background(), request)
	if !errors.Is(err, ErrWikiCandidateInvalidRequest) || transport.bytes != 0 {
		t.Fatalf("oversize envelope: error=%v transmitted=%d", err, transport.bytes)
	}
}
