package integration_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"testing"
)

// The Human leaves a Room and comes back: while it is away it keeps its
// membership and role but sees, sends and receives nothing new, and its return
// skips what it missed. An Agent member keeps the Room going meanwhile.
func TestRoomLeaveRejoinPreservesAuthorityAndStopsDelivery(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newWorkItemAgentEnv(t)
	roomID := env.createRoom(alice, acmeTenant, "Participation", "participation-room")
	path := "/v0/rooms/" + roomID
	if status, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); status != http.StatusOK {
		t.Fatalf("add Agent: %d %s", status, body)
	}
	env.createMessage(alice, roomID, "Before leave", "before-leave")
	var rootMessageID string
	if err := env.pool.QueryRow(t.Context(), `SELECT id FROM messages WHERE room_id=$1 AND body='Before leave'`, roomID).Scan(&rootMessageID); err != nil {
		t.Fatal(err)
	}
	status, _, body := env.request(alice, http.MethodPost, path+"/messages/"+rootMessageID+"/thread", map[string]any{}, "thread-for-participation")
	if status != http.StatusOK && status != http.StatusCreated {
		t.Fatalf("create thread: %d %s", status, body)
	}
	var thread struct {
		Room struct {
			ID string `json:"id"`
		} `json:"room"`
	}
	decode(t, body, &thread)
	env.createMessage(alice, thread.Room.ID, "Old Thread reply", "old-thread-reply")

	_, _, body = env.request(alice, http.MethodGet, path+"/members", nil, "")
	var beforeMembers, afterMembers struct {
		Items           json.RawMessage `json:"items"`
		SnapshotRoomSeq int64           `json:"snapshot_room_seq"`
	}
	decode(t, body, &beforeMembers)
	status, _, leftBody := env.request(alice, http.MethodPut, path+"/participation", map[string]any{"status": "left"}, "leave-alice")
	if status != http.StatusOK || !bytes.Contains(leftBody, []byte(`"participation":"left"`)) {
		t.Fatalf("leave: %d %s", status, leftBody)
	}
	status, _, repeat := env.request(alice, http.MethodPut, path+"/participation", map[string]any{"status": "left"}, "")
	if status != http.StatusOK || !bytes.Contains(repeat, []byte(`"participation":"left"`)) {
		t.Fatalf("repeated leave: %d %s", status, repeat)
	}
	var epochBefore string
	if err := env.pool.QueryRow(t.Context(), `SELECT membership_epoch_id FROM room_members WHERE room_id=$1 AND actor_id='actor_acme_alice'`, roomID).Scan(&epochBefore); err != nil {
		t.Fatal(err)
	}
	seedAgentMessage(t, env, roomID, "actor_acme_official", "During absence")
	seedAgentMessage(t, env, thread.Room.ID, "actor_acme_official", "Absent Thread reply")
	status, _, body = env.request(alice, http.MethodGet, "/v0/rooms/"+thread.Room.ID+"/messages", nil, "")
	if status != http.StatusOK || bytes.Contains(body, []byte("Absent Thread reply")) || !bytes.Contains(body, []byte("Old Thread reply")) {
		t.Fatalf("left Thread preview: %d %s", status, body)
	}
	status, _, body = env.request(alice, http.MethodPost, "/v0/rooms/"+thread.Room.ID+"/messages", humanTextMessage("blocked Thread reply"), "blocked-thread-reply")
	if status != http.StatusForbidden {
		t.Fatalf("left Thread send: %d %s", status, body)
	}
	status, _, body = env.request(alice, http.MethodGet, "/v0/rooms/"+thread.Room.ID+"/events?after=0&limit=200", nil, "")
	if status == http.StatusOK && bytes.Contains(body, []byte("Absent Thread reply")) {
		t.Fatalf("left member replayed the absent Thread reply: %s", body)
	}
	status, _, body = env.request(alice, http.MethodPost, path+"/messages", humanTextMessage("must not send"), "left-send")
	if status != http.StatusForbidden || !bytes.Contains(body, []byte("ROOM_LEFT")) {
		t.Fatalf("left send: %d %s", status, body)
	}
	status, _, body = env.request(alice, http.MethodGet, path+"/messages", nil, "")
	if status != http.StatusOK || bytes.Contains(body, []byte("During absence")) || !bytes.Contains(body, []byte("Before leave")) {
		t.Fatalf("left preview must keep only prior messages: %d %s", status, body)
	}
	status, _, body = env.request(alice, http.MethodGet, path+"/members", nil, "")
	decode(t, body, &afterMembers)
	if status != http.StatusOK || !bytes.Equal(beforeMembers.Items, afterMembers.Items) {
		t.Fatalf("leave changed membership/role: %d %s", status, body)
	}
	if afterMembers.SnapshotRoomSeq <= beforeMembers.SnapshotRoomSeq {
		t.Fatalf("leave and new Messages did not advance member read watermark: %d -> %d", beforeMembers.SnapshotRoomSeq, afterMembers.SnapshotRoomSeq)
	}
	status, _, body = env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/rooms", nil, "")
	if status != http.StatusOK || bytes.Contains(body, []byte("During absence")) {
		t.Fatalf("left Room summary received messages: %d %s", status, body)
	}
	status, _, body = env.request(alice, http.MethodPut, path+"/participation", map[string]any{"status": "joined"}, "rejoin-alice")
	if status != http.StatusOK || !bytes.Contains(body, []byte(`"participation":"joined"`)) {
		t.Fatalf("rejoin: %d %s", status, body)
	}
	if got := countRows(t, env, `SELECT count(*) FROM room_member_states state JOIN rooms room ON room.id=state.room_id WHERE state.room_id=$1 AND state.actor_id='actor_acme_alice' AND state.read_through_room_seq=room.next_room_seq AND state.left_at IS NULL`, thread.Room.ID); got != 1 {
		t.Fatal("rejoin did not skip absent Thread unread messages")
	}
	var epochAfter, role string
	if err := env.pool.QueryRow(t.Context(), `SELECT membership_epoch_id,role FROM room_members WHERE room_id=$1 AND actor_id='actor_acme_alice'`, roomID).Scan(&epochAfter, &role); err != nil {
		t.Fatal(err)
	}
	if epochBefore != epochAfter {
		t.Fatal("rejoin replaced membership epoch")
	}
	if role != "owner" {
		t.Fatal("owner lost role")
	}
	env.createMessage(alice, roomID, "Rejoined successfully", "rejoined-send")
	status, _, body = env.request(alice, http.MethodGet, path+"/messages", nil, "")
	if status != http.StatusOK || !bytes.Contains(body, []byte("During absence")) {
		t.Fatalf("history missing after rejoin: %d %s", status, body)
	}
}
