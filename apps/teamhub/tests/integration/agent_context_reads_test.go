package integration_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
)

func TestAgentContextReadsCurrentAuthorityWithoutRun(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, credential, roomID := newAgentCLIIdentity(t)
	const nonmemberID = "agent_context_nonmember"
	insertRuntimeRegistrationFixture(t, env.pool, nonmemberID, "active")
	updateDescription := func(description string) {
		t.Helper()
		if _, err := env.pool.Exec(t.Context(), `UPDATE agent_registrations SET description=$1 WHERE tenant_id=$2 AND actor_id='actor_acme_official'`, description, acmeTenant); err != nil {
			t.Fatal(err)
		}
	}
	assertMemberIdentity := func(body []byte, description string) {
		t.Helper()
		var response struct {
			Members []map[string]any `json:"members"`
		}
		decode(t, body, &response)
		found := false
		for _, member := range response.Members {
			if member["actor_id"] == "actor-"+nonmemberID {
				t.Fatal("member query exposed an unrelated registered Agent")
			}
			if _, ok := member["instructions"]; ok {
				t.Fatal("member query exposed private Agent instructions")
			}
			if member["kind"] == "human" {
				if _, ok := member["agent_type"]; ok {
					t.Fatalf("Human has Agent type: %+v", member)
				}
				if _, ok := member["description"]; ok {
					t.Fatalf("Human has Agent description: %+v", member)
				}
			}
			if member["actor_id"] == "actor_acme_official" {
				found = true
				if member["agent_type"] != "general" || member["description"] != description {
					t.Fatalf("registered Agent identity: %+v", member)
				}
			}
		}
		if !found {
			t.Fatal("registered Agent missing from members")
		}
	}
	updateDescription("Reviews launch evidence")
	read := func(endpoint string, input map[string]any) (int, []byte) {
		t.Helper()
		code, _, body := taskWorkerJSONRequest(t, env, http.MethodPost, "/api/agent/v1/"+endpoint, credential.AccessToken, input)
		return code, body
	}
	code, body := read("room-members/query", map[string]any{"inbox_id": roomID})
	if code != http.StatusOK || !strings.Contains(string(body), `"membership_revision":`) || !strings.Contains(string(body), `"actor_id":"actor_acme_official"`) || strings.Contains(string(body), `members.json`) {
		t.Fatalf("Room members: %d %s", code, body)
	}
	assertMemberIdentity(body, "Reviews launch evidence")
	updateDescription("Researches Slack AI cases")
	code, body = read("room-members/query", map[string]any{"inbox_id": roomID})
	if code != http.StatusOK {
		t.Fatalf("live Room member identity: %d %s", code, body)
	}
	assertMemberIdentity(body, "Researches Slack AI cases")
	insertHistoryFixture(t, env, roomID, "context_read_thread_root", "conversation", "Thread root")
	code, _, body = env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/messages/context_read_thread_root/thread", map[string]any{}, "context-read-thread")
	if code != http.StatusCreated && code != http.StatusOK {
		t.Fatalf("Thread: %d %s", code, body)
	}
	var thread struct {
		Room struct {
			ID string `json:"id"`
		} `json:"room"`
	}
	decode(t, body, &thread)
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO room_member_states(room_id,actor_id,thread_opened_at) VALUES($1,'actor_acme_official',now()) ON CONFLICT (room_id,actor_id) DO UPDATE SET thread_opened_at=excluded.thread_opened_at`, thread.Room.ID); err != nil {
		t.Fatal(err)
	}
	code, body = read("room-members/query", map[string]any{"inbox_id": "thread:" + thread.Room.ID})
	if code != http.StatusOK || !strings.Contains(string(body), `"actor_id":"actor_acme_alice"`) {
		t.Fatalf("Thread members: %d %s", code, body)
	}
	assertMemberIdentity(body, "Researches Slack AI cases")
	if _, err := env.pool.Exec(t.Context(), `UPDATE rooms SET team_md_raw_markdown='# Current protocol',team_md_collaborate_pattern='fan-out-and-synthesize',team_md_document='{}',team_md_revision=3,team_md_updated_at=now(),team_md_updated_by_actor_id='actor_acme_alice' WHERE id=$1 AND tenant_id=$2`, roomID, acmeTenant); err != nil {
		t.Fatal(err)
	}
	code, body = read("team-md/query", map[string]any{"inbox_id": roomID})
	if code != http.StatusOK || !strings.Contains(string(body), `"revision":3`) || !strings.Contains(string(body), `# Current protocol`) || strings.Contains(string(body), `"path"`) {
		t.Fatalf("team.md: %d %s", code, body)
	}
	// Historical message text remains unchanged; the attachment supplies its ID.
	requestToken := credential.AccessToken
	request := func(method, requestPath string, input any) (int, []byte) {
		t.Helper()
		data, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		if input == nil {
			data = nil
		}
		req, err := http.NewRequestWithContext(t.Context(), method, env.server.URL+requestPath, bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+requestToken)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-TeamHub-Context-Kind", "room")
		req.Header.Set("X-TeamHub-Context-Id", roomID)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		data, err = io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		return resp.StatusCode, data
	}
	fragmentHTML := "<div>Current inline fragment</div>"
	code, body = commitAgentMessage(t, env, requestToken, "room", roomID, map[string]any{
		"inbox_id": "room:" + roomID, "invocation_id": "agent-invocation-sha256:" + strings.Repeat("f", 64),
		"segments": []map[string]any{{"type": "fragment", "title": "Launch tracker", "content": fragmentHTML}},
	})
	if code != http.StatusOK {
		t.Fatalf("create fragment: %d %s", code, body)
	}
	var fragment struct {
		MessageID string `json:"message_id"`
	}
	decode(t, body, &fragment)
	var fragmentDocumentID, rawMessage string
	if err := env.pool.QueryRow(t.Context(), `SELECT history.resource_references->0->>'document_id',message.body FROM agent_history_messages history JOIN messages message ON message.id=history.message_id WHERE history.message_id=$1`, fragment.MessageID).Scan(&fragmentDocumentID, &rawMessage); err != nil {
		t.Fatal(err)
	}
	// The body shows the fragment's title; its Document stays readable through
	// the history's resource reference.
	if rawMessage != "Launch tracker" || fragmentDocumentID == "" {
		t.Fatalf("fragment body %q, Document %q", rawMessage, fragmentDocumentID)
	}
	code, body = request(http.MethodGet, "/api/agent/v1/files", nil)
	if code != http.StatusOK || !strings.Contains(string(body), fragmentDocumentID) {
		t.Fatalf("fragment docs list: %d %s", code, body)
	}
	code, body = request(http.MethodGet, "/api/agent/v1/files/"+fragmentDocumentID+"/content", nil)
	if code != http.StatusOK || string(body) != fragmentHTML {
		t.Fatalf("fragment docs get: %d %s", code, body)
	}
	// A second Agent reads the attachment with its Human's access, whether or
	// not it is in the Room.
	const readerID = "agent_context_fragment_reader"
	insertRuntimeRegistrationFixture(t, env.pool, readerID, "active")
	if code, body := putRoomMember(t, env, alice, roomID, "actor-"+readerID, "member"); code != http.StatusOK {
		t.Fatalf("fragment reader membership: %d %s", code, body)
	}
	readerCredential, err := agentcredential.New(env.pool).IssueManaged(t.Context(), readerID, "fragment reader")
	if err != nil {
		t.Fatal(err)
	}
	requestToken = readerCredential.AccessToken
	code, body = request(http.MethodGet, "/api/agent/v1/files/"+fragmentDocumentID+"/content", nil)
	if code != http.StatusOK || string(body) != fragmentHTML {
		t.Fatalf("authorized fragment reader: %d %s", code, body)
	}
	code, _, body = env.request(alice, http.MethodDelete, "/v0/rooms/"+roomID+"/members/actor-"+readerID, nil, "context-read-fragment-revoke")
	if code != http.StatusNoContent {
		t.Fatalf("revoke fragment reader: %d %s", code, body)
	}
	code, body = request(http.MethodGet, "/api/agent/v1/files/"+fragmentDocumentID+"/content", nil)
	if code != http.StatusOK || string(body) != fragmentHTML {
		t.Fatalf("fragment read after leaving the Room: %d %s", code, body)
	}
	requestToken = credential.AccessToken
	code, body = request(http.MethodGet, "/api/agent/v1/files/document_not_visible/content", nil)
	if code != http.StatusNotFound {
		t.Fatalf("unreadable document: %d %s", code, body)
	}
	// The Inbox input freezes the fragment's Document as a resource reference.
	var fragmentBody, fragmentReferences string
	if err := env.pool.QueryRow(t.Context(), `SELECT body,agent_inbox_resource_references(segments,attachments)::text FROM messages WHERE id=$1`, fragment.MessageID).Scan(&fragmentBody, &fragmentReferences); err != nil {
		t.Fatal(err)
	}
	if fragmentBody != rawMessage || !strings.Contains(fragmentReferences, fragmentDocumentID) {
		t.Fatalf("fragment resource identity/body: body=%q references=%s", fragmentBody, fragmentReferences)
	}
	code, _, body = env.request(alice, http.MethodDelete, "/v0/rooms/"+roomID+"/members/actor_acme_official", nil, "context-read-revoke")
	if code != http.StatusNoContent {
		t.Fatalf("remove member: %d %s", code, body)
	}
	for _, endpoint := range []string{"room-members/query", "team-md/query"} {
		code, body = read(endpoint, map[string]any{"inbox_id": roomID})
		if code != http.StatusNotFound {
			t.Fatalf("revoked %s: %d %s", endpoint, code, body)
		}
	}
	if countRows(t, env, `SELECT count(*) FROM agent_local_runs`) != 0 {
		t.Fatal("reads created a Local Run")
	}
}
