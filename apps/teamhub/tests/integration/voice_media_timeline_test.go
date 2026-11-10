package integration_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/livekit/protocol/livekit"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
	"google.golang.org/protobuf/proto"
)

func TestVoiceInitialMediaStartKeepsSpeechAudioAndTranscriptTail(t *testing.T) {
	serialIntegrationTest(t, serialSubprocess)
	for _, reconcile := range []bool{false, true} {
		t.Run(strconv.FormatBool(reconcile), func(t *testing.T) {
			ffmpeg, err := exec.LookPath("ffmpeg")
			if err != nil {
				t.Skip("ffmpeg required")
			}
			env, alice, root := newHardwareVoiceCaptureEnvWithStorageAndLimitsAndConfig(t, 16<<20, 1<<30, nil)
			q := store.New(env.pool)
			roomID := env.createRoom(alice, acmeTenant, "Actual media start", "actual-media-start")
			voice, err := q.CreateVoiceSession(t.Context(), store.CreateVoiceSessionParams{ID: "voice_actual_start", AccountID: "account_alice", AuthSessionID: loginSessionOf(t, env, "account_alice"), RoomID: roomID, ProviderRoomName: "actual-start", ParticipantIdentity: "publisher", Purpose: "hardware_control"})
			if err != nil {
				t.Fatal(err)
			}
			if _, err = env.pool.Exec(t.Context(), "UPDATE voice_sessions SET created_at=clock_timestamp()-interval '10 seconds' WHERE id=$1", voice.ID); err != nil {
				t.Fatal(err)
			}
			voice, err = q.GetVoiceSessionForAccount(t.Context(), store.GetVoiceSessionForAccountParams{ID: voice.ID, AccountID: "account_alice"})
			if err != nil {
				t.Fatal(err)
			}
			var startedAt time.Time
			objects, err := artifactstore.NewLocalStore(root, 16<<20)
			if err != nil {
				t.Fatal(err)
			}
			recorder := newVoiceRecorderRoom(t, env.pool)
			// The recorder's clock starts after the directive, not at the request.
			recorder.start = func(ctx context.Context, prefix string) {
				time.Sleep(100 * time.Millisecond)
				// Share PostgreSQL's clock so the start never precedes the
				// request under host/container clock skew.
				if err := env.pool.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&startedAt); err != nil {
					t.Error(err)
				}
				recorder.report(ctx, prefix, "active", startedAt, 0)
			}
			provider := recorder.provider(voicemedia.LiveKitConfig{}, env.pool)
			service := voicemedia.New(env.pool, provider, nil)
			var captureID string
			if reconcile {
				capture, err := q.CreateLiveKitCaptureSession(t.Context(), store.CreateLiveKitCaptureSessionParams{ID: "capture_initial_reconcile", AccountID: "account_alice", RoomID: roomID, VoiceSessionID: voice.ID, StartOffsetMs: time.Since(voice.CreatedAt.Time).Milliseconds()})
				if err != nil {
					t.Fatal(err)
				}
				captureID = capture.ID
				epoch, err := q.CreateVoiceMediaEpoch(t.Context(), store.CreateVoiceMediaEpochParams{ID: "epoch_initial_reconcile", VoiceSessionID: voice.ID, CaptureSessionID: captureID, StagingPrefix: "voice-staging/" + captureID + "/epoch-0"})
				if err != nil {
					t.Fatal(err)
				}
				// A recorder that already follows the epoch reports before
				// reconciliation observes it.
				recorder.start(t.Context(), epoch.StagingPrefix)
				if _, err = env.pool.Exec(t.Context(), "UPDATE voice_media_epochs SET updated_at=clock_timestamp()-interval '3 seconds' WHERE id=$1", epoch.ID); err != nil {
					t.Fatal(err)
				}
				if _, err := service.RunJobStepForTest(t.Context(), voicemedia.CaptureReconcileArgs{CaptureSessionID: epoch.CaptureSessionID}); err != nil {
					t.Fatalf("initial reconcile: %v", err)
				}
			} else {
				capture, err := service.BeginCapture(t.Context(), voicemedia.BeginCaptureRequest{AccountID: "account_alice", RoomID: roomID, VoiceSessionID: voice.ID})
				if err != nil {
					t.Fatal(err)
				}
				captureID = capture.ID
			}
			// These windows are derived from the observed audio start, independently
			// of the Capture timestamp and transcript base under test.
			base := startedAt.Sub(voice.CreatedAt.Time).Milliseconds()
			for _, segment := range []captureSpeech{
				{ID: "last_sentence", SessionID: captureID, AccountID: "account_alice", RoomID: roomID, StartOffsetMs: base + 1900, EndOffsetMs: base + 1980, Text: "The last sentence before saving", NormalizedText: "Thelastsentencebeforesaving", Kind: "speech"},
			} {
				if _, err = createCaptureSpeech(t.Context(), q, segment); err != nil {
					t.Fatal(err)
				}
			}
			epoch, err := q.GetLatestVoiceMediaEpochForCapture(t.Context(), captureID)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = q.TransitionLiveKitCaptureStatus(t.Context(), store.TransitionLiveKitCaptureStatusParams{ID: captureID, Status: "finalizing"}); err != nil {
				t.Fatal(err)
			}
			if _, err = q.SealVoiceMediaEpochAtBoundary(t.Context(), store.SealVoiceMediaEpochAtBoundaryParams{ID: epoch.ID, PlaylistObjectKey: textForVoiceTest(epoch.StagingPrefix + ".m3u8"), ArchivedThroughMs: pgtype.Int8{Int64: 2000, Valid: true}, FinalEndMs: pgtype.Int8{Int64: 2000, Valid: true}}); err != nil {
				t.Fatal(err)
			}
			if _, err = q.CreateCaptureMediaRange(t.Context(), store.CreateCaptureMediaRangeParams{ID: "actual_audio", CaptureSessionID: captureID, EpochID: textForVoiceTest(epoch.ID), Kind: "media", StartOffsetMs: 0, EndOffsetMs: 2000, Reason: "egress_archived"}); err != nil {
				t.Fatal(err)
			}
			if err = q.RecordVoiceInputBoundary(t.Context(), store.RecordVoiceInputBoundaryParams{VoiceSessionID: voice.ID, Kind: "track_ended", OffsetMs: base + 2000}); err != nil {
				t.Fatal(err)
			}
			if err = q.FreezeReadyVoiceTranscripts(t.Context()); err != nil {
				t.Fatal(err)
			}
			capture, err := q.GetCaptureSessionForAccount(t.Context(), store.GetCaptureSessionForAccountParams{ID: captureID, AccountID: textForVoiceTest("account_alice")})
			if err != nil {
				t.Fatal(err)
			}
			segments, err := q.ListCaptureTranscriptSegments(t.Context(), store.ListCaptureTranscriptSegmentsParams{CaptureSessionID: captureID, StartOffsetMs: capture.TranscriptStartOffsetMs.Int64, EndOffsetMs: capture.TranscriptEndOffsetMs.Int64})
			if err != nil {
				t.Fatal(err)
			}
			foundTail := false
			for _, segment := range segments {
				if segment.ID == "last_sentence" {
					foundTail = true
				}
			}
			if !foundTail {
				t.Errorf("Freeze omitted confirmed speech immediately before Stop: end=%d wanted=%d", capture.TranscriptEndOffsetMs.Int64, base+2000)
			}
			input := filepath.Join(t.TempDir(), "audio.m4a")
			if body, err := exec.CommandContext(t.Context(), ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2", "-c:a", "aac", input).CombinedOutput(); err != nil {
				t.Fatalf("audio fixture: %v %s", err, body)
			}
			recorder.record(epoch.StagingPrefix, input, true)
			materializer, err := voicemedia.NewHLSMaterializer(env.pool, objects, recorder.staging)
			if err != nil {
				t.Fatal(err)
			}
			output, err := voicemedia.New(env.pool, provider, materializer).Materialize(t.Context(), voicemedia.MaterializeRequest{AccountID: "account_alice", CaptureSessionID: captureID, FromMS: 0, ThroughMS: 2000, Purpose: "final"})
			if err != nil {
				t.Fatal(err)
			}
			// Without an in-media gap the published audio equals the source, but
			// each saved output owns its stored object.
			var outputs, objectKeys int
			if err = env.pool.QueryRow(t.Context(), `SELECT count(*), count(DISTINCT object_key)
				FROM capture_media_outputs WHERE capture_session_id=$1`, captureID).Scan(&outputs, &objectKeys); err != nil {
				t.Fatal(err)
			}
			if outputs != 2 || objectKeys != 2 {
				t.Fatalf("saved outputs = %d over %d objects, want source and final over two objects", outputs, objectKeys)
			}
			reader, err := objects.Open(t.Context(), output.ObjectKey)
			if err != nil {
				t.Fatal(err)
			}
			data, err := io.ReadAll(reader)
			err = errors.Join(err, reader.Close())
			if err != nil {
				t.Fatal(err)
			}
			result := filepath.Join(t.TempDir(), "result.m4a")
			if err = os.WriteFile(result, data, 0600); err != nil {
				t.Fatal(err)
			}
			before, after := voiceTimelineAudioPackets(t, input), voiceTimelineAudioPackets(t, result)
			for _, packet := range before {
				at, _ := strconv.ParseFloat(packet.Time, 64)
				present := false
				for _, saved := range after {
					if saved.Hash == packet.Hash {
						present = true
						break
					}
				}
				if at > 0.5 && at < 0.8 && !present {
					t.Error("published audio removed speech outside any media gap")
				}
			}
		})
	}
	t.Run("stop-before-initial-media", assertInitialStopBeforeMedia)
	t.Run("unknown-media-clock-and-normal-stop", assertInitialMediaClockAndNormalStop)

}

func assertInitialMediaClockAndNormalStop(t *testing.T) {
	env, q, capture, epoch := newVoiceRecoveryLifecycle(t)
	epoch, err := q.GetVoiceMediaEpoch(t.Context(), epoch.ID)
	if err != nil {
		t.Fatal(err)
	}
	requested := time.Now().Add(-11 * time.Second).Truncate(time.Microsecond)
	// Replay the measured 2167ms request/media lead and 245ms post-Stop media.
	mediaStart := requested.Add(2167 * time.Millisecond)
	stopAt := requested.Add(3922 * time.Millisecond)
	if _, err := env.pool.Exec(t.Context(), "UPDATE capture_sessions SET status='starting',created_at=$2,transcript_start_offset_ms=1000 WHERE id=$1", capture.ID, requested); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), "UPDATE voice_sessions SET created_at=$2 WHERE id=$1", capture.VoiceSessionID.String, requested.Add(-time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), "UPDATE voice_media_epochs SET observed_state='requested',first_archived_ms=NULL,archived_through_ms=NULL WHERE id=$1", epoch.ID); err != nil {
		t.Fatal(err)
	}
	recorder := newVoiceRecorderRoom(t, env.pool)
	recorder.direct("recovery-tx", epoch.StagingPrefix)
	provider := recorder.provider(voicemedia.LiveKitConfig{}, env.pool)
	service := voicemedia.New(env.pool, provider, nil)
	reconcile := func() {
		t.Helper()
		if _, err := env.pool.Exec(t.Context(), "UPDATE voice_media_epochs SET updated_at=clock_timestamp()-interval '3 seconds' WHERE id=$1", epoch.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := service.RunJobStepForTest(t.Context(), voicemedia.CaptureReconcileArgs{CaptureSessionID: capture.ID}); err != nil {
			t.Fatalf("media clock reconciliation: %v", err)
		}
	}
	reconcile()
	pending, err := q.GetVoiceMediaEpoch(t.Context(), epoch.ID)
	if err != nil {
		t.Fatal(err)
	}
	if pending.FirstArchivedMs.Valid {
		t.Error("an unreported recorder permanently confirmed the request clock")
	}
	recorder.report(t.Context(), epoch.StagingPrefix, "active", mediaStart, 0)
	reconcile()
	reconcile()
	confirmed, err := q.GetCaptureSessionForAccount(t.Context(), store.GetCaptureSessionForAccountParams{ID: capture.ID, AccountID: textForVoiceTest("account_alice")})
	if err != nil {
		t.Fatal(err)
	}
	if !confirmed.CreatedAt.Time.Equal(mediaStart) {
		t.Errorf("recording base=%v want actual media=%v", confirmed.CreatedAt.Time, mediaStart)
	}
	if _, err := service.EndCapture(t.Context(), voicemedia.EndCaptureRequest{AccountID: "account_alice", CaptureSessionID: capture.ID}); err != nil {
		t.Fatal(err)
	}
	requireVoiceJobQueued(t, env.pool, voicemedia.CaptureStopArgs{CaptureSessionID: capture.ID}, "Stop")
	requireVoiceJobQueued(t, env.pool, voicemedia.CaptureReconcileArgs{CaptureSessionID: capture.ID}, "Stop")
	if _, err := env.pool.Exec(t.Context(), "UPDATE capture_sessions SET stop_requested_at=$2 WHERE id=$1", capture.ID, stopAt); err != nil {
		t.Fatal(err)
	}
	recorder.report(t.Context(), epoch.StagingPrefix, "available", mediaStart, 2000)
	reconcile()
	requireVoiceJobQueued(t, env.pool, voicemedia.CaptureMaterializeArgs{CaptureSessionID: capture.ID}, "completing the stop")
	gaps, err := q.GetCaptureGapSummary(t.Context(), capture.ID)
	if err != nil || gaps.GapCount != 0 {
		t.Errorf("healthy Stop acquired the measured false 922ms gap: %+v err=%v", gaps, err)
	}
	sealed, err := q.GetVoiceMediaEpoch(t.Context(), epoch.ID)
	if err != nil || sealed.ArchivedThroughMs.Int64 != 2000 || sealed.FinalEndMs.Int64 != 1755 {
		t.Errorf("Stop must clamp the recorded media clock: %+v err=%v", sealed, err)
	}
}

func assertInitialStopBeforeMedia(t *testing.T) {
	env, alice, _ := newHardwareVoiceCaptureEnvWithStorageAndLimitsAndConfig(t, 1<<20, 1<<30, nil)
	q := store.New(env.pool)
	roomID := env.createRoom(alice, acmeTenant, "Stop before media", "stop-before-media")
	voice, err := q.CreateVoiceSession(t.Context(), store.CreateVoiceSessionParams{ID: "voice_stop_before_media", AccountID: "account_alice", AuthSessionID: loginSessionOf(t, env, "account_alice"), RoomID: roomID, ProviderRoomName: "stop-before-media", ParticipantIdentity: "publisher", Purpose: "hardware_control"})
	if err != nil {
		t.Fatal(err)
	}
	entered, release := make(chan struct{}), make(chan time.Time)
	defer close(release)
	var deleted atomic.Bool
	recorder := newVoiceRecorderRoom(t, env.pool)
	recorder.start = func(ctx context.Context, prefix string) {
		close(entered)
		start, ok := <-release
		if !ok {
			return
		}
		recorder.report(ctx, prefix, "active", start, 0)
	}
	recorder.handle = func(path string, _ []byte) proto.Message {
		if strings.HasSuffix(path, "/DeleteRoom") {
			deleted.Store(true)
			return &livekit.DeleteRoomResponse{}
		}
		return nil
	}
	provider := recorder.provider(voicemedia.LiveKitConfig{}, env.pool)
	service := voicemedia.New(env.pool, provider, nil)
	type started struct {
		capture voicemedia.Capture
		err     error
	}
	finished := make(chan started, 1)
	go func() {
		capture, err := service.BeginCapture(t.Context(), voicemedia.BeginCaptureRequest{AccountID: "account_alice", RoomID: roomID, VoiceSessionID: voice.ID})
		finished <- started{capture, err}
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("initial Start did not enter")
	}
	capture, err := q.GetActiveLiveKitCaptureForVoiceSession(t.Context(), textForVoiceTest(voice.ID))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.EndCapture(t.Context(), voicemedia.EndCaptureRequest{AccountID: "account_alice", CaptureSessionID: capture.ID}); err != nil {
		t.Fatal(err)
	}
	stop, err := q.GetCaptureSessionForAccount(t.Context(), aliceCapture(capture.ID))
	if err != nil {
		t.Fatal(err)
	}
	// Use the committed database clock after the Stop barrier, not the host
	// clock: Docker's PostgreSQL clock may be ahead during the full suite.
	release <- stop.StopRequestedAt.Time.Add(time.Microsecond)
	result := <-finished
	if result.err != nil || result.capture.Status != "failed" || result.capture.LastFailureCode != "stopped_before_media" {
		t.Fatalf("initial late Start captured after Stop: %+v %v", result.capture, result.err)
	}
	ranges, err := q.ListCaptureMediaRangesForCapture(t.Context(), capture.ID)
	if err != nil || len(ranges) != 0 {
		t.Fatalf("pre-start Stop fabricated recording media: %+v %v", ranges, err)
	}
	if _, err = env.pool.Exec(t.Context(), "UPDATE voice_sessions SET updated_at=clock_timestamp()-interval '10 seconds' WHERE id=$1", voice.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.RunJobStepForTest(t.Context(), voicemedia.VoiceSessionReconcileArgs{VoiceSessionID: voice.ID}); err != nil || !deleted.Load() {
		t.Fatalf("late initial publisher was not durably revoked: deleted=%v err=%v", deleted.Load(), err)
	}
}

type voiceTimelinePacket struct {
	Time string `json:"pts_time"`
	Hash string `json:"data_hash"`
}

func voiceTimelineAudioPackets(t *testing.T, file string) []voiceTimelinePacket {
	t.Helper()
	body, err := exec.CommandContext(t.Context(), "ffprobe", "-v", "error", "-select_streams", "a:0", "-show_packets", "-show_data_hash", "sha256", "-show_entries", "packet=pts_time,data_hash", "-of", "json", file).Output()
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Packets []voiceTimelinePacket `json:"packets"`
	}
	if err = json.Unmarshal(body, &result); err != nil {
		t.Fatal(err)
	}
	return result.Packets
}
