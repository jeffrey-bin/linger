package integration_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
)

func TestAgentCLIFilesHTTPDerivesIdentityAndRejectsExpiredCredential(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, issued, roomID := newAgentCLIIdentity(t)
	external, err := agentcredential.New(env.pool).IssueManaged(t.Context(), issued.AgentID, "second CLI")
	if err != nil {
		t.Fatalf("issue second credential: %v", err)
	}
	if !agentcredential.ValidToken(external.AccessToken) {
		t.Fatal("invalid issued token")
	}
	targetKind, targetID := "room", roomID
	expectedTenant, expectedAgent := external.TenantID, external.AgentID
	request := func(method, requestPath, contentType string, content []byte) (int, []byte) {
		t.Helper()
		req, err := http.NewRequestWithContext(t.Context(), method, env.server.URL+requestPath, bytes.NewReader(content))
		if err != nil {
			t.Fatal(err)
		}
		if contentType != "" {
			req.Header.Set("Content-Type", contentType)
		}
		req.Header.Set("Authorization", "Bearer "+external.AccessToken)
		req.Header.Set("X-TeamHub-Context-Kind", targetKind)
		req.Header.Set("X-TeamHub-Context-Id", targetID)
		req.Header.Set("X-TeamHub-Expected-Tenant-Id", expectedTenant)
		req.Header.Set("X-TeamHub-Expected-Agent-Id", expectedAgent)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		data, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		return resp.StatusCode, data
	}
	// send delivers one file in a Room message, the CLI's only way to create a
	// Document, and returns the new Document and its Version.
	send := func(invocation, filename, format, mediaType, content string) (string, string) {
		t.Helper()
		digest := sha256.Sum256([]byte(content))
		var buffer bytes.Buffer
		writer := multipart.NewWriter(&buffer)
		metadata, err := writer.CreateFormField("metadata")
		if err != nil {
			t.Fatal(err)
		}
		if err := json.NewEncoder(metadata).Encode(map[string]any{
			"invocation_id": "agent-invocation-sha256:" + strings.Repeat(invocation, 64), "inbox_id": "room:" + roomID,
			"segments": []map[string]any{{"type": "document", "upload_id": "upload_0"}},
			"uploads":  []map[string]any{{"upload_id": "upload_0", "filename": filename, "representation_format": format, "media_type": mediaType, "size_bytes": len(content), "sha256": hex.EncodeToString(digest[:])}},
		}); err != nil {
			t.Fatal(err)
		}
		file, err := writer.CreateFormFile("file", "upload_0")
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.WriteString(file, content)
		_ = writer.Close()
		code, body := request(http.MethodPost, "/api/agent/v1/messages/commit", writer.FormDataContentType(), buffer.Bytes())
		var receipt struct {
			Resources []struct {
				DocumentID string `json:"document_id"`
				VersionID  string `json:"version_id"`
			} `json:"resources"`
		}
		if code != http.StatusOK || json.Unmarshal(body, &receipt) != nil || len(receipt.Resources) != 1 || receipt.Resources[0].DocumentID == "" {
			t.Fatalf("send %s=%d %s", filename, code, body)
		}
		return receipt.Resources[0].DocumentID, receipt.Resources[0].VersionID
	}
	expectedAgent = "another-agent"
	code, body := request(http.MethodGet, "/api/agent/v1/files", "", nil)
	if code != 403 {
		t.Fatalf("mismatched profile identity=%d %s", code, body)
	}
	expectedAgent = external.AgentID
	documentID, versionID := send("c", "evidence.txt", "plain_text", "text/plain", "independent file bytes")
	code, body = request(http.MethodGet, "/api/agent/v1/files/"+documentID+"/content", "", nil)
	if code != 200 || string(body) != "independent file bytes" {
		t.Fatalf("download=%d %s", code, body)
	}

	// Before asynchronous native conversion, the committed source bytes remain readable.
	nativeID, _ := send("d", "pending.md", "markdown", "text/markdown", "# Pending native import\n")
	code, body = request(http.MethodGet, "/api/agent/v1/files/"+nativeID+"/content", "", nil)
	if code != 200 || string(body) != "# Pending native import\n" {
		t.Fatalf("pending native import source=%d %s", code, body)
	}

	code, _, body = env.request(alice, http.MethodPost, "/v0/documents/"+documentID+"/comment-threads", map[string]any{"document_version_id": versionID, "initial_comment": map[string]any{"segments": []map[string]string{{"type": "text", "content": "Review file"}}}}, "agent-cli-comment-thread")
	if code != http.StatusCreated {
		t.Fatalf("create comment=%d %s", code, body)
	}
	var thread roomDocumentCommentThreadResponse
	decode(t, body, &thread)
	targetKind, targetID = "document", documentID
	reply, _ := json.Marshal(map[string]any{"thread_id": thread.ID, "invocation_id": "agent-invocation-sha256:" + strings.Repeat("a", 64), "segments": []map[string]string{{"type": "text", "content": "Reply without Run"}}})
	code, body = request(http.MethodPost, "/api/agent/v1/document-comments/replies", "", reply)
	if code != 200 {
		t.Fatalf("comment reply=%d %s", code, body)
	}
	code, body = request(http.MethodPost, "/api/agent/v1/document-comments/replies", "", reply)
	if code != 200 || !strings.Contains(string(body), `"replayed":true`) {
		t.Fatalf("comment retry=%d %s", code, body)
	}
	targetID = "unknown-document"
	code, body = request(http.MethodPost, "/api/agent/v1/document-comments/replies", "", reply)
	if code != 403 {
		t.Fatalf("comment wrong target=%d %s", code, body)
	}
	targetKind, targetID = "room", roomID
	if err := revokeAgentCredential(t.Context(), env.pool, external.CredentialID); err != nil {
		t.Fatalf("expire credential: %v", err)
	}
	code, body = request(http.MethodGet, "/api/agent/v1/files", "", nil)
	if code != 401 {
		t.Fatalf("expired file read=%d %s", code, body)
	}
	var count int
	if err := env.pool.QueryRow(t.Context(), `SELECT count(*) FROM agent_local_runs`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("runtime rows=%d err=%v", count, err)
	}
}
