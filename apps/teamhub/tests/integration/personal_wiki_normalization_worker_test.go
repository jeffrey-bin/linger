package integration_test

import (
	"bytes"
	"context"
	"encoding/hex"
	"net/http"
	"strings"
	"testing"
	"time"
)

type unifiedWikiSourceUpload struct {
	ID             string `json:"id"`
	Title          string `json:"title"`
	Format         string `json:"format"`
	CurrentVersion *struct {
		ID string `json:"id"`
	} `json:"current_version"`
}

func TestPersonalWikiNormalizationWorkerLeavesSuspendedUnifiedSourceOutOfWiki(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	uploaded := uploadUnifiedWikiSource(t, env, alice, "suspended.txt", "plain_text", "text/plain",
		[]byte("source removed from the Wiki context"))

	result, err := env.pool.Exec(context.Background(), `UPDATE document_context_bindings
		SET status='suspended',access_epoch=access_epoch+1,updated_at=clock_timestamp()
		WHERE document_id=$1 AND binding_kind='wiki_source' AND status='active'`, uploaded.ID)
	if err != nil {
		t.Fatal(err)
	}
	if result.RowsAffected() != 1 {
		t.Fatalf("suspended bindings=%d want=1", result.RowsAffected())
	}

	status, _, body := env.request(alice, http.MethodGet,
		"/v0/tenants/"+acmeTenant+"/personal-wiki/documents", nil, "")
	if status != http.StatusOK || strings.Contains(string(body), uploaded.ID) {
		t.Fatalf("suspended source remained in Wiki list: status=%d body=%s", status, body)
	}

	status, _, content := requestUnifiedDocumentVersionContent(t, env, alice, http.MethodGet,
		"/v0/document-versions/"+uploaded.CurrentVersion.ID+"/content", nil)
	if status != http.StatusOK || string(content) != "source removed from the Wiki context" {
		t.Fatalf("owner stable Version read status=%d body=%q", status, content)
	}
}

func TestPersonalWikiUnifiedSourceFreezesExactBytes(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	for _, testCase := range []struct {
		name, filename, format, mediaType, wantMediaType string
		content                                          []byte
	}{
		{name: "text", filename: "worker.txt", format: "plain_text", mediaType: "text/plain; charset=utf-8", wantMediaType: "text/plain", content: []byte("plain source\nwith UTF-8 \u4e2d\u6587\n")},
		{name: "markdown", filename: "notes.md", format: "markdown", mediaType: "text/markdown", wantMediaType: "text/markdown", content: []byte("# Notes\nexact markdown Wiki source\n")},
		{name: "PDF", filename: "source.pdf", format: "pdf", mediaType: "application/pdf", wantMediaType: "application/pdf", content: []byte("%PDF-1.7\n% exact immutable source\n")},
		{name: "binary", filename: "opaque.data", format: "binary", mediaType: "application/octet-stream", wantMediaType: "application/octet-stream", content: []byte{0x00, 0xff, 0x2a, 0x80, 0x00, 0x7f}},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			uploaded := uploadUnifiedWikiSource(t, env, alice, testCase.filename, testCase.format, testCase.mediaType, testCase.content)
			assertUnifiedWikiVersionContent(t, env, alice, uploaded, testCase.content, testCase.wantMediaType)
		})
	}
}

func TestPersonalWikiMaterializedPathConflictSettlesTargetAndDoesNotBlockNextActor(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	content := []byte("same filename and bytes, distinct user commands")
	first := uploadUnifiedWikiSourceWithKey(t, env, alice, "same-name-first", "same.txt",
		"plain_text", "text/plain", content)
	second := uploadUnifiedWikiSourceWithKey(t, env, alice, "same-name-second", "same.txt",
		"plain_text", "text/plain", content)

	if first.ID == second.ID || first.CurrentVersion.ID == second.CurrentVersion.ID {
		t.Fatalf("distinct uploads reused identity: first=%s/%s second=%s/%s",
			first.ID, first.CurrentVersion.ID, second.ID, second.CurrentVersion.ID)
	}
	var documents, versions, placements, bindings int
	if err := env.pool.QueryRow(context.Background(), `SELECT
		(SELECT count(*) FROM documents WHERE id=ANY($1)),
		(SELECT count(*) FROM document_versions WHERE document_id=ANY($1)),
		(SELECT count(*) FROM document_placements WHERE document_id=ANY($1)),
		(SELECT count(*) FROM document_context_bindings
		 WHERE document_id=ANY($1) AND binding_kind='wiki_source' AND status='active')`,
		[]string{first.ID, second.ID}).Scan(&documents, &versions, &placements, &bindings); err != nil {
		t.Fatal(err)
	}
	if documents != 2 || versions != 2 || placements != 2 || bindings != 2 {
		t.Fatalf("same-name aggregates documents=%d versions=%d placements=%d bindings=%d",
			documents, versions, placements, bindings)
	}
}

func uploadUnifiedWikiSource(
	t *testing.T,
	env *testEnv,
	client *http.Client,
	filename, representationFormat, mediaType string,
	content []byte,
) unifiedWikiSourceUpload {
	t.Helper()
	suffix := hex.EncodeToString([]byte(time.Now().UTC().Format("150405.000000000")))
	return uploadUnifiedWikiSourceWithKey(t, env, client, "unified-wiki-upload-"+suffix,
		filename, representationFormat, mediaType, content)
}

func uploadUnifiedWikiSourceWithKey(
	t *testing.T,
	env *testEnv,
	client *http.Client,
	idempotencyKey, filename, representationFormat, mediaType string,
	content []byte,
) unifiedWikiSourceUpload {
	t.Helper()
	status, _, body := env.request(client, http.MethodGet,
		"/v0/tenants/"+acmeTenant+"/personal-wiki", nil, "")
	if status != http.StatusOK {
		t.Fatalf("ensure Personal Wiki status=%d body=%s", status, body)
	}
	status, headers, body := requestUnifiedDocumentMultipart(t, env, client,
		"/v0/tenants/"+acmeTenant+"/personal-wiki/documents/uploads", idempotencyKey,
		map[string]string{
			"filename": filename, "representation_format": representationFormat, "media_type": mediaType,
		}, filename, content)
	if status != http.StatusCreated || headers.Get("Idempotent-Replay") != "" {
		t.Fatalf("Wiki source upload status=%d replay=%q body=%s",
			status, headers.Get("Idempotent-Replay"), body)
	}
	var uploaded unifiedWikiSourceUpload
	decode(t, body, &uploaded)
	if uploaded.ID == "" || uploaded.Title != filename || uploaded.Format != representationFormat ||
		uploaded.CurrentVersion == nil || uploaded.CurrentVersion.ID == "" {
		t.Fatalf("Wiki source upload=%+v body=%s", uploaded, body)
	}
	return uploaded
}

func assertUnifiedWikiVersionContent(
	t *testing.T,
	env *testEnv,
	client *http.Client,
	uploaded unifiedWikiSourceUpload,
	want []byte,
	wantMediaType string,
) {
	t.Helper()
	status, headers, body := requestUnifiedDocumentVersionContent(t, env, client, http.MethodGet,
		"/v0/document-versions/"+uploaded.CurrentVersion.ID+"/content", nil)
	if status != http.StatusOK || !bytes.Equal(body, want) ||
		!strings.HasPrefix(headers.Get("Content-Type"), wantMediaType) {
		t.Fatalf("Version content status=%d media_type=%q equal=%t body=%q",
			status, headers.Get("Content-Type"), bytes.Equal(body, want), body)
	}
}
