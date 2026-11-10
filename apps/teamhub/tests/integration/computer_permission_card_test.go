package integration_test

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
)

// permissionLocalComputers reports a Mac whose Linger Screen Recording state
// the test sets; every action records what the owner's card asked for.
type permissionLocalComputers struct {
	recordingLocalComputers
	mu      sync.Mutex
	state   string
	actions []roomagent.LocalComputerPermissionCommand
}

func (c *permissionLocalComputers) setState(state string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.state = state
}

func (c *permissionLocalComputers) LocalComputerPermissions(_ context.Context, command roomagent.LocalComputerPermissionCommand) (roomagent.LocalComputerPermissionStatus, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if command.Action != roomagent.LocalComputerPermissionStatusAction {
		c.actions = append(c.actions, command)
	}
	entry := func(id, state string) roomagent.LocalComputerPermissionEntry {
		return roomagent.LocalComputerPermissionEntry{ID: id, State: state, Prompt: "available"}
	}
	return roomagent.LocalComputerPermissionStatus{Platform: "darwin", Host: "desktop", Subjects: []roomagent.LocalComputerPermissionSubject{
		{Subject: "linger", Permissions: []roomagent.LocalComputerPermissionEntry{entry("screen_recording", c.state), entry("accessibility", "granted")}},
		{Subject: "computer_use", Permissions: []roomagent.LocalComputerPermissionEntry{entry("screen_recording", "denied"), entry("accessibility", "denied")}},
	}}, nil
}

// An Agent missing Screen Recording posts one computer_permission card, reused
// while pending. The owner's grant on the Mac settles it through the card's
// own status read and wakes the Agent; a decline resolves the next one.
func TestComputerPermissionCardSettlesOnGrantAndDecline(t *testing.T) {
	allowParallelIntegrationTest(t)
	computers := &permissionLocalComputers{state: "not_determined"}
	env, alice, issued, roomID := newAgentCLIIdentity(t, withLocalComputers(computers))
	var computerID string
	if err := env.pool.QueryRow(t.Context(), `SELECT computer_id FROM agent_registrations WHERE actor_id='actor_acme_official'`).Scan(&computerID); err != nil {
		t.Fatal(err)
	}
	request := func(body map[string]any) (int, string) {
		t.Helper()
		status, response := postAgentInRoom(t, env, issued.AccessToken, roomID, "/api/agent/v1/computer/permissions/request", body)
		return status, string(response)
	}
	screen := map[string]any{"subject": "linger", "permissions": []string{"screen_recording"}, "reason": "Take a screenshot of the report"}

	for _, invalid := range []map[string]any{
		{"subject": "linger", "permissions": []string{"camera"}},
		{"subject": "linger", "permissions": []string{"accessibility", "accessibility"}},
		{"subject": "cua", "permissions": []string{"accessibility"}},
		{"subject": "linger", "permissions": []string{}},
	} {
		if status, body := request(invalid); status != http.StatusBadRequest {
			t.Fatalf("invalid request %v: %d %s", invalid, status, body)
		}
	}
	if status, body := request(map[string]any{"subject": "linger", "permissions": []string{"accessibility"}}); status != http.StatusOK ||
		!strings.Contains(body, `"status":"ready"`) {
		t.Fatalf("granted permission: %d %s", status, body)
	}

	status, body := request(screen)
	if status != http.StatusOK || !strings.Contains(body, `"status":"permission_requested"`) || !strings.Contains(body, `"computer_id":"`+computerID+`"`) {
		t.Fatalf("first request: %d %s", status, body)
	}
	var first struct {
		InteractionID string `json:"interaction_id"`
		MessageID     string `json:"message_id"`
	}
	decode(t, []byte(body), &first)
	if status, body := request(screen); status != http.StatusOK || !strings.Contains(body, first.InteractionID) {
		t.Fatalf("pending card was not reused: %d %s", status, body)
	}
	if got := countRows(t, env, `SELECT count(*) FROM decisions WHERE room_id=$1 AND status='pending' AND kind='computer_permission'
 AND view->>'computer_id'=$2 AND view->>'subject'='linger' AND decider_actor_id='actor_acme_alice'`, roomID, computerID); got != 1 {
		t.Fatalf("pending computer permission cards=%d", got)
	}
	// A card for the other app is a separate request.
	if status, body := request(map[string]any{"subject": "computer_use", "permissions": []string{"accessibility"}}); status != http.StatusOK ||
		strings.Contains(body, first.InteractionID) {
		t.Fatalf("computer use request: %d %s", status, body)
	}

	permissions := "/v0/tenants/tenant_acme/local-computers/" + computerID + "/permissions"
	if code, _, body := env.request(alice, http.MethodPost, permissions, map[string]any{"action": "prompt", "subject": "linger"}, ""); code != http.StatusBadRequest {
		t.Fatalf("prompt without a permission: %d %s", code, body)
	}
	if code, _, body := env.request(alice, http.MethodPost, permissions, map[string]any{
		"action": "prompt", "subject": "linger", "permission": "screen_recording",
	}, ""); code != http.StatusOK || !strings.Contains(string(body), `"subjects"`) {
		t.Fatalf("prompt: %d %s", code, body)
	}
	computers.mu.Lock()
	if len(computers.actions) != 1 || computers.actions[0].Action != roomagent.LocalComputerPermissionPrompt ||
		computers.actions[0].OwnerActorID != "actor_acme_alice" || computers.actions[0].Permission != "screen_recording" {
		t.Fatalf("actions=%+v", computers.actions)
	}
	computers.mu.Unlock()
	assertCardStatus(t, env, first.InteractionID, "pending")

	computers.setState("granted")
	if code, _, body := env.request(alice, http.MethodGet, permissions, nil, ""); code != http.StatusOK {
		t.Fatalf("owner status: %d %s", code, body)
	}
	assertBrowserCardHandoff(t, env, first.InteractionID, first.MessageID, "answered", `"decision": "granted"`,
		"the user granted screen_recording for Linger. Continue the task now.")
	if got := countRows(t, env, `SELECT count(*) FROM decisions WHERE kind='computer_permission' AND view->>'subject'='computer_use' AND status='pending'`); got != 1 {
		t.Fatalf("the computer use card settled without its grant: pending=%d", got)
	}
	if status, body := request(screen); status != http.StatusOK || !strings.Contains(body, `"status":"ready"`) {
		t.Fatalf("granted request: %d %s", status, body)
	}

	computers.setState("denied")
	status, body = request(screen)
	var second struct {
		InteractionID string `json:"interaction_id"`
		MessageID     string `json:"message_id"`
	}
	decode(t, []byte(body), &second)
	if status != http.StatusOK || second.InteractionID == "" || second.InteractionID == first.InteractionID {
		t.Fatalf("second request: %d %s", status, body)
	}
	if code, _, body := env.request(alice, http.MethodPost, "/v0/decisions/"+second.InteractionID, map[string]any{
		"expected_version": 1, "decision": "granted",
	}, "permission-granted-"+second.InteractionID); code != http.StatusBadRequest {
		t.Fatalf("the owner cannot answer granted: %d %s", code, body)
	}
	if code, _, body := env.request(alice, http.MethodPost, "/v0/decisions/"+second.InteractionID, map[string]any{
		"expected_version": 1, "decision": "deny",
	}, "permission-deny-"+second.InteractionID); code != http.StatusOK {
		t.Fatalf("decline: %d %s", code, body)
	}
	assertBrowserCardHandoff(t, env, second.InteractionID, second.MessageID, "denied", `"decision": "deny"`,
		"the user declined to grant screen_recording for Linger")
}

func assertCardStatus(t *testing.T, env *testEnv, decisionID, want string) {
	t.Helper()
	var status string
	if err := env.pool.QueryRow(t.Context(), `SELECT status FROM decisions WHERE id=$1`, decisionID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != want {
		t.Fatalf("card %s status=%s want %s", decisionID, status, want)
	}
}
