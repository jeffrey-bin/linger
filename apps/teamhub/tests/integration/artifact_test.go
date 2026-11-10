package integration_test

import (
	"bytes"
	"context"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
)

func TestHumanDocumentCore(t *testing.T) {
	allowParallelIntegrationTest(t)
	artifactRoot := integrationArtifactRoot(t)
	databaseURL := newIntegrationDatabase(t)
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	application, err := newIntegrationApp(ctx, config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.ArtifactStorageRoot = artifactRoot
		c.ArtifactMaxBytes = 1 << 20
	}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
	alice := env.login("alice", alicePassword)
	unique := strings.ReplaceAll(time.Now().Format("150405.000000000"), ".", "")
	roomID := createPrivateRoom(t, env, alice, "Documents "+unique, "document-room-"+unique)

	t.Run("Document uploads reject invalid idempotency keys consistently", func(t *testing.T) {
		uploadPath := "/v0/rooms/" + roomID + "/documents/uploads"
		tests := []struct {
			name, method, path, key string
			payload                 any
		}{
			{name: "missing key", method: http.MethodPost, path: uploadPath},
			{name: "malformed key", method: http.MethodPost, path: uploadPath, key: strings.Repeat("a", 129)},
		}
		for _, test := range tests {
			t.Run(test.name, func(t *testing.T) {
				status, _, body := env.request(alice, test.method, test.path, test.payload, test.key)
				if status != http.StatusBadRequest || !bytes.Contains(body, []byte(`"code":"INVALID_IDEMPOTENCY_KEY"`)) {
					t.Fatalf("invalid idempotency key status=%d body=%s", status, body)
				}
			})
		}

		t.Run("key validation precedes a malformed body", func(t *testing.T) {
			request, err := http.NewRequest(http.MethodPost, server.URL+"/v0/rooms/"+roomID+"/documents/uploads", strings.NewReader("{"))
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Content-Type", "application/json")
			response, err := alice.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			var body bytes.Buffer
			if _, err = body.ReadFrom(response.Body); err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != http.StatusBadRequest || !bytes.Contains(body.Bytes(), []byte(`"code":"INVALID_IDEMPOTENCY_KEY"`)) {
				t.Fatalf("invalid idempotency key with malformed JSON status=%d body=%s", response.StatusCode, body.Bytes())
			}
		})
	})

	content := []byte("immutable report v1")
	fields := map[string]string{"filename": "report.txt", "representation_format": "plain_text", "media_type": "text/plain"}
	status, _, uploadBody := requestUnifiedDocumentUpload(t, env, alice, "human-upload-"+unique, fields, "report.txt", content)
	if status != http.StatusCreated {
		t.Fatalf("upload status=%d body=%s", status, uploadBody)
	}
	var first struct {
		ID             string `json:"id"`
		Title          string `json:"title"`
		CurrentVersion struct {
			ID            string `json:"id"`
			VersionNumber int    `json:"version_number"`
			SHA256        string `json:"sha256"`
		} `json:"current_version"`
	}
	decode(t, uploadBody, &first)
	if first.ID == "" || first.Title != "report.txt" || first.CurrentVersion.ID == "" ||
		first.CurrentVersion.VersionNumber != 1 || bytes.Contains(uploadBody, []byte("content_object_id")) {
		t.Fatalf("unexpected Human Document: %s", uploadBody)
	}
	status, replayHeaders, replayBody := requestUnifiedDocumentUpload(t, env, alice, "human-upload-"+unique, fields, "report.txt", content)
	if status != http.StatusCreated || replayHeaders.Get("Idempotent-Replay") != "true" || !bytes.Equal(replayBody, uploadBody) {
		t.Fatalf("upload replay status=%d headers=%v body=%s", status, replayHeaders, replayBody)
	}
	status, _, _ = requestUnifiedDocumentUpload(t, env, alice, "human-upload-"+unique, fields, "report.txt", []byte("different"))
	if status != http.StatusConflict {
		t.Fatalf("changed upload replay status=%d want=409", status)
	}

	status, _, secondBody := requestUnifiedDocumentVersionUpload(t, env, alice, first.ID, "human-version-"+unique,
		map[string]string{"expected_current_version_id": first.CurrentVersion.ID, "filename": "report-v2.txt", "representation_format": "plain_text", "media_type": "text/plain"},
		"report-v2.txt", []byte("version two"))
	if status != http.StatusCreated {
		t.Fatalf("append version status=%d body=%s", status, secondBody)
	}
	var second struct {
		ID            string `json:"id"`
		VersionNumber int    `json:"version_number"`
		Source        string `json:"source"`
	}
	decode(t, secondBody, &second)
	if second.ID == "" || second.VersionNumber != 2 || second.Source != "replacement_upload" {
		t.Fatalf("unexpected second version: %s", secondBody)
	}
	status, _, renamedBody := env.request(alice, http.MethodPatch, "/v0/documents/"+first.ID,
		map[string]any{"title": "renamed report.txt"}, "document-rename-"+unique)
	if status != http.StatusOK || !bytes.Contains(renamedBody, []byte(`"title":"renamed report.txt"`)) {
		t.Fatalf("rename status=%d body=%s", status, renamedBody)
	}

	duplicatePath := "/v0/documents/" + first.ID + "/duplicates"
	status, _, duplicateBody := env.request(alice, http.MethodPost, duplicatePath, map[string]any{}, "document-duplicate-"+unique)
	if status != http.StatusCreated {
		t.Fatalf("duplicate status=%d body=%s", status, duplicateBody)
	}
	var duplicate struct {
		ID             string `json:"id"`
		CurrentVersion struct {
			ID     string `json:"id"`
			SHA256 string `json:"sha256"`
		} `json:"current_version"`
	}
	decode(t, duplicateBody, &duplicate)
	if duplicate.ID == first.ID || duplicate.CurrentVersion.ID == second.ID || duplicate.CurrentVersion.SHA256 == "" {
		t.Fatalf("unexpected duplicate: %s", duplicateBody)
	}
	status, _, duplicateContent := env.request(alice, http.MethodGet, "/v0/document-versions/"+duplicate.CurrentVersion.ID+"/content", nil, "")
	if status != http.StatusOK || !bytes.Equal(duplicateContent, []byte("version two")) {
		t.Fatalf("duplicate did not preserve current Version status=%d body=%q", status, duplicateContent)
	}

	status, _, versionPage := env.request(alice, http.MethodGet, "/v0/documents/"+first.ID+"/versions", nil, "")
	if status != http.StatusOK || !bytes.Contains(versionPage, []byte(first.CurrentVersion.ID)) || !bytes.Contains(versionPage, []byte(second.ID)) {
		t.Fatalf("versions status=%d body=%s", status, versionPage)
	}
	status, _, downloaded := env.request(alice, http.MethodGet, "/v0/document-versions/"+first.CurrentVersion.ID+"/content", nil, "")
	if status != http.StatusOK || !bytes.Equal(downloaded, content) {
		t.Fatalf("download status=%d body=%q", status, downloaded)
	}
	contentPath := "/v0/document-versions/" + first.CurrentVersion.ID + "/content"
	status, headers, downloaded := artifactContentRequest(t, alice, server.URL+contentPath, http.MethodHead, nil)
	if status != http.StatusOK || len(downloaded) != 0 || headers.Get("Accept-Ranges") != "bytes" || headers.Get("Content-Length") != fmt.Sprint(len(content)) || headers.Get("ETag") == "" || !strings.HasPrefix(headers.Get("Content-Disposition"), "attachment;") || headers.Get("X-Content-Type-Options") != "nosniff" || headers.Get("Content-Security-Policy") != "sandbox; default-src 'none'" {
		t.Fatalf("head content status=%d headers=%v body=%q", status, headers, downloaded)
	}
	etag := headers.Get("ETag")
	status, headers, downloaded = artifactContentRequest(t, alice, server.URL+contentPath, http.MethodGet, map[string]string{"Range": "bytes=2-8"})
	if status != http.StatusPartialContent || !bytes.Equal(downloaded, content[2:9]) || headers.Get("Content-Range") != fmt.Sprintf("bytes 2-8/%d", len(content)) || headers.Get("Content-Length") != "7" || headers.Get("ETag") != etag {
		t.Fatalf("range content status=%d headers=%v body=%q", status, headers, downloaded)
	}
	status, headers, downloaded = artifactContentRequest(t, alice, server.URL+contentPath, http.MethodGet, map[string]string{"Range": "bytes=-4"})
	if status != http.StatusPartialContent || !bytes.Equal(downloaded, content[len(content)-4:]) || headers.Get("Content-Range") != fmt.Sprintf("bytes %d-%d/%d", len(content)-4, len(content)-1, len(content)) {
		t.Fatalf("suffix range status=%d headers=%v body=%q", status, headers, downloaded)
	}
	status, _, downloaded = artifactContentRequest(t, alice, server.URL+contentPath, http.MethodGet, map[string]string{"Range": "bytes=2-8", "If-Range": `"different"`})
	if status != http.StatusOK || !bytes.Equal(downloaded, content) {
		t.Fatalf("mismatched if-range status=%d body=%q", status, downloaded)
	}
	status, headers, downloaded = artifactContentRequest(t, alice, server.URL+contentPath, http.MethodGet, map[string]string{"Range": "bytes=999-1000", "If-Range": etag})
	if status != http.StatusRequestedRangeNotSatisfiable || len(downloaded) != 0 || headers.Get("Content-Range") != fmt.Sprintf("bytes */%d", len(content)) {
		t.Fatalf("unsatisfied range status=%d headers=%v body=%q", status, headers, downloaded)
	}
	status, _, _ = artifactContentRequest(t, alice, server.URL+contentPath, http.MethodGet, map[string]string{"Range": "bytes=0-1,4-5"})
	if status != http.StatusRequestedRangeNotSatisfiable {
		t.Fatalf("multi-range status=%d want=%d", status, http.StatusRequestedRangeNotSatisfiable)
	}
	revalidate := map[string]string{"If-None-Match": etag}
	status, headers, downloaded = artifactContentRequest(t, alice, server.URL+contentPath, http.MethodGet, revalidate)
	if status != http.StatusNotModified || len(downloaded) != 0 || headers.Get("ETag") != etag || headers.Get("Cache-Control") != "private, no-cache" {
		t.Fatalf("revalidated content status=%d headers=%v body=%q", status, headers, downloaded)
	}
	status, _, downloaded = artifactContentRequest(t, alice, server.URL+"/v0/documents/"+first.ID+"/downloads", http.MethodGet, map[string]string{"If-None-Match": "*"})
	if status != http.StatusOK || len(downloaded) == 0 {
		t.Fatalf("latest download ignores If-None-Match status=%d body=%q", status, downloaded)
	}
	loggedOut := env.login("alice", alicePassword)
	status, _, _ = artifactContentRequest(t, loggedOut, server.URL+contentPath, http.MethodGet, revalidate)
	if status != http.StatusNotModified {
		t.Fatalf("second session revalidation status=%d want=304", status)
	}
	if status, _, body := env.request(loggedOut, http.MethodPost, "/v0/auth/logout", nil, ""); status != http.StatusNoContent {
		t.Fatalf("logout status=%d body=%s", status, body)
	}
	status, _, _ = artifactContentRequest(t, loggedOut, server.URL+contentPath, http.MethodGet, revalidate)
	if status != http.StatusUnauthorized {
		t.Fatalf("revalidation after logout status=%d want=401", status)
	}
	status, _, _ = env.request(alice, http.MethodDelete, "/v0/documents/"+first.ID, nil, "document-trash-"+unique)
	if status != http.StatusNoContent {
		t.Fatalf("trash Document status=%d", status)
	}
	status, _, trashingBody := env.request(alice, http.MethodGet, "/v0/documents/"+first.ID, nil, "")
	if status != http.StatusNotFound {
		t.Fatalf("trashing Document status=%d body=%s", status, trashingBody)
	}
	if _, err := pool.Exec(ctx, "update document_versions set sha256=$2 where id=$1", first.CurrentVersion.ID, strings.Repeat("0", 64)); err == nil {
		t.Fatal("immutable Document Version accepted a metadata update")
	}
}

func artifactContentRequest(t *testing.T, client *http.Client, url, method string, headers map[string]string) (int, http.Header, []byte) {
	t.Helper()
	request, err := http.NewRequest(method, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var body bytes.Buffer
	if _, err := body.ReadFrom(response.Body); err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, response.Header, body.Bytes()
}

func artifactUpload(t *testing.T, client *http.Client, url, key string, fields map[string]string, content []byte) (int, http.Header, []byte) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for name, value := range fields {
		if err := writer.WriteField(name, value); err != nil {
			t.Fatal(err)
		}
	}
	part, err := writer.CreateFormFile("content", fields["filename"])
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, url, &body)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.Header.Set("Idempotency-Key", key)
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	responseBody := new(bytes.Buffer)
	if _, err := responseBody.ReadFrom(response.Body); err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, response.Header, responseBody.Bytes()
}
