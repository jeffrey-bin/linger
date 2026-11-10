package integration_test

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// The real media service against a LiveKit API fake; the App runs no voice
// workers on it, so the test drives the session reconciliation itself.
type loginSessionTestMedia struct{ voicemedia.Plane }

func TestVoiceSessionsBelongToTheirLoginSession(t *testing.T) {
	allowParallelIntegrationTest(t)
	var deletedRooms atomic.Int32
	providerAPI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/DeleteRoom") {
			deletedRooms.Add(1)
		}
		w.Header().Set("Content-Type", "application/protobuf")
		w.WriteHeader(http.StatusOK)
	}))
	defer providerAPI.Close()
	media := &loginSessionTestMedia{}
	env, alice, _ := newHardwareVoiceCaptureEnvWithStorageAndLimitsAndConfig(t, 1<<20, 1<<30, nil, withVoiceMedia(media))
	provider, err := voicemedia.NewLiveKitProvider(voicemedia.LiveKitConfig{APIURL: providerAPI.URL, PublicURL: providerAPI.URL, APIKey: "test", APISecret: "test"}, env.pool)
	if err != nil {
		t.Fatal(err)
	}
	service := voicemedia.New(env.pool, provider, nil)
	media.Plane = service
	q := store.New(env.pool)
	otherBrowser := env.login("alice", alicePassword)
	roomID := env.createRoom(alice, acmeTenant, "Voice login sessions", "voice-login-sessions")
	otherRoomID := env.createRoom(alice, acmeTenant, "Voice other browser", "voice-other-browser")
	create := func(client *http.Client, room, key string, want int) httpapi.VoiceSession {
		t.Helper()
		status, _, body := env.request(client, http.MethodPost, "/v0/rooms/"+room+"/voice-sessions", map[string]any{"purpose": "hardware_control"}, key)
		var session httpapi.VoiceSession
		if status != want {
			t.Fatalf("create %s=%d %s", key, status, body)
		}
		if want == http.StatusCreated {
			decode(t, body, &session)
		}
		return session
	}
	recording := create(alice, roomID, "login-recording", http.StatusCreated)
	// The same login session still holds one active session at a time.
	create(alice, otherRoomID, "login-second-recording", http.StatusConflict)

	// Another browser of the same Account neither sees nor drives it.
	for index, check := range []struct {
		method, path string
		payload      any
	}{
		{http.MethodGet, "/v0/rooms/" + roomID + "/voice-sessions", nil},
		{http.MethodGet, "/v0/voice-sessions/" + recording.Id, nil},
		{http.MethodPost, "/v0/voice-sessions/" + recording.Id + "/connection-credentials", nil},
		{http.MethodPost, "/v0/voice-sessions/" + recording.Id + "/captures", map[string]any{"room_id": roomID, "start_offset_ms": 0}},
		{http.MethodGet, "/v0/voice-sessions/" + recording.Id + "/transcript-events", nil},
		{http.MethodGet, "/v0/voice-sessions/" + recording.Id + "/events", nil},
		{http.MethodDelete, "/v0/voice-sessions/" + recording.Id, nil},
	} {
		key := ""
		if check.method != http.MethodGet {
			key = "other-browser-" + strconv.Itoa(index)
		}
		if status, _, body := env.request(otherBrowser, check.method, check.path, check.payload, key); status != http.StatusNotFound {
			t.Fatalf("other login session %s %s=%d %s", check.method, check.path, status, body)
		}
	}
	// It holds its own session, even under the same Idempotency-Key, and the
	// policy names only the caller's Room.
	otherRecording := create(otherBrowser, otherRoomID, "login-recording", http.StatusCreated)
	if otherRecording.Id == recording.Id {
		t.Fatal("another login session replayed the first one's session")
	}
	if status, _, body := env.request(otherBrowser, http.MethodPost, "/v0/voice-sessions/"+otherRecording.Id+"/connection-credentials", nil, ""); status != http.StatusCreated {
		t.Fatalf("own credential=%d %s", status, body)
	}
	for client, want := range map[*http.Client]string{alice: roomID, otherBrowser: otherRoomID} {
		status, _, body := env.request(client, http.MethodGet, "/v0/tenants/"+acmeTenant+"/voice-media-policy", nil, "")
		var policy httpapi.VoiceMediaPolicy
		decode(t, body, &policy)
		if status != http.StatusOK || policy.ActiveRoomId == nil || *policy.ActiveRoomId != want {
			t.Fatalf("policy=%d %s, want Room %s", status, body, want)
		}
	}

	// Only the recorder reads the Capture, from any of their login sessions;
	// only the login session recording it stops it.
	capture, err := q.CreateLiveKitCaptureSession(t.Context(), store.CreateLiveKitCaptureSessionParams{ID: "capture_login_session", AccountID: "account_alice", RoomID: roomID, VoiceSessionID: recording.Id})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = q.CreateVoiceMediaEpoch(t.Context(), store.CreateVoiceMediaEpochParams{ID: "epoch_login_session", VoiceSessionID: recording.Id, CaptureSessionID: capture.ID, StagingPrefix: "voice-staging/capture_login_session/epoch-0"}); err != nil {
		t.Fatal(err)
	}
	if _, err = q.TransitionLiveKitCaptureStatus(t.Context(), store.TransitionLiveKitCaptureStatusParams{ID: capture.ID, Status: "recording"}); err != nil {
		t.Fatal(err)
	}
	if status, _, body := env.request(otherBrowser, http.MethodGet, "/v0/voice-captures/"+capture.ID, nil, ""); status != http.StatusOK {
		t.Fatalf("recorder's other login session read=%d %s", status, body)
	}
	if status, _, body := env.request(otherBrowser, http.MethodPost, "/v0/voice-captures/"+capture.ID+"/stop", nil, "stop-other-browser"); status != http.StatusNotFound {
		t.Fatalf("the other login session stopped the recording=%d %s", status, body)
	}

	// Signing out ends the session the way a departed publisher's ends: the
	// recording is stopped and saved, then the session closes.
	if status, _, _ := env.request(alice, http.MethodPost, "/v0/auth/logout", nil, ""); status != http.StatusNoContent {
		t.Fatalf("logout=%d", status)
	}
	if status, _, _ := env.request(alice, http.MethodPost, "/v0/voice-sessions/"+recording.Id+"/connection-credentials", nil, ""); status != http.StatusUnauthorized {
		t.Fatalf("credential after logout=%d", status)
	}
	reconcile := func() {
		t.Helper()
		if _, err := env.pool.Exec(t.Context(), "UPDATE voice_sessions SET updated_at=clock_timestamp()-interval '1 minute' WHERE id=$1", recording.Id); err != nil {
			t.Fatal(err)
		}
		if _, err := service.RunJobStepForTest(t.Context(), voicemedia.VoiceSessionReconcileArgs{VoiceSessionID: recording.Id}); err != nil {
			t.Fatalf("session reconciliation: %v", err)
		}
	}
	readStatus := func(table, id string) string {
		t.Helper()
		var status string
		if err := env.pool.QueryRow(t.Context(), "SELECT status FROM "+table+" WHERE id=$1", id).Scan(&status); err != nil {
			t.Fatal(err)
		}
		return status
	}
	reconcile()
	if got, session := readStatus("capture_sessions", capture.ID), readStatus("voice_sessions", recording.Id); got != "finalizing" || session != "closing" || deletedRooms.Load() != 0 {
		t.Fatalf("sign-out must save the recording first: capture=%s session=%s deleted=%d", got, session, deletedRooms.Load())
	}
	if _, err = env.pool.Exec(t.Context(), "UPDATE capture_sessions SET status='recovering' WHERE id=$1", capture.ID); err != nil {
		t.Fatal(err)
	}
	reconcile()
	if session := readStatus("voice_sessions", recording.Id); session != "closed" || deletedRooms.Load() != 1 {
		t.Fatalf("signed-out session=%s deleted=%d", session, deletedRooms.Load())
	}
	if session := readStatus("voice_sessions", otherRecording.Id); session != "connected" {
		t.Fatalf("the other login session's recording session=%s", session)
	}
	// A session whose login session was deleted closes the same way.
	orphan, err := q.CreateVoiceSession(t.Context(), store.CreateVoiceSessionParams{ID: "voice_orphan", AccountID: "account_alice", AuthSessionID: pgtype.Text{}, RoomID: roomID, ProviderRoomName: "voice-orphan", ParticipantIdentity: "orphan", Purpose: "hardware_control"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), "UPDATE voice_sessions SET updated_at=clock_timestamp()-interval '2 minutes' WHERE id=$1", orphan.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.RunJobStepForTest(t.Context(), voicemedia.VoiceSessionReconcileArgs{VoiceSessionID: orphan.ID}); err != nil || readStatus("voice_sessions", orphan.ID) != "closed" {
		t.Fatalf("orphaned session err=%v status=%s", err, readStatus("voice_sessions", orphan.ID))
	}
}
