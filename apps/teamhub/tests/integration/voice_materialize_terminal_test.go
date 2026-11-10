package integration_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
)

type stubVoiceMaterializer struct{ err error }

func (m stubVoiceMaterializer) Materialize(_ context.Context, input voicemedia.MaterializeRequest) (voicemedia.MaterializedAudio, error) {
	if m.err != nil {
		return voicemedia.MaterializedAudio{}, m.err
	}
	digest := sha256.Sum256([]byte(input.CaptureSessionID))
	// capture_media_outputs.object_key is unique, so each purpose needs its own key.
	return voicemedia.MaterializedAudio{ObjectKey: "voice/" + input.CaptureSessionID + "/" + input.Purpose, Filename: "capture.m4a", MediaType: "audio/mp4", DurationMS: 1000, SizeBytes: 15, SHA256: hex.EncodeToString(digest[:])}, nil
}

type voiceMaterializeState struct {
	attempts      int32
	captureStatus string
}

func TestVoiceMaterializationStopsWhenDocumentOwnerIsGone(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, root := newHardwareVoiceCaptureEnvWithStorageAndLimitsAndConfig(t, 1<<20, 1<<30, nil, skipping(app.VoiceJobs))
	service := newVoiceMaterializeTestService(t, env, root, stubVoiceMaterializer{})
	deletingCapture, deletingRoom := seedVoiceMaterialization(t, env, alice, "deleting", true)
	// A Room under deletion rejects the upload and every Room Event.
	if _, err := env.pool.Exec(t.Context(), `UPDATE rooms SET deletion_started_at=now(),deletion_started_by_actor_id='actor_acme_alice' WHERE id=$1`, deletingRoom); err != nil {
		t.Fatal(err)
	}
	if next, err := service.RunJobStepForTest(t.Context(), voicemedia.CaptureMaterializeArgs{CaptureSessionID: deletingCapture}); next != voicemedia.JobDone || err != nil {
		t.Fatalf("deleting Room next=%v err=%v", next, err)
	}
	if state := readVoiceMaterializeState(t, env, deletingCapture); state.captureStatus != "failed" || state.attempts != 1 {
		t.Fatalf("deleting Room state=%+v", state)
	}
	if count := captureFailedEvents(t, env, deletingRoom, deletingCapture); count != 0 {
		t.Fatalf("deleting Room events=%d", count)
	}
	if next, err := service.RunJobStepForTest(t.Context(), voicemedia.CaptureMaterializeArgs{CaptureSessionID: deletingCapture}); next != voicemedia.JobDone || err != nil {
		t.Fatalf("terminal materialization step next=%v err=%v", next, err)
	}
	if state := readVoiceMaterializeState(t, env, deletingCapture); state.attempts != 1 {
		t.Fatalf("terminal materialization was claimed again: %+v", state)
	}
}

func TestVoiceMaterializationRetryBackoffBecomesTerminal(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, root := newHardwareVoiceCaptureEnvWithStorageAndLimitsAndConfig(t, 1<<20, 1<<30, nil, skipping(app.VoiceJobs))
	captureID, roomID := seedVoiceMaterialization(t, env, alice, "budget", true)
	cause := errors.New("staging unavailable")
	service := newVoiceMaterializeTestService(t, env, root, stubVoiceMaterializer{err: cause})
	const maxAttempts = 12
	const capped = 5 * time.Minute
	wantDelays := []time.Duration{5 * time.Second, 10 * time.Second, 20 * time.Second, 40 * time.Second, 80 * time.Second, 160 * time.Second, capped, capped, capped, capped, capped}
	for attempt := int32(1); attempt <= maxAttempts; attempt++ {
		next, err := service.RunJobStepForTest(t.Context(), voicemedia.CaptureMaterializeArgs{CaptureSessionID: captureID})
		state := readVoiceMaterializeState(t, env, captureID)
		if state.attempts != attempt {
			t.Fatalf("attempt %d state=%+v", attempt, state)
		}
		if attempt < maxAttempts {
			if !errors.Is(err, cause) || state.captureStatus != "finalizing" {
				t.Fatalf("attempt %d err=%v state=%+v", attempt, err, state)
			}
			if want := wantDelays[attempt-1]; next != want {
				t.Fatalf("attempt %d delay=%v want=%v", attempt, next, want)
			}
			// A wake inside the back-off waits it out without spending an attempt.
			if early, earlyErr := service.RunJobStepForTest(t.Context(), voicemedia.CaptureMaterializeArgs{CaptureSessionID: captureID}); earlyErr != nil || early <= 0 || early > wantDelays[attempt-1] {
				t.Fatalf("attempt %d early wake next=%v err=%v", attempt, early, earlyErr)
			}
			if state := readVoiceMaterializeState(t, env, captureID); state.attempts != attempt {
				t.Fatalf("attempt %d early wake spent an attempt: %+v", attempt, state)
			}
			if _, err = env.pool.Exec(t.Context(), "UPDATE capture_sessions SET materialize_retry_at=clock_timestamp() WHERE id=$1", captureID); err != nil {
				t.Fatal(err)
			}
			continue
		}
		if err != nil || next != voicemedia.JobDone || state.captureStatus != "failed" {
			t.Fatalf("exhausted next=%v err=%v state=%+v", next, err, state)
		}
	}
	if count := captureFailedEvents(t, env, roomID, captureID); count != 1 {
		t.Fatalf("capture failed events=%d", count)
	}
	if next, err := service.RunJobStepForTest(t.Context(), voicemedia.CaptureMaterializeArgs{CaptureSessionID: captureID}); next != voicemedia.JobDone || err != nil {
		t.Fatalf("exhausted materialization was claimed again next=%v err=%v", next, err)
	}
}

func TestVoiceMaterializationTranscriptWaitKeepsRetryBudget(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, root := newHardwareVoiceCaptureEnvWithStorageAndLimitsAndConfig(t, 1<<20, 1<<30, nil, skipping(app.VoiceJobs))
	captureID, _ := seedVoiceMaterialization(t, env, alice, "wait", false)
	service := newVoiceMaterializeTestService(t, env, root, stubVoiceMaterializer{})
	for range 15 {
		if next, err := service.RunJobStepForTest(t.Context(), voicemedia.CaptureMaterializeArgs{CaptureSessionID: captureID}); next != time.Second || err != nil {
			t.Fatalf("transcript wait next=%v err=%v", next, err)
		}
		state := readVoiceMaterializeState(t, env, captureID)
		if state.attempts != 0 || state.captureStatus != "finalizing" {
			t.Fatalf("transcript wait state=%+v", state)
		}
	}
}

func seedVoiceMaterialization(t *testing.T, env *testEnv, alice *http.Client, id string, transcriptComplete bool) (captureID, roomID string) {
	t.Helper()
	q := store.New(env.pool)
	roomID = env.createRoom(alice, acmeTenant, "Voice materialize "+id, "voice-materialize-"+id)
	voice, err := q.CreateVoiceSession(t.Context(), store.CreateVoiceSessionParams{ID: "voice_materialize_" + id, AccountID: "account_alice", AuthSessionID: loginSessionOf(t, env, "account_alice"), RoomID: roomID, ProviderRoomName: "materialize-" + id, ParticipantIdentity: id, Purpose: "hardware_control"})
	if err != nil {
		t.Fatal(err)
	}
	capture, err := q.CreateLiveKitCaptureSession(t.Context(), store.CreateLiveKitCaptureSessionParams{ID: "capture_materialize_" + id, AccountID: "account_alice", RoomID: roomID, VoiceSessionID: voice.ID, StartOffsetMs: 0})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = q.TransitionLiveKitCaptureStatus(t.Context(), store.TransitionLiveKitCaptureStatusParams{ID: capture.ID, Status: "recording"}); err != nil {
		t.Fatal(err)
	}
	if transcriptComplete {
		if _, err = q.AdvanceCaptureTranscriptCoverage(t.Context(), store.AdvanceCaptureTranscriptCoverageParams{SessionID: capture.ID, AccountID: "account_alice", RoomID: roomID, StreamID: id, Lane: "live", StartOffsetMs: 0, EndOffsetMs: 1000}); err != nil {
			t.Fatal(err)
		}
	}
	epoch, err := q.CreateVoiceMediaEpoch(t.Context(), store.CreateVoiceMediaEpochParams{ID: "epoch_materialize_" + id, VoiceSessionID: voice.ID, CaptureSessionID: capture.ID, StagingPrefix: "voice-staging/" + capture.ID + "/epoch-0"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = q.CreateCaptureMediaRange(t.Context(), store.CreateCaptureMediaRangeParams{ID: "range_materialize_" + id, CaptureSessionID: capture.ID, EpochID: textForVoiceTest(epoch.ID), Kind: "media", StartOffsetMs: 0, EndOffsetMs: 1000, Reason: "test"}); err != nil {
		t.Fatal(err)
	}
	if _, err = env.pool.Exec(t.Context(), "UPDATE capture_sessions SET status='finalizing',transcript_end_offset_ms=1000 WHERE id=$1", capture.ID); err != nil {
		t.Fatal(err)
	}
	if err = q.RequestVoiceCaptureMaterialization(t.Context(), capture.ID); err != nil {
		t.Fatal(err)
	}
	// An Actor holds one active Voice Session, so close it before seeding the next Capture.
	if _, err = q.CloseVoiceSession(t.Context(), voice.ID); err != nil {
		t.Fatal(err)
	}
	return capture.ID, roomID
}

func newVoiceMaterializeTestService(t *testing.T, env *testEnv, root string, materializer interface {
	Materialize(context.Context, voicemedia.MaterializeRequest) (voicemedia.MaterializedAudio, error)
}) *voicemedia.Service {
	t.Helper()
	objects, err := artifactstore.NewLocalStore(root, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	return voicemedia.NewWithDocuments(env.pool, nil, materializer, document.NewWithObjectStore(env.pool, objects))
}

func readVoiceMaterializeState(t *testing.T, env *testEnv, captureID string) voiceMaterializeState {
	t.Helper()
	var state voiceMaterializeState
	if err := env.pool.QueryRow(t.Context(), `SELECT materialize_attempts,status FROM capture_sessions WHERE id=$1`, captureID).Scan(&state.attempts, &state.captureStatus); err != nil {
		t.Fatal(err)
	}
	return state
}

func captureFailedEvents(t *testing.T, env *testEnv, roomID, captureID string) int {
	t.Helper()
	var count int
	if err := env.pool.QueryRow(t.Context(), `SELECT count(*) FROM room_events WHERE room_id=$1 AND resource_id=$2 AND event_type='capture.session.changed' AND payload->>'status'='failed'`, roomID, captureID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}
