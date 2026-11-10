package integration_test

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
)

type documentPreviewSessionResponse struct {
	PreviewURL string    `json:"preview_url"`
	ExpiresAt  time.Time `json:"expires_at"`
}

type previewDocumentResponse struct {
	ID             string `json:"id"`
	CurrentVersion *struct {
		ID string `json:"id"`
	} `json:"current_version"`
}

func TestDocumentFolderPreview(t *testing.T) {
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
	var storedPreviewTables int
	if err := pool.QueryRow(ctx, `SELECT
		(to_regclass('document_preview_sessions') IS NOT NULL)::int+
		(to_regclass('document_preview_files') IS NOT NULL)::int`).Scan(&storedPreviewTables); err != nil {
		t.Fatal(err)
	}
	if storedPreviewTables != 0 {
		t.Fatalf("stored preview tables=%d want=0", storedPreviewTables)
	}
	alice := env.login("alice", alicePassword)
	unique := strings.ReplaceAll(time.Now().Format("150405.000000000"), ".", "")

	status, _, folderBody := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/me/document-folders",
		map[string]any{"name": "site"}, "preview-folder-"+unique)
	if status != http.StatusCreated {
		t.Fatalf("create preview Folder status=%d body=%s", status, folderBody)
	}
	var folder struct {
		ID string `json:"id"`
	}
	decode(t, folderBody, &folder)

	indexV1 := uploadPreviewDocument(t, env, alice, "preview-index-"+unique, folder.ID,
		"index.html", "text/html", []byte(`<script type="module" src="./app.js"></script>`))
	appV1 := uploadPreviewDocument(t, env, alice, "preview-app-"+unique, folder.ID,
		"app.js", "text/javascript", []byte(`document.body.textContent = "v1";`))
	_ = uploadPreviewDocument(t, env, alice, "preview-secret-"+unique, "",
		"secret.txt", "text/plain", []byte("outside preview root"))
	status, _, assetsBody := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/me/document-folders",
		map[string]any{"name": "assets", "parent_id": folder.ID}, "preview-assets-folder-"+unique)
	if status != http.StatusCreated {
		t.Fatalf("create nested preview Folder status=%d body=%s", status, assetsBody)
	}
	var assetsFolder struct {
		ID string `json:"id"`
	}
	decode(t, assetsBody, &assetsFolder)
	_ = uploadPreviewDocument(t, env, alice, "preview-style-"+unique, assetsFolder.ID,
		"style.css", "text/css", []byte("body { color: red; }"))

	t.Run("duplicate root filenames keep the exact Message attachment entry previewable", func(t *testing.T) {
		_ = uploadPreviewDocument(t, env, alice, "preview-frontend-first-"+unique, "",
			"frontend.md", "text/markdown", []byte("# First frontend"))
		roomID := createPrivateRoom(t, env, alice, "Duplicate preview "+unique, "preview-duplicate-room-"+unique)
		upload := uploadMessageAttachment(t, alice, server.URL, roomID,
			"preview-frontend-message-upload-"+unique, "frontend.md", []byte("# Message frontend"))
		status, _, messageBody := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/messages", map[string]any{
			"raw_message": "Review frontend.", "segments": []map[string]any{{"type": "text", "content": "Review frontend."}},
			"attachment_upload_ids": []string{upload.ID},
		}, "preview-frontend-message-"+unique)
		if status != http.StatusCreated {
			t.Fatalf("create frontend attachment Message status=%d body=%s", status, messageBody)
		}
		var message attachmentMessageResponse
		decode(t, messageBody, &message)
		if len(message.Attachments) != 1 {
			t.Fatalf("frontend attachment Message=%s", messageBody)
		}
		status, _, previewBody := env.request(alice, http.MethodPost,
			"/v0/document-versions/"+message.Attachments[0].DocumentVersionID+"/preview-sessions", map[string]any{}, "")
		if status != http.StatusCreated {
			t.Fatalf("create duplicate-name preview Session status=%d body=%s", status, previewBody)
		}
		var session documentPreviewSessionResponse
		decode(t, previewBody, &session)
		if !strings.HasSuffix(session.PreviewURL, "/frontend.md") {
			t.Fatalf("duplicate-name preview URL=%q", session.PreviewURL)
		}
		previewURL, err := url.Parse(session.PreviewURL)
		if err != nil {
			t.Fatal(err)
		}
		status, _, content := documentPreviewContentRequest(t, server.URL+previewURL.Path, http.MethodGet, nil)
		if status != http.StatusOK || !bytes.Equal(content, []byte("# Message frontend")) {
			t.Fatalf("duplicate-name exact entry status=%d body=%q", status, content)
		}
	})

	t.Run("unrelated invalid sibling does not block a valid entry", func(t *testing.T) {
		status, _, invalidFolderBody := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/me/document-folders",
			map[string]any{"name": "percent%folder"}, "preview-invalid-folder-"+unique)
		if status != http.StatusCreated {
			t.Fatalf("create invalid-path sibling Folder status=%d body=%s", status, invalidFolderBody)
		}
		var invalidFolder struct {
			ID string `json:"id"`
		}
		decode(t, invalidFolderBody, &invalidFolder)
		_ = uploadPreviewDocument(t, env, alice, "preview-invalid-child-"+unique, invalidFolder.ID,
			"ignored.txt", "text/plain", []byte("unrelated invalid sibling"))
		entry := uploadPreviewDocument(t, env, alice, "preview-safe-entry-"+unique, "",
			"safe.md", "text/markdown", []byte("# Safe entry"))
		status, _, previewBody := env.request(alice, http.MethodPost,
			"/v0/document-versions/"+entry.CurrentVersion.ID+"/preview-sessions", map[string]any{}, "")
		if status != http.StatusCreated {
			t.Fatalf("create valid-entry preview Session status=%d body=%s", status, previewBody)
		}
	})

	status, _, createBody := env.request(alice, http.MethodPost,
		"/v0/document-versions/"+indexV1.CurrentVersion.ID+"/preview-sessions", map[string]any{}, "")
	if status != http.StatusCreated {
		t.Fatalf("create preview Session status=%d body=%s", status, createBody)
	}
	var preview documentPreviewSessionResponse
	decode(t, createBody, &preview)
	previewURL, err := url.Parse(preview.PreviewURL)
	if err != nil || !preview.ExpiresAt.After(time.Now()) ||
		!strings.HasSuffix(previewURL.Path, "/index.html") {
		t.Fatalf("invalid preview Session response=%s error=%v", createBody, err)
	}

	status, _, replacementBody := requestUnifiedDocumentVersionUpload(t, env, alice,
		appV1.ID, "preview-app-v2-"+unique, map[string]string{
			"expected_current_version_id": appV1.CurrentVersion.ID,
			"filename":                    "app.js", "representation_format": "plain_text", "media_type": "text/javascript",
		}, "app.js", []byte(`document.body.textContent = "v2";`))
	if status != http.StatusCreated {
		t.Fatalf("append app.js V2 status=%d body=%s", status, replacementBody)
	}

	previewBasePath := strings.TrimSuffix(previewURL.Path, "/index.html")
	status, headers, body := documentPreviewContentRequest(t, server.URL+previewURL.Path, http.MethodGet, nil)
	if status != http.StatusOK || !bytes.Equal(body, []byte(`<script type="module" src="./app.js"></script>`)) {
		t.Fatalf("preview entry status=%d body=%q", status, body)
	}
	assertDocumentPreviewHeaders(t, headers)
	status, headers, body = documentPreviewContentRequest(t, server.URL+previewBasePath+"/app.js", http.MethodGet, nil)
	if status != http.StatusOK || !bytes.Equal(body, []byte(`document.body.textContent = "v2";`)) {
		t.Fatalf("current dependency status=%d body=%q", status, body)
	}
	assertDocumentPreviewHeaders(t, headers)
	status, _, body = documentPreviewContentRequest(t, server.URL+previewBasePath+"/assets/style.css", http.MethodGet, nil)
	if status != http.StatusOK || !bytes.Equal(body, []byte("body { color: red; }")) {
		t.Fatalf("nested dependency status=%d body=%q", status, body)
	}
	status, _, body = documentPreviewContentRequest(t, server.URL+previewBasePath+"/app.js", http.MethodGet,
		map[string]string{"Range": "bytes=0-7"})
	if status != http.StatusPartialContent || !bytes.Equal(body, []byte("document")) {
		t.Fatalf("preview range status=%d body=%q", status, body)
	}
	for _, requestPath := range []string{
		previewBasePath + "/missing.js", previewBasePath + "/%2e%2e/secret.txt",
		previewBasePath + "/..%252fsecret.txt", previewBasePath + "/folder%5c..%5csecret.txt",
		previewBasePath + "/secret.txt", previewBasePath + "/assets",
	} {
		status, _, _ = documentPreviewContentRequest(t, server.URL+requestPath, http.MethodGet, nil)
		if status != http.StatusNotFound {
			t.Fatalf("bounded preview path %q status=%d want=404", requestPath, status)
		}
	}

	token := strings.Split(strings.TrimPrefix(previewURL.Path, "/v0/document-previews/"), "/")[0]
	encodedPayload, _, _ := strings.Cut(token, ".")
	forgedPath := strings.Replace(previewURL.Path, token, encodedPayload+".bm90LXRoZS1zaWduYXR1cmU", 1)
	status, _, _ = documentPreviewContentRequest(t, server.URL+forgedPath, http.MethodGet, nil)
	if status != http.StatusNotFound {
		t.Fatalf("forged preview status=%d want=404", status)
	}

	// A Document outside My Documents, such as one an Agent shared, previews
	// only its entry, and each request re-checks that it is still readable.
	roomID := createPrivateRoom(t, env, alice, "Shared preview "+unique, "shared-preview-"+unique)
	status, _, sharedBody := requestUnifiedDocumentMultipart(t, env, alice,
		"/v0/rooms/"+roomID+"/documents/uploads", "preview-shared-"+unique, map[string]string{
			"filename": "shared.html", "representation_format": "plain_text", "media_type": "text/html",
		}, "shared.html", []byte("shared entry"))
	if status != http.StatusCreated {
		t.Fatalf("upload shared Document status=%d body=%s", status, sharedBody)
	}
	var shared previewDocumentResponse
	decode(t, sharedBody, &shared)
	if shared.CurrentVersion == nil {
		t.Fatalf("shared Document has no Version: %s", sharedBody)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM document_placements WHERE document_id=$1`, shared.ID); err != nil {
		t.Fatal(err)
	}
	status, _, sharedPreviewBody := env.request(alice, http.MethodPost,
		"/v0/document-versions/"+shared.CurrentVersion.ID+"/preview-sessions", map[string]any{}, "")
	if status != http.StatusCreated {
		t.Fatalf("create Room upload preview status=%d body=%s", status, sharedPreviewBody)
	}
	var sharedPreview documentPreviewSessionResponse
	decode(t, sharedPreviewBody, &sharedPreview)
	sharedURL, err := url.Parse(sharedPreview.PreviewURL)
	if err != nil || !strings.HasSuffix(sharedURL.Path, "/shared.html") {
		t.Fatalf("shared entry-only URL=%q error=%v", sharedPreview.PreviewURL, err)
	}
	status, _, _ = documentPreviewContentRequest(t, server.URL+strings.TrimSuffix(sharedURL.Path, "/shared.html")+"/secret.txt", http.MethodGet, nil)
	if status != http.StatusNotFound {
		t.Fatalf("entry-only shared preview served a sibling: status=%d", status)
	}
	status, _, body = documentPreviewContentRequest(t, server.URL+sharedURL.Path, http.MethodGet, nil)
	if status != http.StatusOK || !bytes.Equal(body, []byte("shared entry")) {
		t.Fatalf("shared preview status=%d body=%q", status, body)
	}
	status, _, trashBody := env.request(alice, http.MethodDelete, "/v0/documents/"+shared.ID, nil, "preview-trash-"+unique)
	if status != http.StatusNoContent {
		t.Fatalf("trash previewed Document status=%d body=%s", status, trashBody)
	}
	status, _, _ = documentPreviewContentRequest(t, server.URL+sharedURL.Path, http.MethodGet, nil)
	if status != http.StatusNotFound {
		t.Fatalf("authority-revoked shared preview status=%d want=404", status)
	}

	t.Run("generic HTML MIME is normalized only for preview", func(t *testing.T) {
		entry := uploadPreviewDocument(t, env, alice, "preview-generic-html", "", "generic.html", "application/octet-stream", []byte("<h1>preview</h1>"))
		code, _, body := env.request(alice, http.MethodPost, "/v0/document-versions/"+entry.CurrentVersion.ID+"/preview-sessions", map[string]any{}, "")
		if code != http.StatusCreated {
			t.Fatalf("create generic HTML preview: %d %s", code, body)
		}
		var session documentPreviewSessionResponse
		decode(t, body, &session)
		previewURL, err := url.Parse(session.PreviewURL)
		if err != nil {
			t.Fatal(err)
		}
		for _, method := range []string{http.MethodGet, http.MethodHead} {
			code, headers, content := documentPreviewContentRequest(t, server.URL+previewURL.Path, method, nil)
			if code != http.StatusOK || headers.Get("Content-Type") != "text/html; charset=utf-8" {
				t.Fatalf("%s HTML preview: status=%d headers=%v", method, code, headers)
			}
			if method == http.MethodGet && string(content) != "<h1>preview</h1>" {
				t.Fatalf("preview changed bytes: %q", content)
			}
		}
		code, headers, _ := env.request(alice, http.MethodGet, "/v0/document-versions/"+entry.CurrentVersion.ID+"/content", nil, "")
		if code != http.StatusOK || headers.Get("Content-Type") != "application/octet-stream" {
			t.Fatalf("download MIME changed: status=%d headers=%v", code, headers)
		}
	})
}

func uploadPreviewDocument(
	t *testing.T,
	env *testEnv,
	client *http.Client,
	key, parentID, filename, mediaType string,
	content []byte,
) previewDocumentResponse {
	t.Helper()
	fields := map[string]string{
		"filename": filename, "representation_format": "plain_text", "media_type": mediaType,
	}
	if parentID != "" {
		fields["parent_id"] = parentID
	}
	status, _, body := requestUnifiedDocumentUpload(t, env, client, key, fields, filename, content)
	if status != http.StatusCreated {
		t.Fatalf("upload preview Document %s status=%d body=%s", filename, status, body)
	}
	var document previewDocumentResponse
	decode(t, body, &document)
	if document.ID == "" || document.CurrentVersion == nil || document.CurrentVersion.ID == "" {
		t.Fatalf("invalid preview Document: %s", body)
	}
	return document
}

func documentPreviewContentRequest(
	t *testing.T,
	requestURL, method string,
	headers map[string]string,
) (int, http.Header, []byte) {
	t.Helper()
	request, err := http.NewRequest(method, requestURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body := new(bytes.Buffer)
	if _, err := body.ReadFrom(response.Body); err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, response.Header, body.Bytes()
}

func assertDocumentPreviewHeaders(t *testing.T, headers http.Header) {
	t.Helper()
	csp := headers.Get("Content-Security-Policy")
	if headers.Get("X-Content-Type-Options") != "nosniff" ||
		headers.Get("Referrer-Policy") != "no-referrer" ||
		headers.Get("Cache-Control") != "private, no-store" ||
		headers.Get("Access-Control-Allow-Origin") != "null" ||
		headers.Get("Cross-Origin-Resource-Policy") != "cross-origin" ||
		!strings.Contains(csp, "default-src 'none'") ||
		!strings.Contains(csp, "script-src 'self'") ||
		!strings.Contains(csp, "connect-src 'self'") {
		t.Fatalf("unsafe preview headers: %v", headers)
	}
}
