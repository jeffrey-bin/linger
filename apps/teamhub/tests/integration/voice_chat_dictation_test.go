package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/livekit/protocol/livekit"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
	"google.golang.org/protobuf/proto"
)

// Keep product workers off while exercising the real database-backed media
// service and real HTTP authorization against a local LiveKit API fake.
type dictationTestMedia struct{ voicemedia.Plane }

func (m *dictationTestMedia) CommitDictationTurn(ctx context.Context, accountID, id, requestID string) error {
	return m.Plane.(*voicemedia.Service).CommitDictationTurn(ctx, accountID, id, requestID)
}

func TestVoiceChatDictationKeepsCommandsAsSpeechAndFinalizesAuthorizedTurns(t *testing.T) {
	allowParallelIntegrationTest(t)
	var commits atomic.Int32
	var readinessUnavailable atomic.Bool
	media := &dictationTestMedia{}
	providerAPI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/protobuf")
		if strings.HasSuffix(r.URL.Path, "/ListParticipants") && readinessUnavailable.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/SendData") {
			body, err := io.ReadAll(r.Body)
			if err != nil {
				t.Error(err)
			}
			var input livekit.SendDataRequest
			if err := proto.Unmarshal(body, &input); err != nil {
				t.Error(err)
			}
			if input.GetTopic() != "linger.voice.dictation.commit" || input.Kind != livekit.DataPacket_RELIABLE || string(input.Data) != `{"request_id":"manual-turn-1"}` {
				t.Errorf("unexpected dictation commit packet")
			}
			commits.Add(1)
		} else if !strings.HasSuffix(r.URL.Path, "/CreateRoom") && !strings.HasSuffix(r.URL.Path, "/ListParticipants") && !strings.HasSuffix(r.URL.Path, "/ListDispatch") && !strings.HasSuffix(r.URL.Path, "/CreateDispatch") && !strings.HasSuffix(r.URL.Path, "/DeleteRoom") {
			t.Errorf("dictation used unexpected media API %s", r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer providerAPI.Close()
	env, alice, _ := newHardwareVoiceCaptureEnvWithStorageAndLimitsAndConfig(t, 1<<20, 1<<30, func(cfg *config.Config) {
		cfg.Voice.RuntimeToken = "dictation-test-token"
	}, withVoiceMedia(media))
	provider, err := voicemedia.NewLiveKitProvider(voicemedia.LiveKitConfig{APIURL: providerAPI.URL, PublicURL: providerAPI.URL, APIKey: "test", APISecret: "test"}, env.pool)
	if err != nil {
		t.Fatal(err)
	}
	service := voicemedia.New(env.pool, provider, nil)
	media.Plane = service
	status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/direct-rooms", map[string]any{"peer_actor_id": "actor_acme_official"}, "")
	if status != http.StatusOK && status != http.StatusCreated {
		t.Fatalf("create Agent DM=%d %s", status, body)
	}
	var direct struct {
		ID string `json:"id"`
	}
	decode(t, body, &direct)
	if direct.ID == "" {
		t.Fatalf("Agent DM missing ID: %s", body)
	}
	// Dictation sends ordinary chat Messages, so a group Room accepts it too.
	groupID := env.createRoom(alice, acmeTenant, "Group dictation", "dictation-group")
	createPath := "/v0/rooms/" + direct.ID + "/voice-sessions"
	status, _, body = env.request(alice, http.MethodPost, "/v0/rooms/"+groupID+"/voice-sessions", map[string]any{"purpose": "chat_dictation"}, "dictation-group")
	if status != http.StatusCreated {
		t.Fatalf("group dictation=%d %s", status, body)
	}
	var group httpapi.VoiceSession
	decode(t, body, &group)
	if status, _, body = env.request(alice, http.MethodDelete, "/v0/voice-sessions/"+group.Id, nil, "dictation-group-close"); status != http.StatusOK {
		t.Fatalf("close group dictation=%d %s", status, body)
	}
	status, _, body = env.request(alice, http.MethodPost, createPath, map[string]any{"purpose": "chat_dictation"}, "dictation-session")
	if status != http.StatusCreated {
		t.Fatalf("create dictation=%d %s", status, body)
	}
	var voice httpapi.VoiceSession
	decode(t, body, &voice)
	if voice.Purpose != httpapi.ChatDictation {
		t.Fatalf("missing dictation purpose acknowledgement: %s", body)
	}
	// The recording window resumes only a recording session, never dictation.
	if status, _, body = env.request(alice, http.MethodGet, createPath, nil, ""); status != http.StatusNotFound {
		t.Fatalf("recording window reused dictation=%d %s", status, body)
	}
	status, _, body = env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/voice-media-policy", nil, "")
	var policy httpapi.VoiceMediaPolicy
	decode(t, body, &policy)
	if status != http.StatusOK || !policy.VoiceMediaSupported {
		t.Fatalf("dictation capability=%d %s", status, body)
	}
	status, _, _ = env.request(alice, http.MethodPost, createPath, map[string]any{"purpose": "hardware_control"}, "dictation-session")
	if status != http.StatusConflict {
		t.Fatalf("purpose-changing idempotent retry=%d", status)
	}
	status, _, _ = env.request(alice, http.MethodPost, createPath, map[string]any{"purpose": "hardware_control"}, "hardware-session-conflict")
	if status != http.StatusConflict {
		t.Fatalf("second active session stole microphone=%d", status)
	}
	status, _, _ = env.request(alice, http.MethodPost, "/v0/voice-sessions/"+voice.Id+"/captures", map[string]any{"room_id": direct.ID, "start_offset_ms": 0}, "dictation-capture-denied")
	if status != http.StatusConflict {
		t.Fatalf("dictation Capture=%d", status)
	}
	messageCount := countRows(t, env, "SELECT count(*) FROM messages WHERE room_id=$1", direct.ID)
	observe := func(id, kind, text string, start, end int64, want int) {
		t.Helper()
		payload, _ := json.Marshal(map[string]any{"voice_session_id": voice.Id, "event_id": id, "media_epoch": 0, "lane": "live", "kind": kind, "start_offset_ms": start, "end_offset_ms": end, "text": text})
		request, err := http.NewRequestWithContext(t.Context(), http.MethodPost, env.server.URL+"/internal/v1/voice/observations", bytes.NewReader(payload))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Authorization", "Bearer dictation-test-token")
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		responseBody, _ := io.ReadAll(response.Body)
		_ = response.Body.Close()
		if response.StatusCode != want {
			t.Fatalf("%s callback=%d %s", kind, response.StatusCode, responseBody)
		}
	}
	assertInputBoundary := func(start, end *int64) {
		t.Helper()
		status, _, body := env.request(alice, http.MethodGet, "/v0/voice-sessions/"+voice.Id, nil, "")
		var current httpapi.VoiceSession
		decode(t, body, &current)
		equal := func(got, want *int64) bool {
			return got == nil && want == nil || got != nil && want != nil && *got == *want
		}
		if status != http.StatusOK || !equal(current.InputStartedOffsetMs, start) || !equal(current.InputEndedOffsetMs, end) {
			t.Fatalf("persisted input boundary=%d %s", status, body)
		}
	}
	assertInputBoundary(nil, nil)
	start, end := int64(0), int64(1000)
	observe("input-start", "track_started", "", start, start, http.StatusAccepted)
	assertInputBoundary(&start, nil)
	finals := []string{"First sentence", "Second sentence", "Third sentence", "Fourth sentence"}
	for index, text := range finals {
		start := int64(index*200 + 100)
		observe("dictation-final-"+string(rune('a'+index)), "final", text, start, start+100, http.StatusAccepted)
	}
	// The whole turn may share the same exact window as an individual final.
	observe("dictation-turn-first", "turn_finalized", finals[0], 100, 200, http.StatusAccepted)
	observe("dictation-turn-first", "turn_finalized", finals[0], 100, 200, http.StatusAccepted)
	observe("dictation-turn-first", "turn_finalized", "different payload", 100, 200, http.StatusConflict)
	observe("dictation-partial", "partial", "，。", 900, 1000, http.StatusAccepted)
	observe("dictation-turn-empty", "turn_finalized", "，。", 900, 1000, http.StatusAccepted)
	status, _, body = env.request(alice, http.MethodGet, "/v0/voice-sessions/"+voice.Id+"/transcript-events", nil, "")
	var page httpapi.VoiceTranscriptEventPage
	decode(t, body, &page)
	if status != http.StatusOK || len(page.Items) != 5 || page.PartialTranscript != nil {
		t.Fatalf("dictation feed=%d %s", status, body)
	}
	turns := 0
	for _, event := range page.Items {
		if event.CaptureSessionId != nil {
			t.Fatalf("dictation acquired archive semantics: %+v", event)
		}
		if event.Kind == httpapi.DictationTurn {
			turns++
		} else if event.Kind != httpapi.Speech {
			t.Fatalf("dictation final kind=%s", event.Kind)
		}
	}
	if turns != 1 || countRows(t, env, "SELECT count(*) FROM capture_sessions WHERE voice_session_id=$1", voice.Id) != 0 || countRows(t, env, "SELECT count(*) FROM messages WHERE room_id=$1", direct.ID) != messageCount {
		t.Fatal("dictation created duplicate turns, archive or chat messages")
	}
	commitPath := "/v0/voice-sessions/" + voice.Id + "/dictation-commit"
	// The Voice Session belongs to the login session that opened it.
	otherBrowser := env.login("alice", alicePassword)
	for _, client := range []*http.Client{otherBrowser, alice} {
		status, _, body = env.request(client, http.MethodPost, commitPath, map[string]any{"request_id": "manual-turn-1"}, "")
		want := http.StatusNotFound
		if client == alice {
			want = http.StatusAccepted
		}
		if status != want {
			t.Fatalf("commit=%d want=%d %s", status, want, body)
		}
	}
	if commits.Load() != 1 {
		t.Fatalf("unexpected commit count=%d", commits.Load())
	}
	status, _, _ = env.request(otherBrowser, http.MethodGet, "/v0/voice-sessions/"+voice.Id+"/transcript-events", nil, "")
	if status != http.StatusNotFound {
		t.Fatalf("foreign feed=%d", status)
	}
	observe("input-end", "track_ended", "", end, end, http.StatusAccepted)
	readinessUnavailable.Store(true)
	assertInputBoundary(&start, &end)
	readinessUnavailable.Store(false)
	// An old end must remain older than a replacement input's start; an idle
	// replacement can end at its start without requiring a transcript event.
	start = 2000
	observe("replacement-start", "track_started", "", start, start, http.StatusAccepted)
	assertInputBoundary(&start, &end)
	observe("replacement-end", "track_ended", "", start, start, http.StatusAccepted)
	assertInputBoundary(&start, &start)
	if _, err := service.CloseVoiceSession(t.Context(), "account_alice", voice.Id); err != nil {
		t.Fatal(err)
	}
	status, _, _ = env.request(alice, http.MethodPost, commitPath, map[string]any{"request_id": "manual-turn-1"}, "")
	if status != http.StatusConflict {
		t.Fatalf("closed dictation commit=%d", status)
	}
	status, _, body = env.request(alice, http.MethodPost, createPath, map[string]any{}, "hardware-missing-purpose")
	if status != http.StatusBadRequest {
		t.Fatalf("session without purpose=%d %s", status, body)
	}
	status, _, body = env.request(alice, http.MethodPost, createPath, map[string]any{"purpose": "hardware_control"}, "hardware-session")
	if status != http.StatusCreated {
		t.Fatalf("hardware session=%d %s", status, body)
	}
	decode(t, body, &voice)
	if voice.Purpose != httpapi.HardwareControl {
		t.Fatalf("hardware purpose=%s", body)
	}
	// The login session already holds an open VoiceSession.
	status, _, body = env.request(alice, http.MethodPost, createPath, map[string]any{"purpose": "hardware_control"}, "")
	if status != http.StatusConflict {
		t.Fatalf("repeated hardware session=%d %s", status, body)
	}
	observe("hardware-turn-denied", "turn_finalized", "Ordinary speech", 100, 200, http.StatusConflict)
	status, _, _ = env.request(alice, http.MethodPost, "/v0/voice-sessions/"+voice.Id+"/dictation-commit", map[string]any{"request_id": "manual-turn-1"}, "")
	if status != http.StatusConflict || commits.Load() != 1 {
		t.Fatalf("hardware dictation commit=%d calls=%d", status, commits.Load())
	}
}
