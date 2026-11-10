package integration_test

import (
	"bytes"
	"context"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicetranscription"
)

func TestVoiceArchiveSplicePreservesGapSpeechAndBoundaries(t *testing.T) {
	serialIntegrationTest(t, serialSubprocess)
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg required")
	}
	env, q, capture, _ := newVoiceRecoveryLifecycle(t)
	ctx := t.Context()
	const origin = int64(5000)
	if _, err = env.pool.Exec(ctx, `UPDATE capture_sessions SET status='finalizing',
		transcript_start_offset_ms=$2,transcript_end_offset_ms=$3,transcript_integrity_lost=true WHERE id=$1`, capture.ID, origin, origin+3000); err != nil {
		t.Fatal(err)
	}
	for _, segment := range []captureSpeech{
		// Live speech the archive covers is replaced; live speech accepted
		// inside the media gap has no archived audio and stays.
		{ID: "splice_live_opening", Text: "Opening remarks", Kind: "speech", StartOffsetMs: origin + 100, EndOffsetMs: origin + 200},
		{ID: "splice_gap_speech", Text: "A sentence inside the gap", Kind: "speech", StartOffsetMs: origin + 1500, EndOffsetMs: origin + 1600},
	} {
		segment.SessionID, segment.RoomID, segment.AccountID, segment.NormalizedText = capture.ID, capture.RoomID, "account_alice", segment.Text
		if _, err = createCaptureSpeech(ctx, q, segment); err != nil {
			t.Fatal(err)
		}
	}
	for _, span := range []store.CreateCaptureMediaRangeParams{
		{ID: "splice_first", Kind: "media", StartOffsetMs: 0, EndOffsetMs: 1000},
		{ID: "splice_gap", Kind: "gap", StartOffsetMs: 1000, EndOffsetMs: 2000},
		{ID: "splice_second", Kind: "media", StartOffsetMs: 2000, EndOffsetMs: 3000},
	} {
		span.CaptureSessionID, span.Reason = capture.ID, "egress_restart"
		if _, err = q.CreateCaptureMediaRange(ctx, span); err != nil {
			t.Fatal(err)
		}
	}
	// The saved source concatenates two one-second media spans and omits the
	// wall-clock gap. Decode real audio before running the publishing transaction.
	input := filepath.Join(t.TempDir(), "source.m4a")
	if output, err := exec.CommandContext(ctx, ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=2", "-c:a", "aac", input).CombinedOutput(); err != nil {
		t.Fatalf("source fixture: %v %s", err, output)
	}
	audio, err := os.ReadFile(input)
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
	version, err := documents.CreateStoredRoomUploadTx(ctx, tx, document.StoredRoomUploadInput{AccountID: "account_alice", RoomID: capture.RoomID, CommandID: "splice-source", Filename: "source.m4a", RepresentationFormat: "m4a", MediaType: "audio/mp4", Object: object})
	if err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	digest := hex.EncodeToString(object.SHA256[:])
	if _, err = q.CreateCaptureMediaOutput(ctx, store.CreateCaptureMediaOutputParams{ID: "splice_source", CaptureSessionID: capture.ID, Purpose: "source", RangeDigest: digest, ObjectKey: object.Key, Filename: "source.m4a", DurationMs: 2000, SizeBytes: object.Size, Sha256: digest}); err != nil {
		t.Fatal(err)
	}
	if _, err = q.AttachVoiceSourceAudio(ctx, store.AttachVoiceSourceAudioParams{ID: capture.ID, SourceAudioDocumentID: textForVoiceTest(version.DocumentID), SourceAudioDocumentVersionID: textForVoiceTest(version.ID)}); err != nil {
		t.Fatal(err)
	}
	if _, err = q.QueueVoiceTranscriptRecovery(ctx, store.QueueVoiceTranscriptRecoveryParams{CaptureSessionID: capture.ID, SourceDurationMs: 2000}); err != nil {
		t.Fatal(err)
	}
	materializer, err := voicemedia.NewHLSMaterializer(env.pool, objects, voicemedia.NewLocalStagingStore(env.pool, t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	asr := &spliceArchiveTranscriber{t: t}
	service := voicemedia.NewWithDocuments(env.pool, nil, materializer, documents)
	service.SetArchiveTranscriber(asr, strings.TrimSpace)
	if _, err := service.RunJobStepForTest(ctx, voicemedia.TranscriptRecoveryArgs{CaptureSessionID: capture.ID}); err != nil {
		t.Fatalf("recovery publication: %v", err)
	}
	job, err := q.GetCaptureSessionForAccount(ctx, aliceCapture(capture.ID))
	if err != nil || job.TranscriptRecoveryStatus.String != "succeeded" || job.TranscriptRecoveryProgressMs != 2000 || asr.calls != 1 {
		t.Fatalf("source was not completely recovered: job=%+v calls=%d err=%v", job, asr.calls, err)
	}
	segments, err := q.ListCaptureTranscriptSegments(ctx, store.ListCaptureTranscriptSegmentsParams{CaptureSessionID: capture.ID, StartOffsetMs: origin, EndOffsetMs: origin + 3000})
	if err != nil || len(segments) != 4 {
		t.Fatalf("published segments: %+v err=%v", segments, err)
	}
	if segments[0].ID == "splice_live_opening" || segments[0].Text != "Opening remarks" || segments[0].Lane != "recovery" || segments[0].StartOffsetMs != origin+100 {
		t.Fatalf("archived opening did not replace live speech: %+v", segments[0])
	}
	if segments[1].Text != "The content of this task" || segments[1].StartOffsetMs != origin+200 || segments[1].EndOffsetMs != origin+1000 {
		t.Fatalf("pre-gap sentence end crossed the gap: %+v", segments[1])
	}
	if segments[2].ID != "splice_gap_speech" || segments[2].Lane == "recovery" || segments[2].StartOffsetMs != origin+1500 || segments[2].EndOffsetMs != origin+1600 {
		t.Fatalf("accepted gap speech was lost or moved after subsequent speech: %+v", segments[2])
	}
	if segments[3].Text != "The next sentence after the gap" || segments[3].StartOffsetMs != origin+2000 || segments[3].EndOffsetMs != origin+2500 {
		t.Fatalf("post-gap sentence moved into the gap: %+v", segments[3])
	}
}

type spliceArchiveTranscriber struct {
	t     *testing.T
	calls int
}

func (s *spliceArchiveTranscriber) TranscribeArchivePCM(_ context.Context, pcm []byte) ([]voicetranscription.StreamingResult, error) {
	s.t.Helper()
	s.calls++
	if len(pcm) != 2000*32 {
		s.t.Fatalf("expected complete two-second source PCM, got %d bytes", len(pcm))
	}
	return []voicetranscription.StreamingResult{
		{Text: "Opening remarks", StartMS: 100, EndMS: 200, Final: true},
		{Text: "The content of this task", StartMS: 200, EndMS: 1000, Final: true},
		{Text: "The next sentence after the gap", StartMS: 1000, EndMS: 1500, Final: true},
	}, nil
}
