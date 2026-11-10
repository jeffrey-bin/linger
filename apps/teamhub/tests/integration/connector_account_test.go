package integration_test

import (
	"bytes"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
)

// Without a Composio key every connected app command asks the Human for the
// key with one card, reused while pending, and tells the Agent so through
// provider_key_required. Saving a key resolves the card and wakes the Agent,
// whose next request asks for the app itself.
func TestConnectedAppCommandsWithoutComposioAskForTheKey(t *testing.T) {
	allowParallelIntegrationTest(t)
	const key = "composio-saved-key"
	provider := &managedAppsProvider{configs: map[string]managedAuthConfig{}, links: map[string]map[string]string{}, requiredKey: key}
	server := httptest.NewServer(provider)
	registerIntegrationServerCleanup(t, server)
	env, alice, issued, roomID := newAgentCLIIdentity(t, withConfig(func(cfg *config.Config) {
		cfg.ExternalApps.ComposioAPIKey, cfg.ExternalApps.ComposioBaseURL = "", server.URL
		cfg.ExternalApps.SecretEncryptionKey = base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{3}, 32))
	}))
	needsKey := func(path string, body map[string]any) {
		t.Helper()
		status, response := postAgentInRoom(t, env, issued.AccessToken, roomID, path, body)
		var failure struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		decode(t, response, &failure)
		if status != http.StatusConflict || failure.Error.Code != "provider_key_required" {
			t.Fatalf("%s without Composio: %d %s", path, status, response)
		}
	}

	if status, body := postAgentInRoom(t, env, issued.AccessToken, roomID, "/api/agent/v1/apps/account", map[string]any{"app_key": "unknown_app"}); status != http.StatusBadRequest {
		t.Fatalf("unknown app without Composio: %d %s", status, body)
	}
	needsKey("/api/agent/v1/apps/account", map[string]any{"app_key": "higgsfield"})
	needsKey("/api/agent/v1/apps/account", map[string]any{"app_key": "fal_ai"})
	needsKey("/api/agent/v1/apps/tools/search", map[string]any{"query": "create an issue in Linear"})
	needsKey("/api/agent/v1/apps/tools/execute", map[string]any{
		"connection_id": "external_connection_none", "tool_slug": "LINEAR_CREATE_ISSUE", "tool_version": "20261015_00", "arguments": map[string]any{},
	})
	needsKey("/api/agent/v1/apps/auto-reminders/list", map[string]any{})
	var keyCard, keyMessage string
	if err := env.pool.QueryRow(t.Context(), `SELECT id, message_id FROM decisions WHERE room_id=$1 AND status='pending'
 AND kind='provider_key' AND view->>'app_key'='higgsfield' AND decider_actor_id='actor_acme_alice'`, roomID).Scan(&keyCard, &keyMessage); err != nil {
		t.Fatalf("the first request's key card: %v", err)
	}
	if got := countRows(t, env, `SELECT count(*) FROM decisions WHERE room_id=$1 AND kind='provider_key'`, roomID); got != 1 {
		t.Fatalf("key cards=%d, want the first one reused", got)
	}
	if code, _, body := env.request(alice, http.MethodPost, "/v0/decisions/"+keyCard, map[string]any{
		"expected_version": 1, "decision": "approve",
	}, "key-approve-"+keyCard); code != http.StatusBadRequest {
		t.Fatalf("approve is not a key decision: %d %s", code, body)
	}

	if code, _, body := env.request(alice, http.MethodPut, "/v0/external-apps/provider-key", map[string]any{"api_key": key}, ""); code != http.StatusOK {
		t.Fatalf("save key: %d %s", code, body)
	}
	assertBrowserCardHandoff(t, env, keyCard, keyMessage, "answered", `"decision": "configured"`, "the user added the Composio API key")

	status, body := postAgentInRoom(t, env, issued.AccessToken, roomID, "/api/agent/v1/apps/account", map[string]any{"app_key": "higgsfield"})
	var card struct {
		Status        string `json:"status"`
		InteractionID string `json:"interaction_id"`
	}
	decode(t, body, &card)
	if status != http.StatusOK || card.Status != "authorization_required" || card.InteractionID == keyCard {
		t.Fatalf("account request after the key: %d %s", status, body)
	}
	if got := countRows(t, env, `SELECT count(*) FROM decisions WHERE id=$1 AND kind='connection_auth' AND view->>'app_key'='higgsfield'`, card.InteractionID); got != 1 {
		t.Fatalf("connection authorization cards=%d", got)
	}
}
