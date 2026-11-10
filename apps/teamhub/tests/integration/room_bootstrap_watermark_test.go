package integration_test

import (
	"context"
	"net/http"
	"strconv"
	"testing"
	"time"
)

func TestRoomBootstrapSnapshotsExposeWatermarksAndLatestMessages(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRoomMembershipEnv(t)
	alice := env.login("alice", alicePassword)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Bootstrap "+suffix, "bootstrap-room-"+suffix)
	messageIDs := []string{
		createHumanMessage(t, env, alice, roomID, "First", "bootstrap-message-1-"+suffix),
		createHumanMessage(t, env, alice, roomID, "Second", "bootstrap-message-2-"+suffix),
		createHumanMessage(t, env, alice, roomID, "Third", "bootstrap-message-3-"+suffix),
	}

	var legacyEventsExist bool
	if err := env.pool.QueryRow(t.Context(), "SELECT to_regclass('public.user_events') IS NOT NULL").Scan(&legacyEventsExist); err != nil {
		t.Fatal(err)
	}
	if legacyEventsExist {
		t.Fatal("retired User Event mirror must not remain in the current schema")
	}
	status, _, body := env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/rooms?limit=200", nil, "")
	if status != http.StatusOK {
		t.Fatalf("list Rooms status=%d body=%s", status, body)
	}
	if containsJSONText(body, "latest_delivery_seq") {
		t.Fatalf("Room snapshot still carries an Account Delivery watermark: %s", body)
	}

	var expectedRoomSeq int64
	if err := env.pool.QueryRow(
		context.Background(),
		"select next_room_seq from rooms where id=$1",
		roomID,
	).Scan(&expectedRoomSeq); err != nil {
		t.Fatal(err)
	}
	for _, endpoint := range []string{"", "/members?limit=1"} {
		status, _, projection := env.request(alice, http.MethodGet, "/v0/rooms/"+roomID+endpoint, nil, "")
		var snapshot struct {
			SnapshotRoomSeq *int64 `json:"snapshot_room_seq"`
		}
		decode(t, projection, &snapshot)
		if status != http.StatusOK || snapshot.SnapshotRoomSeq == nil || *snapshot.SnapshotRoomSeq != expectedRoomSeq {
			t.Fatalf("Room projection %s watermark status=%d body=%s want=%d", endpoint, status, projection, expectedRoomSeq)
		}
	}
	status, _, body = env.request(
		alice,
		http.MethodGet,
		"/v0/rooms/"+roomID+"/messages?limit=2",
		nil,
		"",
	)
	if status != http.StatusOK {
		t.Fatalf("list latest Messages status=%d body=%s", status, body)
	}
	var latest struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
		Page struct {
			HasMore    bool   `json:"has_more"`
			NextCursor string `json:"next_cursor"`
		} `json:"page"`
		SnapshotRoomSeq int64 `json:"snapshot_room_seq"`
	}
	decode(t, body, &latest)
	if latest.SnapshotRoomSeq != expectedRoomSeq {
		t.Fatalf("Message snapshot room_seq=%d want=%d", latest.SnapshotRoomSeq, expectedRoomSeq)
	}
	if len(latest.Items) != 2 || latest.Items[0].ID != messageIDs[1] || latest.Items[1].ID != messageIDs[2] {
		t.Fatalf("latest Message page=%+v want=%v", latest.Items, messageIDs[1:])
	}
	if !latest.Page.HasMore || latest.Page.NextCursor != messageIDs[1] {
		t.Fatalf("latest Message page metadata=%+v", latest.Page)
	}

	status, _, body = env.request(
		alice,
		http.MethodGet,
		"/v0/rooms/"+roomID+"/messages?limit=2&cursor="+latest.Page.NextCursor,
		nil,
		"",
	)
	if status != http.StatusOK {
		t.Fatalf("list older Messages status=%d body=%s", status, body)
	}
	var older struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
		Page struct {
			HasMore bool `json:"has_more"`
		} `json:"page"`
	}
	decode(t, body, &older)
	if len(older.Items) != 1 || older.Items[0].ID != messageIDs[0] || older.Page.HasMore {
		t.Fatalf("older Message page=%+v", older)
	}
}
