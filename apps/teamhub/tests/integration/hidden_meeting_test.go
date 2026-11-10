package integration_test

import (
	"net/http"
	"testing"
)

func TestHidingAMeetingIsPerHumanAndKeepsTheCapture(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRoomMembershipEnv(t)
	alice := env.login("alice", alicePassword)
	direct := requestDirectRoom(alice, env.server.URL, "actor_acme_official")
	if direct.err != nil || (direct.status != http.StatusCreated && direct.status != http.StatusOK) {
		t.Fatalf("direct Room=%d %v", direct.status, direct.err)
	}
	var aliceActorID string
	if err := env.pool.QueryRow(t.Context(), `SELECT id FROM actors WHERE tenant_id=$1 AND account_id='account_alice' AND kind='human'`, acmeTenant).Scan(&aliceActorID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `
		INSERT INTO voice_sessions(id,tenant_id,room_id,created_by_actor_id,status,purpose,provider_room_name,participant_identity,closed_at)
		VALUES('hidden_meeting_voice',$1,$2,$3,'closed','hardware_control','hidden-meeting-room','hidden-meeting-participant',now());
	`, acmeTenant, direct.roomID, aliceActorID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `
		INSERT INTO capture_sessions(id,tenant_id,room_id,created_by_actor_id,status,voice_session_id,requested_transcript_start_offset_ms)
		VALUES('hidden_meeting_capture',$1,$2,$3,'recording','hidden_meeting_voice',0);
	`, acmeTenant, direct.roomID, aliceActorID); err != nil {
		t.Fatal(err)
	}
	path := "/v0/tenants/" + acmeTenant + "/me/meetings/"

	// Hiding twice succeeds and keeps the first hide time.
	for range 2 {
		if status, _, body := env.request(alice, http.MethodDelete, path+"hidden_meeting_capture", nil, ""); status != http.StatusNoContent {
			t.Fatalf("hide meeting status=%d body=%s", status, body)
		}
	}
	var hidden bool
	if err := env.pool.QueryRow(t.Context(), `SELECT hidden_at IS NOT NULL FROM capture_sessions WHERE id='hidden_meeting_capture'`).Scan(&hidden); err != nil || !hidden {
		t.Fatalf("hidden=%t err=%v", hidden, err)
	}
	var captureKept bool
	if err := env.pool.QueryRow(t.Context(), `SELECT EXISTS(SELECT 1 FROM capture_sessions WHERE id='hidden_meeting_capture')`).Scan(&captureKept); err != nil || !captureKept {
		t.Fatalf("capture kept=%v err=%v", captureKept, err)
	}

	if status, _, body := env.request(alice, http.MethodDelete, path+"capture_missing", nil, ""); status != http.StatusNotFound {
		t.Fatalf("missing meeting status=%d body=%s", status, body)
	}
}
