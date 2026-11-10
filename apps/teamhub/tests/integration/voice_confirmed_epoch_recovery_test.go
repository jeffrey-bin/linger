package integration_test

import (
	"context"
	"errors"
	"io"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
)

func TestVoiceConfirmedEmptyEpochPreservesRecordedPrefix(t *testing.T) {
	allowParallelIntegrationTest(t)
	for _, stopRequested := range []bool{false, true} {
		t.Run(strconv.FormatBool(stopRequested), func(t *testing.T) {
			env, q, capture, previous := newVoiceRecoveryLifecycle(t)
			if _, err := q.SealVoiceMediaEpoch(t.Context(), store.SealVoiceMediaEpochParams{ID: previous.ID, PlaylistObjectKey: textForVoiceTest(previous.StagingPrefix + ".m3u8"), ArchivedThroughMs: pgtype.Int8{Int64: 10000, Valid: true}}); err != nil {
				t.Fatal(err)
			}
			if _, err := q.CreateCaptureMediaRange(t.Context(), store.CreateCaptureMediaRangeParams{ID: "retained_prefix", CaptureSessionID: capture.ID, EpochID: textForVoiceTest(previous.ID), Kind: "media", StartOffsetMs: 0, EndOffsetMs: 10000, Reason: "egress_archived"}); err != nil {
				t.Fatal(err)
			}
			epoch, err := q.CreateVoiceMediaEpoch(t.Context(), store.CreateVoiceMediaEpochParams{ID: "confirmed_empty", VoiceSessionID: capture.VoiceSessionID.String, CaptureSessionID: capture.ID, EpochIndex: 1, StagingPrefix: "voice-staging/" + capture.ID + "/epoch-1"})
			if err != nil {
				t.Fatal(err)
			}
			epoch, err = q.ActivateVoiceMediaEpoch(t.Context(), store.ActivateVoiceMediaEpochParams{ID: epoch.ID, ProviderEgressID: textForVoiceTest("voice-staging/" + capture.ID + "/epoch-1"), FirstArchivedMs: pgtype.Int8{Int64: 15000, Valid: true}})
			if err != nil {
				t.Fatal(err)
			}
			if !epoch.FirstArchivedMs.Valid {
				t.Fatal("test did not commit ACTIVE before failure")
			}
			if _, err = q.CreateCaptureMediaRange(t.Context(), store.CreateCaptureMediaRangeParams{ID: "leading_gap", CaptureSessionID: capture.ID, Kind: "gap", StartOffsetMs: 10000, EndOffsetMs: 15000, Reason: "egress_restart"}); err != nil {
				t.Fatal(err)
			}
			var starts atomic.Int32
			recorder := confirmedTerminalRecorder(t, env, &starts)
			recorder.report(t.Context(), epoch.StagingPrefix, "failed", time.Time{}, 0)
			provider := recorder.provider(voicemedia.LiveKitConfig{}, env.pool)
			service := voicemedia.New(env.pool, provider, failedRecoveryMediaInspector{})
			if stopRequested {
				if _, err = service.EndCapture(t.Context(), voicemedia.EndCaptureRequest{AccountID: "account_alice", CaptureSessionID: capture.ID}); err != nil {
					t.Fatal(err)
				}
			}
			for range 2 {
				if _, err = env.pool.Exec(t.Context(), "UPDATE voice_media_epochs SET updated_at=clock_timestamp()-interval '3 seconds'"); err != nil {
					t.Fatal(err)
				}
				if _, err = service.RunJobStepForTest(t.Context(), voicemedia.CaptureReconcileArgs{CaptureSessionID: capture.ID}); err != nil {
					t.Fatal(err)
				}
			}
			current, err := q.GetCaptureSessionForAccount(t.Context(), store.GetCaptureSessionForAccountParams{ID: capture.ID, AccountID: textForVoiceTest("account_alice")})
			if err != nil {
				t.Fatal(err)
			}
			if current.Status == "failed" {
				t.Fatal("empty confirmed epoch discarded a nonempty recorded prefix")
			}
			epochs, err := q.ListVoiceMediaEpochsForCapture(t.Context(), capture.ID)
			if err != nil {
				t.Fatal(err)
			}
			if len(epochs) < 2 || epochs[1].ProviderEgressID.String != epoch.ProviderEgressID.String || epochs[1].ObservedState != "available" {
				t.Fatalf("failed epoch audit was lost: %+v", epochs)
			}
			if stopRequested {
				stop, err := q.GetCaptureSessionForAccount(t.Context(), aliceCapture(capture.ID))
				if err != nil || !stop.MaterializeRequestedAt.Valid || starts.Load() != 0 {
					t.Fatalf("Stop did not salvage prefix: %+v starts=%d err=%v", stop, starts.Load(), err)
				}
				ranges, err := q.ListCaptureMediaRangesForCapture(t.Context(), capture.ID)
				if err != nil {
					t.Fatal(err)
				}
				gaps := 0
				for _, span := range ranges {
					if span.Kind == "gap" {
						gaps++
						if span.StartOffsetMs != 10000 {
							t.Fatalf("overlapping tail gaps double count media loss: %+v", ranges)
						}
					}
				}
				if gaps != 1 {
					t.Fatalf("continuous loss split or duplicated: gaps=%d", gaps)
				}
			} else if len(epochs) != 3 || epochs[2].ObservedState != "active" || starts.Load() != 1 {
				t.Fatalf("recording did not restart independently: epochs=%+v starts=%d", epochs, starts.Load())
			}
		})
	}
}

func TestVoiceConfirmedTerminalMediaPreservesTailWithoutCodecFalseGap(t *testing.T) {
	serialIntegrationTest(t, serialSubprocess)
	t.Run("unrelated-probes", func(t *testing.T) {
		var starts atomic.Int32
		env, _, _, _ := newVoiceRecoveryLifecycle(t)
		server := confirmedTerminalRecorder(t, env, &starts).server
		for _, requestPath := range []string{"/", "/twirp/livekit.RoomService/UpdateRoomMetadata"} {
			request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, server.URL+requestPath, nil)
			if err != nil {
				t.Fatal(err)
			}
			response, err := server.Client().Do(request)
			if err != nil {
				t.Fatal(err)
			}
			_ = response.Body.Close()
			if response.StatusCode != http.StatusNotFound {
				t.Errorf("GET %s probe returned %d, want 404", requestPath, response.StatusCode)
			}
		}
		if starts.Load() != 0 {
			t.Fatal("unrelated probes started a recorder")
		}
	})
	for _, scenario := range []string{"failed-tail", "complete-tail", "aac-rounding", "aac-padding"} {
		t.Run(scenario, func(t *testing.T) {
			ffmpeg, err := exec.LookPath("ffmpeg")
			if err != nil {
				t.Skip("ffmpeg required")
			}
			input := filepath.Join(t.TempDir(), "audio.m4a")
			if body, err := exec.CommandContext(t.Context(), ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2", "-c:a", "aac", input).CombinedOutput(); err != nil {
				t.Fatalf("AAC fixture: %v %s", err, body)
			}
			raw := filepath.Join(t.TempDir(), "audio.aac")
			if body, err := exec.CommandContext(t.Context(), ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", input, "-c:a", "copy", "-f", "adts", raw).CombinedOutput(); err != nil {
				t.Fatalf("AAC packet fixture: %v %s", err, body)
			}
			mediaEnd, stopEnd := int64(2000), int64(3000)
			missing := scenario == "failed-tail" || scenario == "complete-tail"
			if !missing {
				stopEnd = 2000
			}
			if scenario == "aac-rounding" {
				packets := voiceTimelineAudioPackets(t, input)
				at, err := strconv.ParseFloat(packets[len(packets)-1].Time, 64)
				if err != nil {
					t.Fatal(err)
				}
				mediaEnd = int64(math.Floor(at * 1000))
			}
			if scenario == "aac-padding" {
				body, err := exec.CommandContext(t.Context(), "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", raw).Output()
				if err != nil {
					t.Fatal(err)
				}
				seconds, err := strconv.ParseFloat(strings.TrimSpace(string(body)), 64)
				if err != nil {
					t.Fatal(err)
				}
				mediaEnd = int64(math.Round(seconds * 1000))
			}
			env, q, capture, epoch := newVoiceRecoveryLifecycle(t)
			epoch, err = q.GetVoiceMediaEpoch(t.Context(), epoch.ID)
			if err != nil {
				t.Fatal(err)
			}
			origin := time.Now().Add(-5 * time.Second).Truncate(time.Microsecond)
			if _, err = env.pool.Exec(t.Context(), "UPDATE capture_sessions SET created_at=$2,transcript_start_offset_ms=1000 WHERE id=$1", capture.ID, origin); err != nil {
				t.Fatal(err)
			}
			if _, err = env.pool.Exec(t.Context(), "UPDATE voice_sessions SET created_at=$2 WHERE id=$1", capture.VoiceSessionID.String, origin.Add(-time.Second)); err != nil {
				t.Fatal(err)
			}
			var starts atomic.Int32
			objects, err := artifactstore.NewLocalStore(t.TempDir(), 16<<20)
			if err != nil {
				t.Fatal(err)
			}
			recorder := confirmedTerminalRecorder(t, env, &starts)
			// The recorder archived the whole input, but a failed recorder
			// never sealed its playlist.
			recorder.record(epoch.StagingPrefix, input, scenario != "failed-tail")
			recorder.report(t.Context(), epoch.StagingPrefix, "active", origin, mediaEnd)
			if scenario == "failed-tail" {
				recorder.report(t.Context(), epoch.StagingPrefix, "failed", time.Time{}, 0)
			} else {
				recorder.report(t.Context(), epoch.StagingPrefix, "available", origin, mediaEnd)
			}
			provider := recorder.provider(voicemedia.LiveKitConfig{}, env.pool)
			materializer, err := voicemedia.NewHLSMaterializer(env.pool, objects, recorder.staging)
			if err != nil {
				t.Fatal(err)
			}
			service := voicemedia.New(env.pool, provider, materializer)
			if _, err = createCaptureSpeech(t.Context(), q, captureSpeech{ID: "accepted_tail", SessionID: capture.ID, AccountID: "account_alice", RoomID: capture.RoomID, StartOffsetMs: 1000 + stopEnd - 80, EndOffsetMs: 1000 + stopEnd, Text: "The last sentence that must be kept", NormalizedText: "Thelastsentencethatmustbekept", Kind: "speech"}); err != nil {
				t.Fatal(err)
			}
			if _, err = service.EndCapture(t.Context(), voicemedia.EndCaptureRequest{AccountID: "account_alice", CaptureSessionID: capture.ID}); err != nil {
				t.Fatal(err)
			}
			if _, err = env.pool.Exec(t.Context(), "UPDATE capture_sessions SET stop_requested_at=$2 WHERE id=$1", capture.ID, origin.Add(time.Duration(stopEnd)*time.Millisecond)); err != nil {
				t.Fatal(err)
			}
			if _, err = env.pool.Exec(t.Context(), "UPDATE voice_media_epochs SET updated_at=clock_timestamp()-interval '3 seconds' WHERE id=$1", epoch.ID); err != nil {
				t.Fatal(err)
			}
			if _, err := service.RunJobStepForTest(t.Context(), voicemedia.CaptureReconcileArgs{CaptureSessionID: capture.ID}); err != nil {
				t.Fatalf("terminal epoch did not seal: %v", err)
			}
			if err = q.RecordVoiceInputBoundary(t.Context(), store.RecordVoiceInputBoundaryParams{VoiceSessionID: capture.VoiceSessionID.String, Kind: "track_ended", OffsetMs: 1000 + stopEnd}); err != nil {
				t.Fatal(err)
			}
			if err = q.FreezeReadyVoiceTranscripts(t.Context()); err != nil {
				t.Fatal(err)
			}
			current, err := q.GetCaptureSessionForAccount(t.Context(), store.GetCaptureSessionForAccountParams{ID: capture.ID, AccountID: textForVoiceTest("account_alice")})
			if err != nil {
				t.Fatal(err)
			}
			visible, err := q.ListCaptureTranscriptSegments(t.Context(), store.ListCaptureTranscriptSegmentsParams{CaptureSessionID: capture.ID, StartOffsetMs: 1000, EndOffsetMs: current.TranscriptEndOffsetMs.Int64})
			if err != nil {
				t.Fatal(err)
			}
			if len(visible) != 1 || visible[0].ID != "accepted_tail" {
				t.Errorf("Freeze dropped accepted tail: end=%d wanted=%d", current.TranscriptEndOffsetMs.Int64, 1000+stopEnd)
			}
			gaps, err := q.GetCaptureGapSummary(t.Context(), capture.ID)
			if err != nil {
				t.Fatal(err)
			}
			if missing && (gaps.GapCount != 1 || gaps.GapDurationMs != 1000) {
				t.Errorf("real missing tail not disclosed: %+v", gaps)
			}
			if !missing && gaps.GapCount != 0 {
				t.Errorf("AAC boundary rounding/padding became a false gap: media=%d stop=%d gaps=%+v", mediaEnd, stopEnd, gaps)
			}
			saved, err := service.Materialize(t.Context(), voicemedia.MaterializeRequest{AccountID: "account_alice", CaptureSessionID: capture.ID, FromMS: 0, ThroughMS: min(mediaEnd, stopEnd), Purpose: "final"})
			if err != nil {
				t.Fatal(err)
			}
			if saved.DurationMS < 1950 || saved.DurationMS > 2050 {
				t.Fatalf("saved AAC prefix was discarded/truncated: %dms", saved.DurationMS)
			}
			reader, err := objects.Open(t.Context(), saved.ObjectKey)
			if err != nil {
				t.Fatal(err)
			}
			body, err := io.ReadAll(reader)
			err = errors.Join(err, reader.Close())
			if err != nil {
				t.Fatal(err)
			}
			output := filepath.Join(t.TempDir(), "saved.m4a")
			if err = os.WriteFile(output, body, 0600); err != nil {
				t.Fatal(err)
			}
			savedPackets := voiceTimelineAudioPackets(t, output)
			if len(savedPackets) < 90 {
				t.Fatal("saved AAC prefix lost packets")
			}
			cursor := 0
			for _, packet := range voiceTimelineAudioPackets(t, input) {
				at, err := strconv.ParseFloat(packet.Time, 64)
				if err != nil {
					t.Fatal(err)
				}
				if at <= 0.1 || at >= 1.9 {
					continue
				}
				for cursor < len(savedPackets) && savedPackets[cursor].Hash != packet.Hash {
					cursor++
				}
				if cursor == len(savedPackets) {
					t.Fatal("saved recording changed or omitted an original AAC packet")
				}
				cursor++
			}
		})
	}
}

// confirmedTerminalRecorder directs the lifecycle epoch's recorder; every
// later epoch's recorder starts and reports active.
func confirmedTerminalRecorder(t *testing.T, env *testEnv, starts *atomic.Int32) *voiceRecorderRoom {
	t.Helper()
	recorder := newVoiceRecorderRoom(t, env.pool)
	recorder.direct("recovery-tx", "voice-staging/capture_recovery_tx/epoch-0")
	recorder.start = func(ctx context.Context, prefix string) {
		starts.Add(1)
		recorder.report(ctx, prefix, "active", time.Now(), 0)
	}
	return recorder
}
