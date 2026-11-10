package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

func TestAgentRuntimeStateHTTPContractAndRecoveryChain(t *testing.T) {
	allowParallelIntegrationTest(t)
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(t.Context(), databaseURL)
	if err != nil {
		t.Fatalf("open Agent Runtime State HTTP database: %v", err)
	}
	t.Cleanup(pool.Close)
	seedReadyFixtureComputers(t, pool)
	application, err := newTestApp(context.Background(), config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.TeamHubInternalToken = teamHubInternalToken
		c.NodeServicesInternalToken = nodeServicesInternalToken
		c.AgentRunTokenSecret = agentRunTokenSecret
		c.ArtifactStorageRoot = t.TempDir()
		c.ArtifactMaxBytes = 1 << 20
	}), skipping(app.SkillInstall), skipping(app.SkillPackageProbe),
		skipping(app.RoomDocumentJobs), skipping(app.AgentCredentialSweep), skipping(app.PersonalWikiJobs))
	if err != nil {
		t.Fatalf("start TeamHub for Agent Runtime State HTTP test: %v", err)
	}
	t.Cleanup(application.Close)

	handler := application.Handler()
	status, body := agentRuntimeStateRequest(t, handler, http.MethodGet,
		"/v0/agent-runtime/config?agent_id="+testRuntimeAgentID, teamHubInternalToken, nil)
	if status != http.StatusOK {
		t.Fatalf("get Runtime configuration status=%d body=%s", status, body)
	}
	var configSnapshot struct {
		AgentID               string `json:"agent_id"`
		ActorID               string `json:"actor_id"`
		TenantID              string `json:"tenant_id"`
		ConfigurationRevision string `json:"configuration_revision"`
		ContentHash           string `json:"content_hash"`
		Agent                 struct {
			Name         string `json:"name"`
			Instructions string `json:"instructions"`
		} `json:"agent"`
		Runtime struct {
			Type  string `json:"type"`
			Model string `json:"model"`
		} `json:"runtime"`
	}
	decode(t, body, &configSnapshot)
	if configSnapshot.AgentID != testRuntimeAgentID || configSnapshot.ActorID != "actor_acme_official" ||
		configSnapshot.TenantID != "tenant_acme" || configSnapshot.ConfigurationRevision != "1" ||
		configSnapshot.ContentHash == "" || configSnapshot.Agent.Name != "@official" ||
		configSnapshot.Runtime.Type != "local" || configSnapshot.Runtime.Model != "gpt-5" {
		t.Fatalf("unexpected Runtime configuration snapshot: %+v", configSnapshot)
	}
	status, replayBody := agentRuntimeStateRequest(t, handler, http.MethodGet,
		"/v0/agent-runtime/config?agent_id="+testRuntimeAgentID+"&revision=1", teamHubInternalToken, nil)
	if status != http.StatusOK || !bytes.Equal(body, replayBody) {
		t.Fatalf("Runtime configuration revision read status=%d body=%s first=%s", status, replayBody, body)
	}
	if _, err := pool.Exec(t.Context(), "UPDATE agent_registrations SET status='revoked' WHERE agent_management_id=$1", testRuntimeAgentID); err != nil {
		t.Fatal(err)
	}
	code, payload := agentRuntimeStateRequest(t, handler, http.MethodGet,
		"/v0/agent-runtime/config?agent_id="+testRuntimeAgentID, teamHubInternalToken, nil)
	assertAgentRuntimeHTTPError(t, code, payload, http.StatusNotFound, "NOT_FOUND")
	if _, err := pool.Exec(t.Context(), "UPDATE agent_registrations SET status='active' WHERE agent_management_id=$1", testRuntimeAgentID); err != nil {
		t.Fatal(err)
	}
	status, body = agentRuntimeStateRequest(t, handler, http.MethodGet,
		"/v0/agent-runtime/config?agent_id="+testRuntimeAgentID+"&revision=2", teamHubInternalToken, nil)
	assertAgentRuntimeHTTPError(t, status, body, http.StatusConflict, "AGENT_RUNTIME_CONFLICT")
	status, body = agentRuntimeStateRequest(t, handler, http.MethodGet,
		"/v0/agent-runtime/config?agent_id=missing-runtime-agent", teamHubInternalToken, nil)
	assertAgentRuntimeHTTPError(t, status, body, http.StatusNotFound, "NOT_FOUND")

	status, _ = agentRuntimeStateRequest(t, handler, http.MethodGet,
		"/v0/agent-runtime/contexts?agent_id="+testRuntimeAgentID, "", nil)
	if status != http.StatusUnauthorized {
		t.Fatalf("missing service bearer status=%d, want 401", status)
	}
	insertRuntimeRoomMembership(t, pool, "http-runtime")

	status, body = agentRuntimeStateRequest(t, handler, http.MethodPost, "/v0/agent-runtime/contexts", teamHubInternalToken, map[string]any{
		"target_residency": "active",
		"ref":              map[string]any{"kind": "meta", "agent_id": testRuntimeAgentID},
	})
	assertAgentRuntimeHTTPError(t, status, body, http.StatusBadRequest, "INVALID_REQUEST")
	ensureRequest := map[string]any{
		"target_residency": "active",
		"ref":              map[string]any{"kind": "meta", "agent_id": testRuntimeAgentID, "room_id": "http-runtime"},
	}
	status, body = agentRuntimeStateRequest(t, handler, http.MethodPost, "/v0/agent-runtime/contexts", teamHubInternalToken, ensureRequest)
	if status != http.StatusOK {
		t.Fatalf("ensure Context status=%d body=%s", status, body)
	}
	var ensured struct {
		Created bool `json:"created"`
		Context struct {
			ContextKey    string `json:"context_key"`
			StateRevision string `json:"state_revision"`
		} `json:"context"`
	}
	decode(t, body, &ensured)
	if !ensured.Created || ensured.Context.ContextKey == "" || ensured.Context.StateRevision != "1" {
		t.Fatalf("unexpected ensured Context: %+v", ensured)
	}
	contextKey := ensured.Context.ContextKey

	status, replayBody = agentRuntimeStateRequest(t, handler, http.MethodPost, "/v0/agent-runtime/contexts", teamHubInternalToken, ensureRequest)
	var replayed struct {
		Created bool `json:"created"`
		Context struct {
			ContextKey string `json:"context_key"`
		} `json:"context"`
	}
	decode(t, replayBody, &replayed)
	if status != http.StatusOK || replayed.Created || replayed.Context.ContextKey != contextKey {
		t.Fatalf("repeated ensure status=%d body=%s", status, replayBody)
	}

	status, body = agentRuntimeStateRequest(t, handler, http.MethodPost, "/v0/agent-runtime/epochs", teamHubInternalToken, map[string]any{
		"epoch": "http-runtime-epoch",
	})
	if status != http.StatusOK {
		t.Fatalf("start epoch status=%d body=%s", status, body)
	}
	const epoch = "http-runtime-epoch"

	status, body = agentRuntimeStateRequest(t, handler, http.MethodPost, "/v0/agent-runtime/trusted-turns", teamHubInternalToken, map[string]any{
		"command_id": "http-retired-command", "context_key": contextKey, "epoch": epoch,
		"inputs": []any{runtimeHTTPInput("http-retired-command-input", "invalid")},
	})
	assertAgentRuntimeHTTPError(t, status, body, http.StatusBadRequest, "INVALID_REQUEST")

	turnRequest := map[string]any{
		"context_key": contextKey, "epoch": epoch,
		"inputs": []any{runtimeHTTPInput("http-runtime-input", "first")},
	}
	var submitted teamhubinternal.SubmitAgentTrustedTurnResult
	status, body = agentRuntimeStateRequest(t, handler, http.MethodPost, "/v0/agent-runtime/trusted-turns", teamHubInternalToken, turnRequest)
	if status != http.StatusOK {
		t.Fatalf("submit trusted turn status=%d body=%s", status, body)
	}
	decode(t, body, &submitted)
	if submitted.RunId == "" || submitted.Created == nil || !*submitted.Created ||
		submitted.Context == nil || submitted.Context.TargetResidency != "active" {
		t.Fatalf("submitted trusted turn did not create a Run in an active Context: %s", body)
	}
	status, replayBody = agentRuntimeStateRequest(t, handler, http.MethodPost, "/v0/agent-runtime/trusted-turns", teamHubInternalToken, turnRequest)
	var repeated teamhubinternal.SubmitAgentTrustedTurnResult
	decode(t, replayBody, &repeated)
	if status != http.StatusOK || repeated.RunId != submitted.RunId || repeated.Created == nil || *repeated.Created {
		t.Fatalf("repeated trusted turn status=%d body=%s first=%s", status, replayBody, body)
	}

	status, body = agentRuntimeStateRequest(t, handler, http.MethodPost, "/v0/agent-runtime/runs/claim", teamHubInternalToken, map[string]any{
		"context_key": contextKey, "epoch": epoch, "claim_id": "http-claim-local-run",
	})
	if status != http.StatusOK {
		t.Fatalf("claim Local Run status=%d body=%s", status, body)
	}
	var runClaim struct {
		Claimed bool `json:"claimed"`
		Run     struct {
			RunID string `json:"run_id"`
		} `json:"run"`
	}
	decode(t, body, &runClaim)
	if !runClaim.Claimed || runClaim.Run.RunID != submitted.RunId {
		t.Fatalf("unexpected Local Run claim: %+v", runClaim)
	}

	configurationRevision := activeRuntimeConfigurationRevision(t, pool)
	checkpoint := runtimeHTTPSessionCheckpoint("0", configurationRevision, "http-thread-one")
	status, body = agentRuntimeStateRequest(t, handler, http.MethodPost, "/v0/agent-runtime/sessions/checkpoint", teamHubInternalToken, map[string]any{
		"context_key": contextKey, "epoch": epoch, "checkpoint": checkpoint,
	})
	if status != http.StatusOK {
		t.Fatalf("checkpoint RuntimeSession status=%d body=%s", status, body)
	}
	assertRuntimeHTTPSession(t, body, "1", "http-thread-one", "9007199254740993")

	status, body = agentRuntimeStateRequest(t, handler, http.MethodGet,
		"/v0/agent-runtime/session?context_key="+url.QueryEscape(contextKey), teamHubInternalToken, nil)
	if status != http.StatusOK {
		t.Fatalf("get RuntimeSession status=%d body=%s", status, body)
	}
	var sessionRead struct {
		Available bool            `json:"available"`
		Session   json.RawMessage `json:"session"`
	}
	decode(t, body, &sessionRead)
	if !sessionRead.Available {
		t.Fatalf("RuntimeSession unavailable after checkpoint: %s", body)
	}
	assertRuntimeHTTPSession(t, sessionRead.Session, "1", "http-thread-one", "9007199254740993")

	checkpoint = runtimeHTTPSessionCheckpoint("1", configurationRevision, "http-thread-two")
	status, body = agentRuntimeStateRequest(t, handler, http.MethodPost, "/v0/agent-runtime/runs/finish", teamHubInternalToken, map[string]any{
		"context_key": contextKey, "epoch": epoch, "run_id": submitted.RunId,
		"terminal": map[string]any{"type": "succeeded"}, "session": checkpoint,
	})
	if status != http.StatusOK {
		t.Fatalf("finish Local Run with Session status=%d body=%s", status, body)
	}
	var finished struct {
		Run struct {
			Status string `json:"status"`
		} `json:"run"`
		Session json.RawMessage `json:"session"`
	}
	decode(t, body, &finished)
	if finished.Run.Status != "succeeded" {
		t.Fatalf("finished Local Run status=%q body=%s", finished.Run.Status, body)
	}
	assertRuntimeHTTPSession(t, finished.Session, "2", "http-thread-two", "9007199254740993")

	// The fallback scan lists no Context once its only Run finished.
	status, body = agentRuntimeStateRequest(t, handler, http.MethodGet, "/v0/agent-runtime/runs/waiting", teamHubInternalToken, nil)
	if status != http.StatusOK {
		t.Fatalf("list waiting Contexts status=%d body=%s", status, body)
	}
	var waiting struct {
		ContextKeys []string `json:"context_keys"`
	}
	decode(t, body, &waiting)
	if slices.Contains(waiting.ContextKeys, contextKey) {
		t.Fatalf("finished Context still waits: %s", body)
	}

	status, body = agentRuntimeStateRequest(t, handler, http.MethodPost, "/v0/agent-runtime/trusted-turns", teamHubInternalToken, map[string]any{
		"context_key": contextKey, "epoch": "http-runtime-epoch-previous",
		"inputs": []any{runtimeHTTPInput("http-fenced-input", "fenced")},
	})
	assertAgentRuntimeHTTPError(t, status, body, http.StatusConflict, "CONTEXT_FENCED")
}

func agentRuntimeStateRequest(
	t *testing.T,
	handler http.Handler,
	method, path, token string,
	payload any,
) (int, []byte) {
	t.Helper()
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			t.Fatalf("encode Agent Runtime State request: %v", err)
		}
		body = bytes.NewReader(encoded)
	}
	request := httptest.NewRequest(method, path, body)
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response.Code, response.Body.Bytes()
}

func runtimeHTTPInput(inputID, body string) map[string]any {
	return map[string]any{
		"input_id": inputID, "source_kind": "trusted_turn",
		"payload": map[string]any{"messageId": inputID, "body": body},
	}
}

func runtimeHTTPSessionCheckpoint(expectedRevision string, configurationRevision int64, threadID string) map[string]any {
	return map[string]any{
		"expected_revision": expectedRevision, "provider_kind": "codex", "schema_version": "1",
		"session":   map[string]any{"threadId": threadID, "largeSequence": json.Number("9007199254740993")},
		"thread_id": threadID, "configuration_revision": strconv.FormatInt(configurationRevision, 10),
	}
}

func assertRuntimeHTTPSession(t *testing.T, raw []byte, revision, threadID, largeSequence string) {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value struct {
		Revision string `json:"revision"`
		ThreadID string `json:"thread_id"`
		Session  struct {
			LargeSequence json.Number `json:"largeSequence"`
		} `json:"session"`
	}
	if err := decoder.Decode(&value); err != nil {
		t.Fatalf("decode RuntimeSession response: %v body=%s", err, raw)
	}
	if value.Revision != revision || value.ThreadID != threadID || value.Session.LargeSequence.String() != largeSequence {
		t.Fatalf("RuntimeSession revision=%q thread=%q largeSequence=%q, want %q/%q/%q",
			value.Revision, value.ThreadID, value.Session.LargeSequence.String(), revision, threadID, largeSequence)
	}
}

func assertAgentRuntimeHTTPError(t *testing.T, status int, body []byte, wantStatus int, wantCode string) {
	t.Helper()
	var response struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	decode(t, body, &response)
	if status != wantStatus || response.Error.Code != wantCode {
		t.Fatalf("Agent Runtime error status=%d code=%q body=%s, want %d/%q", status, response.Error.Code, body, wantStatus, wantCode)
	}
}
