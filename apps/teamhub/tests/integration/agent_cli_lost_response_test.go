package integration_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
)

// The CLI's transcript, receipt file and activity lifecycle are not evidence of
// a business commit. Lose every response byte, replace TeamHub, then recover
// the product fact and its existing receipt without resending the operation.
func TestAgentCLICommittedMessageSurvivesLostResponse(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, issued, roomID := newAgentCLIIdentity(t)
	const message = "Committed before controller received any response"
	invocation := "agent-invocation-sha256:" + strings.Repeat("a", 64)
	input := map[string]any{
		"invocation_id": invocation, "inbox_id": "room:" + roomID,
		"segments": []map[string]any{{"type": "text", "content": message}},
	}
	contentType, encoded := agentMessageCommitBody(t, input)
	var dispatches atomic.Int32
	committed := make(chan int, 1)
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, incoming *http.Request) {
		dispatches.Add(1)
		request, err := http.NewRequestWithContext(incoming.Context(), http.MethodPost, env.server.URL+"/api/agent/v1/messages/commit", incoming.Body)
		if err != nil {
			committed <- 0
			return
		}
		request.Header = incoming.Header.Clone()
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			committed <- 0
			return
		}
		_, readErr := io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
		if readErr != nil {
			committed <- 0
			return
		}
		committed <- response.StatusCode
		connection, _, err := w.(http.Hijacker).Hijack()
		if err == nil {
			_ = connection.Close()
		}
	}))
	registerIntegrationServerCleanup(t, proxy)
	request, err := http.NewRequestWithContext(t.Context(), http.MethodPost, proxy.URL, bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+issued.AccessToken)
	request.Header.Set("Content-Type", contentType)
	request.Header.Set("X-TeamHub-Context-Kind", "room")
	request.Header.Set("X-TeamHub-Context-Id", roomID)
	request.Header.Set("X-TeamHub-Expected-Tenant-Id", acmeTenant)
	request.Header.Set("X-TeamHub-Expected-Agent-Id", issued.AgentID)
	lost, err := (&http.Client{Timeout: 5 * time.Second}).Do(request)
	if lost != nil {
		_ = lost.Body.Close()
	}
	if err == nil || <-committed != http.StatusOK || dispatches.Load() != 1 {
		t.Fatalf("expected one committed operation with no response, err=%v calls=%d", err, dispatches.Load())
	}
	proxy.Close()
	env.server.Close()

	application, err := newIntegrationApp(t.Context(), config.ForTest(func(c *config.Config) {
		c.DatabaseURL = env.databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.TeamHubInternalToken = teamHubInternalToken
		c.NodeServicesInternalToken = nodeServicesInternalToken
		c.AgentRunTokenSecret = agentRunTokenSecret
		c.ArtifactStorageRoot = env.artifactRoot
		c.ArtifactMaxBytes = 64 << 20
	}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	env.server = httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, env.server)

	// Use the same authenticated read path as Web. No mutation request, Runtime
	// callback, CLI receipt or synthetic activity is needed for recovery.
	code, _, body := env.request(alice, http.MethodGet, "/v0/rooms/"+roomID+"/messages", nil, "")
	if code != http.StatusOK || !bytes.Contains(body, []byte(message)) {
		t.Fatalf("fresh TeamHub cannot read committed Room message: %d %s", code, body)
	}
	var messageID string
	if err := env.pool.QueryRow(t.Context(), `SELECT id FROM messages WHERE room_id=$1 AND author_actor_id='actor_acme_official'`, roomID).Scan(&messageID); err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(body, []byte(messageID)) {
		t.Fatal("Web read omitted the authoritative message identity")
	}
	var receiptBody []byte
	if err := env.pool.QueryRow(t.Context(), `SELECT response_body FROM command_replays
 WHERE scope='agent:actor_acme_official' AND invocation_id=$1 AND resource_id=$2`, invocation, messageID).Scan(&receiptBody); err != nil {
		t.Fatalf("durable business receipt missing after lost response: %v", err)
	}
	var receipt struct {
		Accepted  bool   `json:"accepted"`
		MessageID string `json:"message_id"`
	}
	if json.Unmarshal(receiptBody, &receipt) != nil || !receipt.Accepted || receipt.MessageID != messageID {
		t.Fatal("stored receipt does not identify the committed business fact")
	}

	// Untrusted native output cannot associate this effect with another Run:
	// the body cannot name one, and a replay naming one keeps the receipt.
	input["execution_run_ref"] = "forged-run"
	if code, body := commitAgentMessage(t, env, issued.AccessToken, "room", roomID, input); code != http.StatusBadRequest {
		t.Fatalf("Run in the request body accepted: %d %s", code, body)
	}
	delete(input, "execution_run_ref")
	code, body = commitAgentMessageForRun(t, env, issued.AccessToken, "room", roomID, "forged-run", input)
	var replay struct {
		MessageID string `json:"message_id"`
		Duplicate bool   `json:"duplicate_request"`
	}
	decode(t, body, &replay)
	if code != http.StatusOK || !replay.Duplicate || replay.MessageID != messageID {
		t.Fatalf("replay naming another Run: %d %s", code, body)
	}
	if countRows(t, env, `SELECT count(*) FROM messages WHERE room_id=$1 AND author_actor_id='actor_acme_official' AND local_run_id IS NULL`, roomID) != 1 ||
		countRows(t, env, `SELECT count(*) FROM command_replays WHERE scope='agent:actor_acme_official' AND invocation_id=$1`, invocation) != 1 ||
		countRows(t, env, `SELECT count(*) FROM agent_runtime_status_events`) != 0 || dispatches.Load() != 1 {
		t.Fatal("recovery duplicated an effect or accepted untrusted presentation evidence")
	}
}

// The CLI keeps no local receipts, so TeamHub alone tells a retry from a new
// write: one operation ID commits once, and two operations in the same Run
// with identical content are two messages.
func TestAgentCLIOperationIDsDeduplicateRetriesButNotSeparateSends(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, _, issued, roomID := newAgentCLIIdentity(t)
	send := func(invocation string) (int, []byte) {
		return commitAgentMessageForRun(t, env, issued.AccessToken, "room", roomID, "run-same", map[string]any{
			"invocation_id": invocation, "inbox_id": "room:" + roomID,
			"segments": []map[string]any{{"type": "text", "content": "Same words"}},
		})
	}
	first := "agent-invocation-sha256:" + strings.Repeat("b", 64)
	second := "agent-invocation-sha256:" + strings.Repeat("c", 64)
	var results [3]struct {
		MessageID string `json:"message_id"`
		Duplicate bool   `json:"duplicate_request"`
	}
	for index, invocation := range []string{first, first, second} {
		code, body := send(invocation)
		if code != http.StatusOK {
			t.Fatalf("send %d: %d %s", index, code, body)
		}
		decode(t, body, &results[index])
	}
	if results[0].Duplicate || !results[1].Duplicate || results[1].MessageID != results[0].MessageID ||
		results[2].Duplicate || results[2].MessageID == results[0].MessageID {
		t.Fatalf("operation replay results: %+v", results)
	}
	if countRows(t, env, `SELECT count(*) FROM messages WHERE room_id=$1 AND author_actor_id='actor_acme_official'`, roomID) != 2 {
		t.Fatal("a retry committed twice or a second send was deduplicated")
	}
	code, body := commitAgentMessageForRun(t, env, issued.AccessToken, "room", roomID, "run-same", map[string]any{
		"invocation_id": first, "inbox_id": "room:" + roomID,
		"segments": []map[string]any{{"type": "text", "content": "Different words"}},
	})
	if code != http.StatusConflict || !bytes.Contains(body, []byte("idempotency_conflict")) {
		t.Fatalf("changed input under one operation ID: %d %s", code, body)
	}
}
