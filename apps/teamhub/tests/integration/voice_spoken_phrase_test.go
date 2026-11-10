package integration_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// Recording control goes only through the Start and Stop endpoints: a final
// sentence that says "end recording" is ordinary speech on the Capture.
func TestVoiceFinalSayingEndRecordingIsSpeech(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, _ := newVoiceServiceEnv(t,
		func(cfg *config.Config) { cfg.Voice.RuntimeToken = "voice-phrase-token" })
	q := store.New(env.pool)
	roomID := env.createRoom(alice, acmeTenant, "Spoken phrase", "voice-spoken-phrase")
	voice, err := q.CreateVoiceSession(t.Context(), store.CreateVoiceSessionParams{ID: "voice_spoken_phrase", AccountID: "account_alice", AuthSessionID: loginSessionOf(t, env, "account_alice"), RoomID: roomID, ProviderRoomName: "spoken-phrase", ParticipantIdentity: "spoken-phrase", Purpose: "hardware_control"})
	if err != nil {
		t.Fatal(err)
	}
	capture, err := q.CreateLiveKitCaptureSession(t.Context(), store.CreateLiveKitCaptureSessionParams{ID: "capture_spoken_phrase", AccountID: "account_alice", RoomID: roomID, VoiceSessionID: voice.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = q.TransitionLiveKitCaptureStatus(t.Context(), store.TransitionLiveKitCaptureStatusParams{ID: capture.ID, Status: "recording"}); err != nil {
		t.Fatal(err)
	}
	const endRecordingPhrase = "end recording"
	payload, _ := json.Marshal(map[string]any{"voice_session_id": voice.ID, "event_id": "voice_event_spoken_phrase", "media_epoch": 0, "lane": "live", "kind": "final", "start_offset_ms": 1000, "end_offset_ms": 1600, "text": endRecordingPhrase})
	request, err := http.NewRequestWithContext(t.Context(), http.MethodPost, env.server.URL+"/internal/v1/voice/observations", bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer voice-phrase-token")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	responseBody, _ := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("final callback=%d %s", response.StatusCode, responseBody)
	}
	if countRows(t, env, `SELECT count(*) FROM voice_transcript_segments WHERE capture_session_id=$1 AND kind='speech' AND text=$2`, capture.ID, endRecordingPhrase) != 1 {
		t.Fatal("the spoken phrase is not ordinary speech on the Capture")
	}
	if countRows(t, env, `SELECT count(*) FROM capture_sessions WHERE id=$1 AND status='recording'`, capture.ID) != 1 ||
		countRows(t, env, `SELECT count(*) FROM capture_sessions WHERE id=$1 AND stop_requested_at IS NOT NULL`, capture.ID) != 0 {
		t.Fatal("a spoken phrase stopped the recording")
	}
	status, _, body := env.request(alice, http.MethodGet, "/v0/voice-sessions/"+voice.ID+"/transcript-events", nil, "")
	var page httpapi.VoiceTranscriptEventPage
	decode(t, body, &page)
	if status != http.StatusOK || len(page.Items) != 1 || page.Items[0].Kind != httpapi.Speech ||
		page.Items[0].Text != endRecordingPhrase || page.Items[0].CaptureSessionId == nil || *page.Items[0].CaptureSessionId != capture.ID {
		t.Fatalf("transcript feed=%d %s", status, body)
	}
}
