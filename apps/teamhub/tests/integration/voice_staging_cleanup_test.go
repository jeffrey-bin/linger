package integration_test

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
)

type cleaningVoiceMaterializer struct {
	stubVoiceMaterializer
	deleteErr error
	deleted   []string
}

func (m *cleaningVoiceMaterializer) DeleteCaptureStaging(_ context.Context, captureID string) error {
	if m.deleteErr != nil {
		return m.deleteErr
	}
	m.deleted = append(m.deleted, captureID)
	return nil
}

func TestVoiceStagingIsDeletedOnlyAfterTheCaptureEnds(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, root := newHardwareVoiceCaptureEnvWithStorageAndLimitsAndConfig(t, 1<<20, 1<<30, nil, skipping(app.VoiceJobs))
	materializer := &cleaningVoiceMaterializer{}
	service := newVoiceMaterializeTestService(t, env, root, materializer)
	finalized, _ := seedVoiceMaterialization(t, env, alice, "staging-finalized", true)
	failed, _ := seedVoiceMaterialization(t, env, alice, "staging-failed", true)
	recovering, _ := seedVoiceMaterialization(t, env, alice, "staging-recovering", true)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := env.pool.Exec(t.Context(), sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	cleanup := func(captureID string) (time.Duration, error) {
		t.Helper()
		return service.RunJobStepForTest(t.Context(), voicemedia.StagingCleanupArgs{CaptureSessionID: captureID})
	}
	cleanupDone := func(captureID string) {
		t.Helper()
		if next, err := cleanup(captureID); next != voicemedia.JobDone || err != nil {
			t.Fatalf("staging cleanup of %s next=%v err=%v", captureID, next, err)
		}
	}
	// The recorder has stopped writing the finalized and recovering Captures; the
	// failed Capture's recorder is still active.
	exec("UPDATE voice_media_epochs SET observed_state='available' WHERE capture_session_id IN ($1,$2)", finalized, recovering)
	exec("UPDATE voice_media_epochs SET observed_state='active' WHERE capture_session_id=$1", failed)
	exec("UPDATE capture_sessions SET status='failed' WHERE id=$1", failed)
	exec("UPDATE capture_sessions SET status='recovering' WHERE id=$1", recovering)
	for _, captureID := range []string{finalized, failed, recovering} {
		cleanupDone(captureID)
	}
	if len(materializer.deleted) != 0 {
		t.Fatalf("deleted=%v before any Capture ended with its recorder", materializer.deleted)
	}

	if _, err := service.RunJobStepForTest(t.Context(), voicemedia.CaptureMaterializeArgs{CaptureSessionID: finalized}); err != nil {
		t.Fatalf("materialization: %v", err)
	}
	requireVoiceJobQueued(t, env.pool, voicemedia.StagingCleanupArgs{CaptureSessionID: finalized}, "finalizing the recording")
	cleanupDone(finalized)
	cleanupDone(finalized)
	if !slices.Equal(materializer.deleted, []string{finalized}) {
		t.Fatalf("deleted=%v, want only the finalized Capture", materializer.deleted)
	}

	exec("UPDATE voice_media_epochs SET observed_state='failed' WHERE capture_session_id=$1", failed)
	cleanupDone(failed)
	if !slices.Equal(materializer.deleted, []string{finalized, failed}) {
		t.Fatalf("deleted=%v after the failed Capture's recorder ended", materializer.deleted)
	}

	// A failed delete retries a minute later.
	exec("UPDATE capture_sessions SET status='failed' WHERE id=$1", recovering)
	materializer.deleteErr = errors.New("staging unavailable")
	if next, err := cleanup(recovering); next != time.Minute || err == nil {
		t.Fatalf("failed delete next=%v err=%v, want a retry in a minute", next, err)
	}
	materializer.deleteErr = nil
	cleanupDone(recovering)
	if !slices.Equal(materializer.deleted, []string{finalized, failed, recovering}) {
		t.Fatalf("deleted=%v after the retry", materializer.deleted)
	}
	var remaining int
	if err := env.pool.QueryRow(t.Context(), "SELECT count(*) FROM capture_sessions WHERE id IN ($1,$2,$3) AND staging_deleted_at IS NULL", finalized, failed, recovering).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("captures without staging_deleted_at=%d err=%v", remaining, err)
	}
}
