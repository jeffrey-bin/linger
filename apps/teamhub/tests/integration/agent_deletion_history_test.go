package integration_test

import (
	"net/http"
	"testing"
)

func TestAgentDeletionRetiresOnlyTheDirectRoom(t *testing.T) {
	allowParallelIntegrationTest(t)
	t.Run("with Runtime", func(t *testing.T) {
		management := &recordingAgentManagement{}
		env, alice := newAgentRegistrationEnv(t, management)
		status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/agents", map[string]any{
			"name": "History choice", "instructions": "Answer directly", "runtime": fixtureRuntime("gpt-5"), "visibility_scope": "workspace",
		}, "history-choice-agent")
		if status != http.StatusCreated {
			t.Fatalf("create Agent: %d %s", status, body)
		}
		var agent struct {
			Actor struct {
				ID string `json:"id"`
			} `json:"actor"`
		}
		decode(t, body, &agent)
		own := requestDirectRoom(alice, env.server.URL, agent.Actor.ID)
		if own.status != http.StatusCreated {
			t.Fatalf("open DM: own=%+v", own)
		}
		var ownRoom struct {
			ID string `json:"id"`
		}
		decode(t, own.body, &ownRoom)
		env.createMessage(alice, ownRoom.ID, "My private history", "own-history-message")
		groupID := createPrivateRoom(t, env, alice, "Shared history", "history-group-room")
		if status, body := putRoomMember(t, env, alice, groupID, agent.Actor.ID, "member"); status != http.StatusOK {
			t.Fatalf("add Agent: %d %s", status, body)
		}
		env.createMessage(alice, groupID, "Keep the group history", "group-history-message")
		path := "/v0/tenants/" + acmeTenant + "/agents/" + agent.Actor.ID
		status, _, body = env.request(alice, http.MethodDelete, path, nil, "")
		expected := http.StatusNoContent
		if status != expected {
			t.Fatalf("delete: %d want=%d %s", status, expected, body)
		}
		status, _, body = env.request(alice, http.MethodDelete, path, nil, "")
		if status != expected || len(management.notifiedSnapshot()) != 1 {
			t.Fatalf("replay: %d %s upstream=%v", status, body, management.notifiedSnapshot())
		}
		for _, roomID := range []string{ownRoom.ID, groupID} {
			status, _, body = env.request(alice, http.MethodGet, "/v0/rooms/"+roomID+"/messages", nil, "")
			expected := http.StatusOK
			if roomID == ownRoom.ID {
				expected = http.StatusNotFound
			}
			if status != expected {
				t.Fatalf("history room=%s status=%d want=%d %s", roomID, status, expected, body)
			}
		}
		if got := countRows(t, env, "SELECT count(*) FROM rooms WHERE id=$1 AND deleted_at IS NOT NULL", ownRoom.ID); got != 1 {
			t.Fatal("DM deletion not finalized")
		}
		if got := countRows(t, env, "SELECT count(*) FROM agent_registrations WHERE actor_id=$1 AND status='revoked'", agent.Actor.ID); got != 1 {
			t.Fatal("Agent revocation not committed")
		}
	})
	t.Run("without Runtime and without an upstream identity", func(t *testing.T) {
		env := newRoomMembershipEnv(t)
		alice := env.login("alice", alicePassword)
		direct := requestDirectRoom(alice, env.server.URL, "actor_acme_official")
		if direct.status != http.StatusCreated {
			t.Fatalf("open DM: %+v", direct)
		}
		status, _, body := env.request(alice, http.MethodDelete, "/v0/tenants/"+acmeTenant+"/agents/actor_acme_official", nil, "")
		if status != http.StatusNoContent {
			t.Fatalf("delete without Runtime: %d %s", status, body)
		}
		if got := countRows(t, env, "SELECT count(*) FROM rooms WHERE id=$1 AND deleted_at IS NOT NULL", direct.roomID); got != 1 {
			t.Fatal("DM not finalized")
		}
	})

}
