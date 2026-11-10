package integration_test

import (
	"encoding/json"
	"testing"

	"github.com/riverqueue/river"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
)

// A restart continues voice work from the rows: every voice session and
// Capture that still owes work gets one available job per kind, and a voice
// job a stopped process left running becomes available again at once.
func TestVoiceResumeJobsContinuesFromTheRows(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, _ := newHardwareVoiceCaptureEnvWithStorageAndLimitsAndConfig(t, 1<<20, 1<<30, nil, skipping(app.VoiceJobs))
	q := store.New(env.pool)
	roomID := env.createRoom(alice, acmeTenant, "Resume voice jobs", "resume-voice-jobs")
	voice, err := q.CreateVoiceSession(t.Context(), store.CreateVoiceSessionParams{ID: "voice_resume", AccountID: "account_alice", AuthSessionID: loginSessionOf(t, env, "account_alice"), RoomID: roomID, ProviderRoomName: "resume", ParticipantIdentity: "publisher", Purpose: "hardware_control"})
	if err != nil {
		t.Fatal(err)
	}
	// At most one Capture per voice session is active, so the ended one
	// settles before the recording starts.
	ended, err := q.CreateLiveKitCaptureSession(t.Context(), store.CreateLiveKitCaptureSessionParams{ID: "capture_resume_ended", AccountID: "account_alice", RoomID: roomID, VoiceSessionID: voice.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = env.pool.Exec(t.Context(), "UPDATE capture_sessions SET status='failed' WHERE id=$1", ended.ID); err != nil {
		t.Fatal(err)
	}
	recording, err := q.CreateLiveKitCaptureSession(t.Context(), store.CreateLiveKitCaptureSessionParams{ID: "capture_resume_recording", AccountID: "account_alice", RoomID: roomID, VoiceSessionID: voice.ID})
	if err != nil {
		t.Fatal(err)
	}
	// A stopped recording owes its stop and its final materialization.
	if _, err = env.pool.Exec(t.Context(), "UPDATE capture_sessions SET status='finalizing',stop_requested_at=clock_timestamp(),materialize_requested_at=clock_timestamp() WHERE id=$1", recording.ID); err != nil {
		t.Fatal(err)
	}
	// A stopped process left this job running.
	queueVoiceJob(t, env.pool, voicemedia.CaptureReconcileArgs{CaptureSessionID: recording.ID})
	if _, err = env.pool.Exec(t.Context(), "UPDATE river_job SET state='running',attempted_at=now(),attempt=1 WHERE kind='voice_capture_reconcile'"); err != nil {
		t.Fatal(err)
	}

	if err = voicemedia.ResumeJobs(t.Context(), env.pool); err != nil {
		t.Fatal(err)
	}
	for _, job := range []river.JobArgs{
		voicemedia.VoiceSessionReconcileArgs{VoiceSessionID: voice.ID},
		voicemedia.CaptureReconcileArgs{CaptureSessionID: recording.ID},
		voicemedia.CaptureStopArgs{CaptureSessionID: recording.ID},
		voicemedia.CaptureMaterializeArgs{CaptureSessionID: recording.ID},
		voicemedia.StagingCleanupArgs{CaptureSessionID: ended.ID},
	} {
		args, err := json.Marshal(job)
		if err != nil {
			t.Fatal(err)
		}
		var available, total int
		if err := env.pool.QueryRow(t.Context(), `SELECT count(*) FILTER (WHERE state='available'), count(*)
			FROM river_job WHERE kind=$1 AND args @> $2::jsonb`, job.Kind(), args).Scan(&available, &total); err != nil {
			t.Fatal(err)
		}
		if available != 1 || total != 1 {
			t.Fatalf("%s %s: %d available of %d jobs, want exactly one available", job.Kind(), args, available, total)
		}
	}
	var unexpected int
	if err := env.pool.QueryRow(t.Context(), `SELECT count(*) FROM river_job
		WHERE kind IN ('voice_transcript_recovery','voice_capture_completion')
		   OR (kind='voice_capture_reconcile' AND args->>'capture_session_id'=$1)`, ended.ID).Scan(&unexpected); err != nil {
		t.Fatal(err)
	}
	if unexpected != 0 {
		t.Fatalf("ResumeJobs queued %d jobs for work no row owes", unexpected)
	}
}
