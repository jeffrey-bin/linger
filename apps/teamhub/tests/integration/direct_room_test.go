package integration_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestPrivateAgentVisibilityAndDirectRoomLifecycle(t *testing.T) {
	allowParallelIntegrationTest(t)
	agentManagement := &recordingAgentManagement{}
	env, alice := newAgentRegistrationEnv(t, agentManagement)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/agents", map[string]any{
		"name":             "Private Reviewer " + suffix,
		"instructions":     "Review shared Room work.",
		"runtime":          fixtureRuntime("gpt-5"),
		"visibility_scope": "sponsor",
	}, "private-direct-agent-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("create private Agent status=%d body=%s", status, body)
	}
	var registered struct {
		Actor struct {
			ID string `json:"id"`
		} `json:"actor"`
	}
	decode(t, body, &registered)

	// The Sponsor is the deployment's Human, so a Sponsor-only Agent is in its
	// directory.
	assertDirectoryContains(t, env, alice, registered.Actor.ID, true)
	// Direct Rooms are Human-Agent only; a Human peer is not an Agent.
	status, _, body = env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/direct-rooms", map[string]any{
		"peer_actor_id": "actor_acme_alice",
	}, "")
	if status != http.StatusNotFound || !containsJSONText(body, "AGENT_NOT_FOUND") {
		t.Fatalf("Human peer Direct Room status=%d body=%s", status, body)
	}

	const concurrency = 8
	results := make(chan directRoomResponse, concurrency)
	var group sync.WaitGroup
	for range concurrency {
		group.Add(1)
		go func() {
			defer group.Done()
			results <- requestDirectRoom(alice, env.server.URL, registered.Actor.ID)
		}()
	}
	group.Wait()
	close(results)
	var directRoomID string
	for result := range results {
		if result.err != nil || (result.status != http.StatusCreated && result.status != http.StatusOK) {
			t.Fatalf("concurrent Direct Room status=%d err=%v body=%s", result.status, result.err, result.body)
		}
		if directRoomID == "" {
			directRoomID = result.roomID
		}
		if result.roomID != directRoomID {
			t.Fatalf("Direct Room IDs diverged: got=%q want=%q", result.roomID, directRoomID)
		}
	}
	if got := countRows(t, env, "select count(*) from rooms where tenant_id=$1 and direct_human_actor_id='actor_acme_alice' and direct_agent_actor_id=$2", acmeTenant, registered.Actor.ID); got != 1 {
		t.Fatalf("Direct Room pair count=%d want=1", got)
	}
	assertAgentRoomMetaContextKind(t, env.pool, registered.Actor.ID, directRoomID, "direct")

	for _, mutation := range []struct {
		method  string
		path    string
		payload any
		key     string
	}{
		{http.MethodPut, "/v0/rooms/" + directRoomID + "/members/actor_acme_official", map[string]any{"role": "member"}, ""},
		{http.MethodDelete, "/v0/rooms/" + directRoomID + "/members/" + registered.Actor.ID, nil, ""},
		{http.MethodPatch, "/v0/rooms/" + directRoomID, map[string]any{"name": "Changed"}, "direct-room-update-" + suffix},
		{http.MethodDelete, "/v0/rooms/" + directRoomID, nil, "direct-room-delete-" + suffix},
	} {
		status, _, body = env.request(alice, mutation.method, mutation.path, mutation.payload, mutation.key)
		if status != http.StatusConflict || !containsJSONText(body, "DIRECT_ROOM_IMMUTABLE") {
			t.Fatalf("Direct Room mutation %s %s status=%d body=%s", mutation.method, mutation.path, status, body)
		}
	}

	status, _, body = env.request(alice, http.MethodDelete, "/v0/tenants/"+acmeTenant+"/agents/"+registered.Actor.ID, nil, "")
	if status != http.StatusNoContent {
		t.Fatalf("delete Direct Room Agent status=%d body=%s", status, body)
	}
	// The one Human is the Agent's Sponsor, so deleting the Agent also starts
	// deleting the Sponsor's Direct Room with it.
	status, _, body = env.request(alice, http.MethodGet, "/v0/rooms/"+directRoomID, nil, "")
	if status != http.StatusNotFound {
		t.Fatalf("deleted peer Room status=%d body=%s", status, body)
	}
}

// A pair reopens its direct Room as a new Room once the last one finished
// deletion, and not while it is still being deleted. An Agent syncing its
// configuration is still a live peer, so its direct Room (AnotherMe's Chat
// included) takes messages and cannot be deleted meanwhile.
func TestDirectRoomReopensOnlyAfterItsDeletionFinishes(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRoomMembershipEnv(t)
	alice := env.login("alice", alicePassword)
	const agentID = "actor_acme_official"
	setStatus := func(status string) {
		t.Helper()
		if _, err := env.pool.Exec(t.Context(), "UPDATE agent_registrations SET status=$1 WHERE actor_id=$2", status, agentID); err != nil {
			t.Fatal(err)
		}
	}
	first := requestDirectRoom(alice, env.server.URL, agentID)
	if first.err != nil || first.status != http.StatusCreated {
		t.Fatalf("open Direct Room: %+v", first)
	}

	if _, err := env.pool.Exec(t.Context(), `UPDATE rooms SET deletion_started_at=clock_timestamp(),
		deletion_started_by_actor_id='actor_acme_alice' WHERE id=$1`, first.roomID); err != nil {
		t.Fatal(err)
	}
	if deleting := requestDirectRoom(alice, env.server.URL, agentID); deleting.status != http.StatusConflict ||
		!containsJSONText(deleting.body, "DIRECT_ROOM_DELETING") {
		t.Fatalf("open deleting Direct Room status=%d body=%s", deleting.status, deleting.body)
	}
	if _, err := env.pool.Exec(t.Context(), `UPDATE rooms SET deletion_started_at=NULL,deletion_started_by_actor_id=NULL WHERE id=$1`, first.roomID); err != nil {
		t.Fatal(err)
	}

	setStatus("revoked")
	status, _, body := env.request(alice, http.MethodDelete, "/v0/rooms/"+first.roomID, nil, "direct-delete-failed")
	if status != http.StatusNoContent {
		t.Fatalf("delete peerless Direct Room status=%d body=%s", status, body)
	}
	if got := countRows(t, env, "SELECT count(*) FROM rooms WHERE id=$1 AND deleted_at IS NOT NULL", first.roomID); got != 1 {
		t.Fatal("Direct Room deletion did not finish")
	}
	setStatus("active")
	reopened := requestDirectRoom(alice, env.server.URL, agentID)
	if reopened.err != nil || reopened.status != http.StatusCreated || reopened.roomID == first.roomID {
		t.Fatalf("reopen Direct Room: %+v first=%s", reopened, first.roomID)
	}
	if got := countRows(t, env, "SELECT count(*) FROM rooms WHERE direct_human_actor_id='actor_acme_alice' AND direct_agent_actor_id=$1 AND id=$2", agentID, reopened.roomID); got != 1 {
		t.Fatal("the pair does not name its new Direct Room")
	}
	if again := requestDirectRoom(alice, env.server.URL, agentID); again.status != http.StatusOK || again.roomID != reopened.roomID {
		t.Fatalf("open reopened Direct Room: %+v", again)
	}
	assertAgentRoomMetaContextKind(t, env.pool, agentID, reopened.roomID, "direct")
}

func assertDirectoryContains(t *testing.T, env *testEnv, client *http.Client, actorID string, want bool) {
	t.Helper()
	for _, path := range []string{
		"/v0/tenants/" + acmeTenant + "/actors?limit=200",
		"/v0/tenants/" + acmeTenant + "/agents?limit=200",
	} {
		status, _, body := env.request(client, http.MethodGet, path, nil, "")
		if status != http.StatusOK {
			t.Fatalf("directory %s status=%d body=%s", path, status, body)
		}
		if got := containsJSONText(body, actorID); got != want {
			t.Fatalf("directory %s contains Agent=%v want=%v body=%s", path, got, want, body)
		}
	}
}

type directRoomResponse struct {
	status int
	roomID string
	body   []byte
	err    error
}

func requestDirectRoom(client *http.Client, serverURL, peerActorID string) directRoomResponse {
	payload, err := json.Marshal(map[string]any{"peer_actor_id": peerActorID})
	if err != nil {
		return directRoomResponse{err: err}
	}
	request, err := http.NewRequest(http.MethodPost, serverURL+"/v0/tenants/"+acmeTenant+"/direct-rooms", bytes.NewReader(payload))
	if err != nil {
		return directRoomResponse{err: err}
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return directRoomResponse{err: err}
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return directRoomResponse{status: response.StatusCode, err: err}
	}
	var room struct {
		ID string `json:"id"`
	}
	if response.StatusCode == http.StatusCreated || response.StatusCode == http.StatusOK {
		if err := json.Unmarshal(body, &room); err != nil {
			return directRoomResponse{status: response.StatusCode, body: body, err: fmt.Errorf("decode Direct Room: %w", err)}
		}
	}
	return directRoomResponse{status: response.StatusCode, roomID: room.ID, body: body, err: err}
}

// A still uninitialized General Agent opens its Sponsor's new direct chat with
// a greeting and a question card the Sponsor has already read. Answering it,
// even in the Sponsor's own words, hands the answer to the Agent. Reopening
// the chat writes nothing more, and an Agent with instructions opens nothing.
func TestBlankAgentOpensItsFirstDirectChat(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newAgentRegistrationEnv(t, &recordingAgentManagement{})
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	create := func(name, instructions string) string {
		t.Helper()
		status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/agents", map[string]any{
			"name": name, "instructions": instructions, "runtime": fixtureRuntime("gpt-5"), "visibility_scope": "sponsor",
		}, "opening-"+strings.ReplaceAll(name, " ", "-")+"-"+suffix)
		if status != http.StatusCreated {
			t.Fatalf("create %s status=%d body=%s", name, status, body)
		}
		var registered struct {
			Actor struct {
				ID string `json:"id"`
			} `json:"actor"`
		}
		decode(t, body, &registered)
		return registered.Actor.ID
	}
	blankID := create("New Agent", generalAgentUninitializedInstructionsFixture)
	configuredID := create("Reviewer", "Review shared Room work.")

	opened := requestDirectRoom(alice, env.server.URL, blankID)
	if opened.err != nil || opened.status != http.StatusCreated {
		t.Fatalf("open blank Agent chat status=%d err=%v body=%s", opened.status, opened.err, opened.body)
	}
	var greeting string
	if err := env.pool.QueryRow(t.Context(), `SELECT body FROM messages
		WHERE room_id=$1 AND author_actor_id=$2 AND message_kind='conversation'
		AND NOT EXISTS (SELECT 1 FROM decisions decision WHERE decision.message_id=messages.id)`, opened.roomID, blankID).Scan(&greeting); err != nil {
		t.Fatalf("greeting: %v", err)
	}
	if !strings.HasPrefix(greeting, "Hi ") || !strings.HasSuffix(greeting, ", I'm your new Agent. Tell me what you'd like me to take on, and I'll set myself up for it.") {
		t.Fatalf("greeting=%q", greeting)
	}
	var decisionID, messageID string
	var options int
	if err := env.pool.QueryRow(t.Context(), `SELECT id, message_id, jsonb_array_length(view->'questions'->0->'options') FROM decisions
		WHERE room_id=$1 AND requested_by_actor_id=$2 AND decider_actor_id='actor_acme_alice' AND status='pending' AND kind='question'
		AND expires_at IS NULL AND view->'questions'->0->>'prompt'='What should I help you with?'`, opened.roomID, blankID).Scan(&decisionID, &messageID, &options); err != nil {
		t.Fatalf("question card: %v", err)
	}
	if options != 3 {
		t.Fatalf("options=%d", options)
	}
	if got := countRows(t, env, `SELECT count(*) FROM room_member_states state JOIN rooms room ON room.id=state.room_id
		WHERE state.room_id=$1 AND state.actor_id='actor_acme_alice' AND state.read_through_room_seq=room.next_room_seq`, opened.roomID); got != 1 {
		t.Fatal("the Sponsor has not read the opening")
	}
	if reopened := requestDirectRoom(alice, env.server.URL, blankID); reopened.status != http.StatusOK || reopened.roomID != opened.roomID {
		t.Fatalf("reopen status=%d room=%s body=%s", reopened.status, reopened.roomID, reopened.body)
	}
	if got := countRows(t, env, `SELECT count(*) FROM messages WHERE room_id=$1`, opened.roomID); got != 2 {
		t.Fatalf("opening messages after reopen=%d", got)
	}

	status, _, body := env.request(alice, http.MethodPost, "/v0/decisions/"+decisionID, map[string]any{
		"expected_version": 1, "decision": "submit", "answers": map[string]any{"q1": "Plan a trip to Kyoto"},
	}, "opening-answer-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("answer status=%d body=%s", status, body)
	}
	var answer, disposition string
	if err := env.pool.QueryRow(t.Context(), `SELECT message.body,
		(SELECT disposition FROM agent_inbox_message_disposition('tenant_acme',$3,NULL,'room:'||$1,message.id))
		FROM messages message WHERE message.card_context_message_id=$2 AND message.message_kind='agent_runtime'`,
		opened.roomID, messageID, blankID).Scan(&answer, &disposition); err != nil {
		t.Fatal(err)
	}
	if disposition != "notify" || !strings.HasSuffix(answer, " answered:\n- What should I help you with? → Plan a trip to Kyoto") {
		t.Fatalf("answer disposition=%s body=%q", disposition, answer)
	}

	configured := requestDirectRoom(alice, env.server.URL, configuredID)
	if configured.err != nil || configured.status != http.StatusCreated {
		t.Fatalf("open configured Agent chat status=%d err=%v body=%s", configured.status, configured.err, configured.body)
	}
	if got := countRows(t, env, `SELECT count(*) FROM messages WHERE room_id=$1`, configured.roomID); got != 0 {
		t.Fatalf("configured Agent opening messages=%d", got)
	}
}
