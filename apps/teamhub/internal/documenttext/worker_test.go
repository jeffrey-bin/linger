package documenttext

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

type fakeQueries struct {
	sources map[string]store.GetCurrentDocumentTextSourceRow
	upserts []store.UpsertDocumentTextParams
	// rows is returned by every upsert; zero simulates a superseded source.
	rows int64
}

func (f *fakeQueries) GetCurrentDocumentTextSource(_ context.Context, documentID string) (store.GetCurrentDocumentTextSourceRow, error) {
	source, ok := f.sources[documentID]
	if !ok {
		return store.GetCurrentDocumentTextSourceRow{}, pgx.ErrNoRows
	}
	return source, nil
}

func (f *fakeQueries) UpsertDocumentText(_ context.Context, params store.UpsertDocumentTextParams) (int64, error) {
	f.upserts = append(f.upserts, params)
	return f.rows, nil
}

// syncJob builds the River job that one attempt of a sync would receive.
func syncJob(documentID string, attempt int) *river.Job[SyncArgs] {
	return &river.Job[SyncArgs]{
		JobRow: &rivertype.JobRow{Attempt: attempt},
		Args:   SyncArgs{DocumentID: documentID},
	}
}

type fakeDocuments struct {
	markdown  map[string][]byte
	renderErr error
	versions  map[string]document.VersionContent
	renders   *int
}

func (f fakeDocuments) LatestDocumentRuntimeProjection(_ context.Context, documentID string) (document.LatestRuntimeProjection, error) {
	if f.renders != nil {
		*f.renders++
	}
	if f.renderErr != nil {
		return document.LatestRuntimeProjection{}, f.renderErr
	}
	return document.LatestRuntimeProjection{DocumentID: documentID, Bytes: f.markdown[documentID]}, nil
}

func (f fakeDocuments) GetTenantVersionContent(_ context.Context, _, versionID string) (document.VersionContent, error) {
	content, ok := f.versions[versionID]
	if !ok {
		return document.VersionContent{}, document.ErrNotFound
	}
	return content, nil
}

type fakeObjects map[string]string

func (f fakeObjects) Open(_ context.Context, key string) (io.ReadCloser, error) {
	body, ok := f[key]
	if !ok {
		return nil, errors.New("missing object")
	}
	return io.NopCloser(strings.NewReader(body)), nil
}

func newTestNormalizer(t *testing.T, handler http.HandlerFunc) *NormalizerClient {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client, err := NewNormalizerClient(server.URL, "token", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func TestWorkerSyncsNativeAndFileDocuments(t *testing.T) {
	t.Parallel()
	queries := &fakeQueries{rows: 1, sources: map[string]store.GetCurrentDocumentTextSourceRow{
		"doc_native": {TenantID: "tenant_a", SourceKind: "native_body", SourceID: "7"},
		"doc_file":   {TenantID: "tenant_a", SourceKind: "file_version", SourceID: "ver_1"},
		"doc_scan":   {TenantID: "tenant_a", SourceKind: "file_version", SourceID: "ver_2"},
	}}
	documents := fakeDocuments{
		markdown: map[string][]byte{"doc_native": []byte("# Release checklist\n\n- **Freeze** at 4pm")},
		versions: map[string]document.VersionContent{
			"ver_1": {Version: document.Version{ID: "ver_1", Filename: "invoice.pdf", RepresentationFormat: "pdf", MediaType: "application/pdf", SizeBytes: 4}, ObjectKey: "obj_pdf"},
			"ver_2": {Version: document.Version{ID: "ver_2", MediaType: "application/pdf", SizeBytes: 4}, ObjectKey: "obj_scan"},
		},
	}
	objects := fakeObjects{"obj_pdf": "%PDF", "obj_scan": "SCAN"}
	normalizer := newTestNormalizer(t, func(writer http.ResponseWriter, request *http.Request) {
		source, _ := io.ReadAll(request.Body)
		if string(source) == "SCAN" {
			writer.WriteHeader(http.StatusUnprocessableEntity)
			_, _ = writer.Write([]byte(`{"error":{"code":"DOCUMENT_SOURCE_EMPTY"}}`))
			return
		}
		if request.Header.Get("X-Source-Media-Type") != "application/pdf" ||
			request.Header.Get("X-Source-Filename") != "invoice.pdf" ||
			request.Header.Get("X-Source-Representation-Format") != "pdf" {
			t.Errorf("source headers = %v", request.Header)
		}
		_, _ = writer.Write([]byte("Invoice\x00total: **1,200 USD**\n\n| item | qty |\n| --- | --- |\n| widget | 3 |"))
	})
	worker := NewWorker(queries, documents, objects, normalizer, nil)

	for documentID := range queries.sources {
		if err := worker.Work(context.Background(), syncJob(documentID, 1)); err != nil {
			t.Fatalf("sync %s: %v", documentID, err)
		}
	}
	if len(queries.upserts) != 3 {
		t.Fatalf("upserts=%d want 3", len(queries.upserts))
	}
	byDocument := make(map[string]store.UpsertDocumentTextParams)
	for _, upsert := range queries.upserts {
		byDocument[upsert.DocumentID] = upsert
	}
	if got := byDocument["doc_native"]; got.Status != StatusReady || got.SourceID != "7" || got.SourceKind != "native_body" ||
		got.SearchText != "Release checklist Freeze at 4pm" || got.Markdown != "# Release checklist\n\n- **Freeze** at 4pm" ||
		got.MarkdownSha256.String != "a6ce43e2dd71ed3f67404923787edc472c04bdd102f2bdcc0aabb764ae8c8ba6" ||
		got.LongestLineBytes != 19 || got.Scanned {
		t.Fatalf("native upsert = %+v", got)
	}
	if got := byDocument["doc_file"]; got.Status != StatusReady || got.SourceID != "ver_1" ||
		got.SearchText != "Invoice total: 1,200 USD item qty widget 3" || !got.MarkdownSha256.Valid || got.Scanned {
		t.Fatalf("file upsert = %+v", got)
	}
	if got := byDocument["doc_scan"]; got.Status != StatusNoText || got.SearchText != "" || got.Markdown != "" || got.MarkdownSha256.Valid {
		t.Fatalf("scan upsert = %+v", got)
	}
}

func TestWorkerRecordsEveryFailureAndRetriesUntilTheFinalAttempt(t *testing.T) {
	t.Parallel()
	queries := &fakeQueries{rows: 1, sources: map[string]store.GetCurrentDocumentTextSourceRow{
		"doc_native": {TenantID: "tenant_a", SourceKind: "native_body", SourceID: "9"},
	}}
	documents := fakeDocuments{renderErr: document.ErrRuntimeUnavailable}
	var nilClient *NormalizerClient
	worker := NewWorker(queries, documents, fakeObjects{}, nilClient, nil)

	err := worker.Work(context.Background(), syncJob("doc_native", 1))
	if err == nil || !errors.Is(err, document.ErrRuntimeUnavailable) {
		t.Fatalf("a non-final render failure must be returned for River retry, got %v", err)
	}
	// Attempt 5 uses the last delay in the schedule (12h); attempt 6 is final.
	if delay := time.Until(worker.NextRetry(syncJob("doc_native", 5))); delay < 11*time.Hour || delay > 13*time.Hour {
		t.Fatalf("retry delay = %s", delay)
	}
	if err := worker.Work(context.Background(), syncJob("doc_native", maxSyncAttempts)); err != nil {
		t.Fatalf("the final attempt must finish without error, got %v", err)
	}
	// Both attempts record the failure against the version.
	if len(queries.upserts) != 2 {
		t.Fatalf("upserts=%d want 2", len(queries.upserts))
	}
	for _, failure := range queries.upserts {
		if failure.Status != StatusFailed || failure.SourceID != "9" || failure.SourceKind != "native_body" || failure.Markdown != "" {
			t.Fatalf("recorded failure = %+v", failure)
		}
	}
}

func TestWorkerSnoozesFileVersionsWithoutNormalizer(t *testing.T) {
	t.Parallel()
	queries := &fakeQueries{rows: 1, sources: map[string]store.GetCurrentDocumentTextSourceRow{
		"doc_file": {TenantID: "tenant_a", SourceKind: "file_version", SourceID: "ver_1"},
	}}
	worker := NewWorker(queries, fakeDocuments{}, fakeObjects{}, nil, nil)
	var snooze *rivertype.JobSnoozeError
	if err := worker.Work(context.Background(), syncJob("doc_file", 1)); !errors.As(err, &snooze) {
		t.Fatalf("a file Version without a normalizer must wait for one: %v", err)
	}
	if len(queries.upserts) != 0 {
		t.Fatalf("upserts=%+v", queries.upserts)
	}
}

func TestWorkerSupersededSyncFinishesWithoutError(t *testing.T) {
	t.Parallel()
	queries := &fakeQueries{rows: 0, sources: map[string]store.GetCurrentDocumentTextSourceRow{
		"doc_native": {TenantID: "tenant_a", SourceKind: "native_body", SourceID: "7"},
	}}
	documents := fakeDocuments{markdown: map[string][]byte{"doc_native": []byte("hello")}}
	worker := NewWorker(queries, documents, fakeObjects{}, nil, nil)
	if err := worker.Work(context.Background(), syncJob("doc_native", 1)); err != nil {
		t.Fatalf("a superseded sync writes nothing and must not retry: %v", err)
	}
}

func TestWorkerSkipsDocumentWithoutCurrentSource(t *testing.T) {
	t.Parallel()
	queries := &fakeQueries{rows: 1}
	worker := NewWorker(queries, fakeDocuments{}, fakeObjects{}, nil, nil)
	if err := worker.Work(context.Background(), syncJob("doc_gone", 1)); err != nil {
		t.Fatalf("a Document without a current source has nothing to sync: %v", err)
	}
	if len(queries.upserts) != 0 {
		t.Fatalf("upserts=%+v", queries.upserts)
	}
}

// A PDF whose pages draw no text was read by OCR alone; its text says so.
func TestWorkerMarksPDFTextsReadByOCRAlone(t *testing.T) {
	t.Parallel()
	scan := pdfFile("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>",
		"q 200 0 0 200 0 0 cm /Im0 Do Q",
		"<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\xff\nendstream")
	queries := &fakeQueries{rows: 1, sources: map[string]store.GetCurrentDocumentTextSourceRow{
		"doc_scan": {TenantID: "tenant_a", SourceKind: "file_version", SourceID: "ver_scan"},
	}}
	documents := fakeDocuments{versions: map[string]document.VersionContent{
		"ver_scan": {Version: document.Version{ID: "ver_scan", Filename: "receipt.pdf", MediaType: "application/pdf", SizeBytes: int64(len(scan))}, ObjectKey: "obj_scan"},
	}}
	normalizer := newTestNormalizer(t, func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte("RECEIPT total 12"))
	})
	worker := NewWorker(queries, documents, fakeObjects{"obj_scan": string(scan)}, normalizer, nil)
	if err := worker.Work(context.Background(), syncJob("doc_scan", 1)); err != nil {
		t.Fatal(err)
	}
	if len(queries.upserts) != 1 || queries.upserts[0].Status != StatusReady || !queries.upserts[0].Scanned ||
		queries.upserts[0].LongestLineBytes != 16 {
		t.Fatalf("upserts=%+v", queries.upserts)
	}
}
