package integration_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
)

func TestAgentRuntimePreparedResourcesPersistAcrossServiceRestart(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	resources := map[string]any{"version": 1, "effectiveSha256": strings.Repeat("a", 64), "skills": []any{map[string]any{
		"skillId": "skill-exact", "manifestId": "manifest-exact", "manifestVersion": "1.0.0", "name": "Exact Skill", "packageName": "exact-skill", "packageSha256": strings.Repeat("b", 64), "source": "explicit", "config": map[string]any{"prefix": "original"},
	}}}
	prepared, _ := json.Marshal(map[string]any{"nativeSession": nil, "executionResources": resources})
	checkpoint := agentruntimestate.RuntimeSessionCheckpoint{ProviderKind: "codex", SchemaVersion: 2, ConfigurationRevision: activeRuntimeConfigurationRevision(t, env.pool), Session: prepared}
	application, err := newIntegrationApp(t.Context(), config.ForTest(func(c *config.Config) {
		c.DatabaseURL = env.pool.Config().ConnString()
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.TeamHubInternalToken = teamHubInternalToken
		c.NodeServicesInternalToken = nodeServicesInternalToken
		c.AgentRunTokenSecret = agentRunTokenSecret
		c.ArtifactStorageRoot = t.TempDir()
	}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	httpCheckpoint := runtimeHTTPSessionCheckpoint("0", checkpoint.ConfigurationRevision, "")
	httpCheckpoint["schema_version"] = "2"
	httpCheckpoint["session"] = json.RawMessage(prepared)
	delete(httpCheckpoint, "thread_id")
	httpStatus, body := agentRuntimeStateRequest(t, application.Handler(), http.MethodPost, "/v0/agent-runtime/sessions/checkpoint", teamHubInternalToken, map[string]any{
		"context_key": env.contextKey, "epoch": env.epoch, "checkpoint": httpCheckpoint,
	})
	if httpStatus != 200 {
		t.Fatalf("HTTP preparation checkpoint: %d %s", httpStatus, body)
	}
	first, err := env.service.GetRuntimeSession(t.Context(), env.contextKey)
	if err != nil || first == nil || first.Revision != 1 || first.ThreadID != "" {
		t.Fatalf("preparation checkpoint: %+v %v", first, err)
	}

	restarted := agentruntimestate.New(env.pool)
	restored, err := restarted.GetRuntimeSession(t.Context(), env.contextKey)
	if err != nil || restored == nil || !bytes.Equal(restored.Session, first.Session) {
		t.Fatalf("durable prepared version: %+v %v", restored, err)
	}
	// The same preparation written again finds its own write instead of a
	// second revision.
	if replayed, err := restarted.CheckpointRuntimeSession(t.Context(), agentruntimestate.CheckpointSessionInput{ContextKey: env.contextKey, Epoch: env.epoch, Checkpoint: checkpoint}); err != nil || replayed.Revision != first.Revision {
		t.Fatalf("repeated preparation checkpoint: %+v %v", replayed, err)
	}
	checkpoint.ExpectedRevision = first.Revision
	checkpoint.ThreadID = "native-thread"
	checkpoint.Session, _ = json.Marshal(map[string]any{"nativeSession": map[string]any{"threadId": "native-thread", "turns": []string{"history"}}, "executionResources": resources})
	second, err := restarted.CheckpointRuntimeSession(t.Context(), agentruntimestate.CheckpointSessionInput{ContextKey: env.contextKey, Epoch: env.epoch, Checkpoint: checkpoint})
	if err != nil || second.Revision != 2 || second.ThreadID != "native-thread" || !bytes.Contains(second.Session, []byte("manifest-exact")) {
		t.Fatalf("native checkpoint discarded resources: %+v %v", second, err)
	}
	checkpoint.ExpectedRevision = second.Revision
	if _, err := restarted.CheckpointRuntimeSession(t.Context(), agentruntimestate.CheckpointSessionInput{ContextKey: env.contextKey, Epoch: "agent-epoch-previous", Checkpoint: checkpoint}); !errors.Is(err, agentruntimestate.ErrFenced) {
		t.Fatalf("resource checkpoint bypassed the epoch: %v", err)
	}
}
