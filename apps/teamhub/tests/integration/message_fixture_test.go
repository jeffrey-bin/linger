package integration_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"maps"
	"mime/multipart"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentmessages"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentsendmessage"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// humanTextMessage is the Human message request for one text segment.
func humanTextMessage(text string) map[string]any {
	return map[string]any{"raw_message": text, "segments": []map[string]any{{"type": "text", "content": text}}}
}

// createHumanMessage posts one Human text message and returns its ID.
func createHumanMessage(t *testing.T, env *testEnv, client *http.Client, roomID, text, key string) string {
	t.Helper()
	status, _, body := env.request(client, http.MethodPost, "/v0/rooms/"+roomID+"/messages", humanTextMessage(text), key)
	if status != http.StatusCreated {
		t.Fatalf("create message status=%d body=%s", status, body)
	}
	var message struct {
		ID string `json:"id"`
	}
	decode(t, body, &message)
	if message.ID == "" {
		t.Fatalf("create message missing id body=%s", body)
	}
	return message.ID
}

// seedAgentMessage writes one Agent conversation Message with its Room event
// and deliveries through the shared message writer, and returns its ID. Use it
// when a test needs Agent history; tests of the Agent write path itself use
// commitAgentMessage.
func seedAgentMessage(t *testing.T, env *testEnv, roomID, agentActorID, text string) string {
	t.Helper()
	tx, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	queries := store.New(tx)
	agent, err := queries.GetActor(t.Context(), store.GetActorParams{ID: agentActorID, TenantID: acmeTenant})
	if err != nil {
		t.Fatal(err)
	}
	content, err := messagecreation.Normalize([]messagecreation.Segment{{Type: "text", Content: text}})
	if err != nil {
		t.Fatal(err)
	}
	created, err := messagecreation.Create(t.Context(), queries, messagecreation.Draft{
		TenantID: acmeTenant, RoomID: roomID, Author: agent, Content: content,
	})
	if err != nil {
		t.Fatalf("seed Agent message: %v", err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	return created.Message.ID
}

// agentCommitUpload is one file part of an Agent message commit. Uploads are
// sent in slice order, which must match the metadata uploads array.
type agentCommitUpload struct {
	ID, Filename, Format, MediaType string
	Content                         []byte
}

// agentTextMessage is the commit metadata of one text-only Agent message.
func agentTextMessage(inboxID, invocationSeed, text string) map[string]any {
	return map[string]any{
		"invocation_id": "agent-invocation-sha256:" + semanticDigest([]byte(invocationSeed)),
		"inbox_id":      inboxID,
		"segments":      []map[string]any{{"type": "text", "content": text}},
	}
}

// agentMessageCommitBody encodes POST /api/agent/v1/messages/commit: the
// metadata JSON part, then one file part per upload named by its upload_id.
func agentMessageCommitBody(t *testing.T, metadata map[string]any, uploads ...agentCommitUpload) (string, []byte) {
	t.Helper()
	described := make([]map[string]any, 0, len(uploads))
	for _, upload := range uploads {
		digest := sha256.Sum256(upload.Content)
		described = append(described, map[string]any{
			"upload_id": upload.ID, "filename": upload.Filename, "representation_format": upload.Format,
			"media_type": upload.MediaType, "size_bytes": len(upload.Content), "sha256": hex.EncodeToString(digest[:]),
		})
	}
	fields := maps.Clone(metadata)
	fields["uploads"] = described
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	part, err := writer.CreateFormField("metadata")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.NewEncoder(part).Encode(fields); err != nil {
		t.Fatal(err)
	}
	for _, upload := range uploads {
		part, err := writer.CreateFormFile("file", upload.ID)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write(upload.Content); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return writer.FormDataContentType(), buffer.Bytes()
}

// commitAgentMessage commits one Agent message through the CLI route in the
// given Context, or without one when contextKind is empty, and returns the HTTP
// status and response body.
func commitAgentMessage(t *testing.T, env *testEnv, token, contextKind, contextID string, metadata map[string]any, uploads ...agentCommitUpload) (int, []byte) {
	t.Helper()
	return commitAgentMessageForRun(t, env, token, contextKind, contextID, "", metadata, uploads...)
}

// commitAgentMessageForRun commits as the CLI of runID, which names its Run in
// the Run header; an empty runID sends no header.
func commitAgentMessageForRun(t *testing.T, env *testEnv, token, contextKind, contextID, runID string, metadata map[string]any, uploads ...agentCommitUpload) (int, []byte) {
	t.Helper()
	contentType, body := agentMessageCommitBody(t, metadata, uploads...)
	request, err := http.NewRequestWithContext(t.Context(), http.MethodPost, env.server.URL+"/api/agent/v1/messages/commit", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", contentType)
	request.Header.Set("Authorization", "Bearer "+token)
	if contextKind != "" {
		request.Header.Set("X-TeamHub-Context-Kind", contextKind)
		request.Header.Set("X-TeamHub-Context-Id", contextID)
	}
	if runID != "" {
		request.Header.Set("X-TeamHub-Run-Id", runID)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, data
}

// agentMessageReplayMatches reports whether replay is the duplicate receipt of
// the commit that returned first.
func agentMessageReplayMatches(t *testing.T, first, replay []byte) bool {
	t.Helper()
	var original, duplicate struct {
		MessageID string          `json:"message_id"`
		InboxID   string          `json:"inbox_id"`
		Resources json.RawMessage `json:"resources"`
		Duplicate bool            `json:"duplicate_request"`
	}
	decode(t, first, &original)
	decode(t, replay, &duplicate)
	return !original.Duplicate && duplicate.Duplicate && duplicate.MessageID == original.MessageID &&
		duplicate.InboxID == original.InboxID && string(duplicate.Resources) == string(original.Resources)
}

// seedRunningLocalRun ensures the Agent's per-Room Context and records one
// running Local Run in it.
func seedRunningLocalRun(t *testing.T, env *testEnv, agentManagementID, roomID, runID string) {
	t.Helper()
	ensured, err := agentruntimestate.New(env.pool).EnsureContext(t.Context(), agentruntimestate.EnsureContextInput{TargetResidency: "active",
		Ref: agentruntimestate.ContextRef{Kind: "meta", AgentID: agentManagementID, RoomID: roomID},
	})
	if err != nil {
		t.Fatalf("ensure Context: %v", err)
	}
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO agent_local_runs(run_id,context_key,status,started_at)
		VALUES($1,$2,'running',clock_timestamp())`, runID, ensured.Context.ContextKey); err != nil {
		t.Fatalf("seed running Local Run: %v", err)
	}
}

// readAgentHistoryMessage reads one Message, with its context Messages, as the
// given Agent through the live history read.
func readAgentHistoryMessage(t *testing.T, env *testEnv, agentActorID, messageID string) agentmessages.ReadMessage {
	t.Helper()
	result, err := agentmessages.New(env.pool).Read(t.Context(), agentmessages.Reader{TenantID: acmeTenant, ActorID: agentActorID},
		agentmessages.ReadInput{MessageIDs: []string{messageID}})
	if err != nil || result.Messages == nil || len(*result.Messages) != 1 {
		t.Fatalf("read Agent history Message %s: %+v err=%v", messageID, result, err)
	}
	return (*result.Messages)[0]
}

// newAgentSendService is the Agent message send service as TeamHub wires it,
// with its own object store.
func newAgentSendService(t *testing.T, pool *pgxpool.Pool, contexts *agentauth.Service) *agentsendmessage.Service {
	t.Helper()
	objects, err := artifactstore.NewLocalStore(t.TempDir(), 50<<20)
	if err != nil {
		t.Fatal(err)
	}
	return agentsendmessage.New(pool, contexts, document.NewWithObjectStore(pool, objects), objects)
}

// agentSendInput is one upload-free Agent message for the send service.
func agentSendInput(inboxID, invocationID string, segments ...agentsendmessage.PreparedSegment) agentsendmessage.Input {
	return agentsendmessage.Input{InboxID: inboxID, InvocationID: invocationID,
		Atomic: &agentsendmessage.AtomicInput{Segments: segments, Uploads: []agentsendmessage.PreparedUpload{}}}
}
