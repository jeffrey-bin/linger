package integration_test

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicetranscription"
)

func TestVoiceObservationKeepsAttemptCoverageAndIdempotentUncertainty(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, _ := newVoiceServiceEnv(t, func(cfg *config.Config) { cfg.Voice.RuntimeToken = "voice-test-service-token" })
	ctx := t.Context()
	q := store.New(env.pool)
	roomID := env.createRoom(alice, acmeTenant, "Voice coverage", "voice-coverage")
	voice, err := q.CreateVoiceSession(ctx, store.CreateVoiceSessionParams{ID: "voice_coverage", AccountID: "account_alice", AuthSessionID: loginSessionOf(t, env, "account_alice"), RoomID: roomID, ProviderRoomName: "voice-coverage", ParticipantIdentity: "publisher", Purpose: "hardware_control"})
	if err != nil {
		t.Fatal(err)
	}
	capture, err := q.CreateLiveKitCaptureSession(ctx, store.CreateLiveKitCaptureSessionParams{ID: "capture_coverage", AccountID: "account_alice", RoomID: roomID, VoiceSessionID: voice.ID, StartOffsetMs: 1000})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = env.pool.Exec(ctx, "UPDATE capture_sessions SET status='recording' WHERE id=$1", capture.ID); err != nil {
		t.Fatal(err)
	}
	for _, event := range []struct {
		id, kind   string
		epoch      int
		start, end int64
	}{
		{"first", "progress", 0, 500, 2000},
		{"next", "progress", 1, 3000, 4000},
		{"gap", "input_gap", 1, 2000, 3000},
		{"gap", "input_gap", 1, 2000, 3000},
		// Old runtimes sent a point for track_ended; keep the stored start.
		{"ended", "track_ended", 1, 4000, 4000},
	} {
		payload := map[string]any{"event_id": event.id, "kind": event.kind, "voice_session_id": voice.ID, "media_epoch": event.epoch, "lane": "live", "start_offset_ms": event.start, "end_offset_ms": event.end}
		if event.kind == "progress" {
			payload["committed_through_ms"] = event.end
		}
		body, _ := json.Marshal(payload)
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, env.server.URL+"/internal/v1/voice/observations", bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Authorization", "Bearer voice-test-service-token")
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		if closeErr := response.Body.Close(); closeErr != nil {
			t.Fatal(closeErr)
		}
		if response.StatusCode != http.StatusAccepted {
			t.Fatalf("%s status=%d", event.kind, response.StatusCode)
		}
	}
	coverage, err := q.ListVoiceRecoveryCoverage(ctx, capture.ID)
	if err != nil || len(coverage) != 2 || coverage[0].StartOffsetMs != 1000 || coverage[0].EndOffsetMs != 2000 || coverage[1].StartOffsetMs != 3000 || coverage[1].EndOffsetMs != 4000 {
		t.Fatalf("gap overwritten: %+v %v", coverage, err)
	}
	uncertain, err := q.ListVoiceTranscriptUncertainties(ctx, capture.ID)
	if err != nil || len(uncertain) != 1 || uncertain[0].StartOffsetMs != 2000 || uncertain[0].EndOffsetMs != 3000 {
		t.Fatalf("non-idempotent evidence: %+v %v", uncertain, err)
	}
}

type targetedRecoveryASR func(context.Context, []byte) ([]voicetranscription.StreamingResult, error)

func (f targetedRecoveryASR) TranscribeArchivePCM(ctx context.Context, pcm []byte) ([]voicetranscription.StreamingResult, error) {
	return f(ctx, pcm)
}

// A run reads only the planned intervals; after an outage the next run reads
// them again from the first one.
func TestVoiceTargetedRecoveryRetriesPlannedIntervals(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, q, capture, service := newTargetedRecoveryFixture(t, 120_000)
	ctx := t.Context()
	if _, err := env.pool.Exec(ctx, "INSERT INTO capture_transcript_coverage(session_id,stream_id,lane,start_offset_ms,end_offset_ms) VALUES($1,'live','live',5000,125000)", capture.ID); err != nil {
		t.Fatal(err)
	}
	for i, start := range []int64{25000, 85000} {
		if err := q.RecordVoiceTranscriptUncertainty(ctx, store.RecordVoiceTranscriptUncertaintyParams{CaptureSessionID: capture.ID, EventID: fmt.Sprint(i), StartOffsetMs: start, EndOffsetMs: start + 1000}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := q.QueueVoiceTranscriptRecovery(ctx, store.QueueVoiceTranscriptRecoveryParams{CaptureSessionID: capture.ID, SourceDurationMs: 120000}); err != nil {
		t.Fatal(err)
	}
	calls := 0
	service.SetArchiveTranscriber(targetedRecoveryASR(func(_ context.Context, pcm []byte) ([]voicetranscription.StreamingResult, error) {
		calls++
		if len(pcm) != 7000*32 {
			t.Fatalf("transcribed verified interval: %d", len(pcm))
		}
		if calls == 2 {
			return nil, voicetranscription.ErrProviderTimeout
		}
		return []voicetranscription.StreamingResult{{Text: fmt.Sprintf("repair%d", calls), StartMS: 3000, EndMS: 4000, Final: true}}, nil
	}), strings.TrimSpace)
	if _, err := service.RunJobStepForTest(ctx, voicemedia.TranscriptRecoveryArgs{CaptureSessionID: capture.ID}); err == nil {
		t.Fatal("missing injected outage", err)
	}
	job, err := q.GetCaptureSessionForAccount(ctx, aliceCapture(capture.ID))
	if err != nil || job.TranscriptRecoveryProgressMs != 78000 || job.TranscriptRecoveryStatus.String != "pending" {
		t.Fatalf("invalid resume cursor: %+v %v", job, err)
	}
	if _, err = q.RetryVoiceTranscriptRecovery(ctx, store.RetryVoiceTranscriptRecoveryParams{CaptureSessionID: capture.ID, AccountID: "account_alice"}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.RunJobStepForTest(ctx, voicemedia.TranscriptRecoveryArgs{CaptureSessionID: capture.ID}); err != nil {
		t.Fatal("resume", err)
	}
	job, err = q.GetCaptureSessionForAccount(ctx, aliceCapture(capture.ID))
	if err != nil || job.TranscriptRecoveryStatus.String != "succeeded" || job.TranscriptRecoveryProgressMs != 120000 || calls != 4 {
		t.Fatalf("retry did not read both planned intervals again: %+v calls=%d %v", job, calls, err)
	}
}

func TestVoiceUnsafeLocalizedBoundaryFallsBackToFullRecovery(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, q, capture, service := newTargetedRecoveryFixture(t, 60_000)
	ctx := t.Context()
	if _, err := env.pool.Exec(ctx, "INSERT INTO capture_transcript_coverage(session_id,stream_id,lane,start_offset_ms,end_offset_ms) VALUES($1,'live','live',5000,65000)", capture.ID); err != nil {
		t.Fatal(err)
	}
	if err := q.RecordVoiceTranscriptUncertainty(ctx, store.RecordVoiceTranscriptUncertaintyParams{CaptureSessionID: capture.ID, EventID: "local", StartOffsetMs: 35000, EndOffsetMs: 36000}); err != nil {
		t.Fatal(err)
	}
	if _, err := q.QueueVoiceTranscriptRecovery(ctx, store.QueueVoiceTranscriptRecoveryParams{CaptureSessionID: capture.ID, SourceDurationMs: 60000}); err != nil {
		t.Fatal(err)
	}
	calls := 0
	service.SetArchiveTranscriber(targetedRecoveryASR(func(_ context.Context, pcm []byte) ([]voicetranscription.StreamingResult, error) {
		calls++
		if calls == 1 {
			return []voicetranscription.StreamingResult{{Text: "untimed crossing", StartMS: 1000, EndMS: 3000, Final: true}}, nil
		}
		return []voicetranscription.StreamingResult{{Text: fmt.Sprintf("full%d", calls), StartMS: 3000, EndMS: 4000, Final: true}}, nil
	}), strings.TrimSpace)
	if _, err := service.RunJobStepForTest(ctx, voicemedia.TranscriptRecoveryArgs{CaptureSessionID: capture.ID}); err != nil {
		t.Fatal("fallback", err)
	}
	job, err := q.GetCaptureSessionForAccount(ctx, aliceCapture(capture.ID))
	// The failed targeted call and the two blocks of the whole archive.
	if err != nil || calls != 3 || job.TranscriptRecoveryStatus.String != "succeeded" || job.TranscriptRecoveryProgressMs != 60000 {
		t.Fatalf("fallback did not replace partial plan: %+v calls=%d %v", job, calls, err)
	}
	rows, err := q.ListCaptureTranscriptSegments(ctx, store.ListCaptureTranscriptSegmentsParams{CaptureSessionID: capture.ID, EndOffsetMs: 1 << 62})
	if err != nil || len(rows) != 2 {
		t.Fatal(rows, err)
	}
	for _, row := range rows {
		if row.Text == "untimed crossing" {
			t.Fatal("unsafe partial transcript published")
		}
	}
}

func newTargetedRecoveryFixture(t *testing.T, total int64) (*testEnv, *store.Queries, store.CaptureSession, *voicemedia.Service) {
	t.Helper()
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg required")
	}
	env, q, capture, _ := newVoiceRecoveryLifecycle(t)
	ctx := t.Context()
	if _, err = env.pool.Exec(ctx, "UPDATE capture_sessions SET status='finalizing',transcript_start_offset_ms=5000 WHERE id=$1", capture.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = q.CreateCaptureMediaRange(ctx, store.CreateCaptureMediaRangeParams{ID: "targeted_media", CaptureSessionID: capture.ID, Kind: "media", EndOffsetMs: total, Reason: "test"}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "source.m4a")
	if output, err := exec.CommandContext(ctx, ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", fmt.Sprint(total/1000), "-c:a", "aac", path).CombinedOutput(); err != nil {
		t.Fatalf("audio: %v %s", err, output)
	}
	audio, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	objects, err := artifactstore.NewLocalStore(t.TempDir(), 1<<20)
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
	version, err := documents.CreateStoredRoomUploadTx(ctx, tx, document.StoredRoomUploadInput{AccountID: "account_alice", RoomID: capture.RoomID, CommandID: "targeted-source", Filename: "source.m4a", RepresentationFormat: "m4a", MediaType: "audio/mp4", Object: object})
	if err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	digest := hex.EncodeToString(object.SHA256[:])
	if _, err = q.CreateCaptureMediaOutput(ctx, store.CreateCaptureMediaOutputParams{ID: "targeted_source", CaptureSessionID: capture.ID, Purpose: "source", RangeDigest: digest, ObjectKey: object.Key, Filename: "source.m4a", DurationMs: total, SizeBytes: object.Size, Sha256: digest}); err != nil {
		t.Fatal(err)
	}
	if _, err = q.AttachVoiceSourceAudio(ctx, store.AttachVoiceSourceAudioParams{ID: capture.ID, SourceAudioDocumentID: textForVoiceTest(version.DocumentID), SourceAudioDocumentVersionID: textForVoiceTest(version.ID)}); err != nil {
		t.Fatal(err)
	}
	materializer, err := voicemedia.NewHLSMaterializer(env.pool, objects, voicemedia.NewLocalStagingStore(env.pool, t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	return env, q, capture, voicemedia.NewWithDocuments(env.pool, nil, materializer, documents)
}

func TestVoiceTargetedRecoveryPreservesUntouchedLiveTranscript(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, q, capture, service := newTargetedRecoveryFixture(t, 60_000)
	ctx := t.Context()
	// Source clock: 0-30s and 31-60s are verified; only one second is missing.
	for i, span := range [][2]int64{{5000, 35000}, {36000, 65000}} {
		if _, err := env.pool.Exec(ctx, "INSERT INTO capture_transcript_coverage(session_id,stream_id,lane,start_offset_ms,end_offset_ms) VALUES($1,$2,'live',$3,$4)", capture.ID, fmt.Sprint(i), span[0], span[1]); err != nil {
			t.Fatal(err)
		}
	}
	for _, row := range []captureSpeech{
		{ID: "good_first", StartOffsetMs: 6000, EndOffsetMs: 7000, Text: "first", Kind: "speech"},
		{ID: "uncertain", StartOffsetMs: 34000, EndOffsetMs: 36000, Text: "old", Kind: "speech"},
		{ID: "good_last", StartOffsetMs: 55000, EndOffsetMs: 56000, Text: "last", Kind: "speech"},
		{ID: "keep_middle", StartOffsetMs: 50000, EndOffsetMs: 51000, Text: "middle", Kind: "speech"},
	} {
		row.SessionID, row.AccountID, row.RoomID, row.NormalizedText = capture.ID, "account_alice", capture.RoomID, row.Text
		if _, err := createCaptureSpeech(ctx, q, row); err != nil {
			t.Fatal(err)
		}
	}
	if err := q.RecordVoiceTranscriptUncertainty(ctx, store.RecordVoiceTranscriptUncertaintyParams{CaptureSessionID: capture.ID, EventID: "lost_audio", StartOffsetMs: 35000, EndOffsetMs: 36000}); err != nil {
		t.Fatal(err)
	}
	if _, err := q.QueueVoiceTranscriptRecovery(ctx, store.QueueVoiceTranscriptRecoveryParams{CaptureSessionID: capture.ID, SourceDurationMs: 60000}); err != nil {
		t.Fatal(err)
	}
	calls := 0
	service.SetArchiveTranscriber(targetedRecoveryASR(func(_ context.Context, pcm []byte) ([]voicetranscription.StreamingResult, error) {
		calls++
		if len(pcm) != 7000*32 {
			t.Fatalf("expected 5s repair + 2s context, received %d bytes", len(pcm))
		}
		return []voicetranscription.StreamingResult{{Text: "context", StartMS: 100, EndMS: 500, Final: true}, {Text: "repaired", StartMS: 3000, EndMS: 4000, Final: true}}, nil
	}), strings.TrimSpace)
	if _, err := service.RunJobStepForTest(ctx, voicemedia.TranscriptRecoveryArgs{CaptureSessionID: capture.ID}); err != nil {
		t.Fatalf("recovery: %v", err)
	}
	rows, err := q.ListCaptureTranscriptSegments(ctx, store.ListCaptureTranscriptSegmentsParams{CaptureSessionID: capture.ID, EndOffsetMs: 1 << 62})
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]store.VoiceTranscriptSegment{}
	for _, row := range rows {
		got[row.ID] = row
	}
	if len(rows) != 4 || got["good_first"].Text != "first" || got["good_last"].Text != "last" || got["keep_middle"].Lane == "recovery" || got["keep_middle"].Text != "middle" {
		t.Fatalf("changed confirmed transcript: %+v", rows)
	}
	if _, exists := got["uncertain"]; exists {
		t.Fatal("unverified text retained in repair interval")
	}
	if rows[1].Text != "repaired" || rows[1].StartOffsetMs != 34000 || rows[1].Lane != "recovery" {
		t.Fatalf("repair alignment: %+v", rows[1])
	}
	job, err := q.GetCaptureSessionForAccount(ctx, aliceCapture(capture.ID))
	if err != nil || job.TranscriptRecoveryStatus.String != "succeeded" || job.TranscriptRecoveryProgressMs != 60000 || calls != 1 {
		t.Fatalf("job=%+v calls=%d err=%v", job, calls, err)
	}
	uncertain, err := q.ListVoiceTranscriptUncertainties(ctx, capture.ID)
	if err != nil || len(uncertain) != 1 || !uncertain[0].RecoveredAt.Valid {
		t.Fatal("uncertainty not resolved atomically", err)
	}
}

func TestVoiceRecoverySpliceFailureFailsUntilRetried(t *testing.T) {
	allowParallelIntegrationTest(t)
	_, q, capture, service := newTargetedRecoveryFixture(t, 90_000)
	ctx := t.Context()
	if _, err := q.QueueVoiceTranscriptRecovery(ctx, store.QueueVoiceTranscriptRecoveryParams{CaptureSessionID: capture.ID, SourceDurationMs: 90000}); err != nil {
		t.Fatal(err)
	}
	calls := 0
	broken := true
	service.SetArchiveTranscriber(targetedRecoveryASR(func(_ context.Context, _ []byte) ([]voicetranscription.StreamingResult, error) {
		calls++
		if broken {
			if calls == 1 {
				return []voicetranscription.StreamingResult{{Text: "left", StartMS: 29000, EndMS: 30300, Final: true}}, nil
			}
			if calls == 2 {
				return []voicetranscription.StreamingResult{{Text: "incompatible", StartMS: 0, EndMS: 3000, Final: true}}, nil
			}
			return nil, voicetranscription.ErrInvalidProviderResponse
		}
		return []voicetranscription.StreamingResult{{Text: fmt.Sprintf("tail%d", calls), StartMS: 3000, EndMS: 4000, Final: true}}, nil
	}), strings.TrimSpace)
	if _, err := service.RunJobStepForTest(ctx, voicemedia.TranscriptRecoveryArgs{CaptureSessionID: capture.ID}); err == nil {
		t.Fatalf("expected failed splice: %v", err)
	}
	job, err := q.GetCaptureSessionForAccount(ctx, aliceCapture(capture.ID))
	if err != nil || job.TranscriptRecoveryProgressMs != 30300 || job.TranscriptRecoveryStatus.String != "failed" {
		t.Fatalf("poison advanced cursor: %+v %v", job, err)
	}
	broken = false
	if _, err = q.RetryVoiceTranscriptRecovery(ctx, store.RetryVoiceTranscriptRecoveryParams{CaptureSessionID: capture.ID, AccountID: "account_alice"}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.RunJobStepForTest(ctx, voicemedia.TranscriptRecoveryArgs{CaptureSessionID: capture.ID}); err != nil {
		t.Fatalf("retried recovery: %v", err)
	}
	job, err = q.GetCaptureSessionForAccount(ctx, aliceCapture(capture.ID))
	if err != nil || job.TranscriptRecoveryStatus.String != "succeeded" || job.TranscriptRecoveryProgressMs != 90000 {
		t.Fatalf("did not converge: %+v %v", job, err)
	}
}
