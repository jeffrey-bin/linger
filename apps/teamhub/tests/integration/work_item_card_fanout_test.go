package integration_test

import (
	"bufio"
	"encoding/json"
	"net/http"
	"strconv"
	"testing"
	"time"
)

func TestWorkItemMutationHintsEverySessionOfTheHuman(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRoomMembershipEnv(t)
	alice := env.login("alice", alicePassword)
	otherDevice := env.login("alice", alicePassword)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Tenant Work Item wake "+suffix, "tenant-work-item-wake-"+suffix)
	status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/work-items", map[string]any{
		"kind": "issue", "title": "Tenant wake " + suffix, "origin_room_id": roomID,
	}, "tenant-wake-create-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("create Work Item status=%d body=%s", status, body)
	}
	var item workItemResponse
	decode(t, body, &item)

	stream := openSSE(t, otherDevice, env.server.URL+"/v0/events", 10*time.Second)
	defer stream.Body.Close()
	reader := bufio.NewReader(stream.Body)
	requireSSEReady(t, "other device", reader)
	status, _, body = env.request(alice, http.MethodPatch, "/v0/work-items/"+item.ID, map[string]any{
		"expected_version": item.Version, "title": "Tenant wake changed " + suffix,
	}, "tenant-wake-update-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("update Work Item status=%d body=%s", status, body)
	}
	// The other session is not watching the Origin Room; the room hint still reaches it.
	awaitInvalidation(t, reader, "room", roomID)
}

func TestAgentWorkItemTransitionPublishesLiveWorkItemChange(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRoomMembershipEnv(t)
	alice := env.login("alice", alicePassword)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Agent transition SSE "+suffix, "agent-transition-sse-"+suffix)
	if status, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); status != http.StatusOK {
		t.Fatalf("add Agent status=%d body=%s", status, body)
	}
	agentBase := "/v0/agents/" + acmeOfficialAgentManagementID
	status, _, body := agentWorkItemRequest(t, env, http.MethodPost, agentBase+"/work-items", teamHubInternalToken,
		"agent-transition-item-"+suffix, map[string]any{
			"kind": "issue", "title": "Agent transition publishes live events", "origin_room_id": roomID,
			"assignee_actor_ids": []string{"actor_acme_official"},
		})
	if status != http.StatusCreated {
		t.Fatalf("create Agent Work Item status=%d body=%s", status, body)
	}
	var created workItemResponse
	decode(t, body, &created)
	item := getGuardWorkItemResponse(t, env, alice, created.ID)
	nextState := map[string]string{"open": "in_progress", "in_progress": "open"}[item.State]
	if nextState == "" {
		t.Fatalf("unexpected new Work Item state %q", item.State)
	}

	after := currentEventWatermark(t, env, alice, "/v0/rooms/"+roomID+"/events", "latest_room_seq")
	stream := openSSE(t, alice, eventsStreamURL(env.server.URL, roomID, after), 3*time.Second)
	defer stream.Body.Close()
	reader := bufio.NewReader(stream.Body)
	requireSSEReady(t, "alice", reader)

	status, _, body = agentWorkItemRequest(t, env, http.MethodPost, agentBase+"/work-items/"+item.ID+"/transitions",
		teamHubInternalToken, "agent-transition-live-"+suffix, map[string]any{
			"expected_version": item.Version, "state": nextState,
		})
	if status != http.StatusOK {
		t.Fatalf("transition Agent Work Item status=%d body=%s", status, body)
	}
	for {
		record := nextRoomEvent(t, reader)
		var event struct {
			EventType string          `json:"event_type"`
			Payload   json.RawMessage `json:"payload"`
		}
		if err := json.Unmarshal([]byte(record.Data), &event); err != nil {
			t.Fatal(err)
		}
		if event.EventType != "work_item.changed" {
			continue
		}
		if !payloadHasIDAndVersion(t, event.Payload, "work_item_id", item.ID, item.Version+1) {
			t.Fatalf("unexpected work_item.changed payload: %s", event.Payload)
		}
		break
	}
}

func payloadHasIDAndVersion(t *testing.T, payload json.RawMessage, idField, id string, version int64) bool {
	t.Helper()
	var value map[string]any
	if err := json.Unmarshal(payload, &value); err != nil {
		t.Fatal(err)
	}
	return value[idField] == id && value["version"] == float64(version)
}
