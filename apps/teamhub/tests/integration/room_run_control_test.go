package integration_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
)

func TestRoomRunControlAuthorizationAndExactTarget(t *testing.T) {
	allowParallelIntegrationTest(t)
	var mutex sync.Mutex
	calls := []map[string]any{}
	unavailable := false
	runID := ""
	gateway := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		mutex.Lock()
		defer mutex.Unlock()
		if request.URL.Path != "/v1/agent-runs/"+runID+"/cancel" {
			writer.WriteHeader(http.StatusNotFound)
			return
		}
		var body map[string]any
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		calls = append(calls, body)
		if unavailable {
			writer.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(writer).Encode(map[string]any{"run_id": runID, "status": "cancel_requested"}); err != nil {
			t.Error(err)
		}
	}))
	defer gateway.Close()
	env, alice := newAgentRunEnv(t, gateway.URL)
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_registrations SET agent_type='anotherme',receives_all_messages=true,represented_human_actor_id=created_by_actor_id WHERE actor_id='actor_acme_official'`); err != nil {
		t.Fatal(err)
	}
	roomID := createPrivateRoom(t, env, alice, "Run control", "room-control")
	if status, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); status != 200 {
		t.Fatalf("member %d %s", status, body)
	}
	runtime := agentruntimestate.New(env.pool)
	ensured, err := runtime.EnsureContext(t.Context(), agentruntimestate.EnsureContextInput{Ref: agentruntimestate.ContextRef{Kind: "meta", AgentID: acmeOfficialAgentManagementID, RoomID: roomID}, TargetResidency: "active"})
	if err != nil {
		t.Fatal(err)
	}
	startRuntimeEpoch(t, runtime, "run-control-test")
	fence := "run-control-test"
	call := func(client *http.Client, method, suffix, body string) (int, []byte) {
		t.Helper()
		request, err := http.NewRequest(method, env.server.URL+"/v0/rooms/"+roomID+suffix, bytes.NewBufferString(body))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/json")
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		content, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		return response.StatusCode, content
	}
	messageID := createHumanMessage(t, env, alice, roomID, "Cancel this input", "cancel-source-message")
	otherRoom := createPrivateRoom(t, env, alice, "Other control Room", "other-control-room")
	otherMessageID := createHumanMessage(t, env, alice, otherRoom, "Do not expose this input", "other-cancel-source-message")
	if got := countRows(t, env, `SELECT count(*) FROM room_events event JOIN messages message
		ON message.id=event.resource_id AND message.room_id=event.room_id AND message.tenant_id=event.tenant_id
		WHERE event.room_id=$1 AND event.resource_id=$2 AND event.event_type='message.created'`, otherRoom, otherMessageID); got != 1 {
		t.Fatalf("other Room source must exist with its real Event: %d", got)
	}
	// The other Room's Message never reaches this Room's Context.
	if got := countRows(t, env, `SELECT count(*) FROM agent_runtime_inputs WHERE context_key=$1 AND source_message_id=$2`, ensured.Context.ContextKey, otherMessageID); got != 0 {
		t.Fatalf("other Room Message queued for this Room's Context: %d", got)
	}
	dispatch := acceptPresentationInboxMessage(t, runtimeStateTestEnv{pool: env.pool, service: runtime,
		contextKey: ensured.Context.ContextKey, epoch: fence}, roomID, messageID)
	runID = dispatch.RunID
	cancelPath := "/runs/" + runID + "/cancel"
	if status, _ := call(alice, "POST", "/runs/wrong-run/cancel", `{"request_id":"cancel-1"}`); status != 404 {
		t.Fatalf("wrong target %d", status)
	}
	for attempt := 0; attempt < 2; attempt++ {
		if status, body := call(alice, "POST", cancelPath, `{"request_id":"cancel-1"}`); status != 200 || !bytes.Contains(body, []byte("cancel_requested")) {
			t.Fatalf("cancel %d %s", status, body)
		} else {
			var receipt struct {
				MessageIDs []string `json:"message_ids"`
				AgentID    string   `json:"agent_actor_id"`
			}
			if err := json.Unmarshal(body, &receipt); err != nil || len(receipt.MessageIDs) != 1 || receipt.MessageIDs[0] != messageID || receipt.AgentID != "actor_acme_official" {
				t.Fatalf("wrong source receipt: %s, %v", body, err)
			}
		}
	}
	mutex.Lock()
	if len(calls) != 2 {
		t.Fatalf("calls %d", len(calls))
	}
	ref := calls[0]["context_ref"].(map[string]any)
	if ref["agent_id"] != acmeOfficialAgentManagementID || ref["room_id"] != roomID {
		t.Fatalf("wrong target %v", ref)
	}
	unavailable = true
	mutex.Unlock()
	if status, _ := call(alice, "POST", cancelPath, `{"request_id":"cancel-1"}`); status != 503 {
		t.Fatalf("uncertain status %d", status)
	}
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_local_runs SET status='canceled',terminal='{"type":"canceled"}',finished_at=clock_timestamp() WHERE run_id=$1`, runID); err != nil {
		t.Fatal(err)
	}
	if status, body := call(alice, "POST", cancelPath, `{"request_id":"cancel-1"}`); status != 200 || !bytes.Contains(body, []byte("already_terminal")) {
		t.Fatalf("terminal %d %s", status, body)
	}
}
