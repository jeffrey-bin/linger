package integration_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
)

type attachmentUploadResponse struct {
	ID        string `json:"id"`
	RoomID    string `json:"room_id"`
	Filename  string `json:"filename"`
	Status    string `json:"status"`
	ExpiresAt string `json:"expires_at"`
}

type attachmentMessageResponse struct {
	ID          string           `json:"id"`
	RawMessage  string           `json:"raw_message"`
	Segments    []map[string]any `json:"segments"`
	Attachments []struct {
		ID                string `json:"id"`
		DocumentID        string `json:"document_id"`
		DocumentVersionID string `json:"document_version_id"`
		Filename          string `json:"filename"`
		Available         bool   `json:"available"`
	} `json:"attachments"`
}

func TestRoomMessageAttachmentPublication(t *testing.T) {
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
	suffix := strings.ReplaceAll(time.Now().Format("150405.000000000"), ".", "")
	roomID := createPrivateRoom(t, env, alice, "Message attachments "+suffix, "attachment-room-"+suffix)
	otherRoomID := createPrivateRoom(t, env, alice, "Other attachments "+suffix, "attachment-other-room-"+suffix)

	upload := uploadMessageAttachment(t, alice, server.URL, roomID, "upload-first-"+suffix, "report.txt", []byte("immutable attachment"))
	if upload.RoomID != roomID || upload.Filename != "report.txt" || upload.Status != "available" || upload.ExpiresAt == "" {
		t.Fatalf("unexpected pending attachment upload: %+v", upload)
	}
	status, _, documentsBefore := env.request(alice, http.MethodGet, "/v0/rooms/"+roomID+"/documents?limit=100", nil, "")
	if status != http.StatusOK || bytes.Contains(documentsBefore, []byte("report.txt")) {
		t.Fatalf("pending upload leaked into Room Documents status=%d body=%s", status, documentsBefore)
	}

	messagePayload := map[string]any{
		"raw_message":           "Review this report.",
		"segments":              []map[string]any{{"type": "text", "content": "Review this report."}},
		"attachment_upload_ids": []string{upload.ID},
	}
	status, _, messageBody := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/messages", messagePayload, "message-with-attachment-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("create attachment Message status=%d body=%s", status, messageBody)
	}
	var message attachmentMessageResponse
	decode(t, messageBody, &message)
	if len(message.Attachments) != 1 || !message.Attachments[0].Available || message.Attachments[0].Filename != "report.txt" {
		t.Fatalf("unexpected Message attachments: %s", messageBody)
	}
	if message.RawMessage != "Review this report.\nreport.txt" || len(message.Segments) != 3 ||
		message.Segments[2]["document_id"] != message.Attachments[0].DocumentID ||
		message.Segments[2]["type"] != "document" || message.Segments[2]["presentation"] != "card" ||
		message.Segments[2]["document_version_id"] != nil {
		t.Fatalf("published Message did not deliver its Document card: %s", messageBody)
	}
	status, replayHeaders, replayBody := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/messages", messagePayload, "message-with-attachment-"+suffix)
	if status != http.StatusCreated || replayHeaders.Get("Idempotent-Replay") != "true" || !bytes.Equal(replayBody, messageBody) {
		t.Fatalf("Message replay status=%d headers=%v body=%s", status, replayHeaders, replayBody)
	}
	status, _, fetchedBody := env.request(alice, http.MethodGet, "/v0/rooms/"+roomID+"/messages/"+message.ID, nil, "")
	if status != http.StatusOK || !bytes.Contains(fetchedBody, []byte(message.Attachments[0].DocumentVersionID)) {
		t.Fatalf("get Message omitted attachment status=%d body=%s", status, fetchedBody)
	}
	status, _, documentsAfter := env.request(alice, http.MethodGet, "/v0/rooms/"+roomID+"/documents?limit=100", nil, "")
	if status != http.StatusOK || !bytes.Contains(documentsAfter, []byte(message.Attachments[0].DocumentID)) {
		t.Fatalf("committed attachment missing from Room Documents status=%d body=%s", status, documentsAfter)
	}

	t.Run("Markdown alias becomes a native-capable shared Document", func(t *testing.T) {
		markdown := uploadMessageAttachmentWithMediaType(t, alice, server.URL, roomID,
			"upload-markdown-"+suffix, "fresh.md", "text/x-markdown", []byte("# Fresh\n"))
		status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/messages", map[string]any{
			"raw_message":           "Review fresh Markdown.",
			"segments":              []map[string]any{{"type": "text", "content": "Review fresh Markdown."}},
			"attachment_upload_ids": []string{markdown.ID},
		}, "message-markdown-"+suffix)
		if status != http.StatusCreated {
			t.Fatalf("create Markdown attachment Message status=%d body=%s", status, body)
		}
		var created attachmentMessageResponse
		decode(t, body, &created)
		if len(created.Attachments) != 1 {
			t.Fatalf("Markdown Message attachments=%s", body)
		}
		attachment := created.Attachments[0]
		var documents, versions, placements, bindings, migrations int
		var versionMediaType string
		if err := pool.QueryRow(ctx, `SELECT
			(SELECT count(*) FROM documents WHERE id=$1 AND current_version_id=$2),
			(SELECT count(*) FROM document_versions WHERE id=$2 AND document_id=$1
			 AND filename='fresh.md' AND representation_format='markdown'),
			(SELECT media_type FROM document_versions WHERE id=$2),
			(SELECT count(*) FROM document_placements WHERE document_id=$1
			 AND owner_human_actor_id='actor_acme_alice' AND scope_kind='personal'),
			(SELECT count(*) FROM document_context_bindings WHERE document_id=$1
			 AND room_id=$3 AND binding_kind='room' AND status='active'),
			(SELECT count(*) FROM documents WHERE id=$1
			 AND native_import_source_version_id=$2 AND native_import_status='pending')`,
			attachment.DocumentID, attachment.DocumentVersionID, roomID).Scan(
			&documents, &versions, &versionMediaType, &placements, &bindings, &migrations,
		); err != nil {
			t.Fatal(err)
		}
		if documents != 1 || versions != 1 || versionMediaType != "text/markdown" ||
			placements != 1 || bindings != 1 || migrations != 1 {
			t.Fatalf("Markdown aggregate documents=%d versions=%d media=%q placements=%d bindings=%d migrations=%d",
				documents, versions, versionMediaType, placements, bindings, migrations)
		}
		if status, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); status != http.StatusOK {
			t.Fatalf("add Markdown reviewer status=%d body=%s", status, body)
		}
		if !agentCanReadDocument(t, env, acmeOfficialAgentManagementID, attachment.DocumentID) {
			t.Fatal("Room member Agent cannot read the shared Markdown attachment")
		}
		status, _, body = env.request(alice, http.MethodDelete,
			"/v0/rooms/"+roomID+"/members/actor_acme_official", nil, "")
		if status != http.StatusNoContent {
			t.Fatalf("remove Markdown reviewer status=%d body=%s", status, body)
		}
	})

	t.Run("attachment-only Message", func(t *testing.T) {
		only := uploadMessageAttachment(t, alice, server.URL, roomID, "upload-only-"+suffix, "only.txt", []byte("only"))
		status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/messages", map[string]any{
			"raw_message": "", "segments": []any{}, "attachment_upload_ids": []string{only.ID},
		}, "attachment-only-message-"+suffix)
		if status != http.StatusCreated {
			t.Fatalf("attachment-only Message status=%d body=%s", status, body)
		}
		var created attachmentMessageResponse
		decode(t, body, &created)
		if created.RawMessage != "only.txt" || len(created.Attachments) != 1 {
			t.Fatalf("unexpected attachment-only Message: %s", body)
		}
	})

	t.Run("authorized cross-Room context keeps the exact Version provenance", func(t *testing.T) {
		status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+otherRoomID+"/messages", map[string]any{
			"raw_message":                  "Use the selected report.",
			"segments":                     []map[string]any{{"type": "text", "content": "Use the selected report."}},
			"context_document_version_ids": []string{message.Attachments[0].DocumentVersionID},
		}, "cross-room-context-"+suffix)
		if status != http.StatusCreated {
			t.Fatalf("cross-Room context status=%d body=%s", status, body)
		}
		var created attachmentMessageResponse
		decode(t, body, &created)
		if len(created.Attachments) != 1 ||
			created.Attachments[0].DocumentID != message.Attachments[0].DocumentID ||
			created.Attachments[0].DocumentVersionID != message.Attachments[0].DocumentVersionID ||
			created.RawMessage != "Use the selected report.\nreport.txt" {
			t.Fatalf("cross-Room context lost exact Version provenance: %s", body)
		}
	})

	t.Run("cross-Room upload is rejected without publication", func(t *testing.T) {
		pending := uploadMessageAttachment(t, alice, server.URL, roomID, "upload-cross-room-"+suffix, "cross.txt", []byte("cross"))
		status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+otherRoomID+"/messages", map[string]any{
			"raw_message": "cross", "segments": []map[string]any{{"type": "text", "content": "cross"}},
			"attachment_upload_ids": []string{pending.ID},
		}, "cross-room-message-"+suffix)
		if status != http.StatusConflict || !bytes.Contains(body, []byte(`"code":"ATTACHMENT_UPLOAD_UNAVAILABLE"`)) {
			t.Fatalf("cross-Room attachment status=%d body=%s", status, body)
		}
	})

	t.Run("attached and forged uploads cannot be used by a new Message", func(t *testing.T) {
		encoded, _, _ := strings.Cut(upload.ID, ".")
		forged := encoded + "." + base64.RawURLEncoding.EncodeToString([]byte("not the signature"))
		for name, uploadID := range map[string]string{"attached": upload.ID, "forged": forged} {
			status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/messages", map[string]any{
				"raw_message": name, "segments": []map[string]any{{"type": "text", "content": name}},
				"attachment_upload_ids": []string{uploadID},
			}, name+"-attachment-message-"+suffix)
			if status != http.StatusConflict || !bytes.Contains(body, []byte(`"code":"ATTACHMENT_UPLOAD_UNAVAILABLE"`)) {
				t.Fatalf("%s upload reuse status=%d body=%s", name, status, body)
			}
		}
	})

	t.Run("cancelled upload is deleted and cannot be attached", func(t *testing.T) {
		cancelled := uploadMessageAttachment(t, alice, server.URL, roomID, "upload-cancelled-"+suffix, "cancelled.txt", []byte("cancelled"))
		status, _, body := env.request(alice, http.MethodDelete, "/v0/rooms/"+roomID+"/message-attachment-uploads/"+cancelled.ID, nil, "")
		if status != http.StatusNoContent {
			t.Fatalf("cancel Message attachment status=%d body=%s", status, body)
		}
		objects, err := artifactstore.NewLocalStore(artifactRoot, 1<<20)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := objects.Head(ctx, attachmentUploadObjectKey(t, cancelled.ID)); err == nil {
			t.Fatal("cancelled upload object survived")
		}
		status, _, body = env.request(alice, http.MethodDelete, "/v0/rooms/"+roomID+"/message-attachment-uploads/"+cancelled.ID, nil, "")
		if status != http.StatusConflict {
			t.Fatalf("second cancel status=%d body=%s", status, body)
		}
		status, _, body = env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/messages", map[string]any{
			"raw_message": "cancelled", "segments": []map[string]any{{"type": "text", "content": "cancelled"}},
			"attachment_upload_ids": []string{cancelled.ID},
		}, "cancelled-attachment-message-"+suffix)
		if status != http.StatusConflict || !bytes.Contains(body, []byte(`"code":"ATTACHMENT_UPLOAD_UNAVAILABLE"`)) {
			t.Fatalf("cancelled upload reuse status=%d body=%s", status, body)
		}
	})

	t.Run("trashed Document keeps historical attachment metadata", func(t *testing.T) {
		status, _, body := env.request(alice, http.MethodDelete, "/v0/documents/"+message.Attachments[0].DocumentID, nil, "trash-message-attachment-"+suffix)
		if status != http.StatusNoContent {
			t.Fatalf("trash attachment Document status=%d body=%s", status, body)
		}
		status, _, body = env.request(alice, http.MethodGet, "/v0/rooms/"+roomID+"/messages/"+message.ID, nil, "")
		if status != http.StatusOK {
			t.Fatalf("get Message after Document trash status=%d body=%s", status, body)
		}
		var historical attachmentMessageResponse
		decode(t, body, &historical)
		if len(historical.Attachments) != 1 || historical.Attachments[0].Available || historical.Attachments[0].Filename != "report.txt" {
			t.Fatalf("historical attachment metadata was not retained: %s", body)
		}
	})
}

func uploadMessageAttachment(t *testing.T, client *http.Client, serverURL, roomID, key, filename string, content []byte) attachmentUploadResponse {
	t.Helper()
	return uploadMessageAttachmentWithMediaType(t, client, serverURL, roomID, key, filename, "text/plain", content)
}

func uploadMessageAttachmentWithMediaType(t *testing.T, client *http.Client, serverURL, roomID, key, filename, mediaType string, content []byte) attachmentUploadResponse {
	t.Helper()
	status, _, body := artifactUpload(t, client, serverURL+"/v0/rooms/"+roomID+"/message-attachment-uploads", key, map[string]string{
		"filename": filename, "media_type": mediaType,
	}, content)
	if status != http.StatusCreated {
		t.Fatalf("upload Message attachment status=%d body=%s", status, body)
	}
	var upload attachmentUploadResponse
	decode(t, body, &upload)
	return upload
}

// attachmentUploadObjectKey reads the object key a signed upload credential
// names; the credential's payload is base64url JSON before its signature.
func attachmentUploadObjectKey(t *testing.T, token string) string {
	t.Helper()
	encoded, _, _ := strings.Cut(token, ".")
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatal(err)
	}
	var payload struct {
		ObjectKey string `json:"o"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil || payload.ObjectKey == "" {
		t.Fatalf("upload credential has no object key: %v", err)
	}
	return payload.ObjectKey
}

// TestMessageAttachmentExpiryDeletesOnlyUnattachedObjects runs the expiry
// jobs of three uploads: one a Message attached, one still stored, and one
// whose object is already gone. Only the stored, unattached object is
// deleted, and every job completes.
func TestMessageAttachmentExpiryDeletesOnlyUnattachedObjects(t *testing.T) {
	allowParallelIntegrationTest(t)
	databaseURL := newIntegrationDatabase(t)
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	artifactRoot := t.TempDir()
	cfg := config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.ArtifactStorageRoot = artifactRoot
		c.ArtifactMaxBytes = 1 << 20
		c.SigningKey = "attachment-expiry-test-key"
	})

	// Prepare the uploads with jobs off, then start a second App with jobs on
	// so it runs the expiry jobs made due below.
	prepared, err := newIntegrationApp(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(prepared.Handler())
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
	alice := env.login("alice", alicePassword)
	suffix := strings.ReplaceAll(time.Now().Format("150405.000000000"), ".", "")
	roomID := createPrivateRoom(t, env, alice, "Attachment expiry "+suffix, "attachment-expiry-room-"+suffix)
	attached := uploadMessageAttachment(t, alice, server.URL, roomID, "upload-expiry-attached-"+suffix, "attached.txt", []byte("attached"))
	present := uploadMessageAttachment(t, alice, server.URL, roomID, "upload-expiry-present-"+suffix, "present.txt", []byte("present"))
	gone := uploadMessageAttachment(t, alice, server.URL, roomID, "upload-expiry-gone-"+suffix, "gone.txt", []byte("gone"))
	if status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/messages", map[string]any{
		"raw_message": "attached", "segments": []map[string]any{{"type": "text", "content": "attached"}},
		"attachment_upload_ids": []string{attached.ID},
	}, "attachment-expiry-message-"+suffix); status != http.StatusCreated {
		t.Fatalf("attach upload status=%d body=%s", status, body)
	}
	server.Close()
	prepared.Close()

	objects, err := artifactstore.NewLocalStore(artifactRoot, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if err := objects.Delete(ctx, attachmentUploadObjectKey(t, gone.ID)); err != nil {
		t.Fatal(err)
	}
	if got := countRows(t, env, "select count(*) from river_job where kind='message_attachment.expiry' and scheduled_at>now()+interval '23 hours'"); got != 3 {
		t.Fatalf("scheduled expiry jobs=%d want=3", got)
	}
	if _, err := pool.Exec(ctx, "update river_job set scheduled_at=now() where kind='message_attachment.expiry'"); err != nil {
		t.Fatal(err)
	}

	swept, err := newIntegrationApp(ctx, cfg, starting(app.JobQueue))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(swept.Close)
	deadline := time.Now().Add(15 * time.Second)
	for countRows(t, env, "select count(*) from river_job where kind='message_attachment.expiry' and state<>'completed'") != 0 {
		if time.Now().After(deadline) {
			t.Fatal("Message attachment expiry jobs did not complete")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if _, err := objects.Head(ctx, attachmentUploadObjectKey(t, present.ID)); err == nil {
		t.Fatal("unattached object survived its expiry")
	}
	if _, err := objects.Head(ctx, attachmentUploadObjectKey(t, attached.ID)); err != nil {
		t.Fatalf("attached object was deleted: %v", err)
	}
}

// pg_restore clears search_path before COPY evaluates the attachment CHECK.
func TestMessageAttachmentCheckDuringRestore(t *testing.T) {
	allowParallelIntegrationTest(t)
	cfg, err := pgxpool.ParseConfig(newIntegrationDatabase(t))
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = ""
	pool, err := pgxpool.NewWithConfig(t.Context(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	const attachment = `{"id":"file","document_id":"doc","document_version_id":"ver"}`
	for _, tc := range []struct {
		value string
		want  bool
	}{
		{"[" + attachment + "]", true},
		{"[" + attachment + "," + attachment + "]", false},
	} {
		var valid bool
		if err := pool.QueryRow(t.Context(), "SELECT public.message_attachments_valid($1::jsonb)", tc.value).Scan(&valid); err != nil || valid != tc.want {
			t.Fatalf("attachment check during restore: valid=%v, want=%v, err=%v", valid, tc.want, err)
		}
	}
}
