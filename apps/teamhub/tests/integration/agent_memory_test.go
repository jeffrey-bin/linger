package integration_test

import (
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
)

func TestAgentMemoryScopePublication(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, _, business, _ := newAgentCLIIdentity(t)
	ctx := t.Context()
	service := agentruntimestate.New(env.pool)
	endpoint := "/v0/agent-runtime/agents/" + business.AgentID + "/memory"
	document := map[string]any{"revision": 0, "summary": "Orchard", "memory": "release alpha", "sessions": map[string]any{}, "cursors": map[string]any{}}
	code, _, body := taskWorkerJSONRequest(t, env, http.MethodPost, endpoint, teamHubInternalToken, document, nil)
	if code != http.StatusOK {
		t.Fatalf("initial publish: %d %s", code, body)
	}
	var published struct {
		Revision int    `json:"revision"`
		Memory   string `json:"memory"`
	}
	decode(t, body, &published)
	if published.Revision != 1 || published.Memory != "release alpha" {
		t.Fatalf("unexpected publication: %+v", published)
	}
	code, _, _ = taskWorkerJSONRequest(t, env, http.MethodPost, endpoint, teamHubInternalToken, document, nil)
	if code != http.StatusConflict {
		t.Fatalf("stale memory publish allowed: %d", code)
	}
	document["revision"] = 1
	document["memory"] = "release beta"
	code, _, _ = taskWorkerJSONRequest(t, env, http.MethodPost, endpoint, teamHubInternalToken, document, nil)
	if code != http.StatusOK {
		t.Fatalf("next publish: %d", code)
	}
	value, err := service.ReadMemory(ctx, business.AgentID)
	if err != nil || json.Unmarshal(value, &published) != nil || published.Revision != 2 || published.Memory != "release beta" {
		t.Fatalf("persisted Memory: %s %v", value, err)
	}
	if _, err := service.ReadMemory(ctx, "different-agent"); !errors.Is(err, agentruntimestate.ErrNotFound) {
		t.Fatalf("cross-Agent read: %v", err)
	}
}

func TestAgentMemoryReadUsesRevisionColumn(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, _, business, _ := newAgentCLIIdentity(t)
	ctx := t.Context()
	service := agentruntimestate.New(env.pool)
	endpoint := "/v0/agent-runtime/agents/" + business.AgentID + "/memory"
	document := map[string]any{"revision": 0, "summary": "Orchard", "memory": "release alpha", "sessions": map[string]any{}, "cursors": map[string]any{}}
	code, _, body := taskWorkerJSONRequest(t, env, http.MethodPost, endpoint, teamHubInternalToken, document, nil)
	if code != http.StatusOK {
		t.Fatalf("initial publish: %d %s", code, body)
	}
	// The revision column can move ahead of document.revision.
	if _, err := env.pool.Exec(ctx, `UPDATE agent_memories SET revision = revision + 1 WHERE agent_id=$1`, business.AgentID); err != nil {
		t.Fatalf("bump revision column: %v", err)
	}
	value, err := service.ReadMemory(ctx, business.AgentID)
	if err != nil {
		t.Fatalf("read memory: %v", err)
	}
	var read struct {
		Revision int64 `json:"revision"`
	}
	if err := json.Unmarshal(value, &read); err != nil || read.Revision != 2 {
		t.Fatalf("read revision must follow the column (want 2): %s %v", value, err)
	}
	document["revision"] = read.Revision
	document["memory"] = "release beta"
	code, _, body = taskWorkerJSONRequest(t, env, http.MethodPost, endpoint, teamHubInternalToken, document, nil)
	if code != http.StatusOK {
		t.Fatalf("commit with read revision: %d %s", code, body)
	}
	var column, documentRevision int64
	if err := env.pool.QueryRow(ctx, `SELECT revision, (document->>'revision')::bigint FROM agent_memories WHERE agent_id=$1`, business.AgentID).Scan(&column, &documentRevision); err != nil {
		t.Fatalf("read stored revisions: %v", err)
	}
	if column != 3 || documentRevision != 3 {
		t.Fatalf("stored revisions after commit: column=%d document=%d, want 3/3", column, documentRevision)
	}
	document["revision"] = 1
	code, _, _ = taskWorkerJSONRequest(t, env, http.MethodPost, endpoint, teamHubInternalToken, document, nil)
	if code != http.StatusConflict {
		t.Fatalf("stale memory revision allowed: %d", code)
	}
}
