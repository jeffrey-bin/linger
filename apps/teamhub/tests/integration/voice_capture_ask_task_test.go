package integration_test

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// A request asked in the recording's Ask is handed to Another Me as a hidden
// Message with the recording context attached: Another Me's Meta creates the
// background Task itself. A question is answered as before.
func TestRecordingAskRequestIsHandedToAnotherMe(t *testing.T) {
	allowParallelIntegrationTest(t)
	media := &dictationTestMedia{}
	var calls atomic.Int32
	agentService := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/model-calls" {
			http.NotFound(w, r)
			return
		}
		calls.Add(1)
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		var request struct {
			Input string `json:"input"`
		}
		if err = json.Unmarshal(body, &request); err != nil {
			t.Error(err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		output := `{"kind":"answer","answer":"Not decided yet.","answered":false,"source_segments":[],"task_title":""}`
		if strings.Contains(request.Input, "Help me") {
			output = `{"kind":"task","answer":"","answered":false,"source_segments":[],"task_title":"Draft the launch email"}`
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"model":"test-recording-model","output":` + output + `}`))
	}))
	t.Cleanup(agentService.Close)
	env, alice, storageRoot := newHardwareVoiceCaptureEnvWithStorageAndLimitsAndConfig(t, 1<<20, 1<<30, func(cfg *config.Config) {
		cfg.NodeServicesURL = agentService.URL
	},
		withVoiceMedia(media))
	media.Plane = voicemedia.New(env.pool, nil, nil)
	q := store.New(env.pool)
	// Recordings belong to the recorder's Another Me Direct Room.
	direct := requestDirectRoom(alice, env.server.URL, "actor_acme_official")
	if direct.err != nil || (direct.status != http.StatusCreated && direct.status != http.StatusOK) {
		t.Fatalf("Direct Room status=%d err=%v body=%s", direct.status, direct.err, direct.body)
	}
	voice, err := q.CreateVoiceSession(t.Context(), store.CreateVoiceSessionParams{ID: "voice_ask_task", AccountID: "account_alice", RoomID: direct.roomID, ProviderRoomName: "ask-task", ParticipantIdentity: "ask-task", Purpose: "hardware_control"})
	if err != nil {
		t.Fatal(err)
	}
	capture, err := q.CreateLiveKitCaptureSession(t.Context(), store.CreateLiveKitCaptureSessionParams{ID: "capture_ask_task", AccountID: "account_alice", RoomID: direct.roomID, VoiceSessionID: voice.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = env.pool.Exec(t.Context(), "UPDATE capture_sessions SET status='recording',transcript_start_offset_ms=0 WHERE id=$1", capture.ID); err != nil {
		t.Fatal(err)
	}
	// Both the live question evidence and the attached context stop at the
	// captured cutoff; later speech is not part of the request.
	if _, err = createCaptureSpeech(t.Context(), q, captureSpeech{
		ID: "capture_segment_ask", SessionID: capture.ID, AccountID: "account_alice", RoomID: direct.roomID,
		Kind: "speech", StartOffsetMs: 1000, EndOffsetMs: 2000, Text: "The launch is Friday.", NormalizedText: "The launch is Friday.",
		SpeakerID: textForVoiceTest("spk_1"),
	}); err != nil {
		t.Fatal(err)
	}
	// Speech recovered from the archive is part of the context too.
	if _, err = createCaptureSpeech(t.Context(), q, captureSpeech{
		ID: "capture_segment_ask_recovered", SessionID: capture.ID, AccountID: "account_alice", RoomID: direct.roomID,
		Kind: "speech", StartOffsetMs: 500, EndOffsetMs: 900, Text: "Recovered opening.", NormalizedText: "Recovered opening.",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err = env.pool.Exec(t.Context(), `UPDATE voice_transcript_segments SET lane='recovery' WHERE id='capture_segment_ask_recovered'`); err != nil {
		t.Fatal(err)
	}
	questions := "/v0/voice-captures/" + capture.ID + "/questions"
	contextDocuments := func() int {
		return countRows(t, env, `SELECT count(*) FROM documents WHERE title='recording-context.md'`)
	}

	// A question is answered and is never handed over.
	code, _, body := env.request(alice, http.MethodPost, questions, map[string]any{"question": "Is the budget decided?"}, "")
	var answer httpapi.VoiceCaptureQuestion
	decode(t, body, &answer)
	if code != http.StatusOK || answer.Kind != httpapi.VoiceCaptureQuestionKindAnswer || answer.Answer != "Not decided yet." || answer.TaskTitle != nil {
		t.Fatalf("ask question=%d %s", code, body)
	}
	if code, _, body := env.request(alice, http.MethodPost, questions+"/"+answer.Id+"/task", nil, ""); code != http.StatusConflict {
		t.Fatalf("answer sent as a task=%d %s", code, body)
	}

	code, _, body = env.request(alice, http.MethodPost, questions, map[string]any{"question": "  Help me draft the launch email and send it to Lena  "}, "")
	var request httpapi.VoiceCaptureQuestion
	decode(t, body, &request)
	if code != http.StatusOK || request.Kind != httpapi.VoiceCaptureQuestionKindTask || request.Answer != "" ||
		request.TaskTitle == nil || *request.TaskTitle != "Draft the launch email" || request.SentMessageId != nil {
		t.Fatalf("ask task=%d %s", code, body)
	}
	send := questions + "/" + request.Id + "/task"
	// While Another Me is unavailable nobody can take the request, and nothing
	// is left behind.
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_registrations SET status='revoked' WHERE actor_id='actor_acme_official'`); err != nil {
		t.Fatal(err)
	}
	if code, _, body := env.request(alice, http.MethodPost, send, nil, ""); code != http.StatusConflict ||
		!strings.Contains(string(body), "VOICE_TASK_AGENT_UNAVAILABLE") || contextDocuments() != 0 {
		t.Fatalf("unavailable Another Me=%d %s documents=%d", code, body, contextDocuments())
	}
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_registrations SET status='active' WHERE actor_id='actor_acme_official'`); err != nil {
		t.Fatal(err)
	}

	if _, err = createCaptureSpeech(t.Context(), q, captureSpeech{
		ID: "capture_segment_ask_later", SessionID: capture.ID, AccountID: "account_alice", RoomID: direct.roomID,
		Kind: "speech", StartOffsetMs: 3000, EndOffsetMs: 4000, Text: "Later private topic.", NormalizedText: "Later private topic.",
	}); err != nil {
		t.Fatal(err)
	}
	var beforeSend time.Time
	if err = env.pool.QueryRow(t.Context(), "SELECT updated_at FROM capture_sessions WHERE id=$1", capture.ID).Scan(&beforeSend); err != nil {
		t.Fatal(err)
	}
	code, _, body = env.request(alice, http.MethodPost, send, nil, "")
	var sent httpapi.VoiceCaptureQuestion
	decode(t, body, &sent)
	if code != http.StatusOK || sent.SentMessageId == nil {
		t.Fatalf("send task=%d %s", code, body)
	}
	// The recorder's hidden Message wakes Another Me in the Direct Room; the
	// Meta, not TeamHub, decides on and creates the Task.
	if countRows(t, env, `SELECT count(*) FROM messages WHERE id=$1 AND room_id=$2
		AND message_kind='agent_runtime' AND author_actor_id='actor_acme_alice'
		AND segments::text LIKE '%actor_acme_official%'
		AND body LIKE '%“Help me draft the launch email and send it to Lena”%Please handle this as a background Task.%'`,
		*sent.SentMessageId, direct.roomID) != 1 {
		t.Fatal("the request was not handed to Another Me as a hidden Message")
	}
	if countRows(t, env, `SELECT count(*) FROM work_items WHERE kind='task'`) != 0 ||
		countRows(t, env, `SELECT count(*) FROM decisions WHERE kind='room_creation'`) != 0 {
		t.Fatal("TeamHub created a Task or an approval card for the request")
	}
	// The Message mentions the Agent, says what was asked, and attaches the
	// context as a card.
	var segmentsJSON []byte
	if err = env.pool.QueryRow(t.Context(), `SELECT segments FROM messages WHERE id=$1`, *sent.SentMessageId).Scan(&segmentsJSON); err != nil {
		t.Fatal(err)
	}
	var segments []struct {
		Type         string `json:"type"`
		Content      string `json:"content"`
		Target       string `json:"target"`
		TargetType   string `json:"target_type"`
		Presentation string `json:"presentation"`
	}
	decode(t, segmentsJSON, &segments)
	if len(segments) != 3 ||
		segments[0].Type != "reference" || segments[0].Target != "actor_acme_official" || segments[0].TargetType != "agent" ||
		segments[1].Type != "text" || !strings.HasPrefix(segments[1].Content, " From my recording at 00:00:02 — “Help me draft the launch email and send it to Lena”\nPlease handle this as a background Task.") ||
		segments[2].Type != "document" || segments[2].Content != "recording-context.md" || segments[2].Presentation != "card" {
		t.Fatalf("recording task Message segments=%+v", segments)
	}
	var objectKey string
	if err := env.pool.QueryRow(t.Context(), `SELECT version.content_object_id FROM messages message
		CROSS JOIN LATERAL jsonb_array_elements(message.attachments) attachment
		JOIN document_versions version ON version.id=attachment->>'document_version_id'
		WHERE message.id=$1 AND version.filename='recording-context.md'`,
		*sent.SentMessageId).Scan(&objectKey); err != nil {
		t.Fatal(err)
	}
	markdown := readStoredObject(t, storageRoot, objectKey)
	for _, want := range []string{
		"Written by the recorder at 00:00:02: Help me draft the launch email and send it to Lena",
		"## Earlier in Ask", "- Asked: Is the budget decided?", "Answered: Not decided yet.",
		"- [00:00:01 - 00:00:02] Speaker 1: The launch is Friday.",
		"- [00:00:00 - 00:00:00] Recovered opening.",
		"\n## Transcript so far\n\n",
	} {
		if !strings.HasPrefix(markdown, "# Recording context — ") || !strings.Contains(markdown, want) {
			t.Fatalf("context lacks %q:\n%s", want, markdown)
		}
	}
	if strings.Contains(markdown, "Later private topic.") {
		t.Fatalf("context reaches past the request:\n%s", markdown)
	}

	if countRows(t, env, `SELECT
		(SELECT count(*) FROM document_versions WHERE filename='checkpoint.m4a') +
		(SELECT count(*) FROM capture_media_outputs WHERE capture_session_id=$1)`, capture.ID) != 0 {
		t.Fatal("sending a recording task cut audio")
	}
	if countRows(t, env, `SELECT count(*) FROM capture_sessions WHERE id=$1 AND updated_at>$2`, capture.ID, beforeSend) != 1 {
		t.Fatal("sending the request did not make the recording eligible for Memory recollection")
	}
	// Sending again, or listing, shows the same hand-off; nothing is sent twice.
	code, _, again := env.request(alice, http.MethodPost, send, nil, "")
	if code != http.StatusOK || string(again) != string(body) {
		t.Fatalf("resend=%d %s", code, again)
	}
	code, _, listed := env.request(alice, http.MethodGet, questions, nil, "")
	var list httpapi.VoiceCaptureQuestionList
	decode(t, listed, &list)
	if code != http.StatusOK || len(list.Items) != 2 || list.Items[1].SentMessageId == nil || *list.Items[1].SentMessageId != *sent.SentMessageId {
		t.Fatalf("list=%d %s", code, listed)
	}
	if countRows(t, env, `SELECT count(*) FROM messages WHERE room_id=$1 AND message_kind='agent_runtime'
		AND body LIKE '%Please handle this as a background Task.%'`, direct.roomID) != 1 || contextDocuments() != 1 {
		t.Fatal("a resent request was handed over again")
	}
	if calls.Load() != 2 {
		t.Fatalf("the recording's Agent was called %d times, want once per message", calls.Load())
	}
}

func readStoredObject(t *testing.T, root, key string) string {
	t.Helper()
	var found string
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err == nil && !entry.IsDir() && strings.Contains(path, key) {
			found = path
		}
		return err
	})
	if err != nil || found == "" {
		t.Fatalf("stored object %s not found: %v", key, err)
	}
	content, err := os.ReadFile(found)
	if err != nil {
		t.Fatal(err)
	}
	return string(content)
}
