package integration_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
)

func TestLiveKitCompletionKeepsSpeechAcrossStopBoundary(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, storageRoot := newVoiceServiceEnv(t, nil, starting(app.JobQueue))
	q := store.New(env.pool)
	ctx := t.Context()
	direct := requestDirectRoom(alice, env.server.URL, "actor_acme_official")
	if direct.err != nil || (direct.status != http.StatusCreated && direct.status != http.StatusOK) {
		t.Fatalf("direct Room status=%d err=%v", direct.status, direct.err)
	}
	hash := sha256.Sum256([]byte("completion-boundary"))
	voice, err := q.CreateVoiceSession(ctx, store.CreateVoiceSessionParams{ID: "voice_completion_boundary", AccountID: "account_alice", AuthSessionID: loginSessionOf(t, env, "account_alice"), RoomID: direct.roomID, ProviderRoomName: "completion-boundary", ParticipantIdentity: "completion-boundary", Purpose: "hardware_control"})
	if err != nil {
		t.Fatal(err)
	}
	const startMS, stopMS int64 = 1000, 7207431
	capture, err := q.CreateLiveKitCaptureSession(ctx, store.CreateLiveKitCaptureSessionParams{ID: "capture_completion_boundary", AccountID: "account_alice", RoomID: direct.roomID, VoiceSessionID: voice.ID, StartOffsetMs: startMS})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = q.TransitionLiveKitCaptureStatus(ctx, store.TransitionLiveKitCaptureStatusParams{ID: capture.ID, Status: "recording"}); err != nil {
		t.Fatal(err)
	}
	// The real failure retained this 12.67-second final, but lost all 72 chars
	// from the delivered document because its end overshot Stop by only 189ms.
	longSpeech := strings.Repeat("long-phrase-", 6) + "tail!!"
	segments := []struct {
		id, text   string
		start, end int64
	}{
		{"before", "outside-before", 0, 500},
		{"cross_start", "cross-start-private", 900, 1100},
		{"spans_window", "cross-window-private", 900, stopMS + 1000},
		{"at_start", "first-kept", startMS, 2000},
		{"inside", "middle-kept", 5000, 6000},
		{"tail", longSpeech, 7194950, 7207620},
		{"at_stop", "outside-at-stop", stopMS, stopMS + 500},
		{"after", "outside-after", stopMS + 1000, stopMS + 2000},
	}
	for _, segment := range segments {
		if _, err = createCaptureSpeech(ctx, q, captureSpeech{ID: "boundary_" + segment.id, SessionID: capture.ID, AccountID: "account_alice", RoomID: direct.roomID, StartOffsetMs: segment.start, EndOffsetMs: segment.end, Text: segment.text, NormalizedText: segment.text, Kind: "speech"}); err != nil {
			t.Fatalf("insert accepted %s segment: %v", segment.id, err)
		}
	}
	if _, err = q.AdvanceCaptureTranscriptCoverage(ctx, store.AdvanceCaptureTranscriptCoverageParams{SessionID: capture.ID, AccountID: "account_alice", RoomID: direct.roomID, StreamID: "boundary", Lane: "live", StartOffsetMs: startMS, EndOffsetMs: stopMS}); err != nil {
		t.Fatal(err)
	}
	// Task/context and legacy consumers keep their original fully-contained selection.
	contained, err := q.ListCaptureTranscriptSegments(ctx, store.ListCaptureTranscriptSegmentsParams{CaptureSessionID: capture.ID, StartOffsetMs: startMS, EndOffsetMs: stopMS})
	if err != nil || len(contained) != 2 {
		t.Fatalf("shared contained query changed: count=%d err=%v", len(contained), err)
	}
	audio := []byte("synthetic-media")
	digest := sha256.Sum256(audio)
	status, _, body := requestUnifiedDocumentMultipart(t, env, alice, "/v0/rooms/"+direct.roomID+"/documents/uploads", "boundary-audio", map[string]string{"filename": "source.m4a", "representation_format": "m4a", "media_type": "audio/mp4"}, "source.m4a", audio)
	if status != http.StatusCreated {
		t.Fatalf("audio upload status=%d", status)
	}
	var version uploadedDocumentRef
	decode(t, body, &version)
	// Use the production source-audio upload path, including Agent ownership in
	// a Direct Room. A same-named unrelated Document must stay in Shared.
	objects, err := artifactstore.NewLocalStore(storageRoot, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	object, err := objects.Put(ctx, bytes.NewReader(audio))
	if err != nil {
		t.Fatal(err)
	}
	documents := document.NewWithObjectStore(env.pool, objects)
	tx, err := env.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	var originals []document.Version
	for _, command := range []string{"boundary-source", "unrelated-source"} {
		original, err := documents.CreateStoredRoomUploadTx(ctx, tx, document.StoredRoomUploadInput{AccountID: "account_alice", RoomID: direct.roomID, CommandID: command, Filename: "original-recording.m4a", RepresentationFormat: "m4a", MediaType: "audio/mp4", Object: object})
		if err != nil {
			t.Fatal(err)
		}
		originals = append(originals, original)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = q.CreateCaptureMediaOutput(ctx, store.CreateCaptureMediaOutputParams{ID: "output_boundary", CaptureSessionID: capture.ID, Purpose: "final", RangeDigest: hex.EncodeToString(hash[:]), ObjectKey: "output_boundary", Filename: "source.m4a", DurationMs: stopMS - startMS - 500, SizeBytes: int64(len(audio)), Sha256: hex.EncodeToString(digest[:])}); err != nil {
		t.Fatal(err)
	}
	if _, err = env.pool.Exec(ctx, "UPDATE capture_sessions SET document_id=$2,document_version_id=$3,transcript_end_offset_ms=$4,source_audio_document_id=$5,source_audio_document_version_id=$6,status='finalized' WHERE id=$1", capture.ID, version.ID, version.CurrentVersion.ID, stopMS, originals[0].DocumentID, originals[0].ID); err != nil {
		t.Fatal(err)
	}
	queueVoiceJob(t, env.pool, voicemedia.CaptureCompletionArgs{CaptureSessionID: capture.ID})
	var completed store.CaptureSession
	deadline := time.Now().Add(5 * time.Second)
	for {
		completed, err = q.GetCaptureSessionForAccount(ctx, store.GetCaptureSessionForAccountParams{ID: capture.ID, AccountID: textForVoiceTest("account_alice")})
		if err != nil {
			t.Fatal(err)
		}
		if completed.TranscriptDocumentVersionID.Valid {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("completion did not publish the transcript")
		}
		time.Sleep(20 * time.Millisecond)
	}
	status, _, transcript := env.request(alice, http.MethodGet, "/v0/document-versions/"+completed.TranscriptDocumentVersionID.String+"/content", nil, "")
	if status != http.StatusOK {
		t.Fatalf("transcript download status=%d", status)
	}
	for _, excluded := range []string{"outside-before", "cross-start-private", "cross-window-private", "outside-at-stop", "outside-after"} {
		if strings.Contains(string(transcript), excluded) {
			t.Fatal("completion included content outside its speech window")
		}
	}
	if !strings.Contains(string(transcript), longSpeech) {
		t.Fatal("completion dropped the accepted 12.67-second tail for a 189ms Stop overshoot")
	}
	if completed.VoiceCompletionFailedAt.Valid || completed.VoiceCompletionAttempts != 0 {
		t.Fatal("successful completion recorded a failure")
	}
	want := captureTranscriptHeadingForTest(string(transcript)) + "[00:00:00 - 00:00:01] first-kept\n\n[00:00:04 - 00:00:05] middle-kept\n\n[01:59:53 - 02:00:06] " + longSpeech + "\n"
	if string(transcript) != want {
		t.Fatal("completion did not clip the display end")
	}
	canonical, err := q.GetVoiceTranscriptSegmentByEvent(ctx, store.GetVoiceTranscriptSegmentByEventParams{VoiceSessionID: capture.VoiceSessionID.String, EventID: "event_boundary_tail"})
	if err != nil || canonical.Text != longSpeech || completed.TranscriptEndOffsetMs.Int64 != stopMS {
		t.Fatalf("completion changed canonical evidence or the frozen boundary: err=%v", err)
	}
	if countRows(t, env, "SELECT count(*) FROM messages WHERE room_id=$1 AND author_actor_id='actor_acme_official'", direct.roomID) != 1 {
		t.Fatal("completion must publish exactly one Room message")
	}
	// Ready meeting files disappear from BOTH Shared surfaces, without losing
	// their original Document access or changing ownership/placements.
	for _, endpoint := range []string{"/v0/library/documents?view=shared&limit=100", "/v0/tenants/" + capture.TenantID + "/me/shared-document-tree"} {
		status, _, shared := env.request(alice, http.MethodGet, endpoint, nil, "")
		if status != http.StatusOK || strings.Contains(string(shared), completed.TranscriptDocumentID.String) || strings.Contains(string(shared), originals[0].DocumentID) || !strings.Contains(string(shared), originals[1].DocumentID) {
			t.Fatalf("ready meeting leaked into Shared endpoint=%s status=%d body=%s", endpoint, status, shared)
		}
	}
	status, _, _ = env.request(alice, http.MethodGet, "/v0/document-versions/"+completed.TranscriptDocumentVersionID.String+"/content", nil, "")
	if status != http.StatusOK {
		t.Fatal("Meetings filtering revoked transcript access")
	}
	status, _, originalBody := env.request(alice, http.MethodGet, "/v0/document-versions/"+completed.SourceAudioDocumentVersionID.String+"/content", nil, "")
	if status != http.StatusOK || !bytes.Equal(originalBody, audio) {
		t.Fatal("Meetings filtering changed original recording bytes or recovery download access")
	}
	// The source recording remains Meetings-owned even when the official pair is
	// incomplete or the Capture moves through recovery and failure.
	if _, err = env.pool.Exec(ctx, `UPDATE capture_sessions SET transcript_document_id=NULL,transcript_document_version_id=NULL WHERE id=$1`, capture.ID); err != nil {
		t.Fatal(err)
	}
	for _, captureStatus := range []string{"finalized", "recovering", "failed"} {
		if captureStatus != "finalized" {
			if _, err = env.pool.Exec(ctx, `UPDATE capture_sessions SET status=$2,document_id=NULL,document_version_id=NULL WHERE id=$1`, capture.ID, captureStatus); err != nil {
				t.Fatal(err)
			}
		}
		for _, endpoint := range []string{"/v0/library/documents?view=shared&limit=100", "/v0/tenants/" + capture.TenantID + "/me/shared-document-tree"} {
			status, _, shared := env.request(alice, http.MethodGet, endpoint, nil, "")
			if status != http.StatusOK || !strings.Contains(string(shared), completed.TranscriptDocumentID.String) || strings.Contains(string(shared), originals[0].DocumentID) || !strings.Contains(string(shared), originals[1].DocumentID) {
				t.Fatalf("meeting source visibility status=%s endpoint=%s http=%d body=%s", captureStatus, endpoint, status, shared)
			}
		}
	}
}

// The recorder confirms the media clock seconds after Start and rewrites
// transcript_start_offset_ms to it. Speech spoken during that head belongs to
// the recording the user asked for and must reach the delivered transcript;
// speech from before the requested Start stays private.
func TestLiveKitCompletionKeepsSpeechDuringEgressStartupHead(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, _ := newVoiceServiceEnv(t, nil, starting(app.JobQueue))
	q := store.New(env.pool)
	ctx := t.Context()
	direct := requestDirectRoom(alice, env.server.URL, "actor_acme_official")
	if direct.err != nil || (direct.status != http.StatusCreated && direct.status != http.StatusOK) {
		t.Fatalf("direct Room status=%d err=%v", direct.status, direct.err)
	}
	hash := sha256.Sum256([]byte("egress-head"))
	voice, err := q.CreateVoiceSession(ctx, store.CreateVoiceSessionParams{ID: "voice_egress_head", AccountID: "account_alice", AuthSessionID: loginSessionOf(t, env, "account_alice"), RoomID: direct.roomID, ProviderRoomName: "egress-head", ParticipantIdentity: "egress-head", Purpose: "hardware_control"})
	if err != nil {
		t.Fatal(err)
	}
	// 2.7s measured recorder startup head between the request and the media clock.
	const requestedMS, mediaMS, stopMS int64 = 1000, 3700, 20000
	capture, err := q.CreateLiveKitCaptureSession(ctx, store.CreateLiveKitCaptureSessionParams{ID: "capture_egress_head", AccountID: "account_alice", RoomID: direct.roomID, VoiceSessionID: voice.ID, StartOffsetMs: requestedMS})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = q.TransitionLiveKitCaptureStatus(ctx, store.TransitionLiveKitCaptureStatusParams{ID: capture.ID, Status: "recording"}); err != nil {
		t.Fatal(err)
	}
	segments := []struct {
		id, text   string
		start, end int64
	}{
		{"before_request", "before-start-private", 200, 900},
		{"crosses_request", "crosses-start-private", 900, 1400},
		{"startup_head", "egress-head-kept", 1500, 3000},
		{"after_media", "after-media-kept", 5000, 6000},
	}
	for _, segment := range segments {
		if _, err = createCaptureSpeech(ctx, q, captureSpeech{ID: "head_" + segment.id, SessionID: capture.ID, AccountID: "account_alice", RoomID: direct.roomID, StartOffsetMs: segment.start, EndOffsetMs: segment.end, Text: segment.text, NormalizedText: segment.text, Kind: "speech"}); err != nil {
			t.Fatalf("insert %s segment: %v", segment.id, err)
		}
	}
	if _, err = q.AdvanceCaptureTranscriptCoverage(ctx, store.AdvanceCaptureTranscriptCoverageParams{SessionID: capture.ID, AccountID: "account_alice", RoomID: direct.roomID, StreamID: "head", Lane: "live", StartOffsetMs: mediaMS, EndOffsetMs: stopMS}); err != nil {
		t.Fatal(err)
	}
	audio := []byte("synthetic-media")
	digest := sha256.Sum256(audio)
	status, _, body := requestUnifiedDocumentMultipart(t, env, alice, "/v0/rooms/"+direct.roomID+"/documents/uploads", "head-audio", map[string]string{"filename": "source.m4a", "representation_format": "m4a", "media_type": "audio/mp4"}, "source.m4a", audio)
	if status != http.StatusCreated {
		t.Fatalf("audio upload status=%d", status)
	}
	var version uploadedDocumentRef
	decode(t, body, &version)
	if _, err = q.CreateCaptureMediaOutput(ctx, store.CreateCaptureMediaOutputParams{ID: "output_head", CaptureSessionID: capture.ID, Purpose: "final", RangeDigest: hex.EncodeToString(hash[:]), ObjectKey: "output_head", Filename: "source.m4a", DurationMs: stopMS - mediaMS, SizeBytes: int64(len(audio)), Sha256: hex.EncodeToString(digest[:])}); err != nil {
		t.Fatal(err)
	}
	if _, err = env.pool.Exec(ctx, "UPDATE capture_sessions SET document_id=$2,document_version_id=$3,transcript_start_offset_ms=$4,transcript_end_offset_ms=$5,status='finalized' WHERE id=$1", capture.ID, version.ID, version.CurrentVersion.ID, mediaMS, stopMS); err != nil {
		t.Fatal(err)
	}
	queueVoiceJob(t, env.pool, voicemedia.CaptureCompletionArgs{CaptureSessionID: capture.ID})
	var completed store.CaptureSession
	deadline := time.Now().Add(5 * time.Second)
	for {
		completed, err = q.GetCaptureSessionForAccount(ctx, store.GetCaptureSessionForAccountParams{ID: capture.ID, AccountID: textForVoiceTest("account_alice")})
		if err != nil {
			t.Fatal(err)
		}
		if completed.TranscriptDocumentVersionID.Valid {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("completion did not publish the transcript")
		}
		time.Sleep(20 * time.Millisecond)
	}
	status, _, transcript := env.request(alice, http.MethodGet, "/v0/document-versions/"+completed.TranscriptDocumentVersionID.String+"/content", nil, "")
	if status != http.StatusOK {
		t.Fatalf("transcript download status=%d", status)
	}
	for _, excluded := range []string{"before-start-private", "crosses-start-private"} {
		if strings.Contains(string(transcript), excluded) {
			t.Fatal("completion included speech from before the requested Start")
		}
	}
	if !strings.Contains(string(transcript), "egress-head-kept") {
		t.Fatal("completion dropped speech recorded during recorder startup")
	}
	if !strings.Contains(string(transcript), "after-media-kept") {
		t.Fatal("completion dropped speech inside the media window")
	}
}

// The delivered heading carries the generation time; boundary assertions compare
// the transcript body against the heading the file actually declares.
func captureTranscriptHeadingForTest(transcript string) string {
	_, rest, found := strings.Cut(transcript, "\n\n")
	if !found {
		return transcript
	}
	return transcript[:len(transcript)-len(rest)]
}
