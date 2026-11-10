package integration_test

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicetranscription"
)

func TestLiveKitArchiveRecoverySavesAudioAndRedoesStoppedRuns(t *testing.T) {
	serialIntegrationTest(t, serialSubprocess)
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg required")
	}
	env, alice, root := newHardwareVoiceCaptureEnvWithStorageAndLimitsAndConfig(t, 16<<20, 1<<30, nil)
	q := store.New(env.pool)
	roomID := env.createRoom(alice, acmeTenant, "Archive recovery", "archive-recovery")
	voice, err := q.CreateVoiceSession(t.Context(), store.CreateVoiceSessionParams{ID: "voice_archive", AccountID: "account_alice", AuthSessionID: loginSessionOf(t, env, "account_alice"), RoomID: roomID, ProviderRoomName: "voice-archive", ParticipantIdentity: "archive", Purpose: "hardware_control"})
	if err != nil {
		t.Fatal(err)
	}
	capture, err := q.CreateLiveKitCaptureSession(t.Context(), store.CreateLiveKitCaptureSessionParams{ID: "capture_archive", AccountID: "account_alice", RoomID: roomID, VoiceSessionID: voice.ID, StartOffsetMs: 1000})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = env.pool.Exec(t.Context(), "UPDATE capture_sessions SET status='finalizing' WHERE id=$1", capture.ID); err != nil {
		t.Fatal(err)
	}
	// Live ASR and the archived media do not share an exact zero point, so
	// recovery replaces accepted live speech with the archive's positions.
	for _, live := range []struct {
		id, text   string
		start, end int64
	}{
		{"accepted_archive_begin", "Getting started", 5500, 6500},
		{"accepted_archive_commit", "Wrapping up", 73100, 75100},
	} {
		if _, err = createCaptureSpeech(t.Context(), q, captureSpeech{
			ID: live.id, AccountID: "account_alice", RoomID: roomID, SessionID: capture.ID,
			StartOffsetMs: live.start, EndOffsetMs: live.end, Text: live.text, NormalizedText: live.text,
			Kind: "speech",
		}); err != nil {
			t.Fatal(err)
		}
	}
	for _, boundary := range []struct {
		kind   string
		offset int64
	}{{"track_started", 1000}, {"track_ended", 2000}, {"track_started", 3500}} {
		if err = q.RecordVoiceInputBoundary(t.Context(), store.RecordVoiceInputBoundaryParams{VoiceSessionID: voice.ID, Kind: boundary.kind, OffsetMs: boundary.offset}); err != nil {
			t.Fatal(err)
		}
	}
	assertInputGap := func() {
		t.Helper()
		var lost bool
		if err := env.pool.QueryRow(t.Context(), "SELECT transcript_integrity_lost FROM capture_sessions WHERE id=$1", capture.ID).Scan(&lost); err != nil || !lost {
			t.Fatalf("uncovered input was certified as complete: lost=%v err=%v", lost, err)
		}
	}
	assertInputGap()
	// An ASR consumer can end cleanly and never reconnect while the recorder keeps
	// recording. Its earlier flush must not certify the whole later recording.
	if _, err = env.pool.Exec(t.Context(), "UPDATE capture_sessions SET transcript_integrity_lost=false WHERE id=$1", capture.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = env.pool.Exec(t.Context(), "UPDATE voice_sessions SET created_at=clock_timestamp()-interval '90 seconds',last_input_ended_ms=4000 WHERE id=$1", voice.ID); err != nil {
		t.Fatal(err)
	}
	if err = q.MarkStoppedVoiceTranscriptGap(t.Context(), capture.ID); err != nil {
		t.Fatal(err)
	}
	assertInputGap()
	epoch, err := q.CreateVoiceMediaEpoch(t.Context(), store.CreateVoiceMediaEpochParams{ID: "epoch_archive", VoiceSessionID: voice.ID, CaptureSessionID: capture.ID, StagingPrefix: "voice-staging/capture_archive/epoch-0"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = q.SealVoiceMediaEpochAtBoundary(t.Context(), store.SealVoiceMediaEpochAtBoundaryParams{ID: epoch.ID, PlaylistObjectKey: textForVoiceTest(epoch.StagingPrefix + ".m3u8"), ArchivedThroughMs: pgtype.Int8{Int64: 90000, Valid: true}, FinalEndMs: pgtype.Int8{Int64: 90000, Valid: true}}); err != nil {
		t.Fatal(err)
	}
	if _, err = q.CreateCaptureMediaRange(t.Context(), store.CreateCaptureMediaRangeParams{ID: "archive_range", CaptureSessionID: capture.ID, EpochID: textForVoiceTest(epoch.ID), Kind: "media", StartOffsetMs: 0, EndOffsetMs: 90000, Reason: "test"}); err != nil {
		t.Fatal(err)
	}
	if _, err = q.CreateCaptureMediaRange(t.Context(), store.CreateCaptureMediaRangeParams{ID: "archive_tail_gap", CaptureSessionID: capture.ID, Kind: "gap", StartOffsetMs: 90000, EndOffsetMs: 95000, Reason: "stopped_before_recovery"}); err != nil {
		t.Fatal(err)
	}
	if _, err = createCaptureSpeech(t.Context(), q, captureSpeech{ID: "archive_tail_speech", AccountID: "account_alice", RoomID: roomID, SessionID: capture.ID, StartOffsetMs: 91500, EndOffsetMs: 92500, Text: "Keep the confirmed text in the tail gap", NormalizedText: "Keeptheconfirmedtextinthetailgap", Kind: "speech"}); err != nil {
		t.Fatal(err)
	}
	if err = q.RequestVoiceCaptureMaterialization(t.Context(), capture.ID); err != nil {
		t.Fatal(err)
	}
	input := filepath.Join(t.TempDir(), "archive.m4a")
	if output, err := exec.CommandContext(t.Context(), ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "90", "-c:a", "aac", input).CombinedOutput(); err != nil {
		t.Fatalf("fixture: %v %s", err, output)
	}
	objects, err := artifactstore.NewLocalStore(root, 16<<20)
	if err != nil {
		t.Fatal(err)
	}
	recorder := newVoiceRecorderRoom(t, env.pool)
	recorder.record(epoch.StagingPrefix, input, true)
	materializer, err := voicemedia.NewHLSMaterializer(env.pool, objects, recorder.staging)
	if err != nil {
		t.Fatal(err)
	}
	asr := &archiveRecoveryASR{}
	createService := func() *voicemedia.Service {
		s := voicemedia.NewWithDocuments(env.pool, nil, materializer, document.NewWithObjectStore(env.pool, objects))
		s.SetArchiveTranscriber(asr, strings.TrimSpace)
		return s
	}
	service := createService()
	if _, err := service.RunJobStepForTest(t.Context(), voicemedia.CaptureMaterializeArgs{CaptureSessionID: capture.ID}); err != nil {
		t.Fatalf("source save: %v", err)
	}
	requireVoiceJobQueued(t, env.pool, voicemedia.TranscriptRecoveryArgs{CaptureSessionID: capture.ID}, "queuing archive recovery")
	current, err := service.GetCapture(t.Context(), "account_alice", capture.ID)
	if err != nil || current.Status != "recovering" || current.SourceAudioDocumentVersionID == "" {
		t.Fatalf("source not accessible before ASR: %+v err=%v", current, err)
	}
	if _, err = q.CreateLiveKitCaptureSession(t.Context(), store.CreateLiveKitCaptureSessionParams{ID: "capture_after_archive", AccountID: "account_alice", RoomID: roomID, VoiceSessionID: voice.ID, StartOffsetMs: 100000}); err != nil {
		t.Fatalf("saved recording blocks new capture: %v", err)
	}
	if _, err := service.RunJobStepForTest(t.Context(), voicemedia.TranscriptRecoveryArgs{CaptureSessionID: capture.ID}); err == nil {
		t.Fatal("expected transient ASR failure after the first block")
	}
	checkpoint, err := q.GetCaptureSessionForAccount(t.Context(), store.GetCaptureSessionForAccountParams{ID: capture.ID, AccountID: textForVoiceTest("account_alice")})
	if err != nil || checkpoint.TranscriptRecoveryProgressMs <= 0 || checkpoint.TranscriptRecoveryStatus.String != "pending" {
		t.Fatalf("missing retry cursor: %+v err=%v", checkpoint, err)
	}
	if _, err = q.RetryVoiceTranscriptRecovery(t.Context(), store.RetryVoiceTranscriptRecoveryParams{CaptureSessionID: capture.ID, AccountID: "account_alice"}); err != nil {
		t.Fatal(err)
	}
	// A run that stopped mid-recovery leaves the recovery running; the next
	// run of the Capture's job takes it over and reads the source audio again
	// from its beginning.
	if _, err = q.ClaimVoiceTranscriptRecovery(t.Context(), capture.ID); err != nil {
		t.Fatal(err)
	}
	service = createService()
	if _, err := service.RunJobStepForTest(t.Context(), voicemedia.TranscriptRecoveryArgs{CaptureSessionID: capture.ID}); err != nil {
		t.Fatalf("resume recovery: %v", err)
	}
	requireVoiceJobQueued(t, env.pool, voicemedia.CaptureMaterializeArgs{CaptureSessionID: capture.ID}, "publishing the recovered transcript")
	if asr.calls != 5 {
		t.Fatalf("resumed recovery did not read the three source blocks again: calls=%d", asr.calls)
	}
	aligned, err := q.ListCaptureTranscriptSegments(t.Context(), store.ListCaptureTranscriptSegmentsParams{CaptureSessionID: capture.ID, StartOffsetMs: 0, EndOffsetMs: 1 << 62})
	if err != nil {
		t.Fatal(err)
	}
	var alignedBegin, endPhraseIsSpeech bool
	for _, segment := range aligned {
		if segment.ID == "accepted_archive_begin" || segment.ID == "accepted_archive_commit" {
			t.Fatalf("recovery kept live speech the archive replaced: %+v", segment)
		}
		if segment.Text == "Getting started" {
			alignedBegin = segment.StartOffsetMs == 2000 && segment.EndOffsetMs == 3000 && segment.Lane == "recovery" && segment.Kind == "speech"
		}
		if segment.Text == "End recording" {
			endPhraseIsSpeech = segment.Kind == "speech" && segment.Lane == "recovery"
		}
	}
	if !alignedBegin {
		t.Fatal("recovered speech was not placed on the archived audio timeline")
	}
	if !endPhraseIsSpeech {
		t.Fatal("a recovered former control phrase was not kept as plain speech")
	}
	if _, err = q.AdvanceVoiceTranscriptRecoveryProgress(t.Context(), store.AdvanceVoiceTranscriptRecoveryProgressParams{CaptureSessionID: capture.ID, StartOffsetMs: checkpoint.TranscriptRecoveryProgressMs, EndOffsetMs: 90000}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("a stopped run modified accepted recovery: %v", err)
	}
	if _, err := service.RunJobStepForTest(t.Context(), voicemedia.CaptureMaterializeArgs{CaptureSessionID: capture.ID}); err != nil {
		t.Fatalf("materialize recovered audio: %v", err)
	}
	requireVoiceJobQueued(t, env.pool, voicemedia.CaptureCompletionArgs{CaptureSessionID: capture.ID}, "finalizing the recording")
	row, err := q.GetCaptureSessionForAccount(t.Context(), store.GetCaptureSessionForAccountParams{ID: capture.ID, AccountID: textForVoiceTest("account_alice")})
	if err != nil || row.Status != "finalized" || !row.TranscriptRecoveredAt.Valid || !row.TranscriptIntegrityLost {
		t.Fatalf("recovery did not preserve history and finalize: %+v err=%v", row, err)
	}
	if !row.TranscriptEndOffsetMs.Valid || row.TranscriptEndOffsetMs.Int64 != 96000 {
		t.Fatalf("archive recovery dropped the disclosed tail gap: end=%+v", row.TranscriptEndOffsetMs)
	}
	visible, err := q.ListCaptureTranscriptSegments(t.Context(), store.ListCaptureTranscriptSegmentsParams{CaptureSessionID: capture.ID, StartOffsetMs: 1000, EndOffsetMs: row.TranscriptEndOffsetMs.Int64})
	if err != nil {
		t.Fatal(err)
	}
	foundTail := false
	for _, segment := range visible {
		if segment.ID == "archive_tail_speech" {
			foundTail = true
		}
	}
	if !foundTail {
		t.Fatal("final transcript cannot read the accepted tail-gap speech")
	}
	// Live ASR may have accepted speech while the recorder lost media. Archive ASR
	// has no audio for that gap, so replacing its text would lose known words.
	if _, err = q.CreateCaptureMediaRange(t.Context(), store.CreateCaptureMediaRangeParams{ID: "gap_text_range", CaptureSessionID: "capture_after_archive", Kind: "gap", StartOffsetMs: 0, EndOffsetMs: 5000, Reason: "egress_interrupted"}); err != nil {
		t.Fatal(err)
	}
	for index, start := range []int64{100000, 110000} {
		if _, err = createCaptureSpeech(t.Context(), q, captureSpeech{ID: fmt.Sprintf("gap_text_%d", index), AccountID: "account_alice", RoomID: roomID, SessionID: "capture_after_archive", StartOffsetMs: start, EndOffsetMs: start + 4000, Text: "Keep the confirmed text", NormalizedText: "Keeptheconfirmedtext", Kind: "speech"}); err != nil {
			t.Fatal(err)
		}
	}
	if err = q.SupersedeVoiceRecoverySpeech(t.Context(), store.SupersedeVoiceRecoverySpeechParams{CaptureSessionID: "capture_after_archive", PreservedIds: []string{}}); err != nil {
		t.Fatal(err)
	}
	retained, err := q.ListCaptureTranscriptSegments(t.Context(), store.ListCaptureTranscriptSegmentsParams{CaptureSessionID: "capture_after_archive", StartOffsetMs: 0, EndOffsetMs: 1 << 62})
	if err != nil || len(retained) != 1 || retained[0].ID != "gap_text_0" {
		t.Fatalf("archive recovery lost speech accepted during a media gap: count=%d err=%v", len(retained), err)
	}
	// Retire this Capture before the original one is retried below.
	if _, err = env.pool.Exec(t.Context(), "UPDATE capture_sessions SET status='failed' WHERE id='capture_after_archive'"); err != nil {
		t.Fatal(err)
	}
	// A retried recovery reads the source audio again from its beginning.
	if _, err = env.pool.Exec(t.Context(), "UPDATE capture_sessions SET status='recovering',transcript_recovered_at=NULL,document_id=NULL,document_version_id=NULL WHERE id=$1", capture.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = env.pool.Exec(t.Context(), "UPDATE capture_sessions SET transcript_recovery_status='failed' WHERE id=$1", capture.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := q.RetryVoiceTranscriptRecovery(t.Context(), store.RetryVoiceTranscriptRecoveryParams{CaptureSessionID: capture.ID, AccountID: "account_alice"}); err != nil {
		t.Fatalf("owner retry: %v", err)
	}
	if claimed, err := q.ClaimVoiceTranscriptRecovery(t.Context(), capture.ID); err != nil || claimed.TranscriptRecoveryProgressMs != 0 {
		t.Fatalf("a new run did not start at the source audio's beginning: progress=%d err=%v", claimed.TranscriptRecoveryProgressMs, err)
	}
}

type archiveRecoveryASR struct{ calls int }

func (a *archiveRecoveryASR) TranscribeArchivePCM(_ context.Context, pcm []byte) ([]voicetranscription.StreamingResult, error) {
	a.calls++
	if a.calls == 2 {
		return nil, voicetranscription.ErrProviderTimeout
	}
	if len(pcm) > 60*32000 {
		return nil, errors.New("unbounded recovery input")
	}
	segments := []voicetranscription.StreamingResult{{Text: fmt.Sprintf("Recovered content %d", a.calls), StartMS: 3000, EndMS: 8000, Final: true}}
	// Calls 1 and 3 read the first block; call 5 reads the last one.
	if a.calls == 1 || a.calls == 3 {
		segments = append([]voicetranscription.StreamingResult{{Text: "Getting started", StartMS: 1000, EndMS: 2000, Final: true}}, segments...)
	}
	if a.calls == 5 {
		segments = append(segments, voicetranscription.StreamingResult{Text: "Wrapping up", StartMS: 10000, EndMS: 12000, Final: true}, voicetranscription.StreamingResult{Text: "End recording", StartMS: 14000, EndMS: 16000, Final: true})
	}
	return segments, nil
}
