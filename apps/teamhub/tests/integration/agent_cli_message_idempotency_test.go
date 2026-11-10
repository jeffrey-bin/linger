package integration_test

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
)

func TestAgentCLIMessageOperationIdentityIsScopedToAgent(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, firstCredential, roomID := newAgentCLIIdentity(t, withAgentManagement(&recordingAgentManagement{}))
	seedOwnedFixtureComputer(t, env.pool, "computer_fixture_alice", acmeTenant, "actor_acme_alice")
	code, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/agents", map[string]any{
		"name": "Independent message sender", "instructions": "Send authorized Room messages.",
		"runtime": fixtureRuntimeOn("computer_fixture_alice", "gpt-5"),
	}, "register-second-message-sender")
	if code != http.StatusCreated {
		t.Fatalf("register second Agent: %d %s", code, body)
	}
	var secondAgent tenantAgentUpdateView
	decode(t, body, &secondAgent)
	if code, body := putRoomMember(t, env, alice, roomID, secondAgent.Actor.ID, "member"); code != http.StatusOK {
		t.Fatalf("authorize second Agent: %d %s", code, body)
	}
	issue := func(agentID string) agentcredential.Issued {
		t.Helper()
		credential, err := agentcredential.New(env.pool).IssueManaged(t.Context(), agentID, "message operation identity")
		if err != nil {
			t.Fatalf("issue Agent credential: %v", err)
		}
		return credential
	}
	secondCredential := issue(secondAgent.AgentManagementID)
	// CLI hashes only the operation ID. Bearer identity, rather than the token
	// bytes or a model's choice of operation ID, supplies the Agent boundary.
	operationHash := sha256.Sum256([]byte("same-model-selected-operation"))
	invocationID := "agent-invocation-sha256:" + hex.EncodeToString(operationHash[:])
	post := func(token, content string) (int, []byte) {
		t.Helper()
		return commitAgentMessage(t, env, token, "room", roomID, map[string]any{
			"inbox_id": "room:" + roomID, "invocation_id": invocationID,
			"segments": []map[string]any{{"type": "text", "content": content}},
		})
	}
	const content = "Same operation and input, independently sent by each Agent."
	senders := []struct {
		actorID    string
		credential agentcredential.Issued
		messageID  string
	}{
		{actorID: "actor_acme_official", credential: firstCredential},
		{actorID: secondAgent.Actor.ID, credential: secondCredential},
	}
	for index := range senders {
		sender := &senders[index]
		code, body := post(sender.credential.AccessToken, content)
		if code != http.StatusOK {
			t.Fatalf("Agent %d first send with shared operation ID: %d %s", index+1, code, body)
		}
		var result struct {
			Accepted  bool   `json:"accepted"`
			InboxID   string `json:"inbox_id"`
			MessageID string `json:"message_id"`
		}
		decode(t, body, &result)
		if !result.Accepted || result.MessageID == "" || result.InboxID != "room:"+roomID {
			t.Fatalf("Agent %d did not persist its message: %+v", index+1, result)
		}
		sender.messageID = result.MessageID
	}
	if senders[0].messageID == senders[1].messageID {
		t.Fatal("different Agents shared a message receipt")
	}
	for _, sender := range senders {
		assertReplay := func(token string) {
			t.Helper()
			code, body := post(token, content)
			if code != http.StatusOK {
				t.Fatalf("replay: %d %s", code, body)
			}
			var result struct {
				Accepted  bool   `json:"accepted"`
				InboxID   string `json:"inbox_id"`
				MessageID string `json:"message_id"`
			}
			decode(t, body, &result)
			if !result.Accepted || result.MessageID != sender.messageID {
				t.Fatalf("replay changed Agent's receipt: %+v", result)
			}
		}
		assertReplay(sender.credential.AccessToken)
		if err := revokeAgentCredential(t.Context(), env.pool, sender.credential.CredentialID); err != nil {
			t.Fatalf("expire old credential: %v", err)
		}
		if code, body := post(sender.credential.AccessToken, content); code != http.StatusUnauthorized {
			t.Fatalf("expired credential replay: %d %s", code, body)
		}
		rotated := issue(sender.credential.AgentID)
		assertReplay(rotated.AccessToken)
		if code, body := post(rotated.AccessToken, "Changed input for the same operation."); code != http.StatusConflict || !containsJSONText(body, `"code":"idempotency_conflict"`) {
			t.Fatalf("changed input reused receipt: %d %s", code, body)
		}
		var messages, receipts int
		if err := env.pool.QueryRow(t.Context(), `SELECT
 (SELECT count(*) FROM messages WHERE room_id=$1 AND author_actor_id=$2),
 (SELECT count(*) FROM command_replays WHERE scope='agent:'||$2 AND invocation_id=$3 AND resource_id=$4)`,
			roomID, sender.actorID, invocationID, sender.messageID).Scan(&messages, &receipts); err != nil || messages != 1 || receipts != 1 {
			t.Fatalf("Agent side effects: messages=%d receipts=%d err=%v", messages, receipts, err)
		}
	}
}
