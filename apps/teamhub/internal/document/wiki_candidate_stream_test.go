package document

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/contracts-go/nodeservicesinternal"
)

type wikiStreamTransport func(*http.Request) (*http.Response, error)

func (f wikiStreamTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestWikiStreamingPreservesFrozenProtocolAndLazyReads(t *testing.T) {
	content := []byte{0, 1, 2, 255, '\n'}
	digest := sha256.Sum256(content)
	hash := hex.EncodeToString(digest[:])
	reads := 0
	load := func(context.Context) ([]byte, error) { reads++; return content, nil }
	source := WikiCandidateSource{DocumentID: "doc_a", DocumentVersionID: "version_a", Filename: "Größe\".txt", SizeBytes: int64(len(content)), SHA256: hash, loadContent: load}
	request := WikiCandidateGenerationRequest{RefreshID: "refresh_a", TenantID: "tenant_a", GeneratorAgentActorID: "agent_a", Mode: "update", BasePages: []WikiCandidateBasePage{{PageKey: "index.md", SizeBytes: int64(len(content)), SHA256: hash, loadContent: load}}, Changes: WikiCandidateSourceChanges{Modified: []WikiCandidateSource{source}, Removed: []WikiCandidateSourceReference{{DocumentID: "doc_removed", DocumentVersionID: "version_removed", Filename: "removed.txt"}}}}
	transport := wikiStreamTransport(func(r *http.Request) (*http.Response, error) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			return nil, err
		}
		if int64(len(body)) != r.ContentLength {
			t.Errorf("content length=%d body=%d", r.ContentLength, len(body))
		}
		var decoded nodeservicesinternal.WikiRefreshCandidateGenerationRequest
		decoder := json.NewDecoder(bytes.NewReader(body))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&decoded); err != nil {
			t.Error(err)
		}
		if decoded.Mode != "update" || len(decoded.Changes.Added) != 0 || len(decoded.Changes.Modified) != 1 || len(decoded.Changes.Removed) != 1 || len(decoded.BasePages) != 1 {
			t.Errorf("invalid frozen envelope: %+v", decoded)
		}
		if !bytes.Equal(decoded.Changes.Modified[0].Content, content) || !bytes.Equal(decoded.BasePages[0].MarkdownContent, content) || decoded.Changes.Modified[0].Filename != source.Filename {
			t.Error("frozen bytes or metadata changed")
		}
		return &http.Response{StatusCode: http.StatusServiceUnavailable, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{}`))}, nil
	})
	generator, err := NewHTTPWikiCandidateGenerator("http://wiki.invalid", "test-token", &http.Client{Transport: transport})
	if err != nil {
		t.Fatal(err)
	}
	_, err = generator.GenerateWikiCandidates(t.Context(), request)
	if !errors.Is(err, ErrRuntimeUnavailable) || reads != 2 {
		t.Fatalf("lazy reads=%d error=%v", reads, err)
	}
	request.BasePages[0].SizeBytes = 256 << 20
	reads = 0
	_, err = generator.GenerateWikiCandidates(t.Context(), request)
	if !errors.Is(err, ErrWikiCandidateInvalidRequest) || reads != 0 {
		t.Fatalf("oversize admission loaded content: reads=%d error=%v", reads, err)
	}
}

func TestWikiStreamingPreservesSourceFailureAndCancelsEarlyResponse(t *testing.T) {
	content := []byte("source")
	digest := sha256.Sum256(content)
	request := WikiCandidateGenerationRequest{RefreshID: "refresh_a", TenantID: "tenant_a", GeneratorAgentActorID: "agent_a", Mode: "initialize", Changes: WikiCandidateSourceChanges{Added: []WikiCandidateSource{{DocumentID: "doc_a", DocumentVersionID: "version_a", Filename: "source.txt", SizeBytes: int64(len(content)), SHA256: hex.EncodeToString(digest[:])}}}}
	t.Run("source read failure", func(t *testing.T) {
		request.Changes.Added[0].loadContent = func(context.Context) ([]byte, error) {
			return nil, &wikiSourceReadError{code: "object_mismatch", err: ErrVersionConflict}
		}
		generator, _ := NewHTTPWikiCandidateGenerator("http://wiki.invalid", "test-token", &http.Client{Transport: wikiStreamTransport(func(r *http.Request) (*http.Response, error) { _, err := io.Copy(io.Discard, r.Body); return nil, err })})
		_, err := generator.GenerateWikiCandidates(t.Context(), request)
		var sourceErr *wikiSourceReadError
		if !errors.As(err, &sourceErr) || sourceErr.code != "object_mismatch" || !errors.Is(err, ErrVersionConflict) {
			t.Fatalf("lost source error: %v", err)
		}
	})
	t.Run("early terminal response", func(t *testing.T) {
		request.Changes.Added[0].loadContent = func(ctx context.Context) ([]byte, error) { <-ctx.Done(); return nil, ctx.Err() }
		generator, _ := NewHTTPWikiCandidateGenerator("http://wiki.invalid", "test-token", &http.Client{Transport: wikiStreamTransport(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: http.StatusRequestEntityTooLarge, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"error":{"disposition":"terminal"}}`))}, nil
		})})
		_, err := generator.GenerateWikiCandidates(t.Context(), request)
		if !errors.Is(err, ErrWikiCandidateInvalidRequest) {
			t.Fatalf("early response=%v", err)
		}
	})
}

func TestWikiStreamingSendsSessionSources(t *testing.T) {
	room := []byte("## 2026-11-04T09:00:00Z · Ada\n\nMessage metadata: {\"message_id\":\"message_a\"}\n\nHello\n")
	recording := []byte("Transcript")
	session := func(content []byte, id string, routing WikiCandidateSession) WikiCandidateSource {
		digest := sha256.Sum256(content)
		routing.Date, routing.RoomID = "2026-11-04", "room_a"
		routing.RepresentedHumanActorID, routing.RepresentedHumanDisplayName = "actor_human_a", "Ada"
		return WikiCandidateSource{DocumentID: id, DocumentVersionID: hex.EncodeToString(digest[:]), Filename: "2026-11-04 Room.md",
			SizeBytes: int64(len(content)), SHA256: hex.EncodeToString(digest[:]), Content: content, Session: &routing}
	}
	sameText := session(room, "mis_000000000000000000000002", WikiCandidateSession{Kind: "room", SessionID: "room_a"})
	request := WikiCandidateGenerationRequest{RefreshID: "refresh_a", TenantID: "tenant_a", GeneratorAgentActorID: "agent_a", Mode: "initialize",
		Changes: WikiCandidateSourceChanges{Added: []WikiCandidateSource{
			session(room, "mis_000000000000000000000001", WikiCandidateSession{Kind: "room", SessionID: "room_a"}),
			sameText,
			session(recording, "mis_000000000000000000000003", WikiCandidateSession{Kind: "recording", SessionID: "capture_a",
				TranscriptDocumentID: "document_transcript", TranscriptDocumentVersionID: "version_transcript"}),
		}}}
	var decoded nodeservicesinternal.WikiRefreshCandidateGenerationRequest
	transport := wikiStreamTransport(func(r *http.Request) (*http.Response, error) {
		decoder := json.NewDecoder(r.Body)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&decoded); err != nil {
			t.Error(err)
		}
		return &http.Response{StatusCode: http.StatusServiceUnavailable, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{}`))}, nil
	})
	generator, err := NewHTTPWikiCandidateGenerator("http://wiki.invalid", "test-token", &http.Client{Transport: transport})
	if err != nil {
		t.Fatal(err)
	}
	// Two Sessions with the same text share a version; Documents never do.
	if _, err := generator.GenerateWikiCandidates(t.Context(), request); !errors.Is(err, ErrRuntimeUnavailable) {
		t.Fatalf("Session request was refused: %v", err)
	}
	added := decoded.Changes.Added
	if len(added) != 3 || added[0].Session == nil || added[0].Session.Kind != "room" || added[0].Session.SessionId != "room_a" ||
		added[0].Session.Date.String() != "2026-11-04" || added[0].Session.TranscriptDocumentId != nil ||
		added[2].Session == nil || added[2].Session.Kind != "recording" || added[2].Session.SessionId != "capture_a" ||
		added[2].Session.TranscriptDocumentId == nil || *added[2].Session.TranscriptDocumentId != "document_transcript" ||
		!bytes.Equal(added[0].Content, room) {
		t.Fatalf("Session routing was not sent: %+v", added)
	}
	first := request.Changes.Added[0].Session
	request.Changes.Added[0].Session, request.Changes.Added[1].Session = nil, nil
	if _, err := generator.GenerateWikiCandidates(t.Context(), request); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("two Documents shared a version: %v", err)
	}
	request.Changes.Added[0].Session, request.Changes.Added[1].Session = first, sameText.Session
	request.Changes.Added[2].Session.TranscriptDocumentID = ""
	if _, err := generator.GenerateWikiCandidates(t.Context(), request); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("a recording without its transcript was sent: %v", err)
	}
}
