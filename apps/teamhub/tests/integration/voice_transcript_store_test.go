package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/realtime"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// A final retried after its Capture froze is told apart by its event row: the
// same words answer accepted, a new event is ignored, other words conflict.
func TestVoiceFinalAfterCaptureFreezeAnswersByEvent(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, _ := newVoiceServiceEnv(t, func(cfg *config.Config) { cfg.Voice.RuntimeToken = "voice-test-service-token" })
	ctx := t.Context()
	q := store.New(env.pool)
	roomID := env.createRoom(alice, acmeTenant, "Voice freeze", "voice-freeze")
	voice, err := q.CreateVoiceSession(ctx, store.CreateVoiceSessionParams{ID: "voice_freeze", AccountID: "account_alice", AuthSessionID: loginSessionOf(t, env, "account_alice"), RoomID: roomID, ProviderRoomName: "voice-freeze", ParticipantIdentity: "publisher-freeze", Purpose: "hardware_control"})
	if err != nil {
		t.Fatal(err)
	}
	capture, err := q.CreateLiveKitCaptureSession(ctx, store.CreateLiveKitCaptureSessionParams{ID: "capture_freeze", AccountID: "account_alice", RoomID: roomID, VoiceSessionID: voice.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = env.pool.Exec(ctx, "UPDATE capture_sessions SET status='recording',transcript_start_offset_ms=0 WHERE id=$1", capture.ID); err != nil {
		t.Fatal(err)
	}
	final := func(eventID, text string, end int64) (int, string) {
		t.Helper()
		body, _ := json.Marshal(map[string]any{"event_id": eventID, "kind": "final", "voice_session_id": voice.ID, "media_epoch": 0, "lane": "live", "start_offset_ms": 100, "end_offset_ms": end, "text": text})
		request, requestErr := http.NewRequestWithContext(ctx, http.MethodPost, env.server.URL+"/internal/v1/voice/observations", bytes.NewReader(body))
		if requestErr != nil {
			t.Fatal(requestErr)
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Authorization", "Bearer voice-test-service-token")
		response, requestErr := http.DefaultClient.Do(request)
		if requestErr != nil {
			t.Fatal(requestErr)
		}
		defer response.Body.Close()
		payload, _ := io.ReadAll(response.Body)
		return response.StatusCode, string(payload)
	}
	if status, body := final("voice_event_frozen", "Before the stop", 500); status != http.StatusAccepted || !strings.Contains(body, `"accepted"`) {
		t.Fatalf("first final=%d %s", status, body)
	}
	// The transcript end freezes before the final's end, so the Capture no
	// longer accepts it.
	if _, err = env.pool.Exec(ctx, "UPDATE capture_sessions SET status='finalizing',transcript_end_offset_ms=300 WHERE id=$1", capture.ID); err != nil {
		t.Fatal(err)
	}
	if status, body := final("voice_event_frozen", "Before the stop", 500); status != http.StatusAccepted || !strings.Contains(body, `"accepted"`) {
		t.Fatalf("identical retry=%d %s", status, body)
	}
	if status, body := final("voice_event_late", "After the freeze", 600); status != http.StatusAccepted || !strings.Contains(body, `"ignored"`) {
		t.Fatalf("late final=%d %s", status, body)
	}
	if status, body := final("voice_event_frozen", "Other words", 500); status != http.StatusConflict || !strings.Contains(body, "EVENT_CONFLICT") {
		t.Fatalf("changed words=%d %s", status, body)
	}
	var count int
	if err = env.pool.QueryRow(ctx, "SELECT count(*) FROM voice_transcript_segments WHERE voice_session_id=$1", voice.ID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("segments=%d err=%v", count, err)
	}
}

// Captions read live rows only, so archive recovery inserting its rows and
// superseding live ones sends no voice.changed; a live final still does.
func TestVoiceProjectionSkipsRecoveryWrites(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, _, _, voice := newVoiceEventStreamEnv(t)
	ctx := t.Context()
	q := store.New(env.pool)
	capture, err := q.CreateLiveKitCaptureSession(ctx, store.CreateLiveKitCaptureSessionParams{ID: "capture_projection_recovery", AccountID: "account_alice", RoomID: voice.RoomID, VoiceSessionID: voice.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = q.CreateVoiceTranscriptSegment(ctx, store.CreateVoiceTranscriptSegmentParams{ID: "projection_live", EventID: "projection_live", VoiceSessionID: voice.ID, CaptureSessionID: textForVoiceTest(capture.ID), Lane: "live", StartOffsetMs: 100, EndOffsetMs: 200, Text: "live", NormalizedText: "live", Kind: "speech", AccountID: "account_alice", RoomID: voice.RoomID}); err != nil {
		t.Fatal(err)
	}
	listener, err := env.pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Release()
	if _, err = listener.Exec(ctx, "LISTEN teamhub_realtime"); err != nil {
		t.Fatal(err)
	}
	topic := `"voice:` + voice.ID + `"`
	notified := func(wait time.Duration) bool {
		t.Helper()
		waitCtx, cancel := context.WithTimeout(ctx, wait)
		defer cancel()
		for {
			notification, waitErr := listener.Conn().WaitForNotification(waitCtx)
			if errors.Is(waitErr, context.DeadlineExceeded) {
				return false
			}
			if waitErr != nil {
				t.Fatal(waitErr)
			}
			if strings.Contains(notification.Payload, topic) {
				if decoded, decodeErr := realtime.DecodeNotification([]byte(notification.Payload)); decodeErr != nil || decoded.Kind != "voice.changed" {
					t.Fatalf("listener rejects trigger payload %s: %+v %v", notification.Payload, decoded, decodeErr)
				}
				return true
			}
		}
	}
	if _, err = env.pool.Exec(ctx, "INSERT INTO voice_transcript_segments(id,event_id,voice_session_id,capture_session_id,media_epoch,lane,start_offset_ms,end_offset_ms,text,normalized_text,kind) VALUES('projection_recovery','projection_recovery',$1,$2,0,'recovery',100,200,'recovered','recovered','speech')", voice.ID, capture.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = env.pool.Exec(ctx, "UPDATE voice_transcript_segments SET superseded_at=clock_timestamp() WHERE id='projection_live'"); err != nil {
		t.Fatal(err)
	}
	if notified(time.Second) {
		t.Fatal("recovery write sent voice.changed")
	}
	if _, err = q.CreateVoiceTranscriptSegment(ctx, store.CreateVoiceTranscriptSegmentParams{ID: "projection_next", EventID: "projection_next", VoiceSessionID: voice.ID, Lane: "live", StartOffsetMs: 300, EndOffsetMs: 400, Text: "next", NormalizedText: "next", Kind: "speech"}); err != nil {
		t.Fatal(err)
	}
	if !notified(5 * time.Second) {
		t.Fatal("live final sent no voice.changed")
	}
}

// A Capture still completing after a newer one starts stays in the event
// snapshot, and its last change still arrives.
func TestVoiceEventSnapshotKeepsACompletingCapture(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, _, voice := newVoiceEventStreamEnv(t)
	ctx := t.Context()
	q := store.New(env.pool)
	settled, err := q.CreateLiveKitCaptureSession(ctx, store.CreateLiveKitCaptureSessionParams{ID: "capture_snapshot_settled", AccountID: "account_alice", RoomID: voice.RoomID, VoiceSessionID: voice.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = env.pool.Exec(ctx, "UPDATE capture_sessions SET status='failed',created_at=clock_timestamp()-interval '2 minutes',updated_at=clock_timestamp()-interval '2 minutes' WHERE id=$1", settled.ID); err != nil {
		t.Fatal(err)
	}
	completing, err := q.CreateLiveKitCaptureSession(ctx, store.CreateLiveKitCaptureSessionParams{ID: "capture_snapshot_completing", AccountID: "account_alice", RoomID: voice.RoomID, VoiceSessionID: voice.ID})
	if err != nil {
		t.Fatal(err)
	}
	audio := uploadTestDocument(t, env, alice, "snapshot-capture-output", "source.m4a", "m4a", "audio/mp4", "synthetic-media")
	if _, err = env.pool.Exec(ctx, "UPDATE capture_sessions SET status='finalized',document_id=$2,document_version_id=$3,created_at=clock_timestamp()-interval '1 minute',updated_at=clock_timestamp()-interval '1 minute' WHERE id=$1", completing.ID, audio.ID, audio.CurrentVersion.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = q.CreateLiveKitCaptureSession(ctx, store.CreateLiveKitCaptureSessionParams{ID: "capture_snapshot_newest", AccountID: "account_alice", RoomID: voice.RoomID, VoiceSessionID: voice.ID}); err != nil {
		t.Fatal(err)
	}
	captures := func() map[string]string {
		t.Helper()
		page := readVoiceEvents(t, env, alice, voice.ID, "")
		for page.HasMore {
			page = readVoiceEvents(t, env, alice, voice.ID, page.NextCursor)
		}
		statuses := map[string]string{}
		for _, item := range page.Items {
			if item.Capture != nil {
				statuses[item.Capture.Id] = string(item.Capture.Status)
			}
		}
		return statuses
	}
	if got := captures(); len(got) != 2 || got[completing.ID] != "finalizing" || got["capture_snapshot_newest"] != "starting" {
		t.Fatalf("snapshot while completing=%v", got)
	}
	// Completion settles the Capture after the newer one started; the
	// snapshot still carries that last change.
	transcript := uploadTestDocument(t, env, alice, "snapshot-capture-transcript", "transcript.m4a", "m4a", "audio/mp4", "synthetic-transcript")
	if _, err = q.AttachCaptureTranscriptDocument(ctx, store.AttachCaptureTranscriptDocumentParams{ID: completing.ID, TranscriptDocumentID: textForVoiceTest(transcript.ID), TranscriptDocumentVersionID: textForVoiceTest(transcript.CurrentVersion.ID)}); err != nil {
		t.Fatal(err)
	}
	if got := captures(); len(got) != 2 || got[completing.ID] != "finalized" {
		t.Fatalf("snapshot after completion=%v", got)
	}
}
