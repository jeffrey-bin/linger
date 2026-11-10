package integration_test

import (
	"bytes"
	"net/http"
	"testing"
)

type roomMemberPage struct {
	Items []struct {
		Actor struct {
			ID string `json:"id"`
		} `json:"actor"`
		Role string `json:"role"`
	} `json:"items"`
}

// A Human creates a Room alone as its owner; members are added afterwards.
// A Room name is taken among the Rooms the creator is in.
func TestHumanCreatesRoomAsItsOnlyMember(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newWorkItemAgentEnv(t)
	path := "/v0/tenants/" + acmeTenant + "/rooms"
	input := map[string]any{"name": "Created alone"}
	status, _, body := env.request(alice, http.MethodPost, path, input, "created-alone")
	if status != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", status, body)
	}
	var room workRoomResponse
	decode(t, body, &room)
	status, _, membersBody := env.request(alice, http.MethodGet, "/v0/rooms/"+room.ID+"/members", nil, "")
	if status != http.StatusOK {
		t.Fatalf("creator cannot read members: %d %s", status, membersBody)
	}
	var members roomMemberPage
	decode(t, membersBody, &members)
	if len(members.Items) != 1 || members.Items[0].Actor.ID != "actor_acme_alice" || members.Items[0].Role != "owner" {
		t.Fatalf("unexpected members: %+v", members.Items)
	}
	status, _, repeat := env.request(alice, http.MethodPost, path, input, "")
	if status != http.StatusConflict || !bytes.Contains(repeat, []byte("ROOM_NAME_TAKEN")) {
		t.Fatalf("repeated creation status=%d body=%s", status, repeat)
	}
	// Initial members are no longer part of the request.
	before := countRows(t, env, `SELECT count(*) FROM rooms`)
	status, _, body = env.request(alice, http.MethodPost, path, map[string]any{
		"name": "With members", "member_actor_ids": []string{"actor_acme_official"},
	}, "with-members")
	if status != http.StatusBadRequest {
		t.Fatalf("initial members status=%d body=%s", status, body)
	}

	status, _, duplicateBody := env.request(alice, http.MethodPost, path, map[string]any{
		"name": "Created alone",
	}, "duplicate-room-name")
	if status != http.StatusConflict {
		t.Fatalf("duplicate name status=%d body=%s", status, duplicateBody)
	}
	if after := countRows(t, env, `SELECT count(*) FROM rooms`); after != before {
		t.Fatal("rejected requests left a partial Room")
	}
}
