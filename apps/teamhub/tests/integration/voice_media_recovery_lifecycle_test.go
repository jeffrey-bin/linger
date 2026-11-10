package integration_test

import (
	"context"
	"fmt"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
)

func TestVoiceEpochRecoveryRetainsRetryAfterNextEpochWriteFails(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, q, capture, epoch := newVoiceRecoveryLifecycle(t)
	var err error
	if _, err = env.pool.Exec(t.Context(), `
CREATE FUNCTION reject_next_voice_epoch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected next epoch write failure'; END $$;
CREATE TRIGGER reject_next_voice_epoch BEFORE INSERT ON voice_media_epochs FOR EACH ROW WHEN (NEW.epoch_index=1) EXECUTE FUNCTION reject_next_voice_epoch();
`); err != nil {
		t.Fatal(err)
	}
	var starts atomic.Int32
	provider := recoveryLifecycleProvider(t, env, &starts)
	service := voicemedia.New(env.pool, provider, nil)
	if _, err := service.RunJobStepForTest(t.Context(), voicemedia.CaptureReconcileArgs{CaptureSessionID: capture.ID}); err == nil {
		t.Fatalf("injected restart write failure err=%v", err)
	}
	if starts.Load() != 0 {
		t.Fatal("provider started before the durable recovery intent")
	}
	if _, err = env.pool.Exec(t.Context(), `DROP TRIGGER reject_next_voice_epoch ON voice_media_epochs; DROP FUNCTION reject_next_voice_epoch();`); err != nil {
		t.Fatal(err)
	}
	if _, err = env.pool.Exec(t.Context(), `UPDATE voice_media_epochs SET updated_at=clock_timestamp()-interval '3 seconds' WHERE id=$1`, epoch.ID); err != nil {
		t.Fatal(err)
	}
	// A fresh service must resume from PostgreSQL after the failed transition.
	restarted := voicemedia.New(env.pool, provider, nil)
	if _, err := restarted.RunJobStepForTest(t.Context(), voicemedia.CaptureReconcileArgs{CaptureSessionID: capture.ID}); err != nil {
		t.Fatalf("recovery lost its retry after the failed write: err=%v", err)
	}
	latest, err := q.GetLatestVoiceMediaEpochForCapture(t.Context(), capture.ID)
	if err != nil || latest.EpochIndex != 1 || latest.ObservedState != "active" || starts.Load() != 1 {
		t.Fatalf("recording did not resume once: epoch=%+v starts=%d err=%v", latest, starts.Load(), err)
	}
	ranges, err := q.ListCaptureMediaRangesForCapture(t.Context(), capture.ID)
	if err != nil || len(ranges) != 2 || ranges[0].Kind != "media" || ranges[0].EndOffsetMs != 10_000 || ranges[1].Kind != "gap" {
		t.Fatalf("recovery lost archived media or its gap: ranges=%+v err=%v", ranges, err)
	}
}

func TestVoiceEpochRecoveryResumesAfterActivationWriteFails(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, q, capture, epoch := newVoiceRecoveryLifecycle(t)
	if _, err := env.pool.Exec(t.Context(), `CREATE FUNCTION reject_voice_activation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected activation failure'; END $$;
CREATE TRIGGER reject_voice_activation BEFORE UPDATE ON voice_media_epochs FOR EACH ROW WHEN (NEW.epoch_index=1 AND NEW.observed_state='active') EXECUTE FUNCTION reject_voice_activation();`); err != nil {
		t.Fatal(err)
	}
	var starts atomic.Int32
	provider := recoveryLifecycleProvider(t, env, &starts)
	if _, err := voicemedia.New(env.pool, provider, nil).RunJobStepForTest(t.Context(), voicemedia.CaptureReconcileArgs{CaptureSessionID: capture.ID}); err == nil {
		t.Fatalf("injected activation failure err=%v", err)
	}
	if starts.Load() != 1 {
		t.Fatal("provider should have accepted the recovery")
	}
	if _, err := env.pool.Exec(t.Context(), `DROP TRIGGER reject_voice_activation ON voice_media_epochs; DROP FUNCTION reject_voice_activation(); UPDATE voice_media_epochs SET updated_at=clock_timestamp()-interval '3 seconds'; UPDATE voice_media_epochs SET restart_retry_at=NULL;`); err != nil {
		t.Fatal(err)
	}
	if _, err := voicemedia.New(env.pool, provider, nil).RunJobStepForTest(t.Context(), voicemedia.CaptureReconcileArgs{CaptureSessionID: capture.ID}); err != nil {
		t.Fatalf("replay activation err=%v", err)
	}
	latest, err := q.GetLatestVoiceMediaEpochForCapture(t.Context(), capture.ID)
	if err != nil || latest.ID == epoch.ID || !latest.FirstArchivedMs.Valid || latest.FirstArchivedMs.Int64 <= 10000 || latest.ObservedState != "active" || starts.Load() != 1 {
		t.Fatalf("recovery lost its timeline or duplicated recorder epoch: epoch=%+v starts=%d err=%v", latest, starts.Load(), err)
	}
}

func TestVoiceEpochRecoveryCannotRestartAfterAcceptedStop(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, q, capture, _ := newVoiceRecoveryLifecycle(t)
	var starts atomic.Int32
	// The old recorder's terminal report is stored before Stop is accepted,
	// but reconciliation observes it only afterwards.
	provider := recoveryLifecycleProvider(t, env, &starts)
	service := voicemedia.New(env.pool, provider, nil)
	if result, err := service.EndCapture(t.Context(), voicemedia.EndCaptureRequest{AccountID: "account_alice", CaptureSessionID: capture.ID}); err != nil || result.Status != "finalizing" {
		t.Fatalf("Stop was not accepted: %+v %v", result, err)
	}
	if _, err := service.RunJobStepForTest(t.Context(), voicemedia.CaptureReconcileArgs{CaptureSessionID: capture.ID}); err != nil {
		t.Fatal(err)
	}
	epochs, err := q.ListVoiceMediaEpochsForCapture(t.Context(), capture.ID)
	if err != nil || len(epochs) != 1 || starts.Load() != 0 {
		t.Fatalf("accepted Stop was overwritten by recovery: epochs=%d starts=%d err=%v", len(epochs), starts.Load(), err)
	}
	if _, err = env.pool.Exec(t.Context(), "UPDATE voice_media_epochs SET updated_at=clock_timestamp()-interval '3 seconds'"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.RunJobStepForTest(t.Context(), voicemedia.CaptureReconcileArgs{CaptureSessionID: capture.ID}); err != nil {
		t.Fatalf("Stop did not converge after old observation: err=%v", err)
	}
	epochs, err = q.ListVoiceMediaEpochsForCapture(t.Context(), capture.ID)
	if err != nil || epochs[0].ObservedState != "available" {
		t.Fatalf("stopped epoch not sealed: %+v %v", epochs, err)
	}
}

func TestVoiceEpochRecoveryStopsUnstartedEpochWithoutLosingArchivedMedia(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, q, capture, _ := newVoiceRecoveryLifecycle(t)
	var starts atomic.Int32
	provider := recoveryLifecycleProvider(t, env, &starts, func(w http.ResponseWriter) bool { w.WriteHeader(http.StatusServiceUnavailable); return true })
	service := voicemedia.New(env.pool, provider, nil)
	if _, err := service.RunJobStepForTest(t.Context(), voicemedia.CaptureReconcileArgs{CaptureSessionID: capture.ID}); err == nil {
		t.Fatalf("unavailable recovery start err=%v", err)
	}
	if _, err := service.EndCapture(t.Context(), voicemedia.EndCaptureRequest{AccountID: "account_alice", CaptureSessionID: capture.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `UPDATE voice_media_epochs SET updated_at=clock_timestamp()-interval '3 seconds'; UPDATE voice_media_epochs SET restart_retry_at=NULL;`); err != nil {
		t.Fatal(err)
	}
	if _, err := voicemedia.New(env.pool, provider, nil).RunJobStepForTest(t.Context(), voicemedia.CaptureReconcileArgs{CaptureSessionID: capture.ID}); err != nil {
		t.Fatalf("Stop stranded the recorded prefix after an unstarted recovery: err=%v", err)
	}
	stop, err := q.GetCaptureSessionForAccount(t.Context(), aliceCapture(capture.ID))
	if err != nil || !stop.MaterializeRequestedAt.Valid || starts.Load() != 0 {
		t.Fatalf("Stop still waits for an unstarted epoch: materialize_requested=%v starts=%d err=%v", stop.MaterializeRequestedAt.Valid, starts.Load(), err)
	}
	ranges, err := q.ListCaptureMediaRangesForCapture(t.Context(), capture.ID)
	if err != nil || len(ranges) == 0 || ranges[0].Kind != "media" || ranges[0].EndOffsetMs != 10000 {
		t.Fatalf("Stop lost the archived prefix: %+v %v", ranges, err)
	}
	if err = q.RecordVoiceInputBoundary(t.Context(), store.RecordVoiceInputBoundaryParams{VoiceSessionID: capture.VoiceSessionID.String, Kind: "track_ended", OffsetMs: 30000}); err != nil {
		t.Fatal(err)
	}
	if err = q.FreezeReadyVoiceTranscripts(t.Context()); err != nil {
		t.Fatal(err)
	}
	finished, err := q.GetCaptureSessionForAccount(t.Context(), store.GetCaptureSessionForAccountParams{ID: capture.ID, AccountID: textForVoiceTest("account_alice")})
	if err != nil || !finished.TranscriptEndOffsetMs.Valid || finished.TranscriptEndOffsetMs.Int64 < 20000 {
		t.Fatalf("Stop dropped transcript from the disclosed tail gap: %+v %v", finished, err)
	}

}

func TestVoiceEpochRecoveryStopsEgressStartedAfterStop(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, q, capture, _ := newVoiceRecoveryLifecycle(t)
	entered, release := make(chan struct{}), make(chan struct{})
	defer close(release)
	var starts atomic.Int32
	var startTime time.Time
	provider := recoveryLifecycleProviderAt(t, env, &starts, func() time.Time { return startTime }, func(http.ResponseWriter) bool { close(entered); <-release; return false })
	service := voicemedia.New(env.pool, provider, nil)
	finished := make(chan error, 1)
	go func() {
		_, err := service.RunJobStepForTest(t.Context(), voicemedia.CaptureReconcileArgs{CaptureSessionID: capture.ID})
		finished <- err
	}()
	select {
	case <-entered:
	case <-time.After(30 * time.Second):
		t.Fatal("recovery Start did not enter")
	}
	if _, err := service.EndCapture(t.Context(), voicemedia.EndCaptureRequest{AccountID: "account_alice", CaptureSessionID: capture.ID}); err != nil {
		t.Fatal(err)
	}
	acceptedStop, err := q.GetCaptureSessionForAccount(t.Context(), aliceCapture(capture.ID))
	if err != nil {
		t.Fatal(err)
	}
	// Model a provider activation after the durable Stop, independently of
	// clock skew between the PostgreSQL container and the fake provider host.
	startTime = acceptedStop.StopRequestedAt.Time.Add(time.Millisecond)
	release <- struct{}{}
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
	stop, err := q.GetCaptureSessionForAccount(t.Context(), aliceCapture(capture.ID))
	if err != nil || !stop.MaterializeRequestedAt.Valid {
		t.Fatalf("late recorder activation stranded accepted Stop: materialize_requested=%v err=%v", stop.MaterializeRequestedAt.Valid, err)
	}
	epoch, err := q.GetLatestVoiceMediaEpochForCapture(t.Context(), capture.ID)
	if err != nil || epoch.ObservedState != "available" {
		t.Fatalf("late recorder epoch remained active: %+v %v", epoch, err)
	}
}

func TestVoiceRecoveryHandlesFailedUnconfirmedEgress(t *testing.T) {
	allowParallelIntegrationTest(t)
	for _, partial := range []bool{false, true} {
		for _, stopRequested := range []bool{false, true} {
			t.Run(fmt.Sprintf("partial=%v/stop=%v", partial, stopRequested), func(t *testing.T) {
				env, q, capture, _ := newVoiceRecoveryLifecycle(t)
				var starts atomic.Int32
				// Provider timestamps share PostgreSQL's clock so start-before-Stop
				// ordering does not depend on host/container clock skew.
				databaseClock := func() time.Time {
					var now time.Time
					if err := env.pool.QueryRow(t.Context(), "SELECT clock_timestamp()").Scan(&now); err != nil {
						t.Error(err)
						return time.Now()
					}
					return now
				}
				provider := failedRecoveryLifecycleProvider(t, env, &starts, databaseClock, partial)
				inspector := failedRecoveryMediaInspector{partial: partial}
				service := voicemedia.New(env.pool, provider, inspector)
				if _, err := service.RunJobStepForTest(t.Context(), voicemedia.CaptureReconcileArgs{CaptureSessionID: capture.ID}); err == nil {
					t.Fatalf("failed provider admission err=%v", err)
				}
				if starts.Load() != 1 {
					t.Fatalf("failed recorder starts=%d", starts.Load())
				}
				if stopRequested {
					if _, err := service.EndCapture(t.Context(), voicemedia.EndCaptureRequest{AccountID: "account_alice", CaptureSessionID: capture.ID}); err != nil {
						t.Fatal(err)
					}
				}
				for range 2 {
					if _, err := env.pool.Exec(t.Context(), `UPDATE voice_media_epochs SET updated_at=clock_timestamp()-interval '3 seconds'; UPDATE voice_media_epochs SET restart_retry_at=NULL;`); err != nil {
						t.Fatal(err)
					}
					_, err := voicemedia.New(env.pool, provider, inspector).RunJobStepForTest(t.Context(), voicemedia.CaptureReconcileArgs{CaptureSessionID: capture.ID})
					if err != nil {
						t.Fatalf("known failed recorder was retried without recovery: err=%v", err)
					}
				}
				epochs, err := q.ListVoiceMediaEpochsForCapture(t.Context(), capture.ID)
				if err != nil {
					t.Fatal(err)
				}
				if len(epochs) < 2 || epochs[1].ProviderEgressID.String != epochs[1].StagingPrefix || epochs[1].ObservedState != "available" {
					t.Fatalf("failed recorder evidence was lost: %+v", epochs)
				}
				if stopRequested {
					stop, err := q.GetCaptureSessionForAccount(t.Context(), aliceCapture(capture.ID))
					if err != nil || !stop.MaterializeRequestedAt.Valid || starts.Load() != 1 {
						t.Fatalf("Stop did not preserve and finalize the recorded prefix: materialize_requested=%v starts=%d err=%v", stop.MaterializeRequestedAt.Valid, starts.Load(), err)
					}
				} else if len(epochs) != 3 || epochs[2].ObservedState != "active" || starts.Load() != 2 {
					t.Fatalf("recording did not resume in an independent epoch: epochs=%+v starts=%d", epochs, starts.Load())
				}
				ranges, err := q.ListCaptureMediaRangesForCapture(t.Context(), capture.ID)
				if err != nil {
					t.Fatal(err)
				}
				mediaCount := 0
				for _, span := range ranges {
					if span.Kind == "media" {
						mediaCount++
					}
				}
				want := 1
				if partial {
					want = 2
				}
				if mediaCount != want {
					t.Fatalf("recoverable media was lost: media ranges=%d want=%d ranges=%+v", mediaCount, want, ranges)
				}
			})
		}
	}
}

type failedRecoveryMediaInspector struct{ partial bool }

func (i failedRecoveryMediaInspector) Materialize(context.Context, voicemedia.MaterializeRequest) (voicemedia.MaterializedAudio, error) {
	return voicemedia.MaterializedAudio{}, fmt.Errorf("unexpected materialization")
}
func (i failedRecoveryMediaInspector) SegmentCount(context.Context, string, int64) (int64, error) {
	return 1, nil
}
func (i failedRecoveryMediaInspector) InspectSalvagePrefix(context.Context, string) (int64, error) {
	if i.partial {
		return 20, nil
	}
	return 0, voicemedia.ErrNoSalvageMedia
}

func failedRecoveryLifecycleProvider(t *testing.T, env *testEnv, starts *atomic.Int32, startTime func() time.Time, partial bool) *voicemedia.LiveKitProvider {
	t.Helper()
	recorder := newVoiceRecorderRoom(t, env.pool)
	// The old epoch's recorder already sealed ten seconds of media.
	recorder.report(t.Context(), "voice-staging/capture_recovery_tx/epoch-0", "available", startTime(), 10_000)
	if _, err := env.pool.Exec(t.Context(), "UPDATE voice_media_epochs SET updated_at=clock_timestamp()-interval '3 seconds'"); err != nil {
		t.Fatal(err)
	}
	recorder.start = func(ctx context.Context, prefix string) {
		if starts.Add(1) == 1 {
			// The first recovery recorder fails, optionally after archiving a
			// short prefix it reported while active.
			if partial {
				recorder.report(ctx, prefix, "active", startTime(), 20)
			}
			recorder.report(ctx, prefix, "failed", time.Time{}, 0)
			return
		}
		recorder.report(ctx, prefix, "active", startTime(), 0)
	}
	return recorder.provider(voicemedia.LiveKitConfig{}, env.pool)
}

func newVoiceRecoveryLifecycle(t *testing.T) (*testEnv, *store.Queries, store.CaptureSession, store.VoiceMediaEpoch) {
	t.Helper()
	env, alice, _ := newHardwareVoiceCaptureEnvWithStorageAndLimitsAndConfig(t, 1<<20, 1<<30, nil)
	q := store.New(env.pool)
	roomID := env.createRoom(alice, acmeTenant, "Recovery transaction", "recovery-transaction")
	voice, err := q.CreateVoiceSession(t.Context(), store.CreateVoiceSessionParams{ID: "voice_recovery_tx", AccountID: "account_alice", AuthSessionID: loginSessionOf(t, env, "account_alice"), RoomID: roomID, ProviderRoomName: "recovery-tx", ParticipantIdentity: "publisher", Purpose: "hardware_control"})
	if err != nil {
		t.Fatal(err)
	}
	capture, err := q.CreateLiveKitCaptureSession(t.Context(), store.CreateLiveKitCaptureSessionParams{ID: "capture_recovery_tx", AccountID: "account_alice", RoomID: roomID, VoiceSessionID: voice.ID})
	if err != nil {
		t.Fatal(err)
	}
	epoch, err := q.CreateVoiceMediaEpoch(t.Context(), store.CreateVoiceMediaEpochParams{ID: "epoch_recovery_tx", VoiceSessionID: voice.ID, CaptureSessionID: capture.ID, StagingPrefix: "voice-staging/capture_recovery_tx/epoch-0"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = q.ActivateVoiceMediaEpoch(t.Context(), store.ActivateVoiceMediaEpochParams{ID: epoch.ID, ProviderEgressID: textForVoiceTest(epoch.StagingPrefix), FirstArchivedMs: pgtype.Int8{Valid: true}}); err != nil {
		t.Fatal(err)
	}
	if _, err = q.TransitionLiveKitCaptureStatus(t.Context(), store.TransitionLiveKitCaptureStatusParams{ID: capture.ID, Status: "recording"}); err != nil {
		t.Fatal(err)
	}
	if _, err = env.pool.Exec(t.Context(), `
UPDATE voice_media_epochs SET updated_at=clock_timestamp()-interval '3 seconds' WHERE id=$1;
`, epoch.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = env.pool.Exec(t.Context(), "UPDATE capture_sessions SET created_at=clock_timestamp()-interval '20 seconds' WHERE id=$1", capture.ID); err != nil {
		t.Fatal(err)
	}
	return env, q, capture, epoch
}

func recoveryLifecycleProvider(t *testing.T, env *testEnv, starts *atomic.Int32, refuseStart ...func(http.ResponseWriter) bool) *voicemedia.LiveKitProvider {
	t.Helper()
	return recoveryLifecycleProviderAt(t, env, starts, time.Now, refuseStart...)
}

func recoveryLifecycleProviderAt(t *testing.T, env *testEnv, starts *atomic.Int32, startTime func() time.Time, refuseStart ...func(http.ResponseWriter) bool) *voicemedia.LiveKitProvider {
	t.Helper()
	recorder := newVoiceRecorderRoom(t, env.pool)
	// The old epoch's recorder already sealed ten seconds of media.
	recorder.report(t.Context(), "voice-staging/capture_recovery_tx/epoch-0", "available", time.Now(), 10_000)
	if _, err := env.pool.Exec(t.Context(), "UPDATE voice_media_epochs SET updated_at=clock_timestamp()-interval '3 seconds'"); err != nil {
		t.Fatal(err)
	}
	if len(refuseStart) > 0 {
		recorder.refuse = refuseStart[0]
	}
	recorder.start = func(ctx context.Context, prefix string) {
		starts.Add(1)
		recorder.report(ctx, prefix, "active", startTime(), 0)
	}
	recorder.stop = func(ctx context.Context, prefix string) {
		recorder.report(ctx, prefix, "available", startTime(), 0)
	}
	return recorder.provider(voicemedia.LiveKitConfig{}, env.pool)
}

func TestVoiceStalledEpochWaitsForProviderTerminalBeforeRecovery(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, q, capture, epoch := newVoiceRecoveryLifecycle(t)
	if _, err := env.pool.Exec(t.Context(), "UPDATE voice_media_epochs SET segment_count=1,last_segment_at=clock_timestamp()-interval '30 seconds' WHERE id=$1", epoch.ID); err != nil {
		t.Fatal(err)
	}
	var starts atomic.Int32
	recorder := newVoiceRecorderRoom(t, env.pool)
	recorder.direct("recovery-tx", epoch.StagingPrefix)
	recorder.report(t.Context(), epoch.StagingPrefix, "active", time.Now().Add(-20*time.Second), 0)
	recorder.start = func(ctx context.Context, prefix string) {
		starts.Add(1)
		recorder.report(ctx, prefix, "active", time.Now(), 0)
	}
	provider := recorder.provider(voicemedia.LiveKitConfig{}, env.pool)
	service := voicemedia.New(env.pool, provider, failedRecoveryMediaInspector{})
	var err error
	for attempt := 0; attempt < 2; attempt++ {
		if _, err = env.pool.Exec(t.Context(), "UPDATE voice_media_epochs SET updated_at=clock_timestamp()-interval '3 seconds' WHERE id=$1", epoch.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := service.RunJobStepForTest(t.Context(), voicemedia.CaptureReconcileArgs{CaptureSessionID: capture.ID}); err != nil {
			t.Fatalf("stall reconciliation: %v", err)
		}
		latest, err := q.GetLatestVoiceMediaEpochForCapture(t.Context(), capture.ID)
		if err != nil || latest.ID != epoch.ID || latest.ObservedState != "sealing" || starts.Load() != 0 {
			t.Fatalf("live prefix was sealed prematurely: %+v starts=%d err=%v", latest, starts.Load(), err)
		}
		ranges, err := q.ListCaptureMediaRangesForCapture(t.Context(), capture.ID)
		if err != nil || len(ranges) != 0 {
			t.Fatalf("mutable prefix became final media: %v %v", ranges, err)
		}
	}
	if recorder.stops.Load() != 1 {
		t.Fatalf("Stop was repeated while the recorder was sealing: %d", recorder.stops.Load())
	}
	// The old recorder can continue uploading while it seals. Only its
	// available report freezes all 14 seconds; an earlier salvage inspection
	// is not authoritative.
	recorder.report(t.Context(), epoch.StagingPrefix, "available", time.Now(), 14_000)
	if _, err = env.pool.Exec(t.Context(), "UPDATE voice_media_epochs SET updated_at=clock_timestamp()-interval '3 seconds' WHERE id=$1", epoch.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.RunJobStepForTest(t.Context(), voicemedia.CaptureReconcileArgs{CaptureSessionID: capture.ID}); err != nil {
		t.Fatalf("terminal reconciliation: %v", err)
	}
	ranges, err := q.ListCaptureMediaRangesForCapture(t.Context(), capture.ID)
	if err != nil || len(ranges) < 1 || ranges[0].EndOffsetMs != 14000 || starts.Load() != 1 {
		t.Fatalf("terminal tail or successor lost: %v starts=%d err=%v", ranges, starts.Load(), err)
	}
}
