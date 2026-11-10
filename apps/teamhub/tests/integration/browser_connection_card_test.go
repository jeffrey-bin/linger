package integration_test

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
)

// browserLocalComputers answers browser connection reads with a settable state;
// a configure connects Chrome.
type browserLocalComputers struct {
	recordingLocalComputers
	mu    sync.Mutex
	state string
}

func (c *browserLocalComputers) setState(state string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.state = state
}

func (c *browserLocalComputers) ConnectLocalBrowser(_ context.Context, command roomagent.LocalBrowserConnectionCommand) (roomagent.LocalBrowserConnectionStatus, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if command.Action == roomagent.LocalBrowserConnectionConfigure {
		c.state = "connected"
	}
	return roomagent.LocalBrowserConnectionStatus{Mode: "user_chrome", State: c.state, Platform: "darwin"}, nil
}

// An Agent whose owner has not connected Chrome posts one browser connection
// card, reused while pending. The owner's connection resolves it and wakes the
// Agent; a decline resolves the next one and tells the Agent to stop.
func TestBrowserConnectionCardSettlesOnConnectAndDecline(t *testing.T) {
	allowParallelIntegrationTest(t)
	computers := &browserLocalComputers{state: "not_connected"}
	env, alice, issued, roomID := newAgentCLIIdentity(t, withLocalComputers(computers))
	var computerID string
	if err := env.pool.QueryRow(t.Context(), `SELECT computer_id FROM agent_registrations WHERE actor_id='actor_acme_official'`).Scan(&computerID); err != nil {
		t.Fatal(err)
	}
	request := func() (int, string) {
		t.Helper()
		status, body := postAgentInRoom(t, env, issued.AccessToken, roomID, "/api/agent/v1/computer/browser-connection", map[string]any{})
		return status, string(body)
	}
	// The fixture Agent runs on Alice's Local Computer.
	if got := countRows(t, env, `SELECT count(*) FROM local_computers WHERE computer_id=$1 AND owner_tenant_id='tenant_acme' AND owner_actor_id='actor_acme_alice'`, computerID); got != 1 {
		t.Fatalf("fixture Computer owner rows=%d", got)
	}

	status, body := request()
	if status != http.StatusOK || !strings.Contains(body, `"status":"connection_requested"`) {
		t.Fatalf("first request: %d %s", status, body)
	}
	var first struct {
		InteractionID string `json:"interaction_id"`
		MessageID     string `json:"message_id"`
	}
	decode(t, []byte(body), &first)
	if status, body := request(); status != http.StatusOK || !strings.Contains(body, first.InteractionID) {
		t.Fatalf("pending card was not reused: %d %s", status, body)
	}
	if got := countRows(t, env, `SELECT count(*) FROM decisions WHERE room_id=$1 AND status='pending'
 AND kind='browser_connection' AND view->>'computer_id'=$2 AND decider_actor_id='actor_acme_alice'`, roomID, computerID); got != 1 {
		t.Fatalf("pending browser connection cards=%d", got)
	}

	code, _, response := env.request(alice, http.MethodPut, "/v0/tenants/tenant_acme/local-computers/"+computerID+"/browser-connection",
		map[string]any{"extension_token": "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U_-"}, "")
	if code != http.StatusOK || strings.Contains(string(response), "A1b2C3d4") {
		t.Fatalf("connect: %d %s", code, response)
	}
	assertBrowserCardHandoff(t, env, first.InteractionID, first.MessageID, "answered", `"decision": "connected"`, "the user connected their everyday Chrome")
	if status, body := request(); status != http.StatusOK || body != `{"status":"ready"}` {
		t.Fatalf("connected request: %d %s", status, body)
	}

	computers.setState("token_invalid")
	status, body = request()
	var second struct {
		InteractionID string `json:"interaction_id"`
		MessageID     string `json:"message_id"`
	}
	decode(t, []byte(body), &second)
	if status != http.StatusOK || second.InteractionID == "" || second.InteractionID == first.InteractionID {
		t.Fatalf("second request: %d %s", status, body)
	}
	if code, _, body := env.request(alice, http.MethodPost, "/v0/decisions/"+second.InteractionID, map[string]any{
		"expected_version": 1, "decision": "approve",
	}, "browser-approve-"+second.InteractionID); code != http.StatusBadRequest {
		t.Fatalf("approve is not a browser connection decision: %d %s", code, body)
	}
	if code, _, body := env.request(alice, http.MethodPost, "/v0/decisions/"+second.InteractionID, map[string]any{
		"expected_version": 1, "decision": "deny",
	}, "browser-deny-"+second.InteractionID); code != http.StatusOK {
		t.Fatalf("decline: %d %s", code, body)
	}
	assertBrowserCardHandoff(t, env, second.InteractionID, second.MessageID, "denied", `"decision": "deny"`, "the user declined to connect their everyday Chrome")
}

func assertBrowserCardHandoff(t *testing.T, env *testEnv, decisionID, cardMessageID, wantStatus, answer, handoff string) {
	t.Helper()
	var status, stored string
	if err := env.pool.QueryRow(t.Context(), `SELECT status,answer::text FROM decisions WHERE id=$1`, decisionID).Scan(&status, &stored); err != nil {
		t.Fatal(err)
	}
	if status != wantStatus || !strings.Contains(stored, answer) {
		t.Fatalf("card %s status=%s answer=%s", decisionID, status, stored)
	}
	var text, disposition string
	if err := env.pool.QueryRow(t.Context(), `SELECT message.body,
 (SELECT disposition FROM agent_inbox_message_disposition('tenant_acme','actor_acme_official',NULL,'room:'||message.room_id,message.id))
 FROM messages message WHERE message.card_context_message_id=$1 AND message.message_kind='agent_runtime'`, cardMessageID).Scan(&text, &disposition); err != nil {
		t.Fatal(err)
	}
	if disposition != "notify" || !strings.Contains(text, handoff) {
		t.Fatalf("handoff disposition=%s body=%q", disposition, text)
	}
}
