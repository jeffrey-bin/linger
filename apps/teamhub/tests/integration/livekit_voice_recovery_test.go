package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
)

func TestLiveKitStartEventProjectsCaptureIdentity(t *testing.T) {
	allowParallelIntegrationTest(t)
	// The livekit provider builds the HLS materializer at startup, which needs ffmpeg.
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg required")
	}
	env, alice, _ := newHardwareVoiceCaptureEnvWithStorageAndLimitsAndConfig(t, 1<<20, 1<<30, func(cfg *config.Config) {
		cfg.Voice.SonioxAPIKey = "test-soniox-key"
	})
	q := store.New(env.pool)
	roomID := env.createRoom(alice, acmeTenant, "Voice transcript identity", "voice-transcript-identity")
	for _, check := range []struct {
		path   string
		status int
	}{
		{"/v0/rooms/" + roomID + "/active-voice-capture", http.StatusOK},
		{"/v0/rooms/missing/active-voice-capture", http.StatusNotFound},
	} {
		code, _, body := env.request(alice, http.MethodGet, check.path, nil, "")
		if code != check.status || (code == http.StatusOK && string(body) != "null") {
			t.Fatalf("empty Capture response %d %s", code, body)
		}
	}
	voice, err := q.CreateVoiceSession(t.Context(), store.CreateVoiceSessionParams{ID: "voice_identity", AccountID: "account_alice", AuthSessionID: loginSessionOf(t, env, "account_alice"), RoomID: roomID, ProviderRoomName: "voice-identity", ParticipantIdentity: "identity", Purpose: "hardware_control"})
	if err != nil {
		t.Fatal(err)
	}
	capture, err := q.CreateLiveKitCaptureSession(t.Context(), store.CreateLiveKitCaptureSessionParams{ID: "capture_identity", AccountID: "account_alice", RoomID: roomID, VoiceSessionID: voice.ID})
	if err != nil {
		t.Fatal(err)
	}
	code, _, _ := env.request(alice, http.MethodGet, "/v0/rooms/"+roomID+"/active-voice-capture", nil, "")
	if code != http.StatusNotFound {
		t.Fatalf("missing Capture epoch must not become empty success: %d", code)
	}
	if _, err = q.CreateVoiceTranscriptSegment(t.Context(), store.CreateVoiceTranscriptSegmentParams{ID: "segment_identity", EventID: "event_identity", VoiceSessionID: voice.ID, CaptureSessionID: textForVoiceTest(capture.ID), Lane: "live", StartOffsetMs: 100, EndOffsetMs: 200, Text: "Meeting starts", NormalizedText: "Meetingstarts", Kind: "speech", AccountID: "account_alice", RoomID: roomID}); err != nil {
		t.Fatal(err)
	}
	status, _, body := env.request(alice, http.MethodGet, "/v0/voice-sessions/"+voice.ID+"/transcript-events", nil, "")
	if status != http.StatusOK {
		t.Fatalf("transcript feed status=%d", status)
	}
	var page struct {
		Items []struct {
			CaptureID string `json:"capture_session_id"`
			Kind      string `json:"kind"`
		} `json:"items"`
	}
	decode(t, body, &page)
	if len(page.Items) != 1 || page.Items[0].Kind != "speech" || page.Items[0].CaptureID != capture.ID {
		t.Fatalf("recorded speech must identify its own Capture: %+v", page.Items)
	}
}

func TestLiveKitRevocationRejectsCallbacksAndClosesMedia(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, _ := newVoiceServiceEnv(t, func(cfg *config.Config) { cfg.Voice.RuntimeToken = "voice-test-service-token" })
	q := store.New(env.pool)
	roomID := env.createRoom(alice, acmeTenant, "Voice revocation", "voice-revocation")
	voice, err := q.CreateVoiceSession(t.Context(), store.CreateVoiceSessionParams{ID: "voice_revoke", AccountID: "account_alice", AuthSessionID: loginSessionOf(t, env, "account_alice"), RoomID: roomID, ProviderRoomName: "voice-revoke", ParticipantIdentity: "publisher-revoke", Purpose: "hardware_control"})
	if err != nil {
		t.Fatal(err)
	}
	completed, err := q.CreateLiveKitCaptureSession(t.Context(), store.CreateLiveKitCaptureSessionParams{ID: "capture_revoked_completion", AccountID: "account_alice", RoomID: roomID, VoiceSessionID: voice.ID})
	if err != nil {
		t.Fatal(err)
	}
	version := uploadTestDocument(t, env, alice, "revoked-capture-output", "source.m4a", "m4a", "audio/mp4", "synthetic-media")
	if _, err = env.pool.Exec(t.Context(), "UPDATE capture_sessions SET status='finalized',document_id=$2,document_version_id=$3 WHERE id=$1", completed.ID, version.ID, version.CurrentVersion.ID); err != nil {
		t.Fatal(err)
	}
	capture, err := q.CreateLiveKitCaptureSession(t.Context(), store.CreateLiveKitCaptureSessionParams{ID: "capture_revoke", AccountID: "account_alice", RoomID: roomID, VoiceSessionID: voice.ID})
	if err != nil {
		t.Fatal(err)
	}
	epoch, err := q.CreateVoiceMediaEpoch(t.Context(), store.CreateVoiceMediaEpochParams{ID: "epoch_revoke", VoiceSessionID: voice.ID, CaptureSessionID: capture.ID, StagingPrefix: "voice-staging/revoke/epoch-0"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = env.pool.Exec(t.Context(), "DELETE FROM room_members WHERE room_id=$1 AND actor_id=$2", roomID, voice.CreatedByActorID); err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(map[string]any{"voice_session_id": voice.ID, "event_id": "revoked-progress", "media_epoch": 0, "lane": "live", "kind": "progress", "start_offset_ms": 0, "end_offset_ms": 100, "committed_through_ms": 100})
	request, _ := http.NewRequestWithContext(t.Context(), http.MethodPost, env.server.URL+"/internal/v1/voice/observations", bytes.NewReader(payload))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer voice-test-service-token")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if err = response.Body.Close(); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusNotFound {
		t.Errorf("revoked callback status=%d want404", response.StatusCode)
	}
	deleted := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/DeleteRoom") {
			deleted = true
		}
		w.Header().Set("Content-Type", "application/protobuf")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	provider, err := voicemedia.NewLiveKitProvider(voicemedia.LiveKitConfig{APIURL: server.URL, PublicURL: server.URL, APIKey: "test", APISecret: "test"}, env.pool)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = env.pool.Exec(t.Context(), "UPDATE voice_sessions SET updated_at=clock_timestamp()-interval '10 seconds' WHERE id=$1", voice.ID); err != nil {
		t.Fatal(err)
	}
	service := voicemedia.New(env.pool, provider, nil)
	if _, err := service.RunJobStepForTest(t.Context(), voicemedia.VoiceSessionReconcileArgs{VoiceSessionID: voice.ID}); err != nil {
		t.Fatalf("revocation worker: %v", err)
	}
	if !deleted {
		t.Error("revoked publisher Room was not deleted")
	}
	var status string
	if err = env.pool.QueryRow(t.Context(), "SELECT status FROM capture_sessions WHERE id=$1", capture.ID).Scan(&status); err != nil || status != "failed" {
		t.Errorf("revoked Capture status=%s err=%v", status, err)
	}
	if err = env.pool.QueryRow(t.Context(), "SELECT status FROM voice_sessions WHERE id=$1", voice.ID).Scan(&status); err != nil || status != "closed" {
		t.Errorf("revoked VoiceSession status=%s err=%v", status, err)
	}
	current, err := q.GetVoiceMediaEpoch(t.Context(), epoch.ID)
	if err != nil || current.ObservedState != "failed" || current.LastFailureCode.String != "membership_revoked" {
		t.Errorf("revoked media failure not retained: state=%s err=%v", current.ObservedState, err)
	}
	if pendingLiveKitCapture(t, store.New(env.pool), capture.ID) {
		t.Fatal("revoked completion can starve the global queue")
	}
}

func TestLiveKitBeginCaptureKeepsConcurrentReconcileResult(t *testing.T) {
	allowParallelIntegrationTest(t)
	for _, stopFirst := range []bool{false, true} {
		t.Run(fmt.Sprint(stopFirst), func(t *testing.T) {
			env, alice, _ := newHardwareVoiceCaptureEnvWithStorageAndLimitsAndConfig(t, 1<<20, 1<<30, nil)
			q := store.New(env.pool)
			roomID := env.createRoom(alice, acmeTenant, "Start race", "start-race")
			voice, err := q.CreateVoiceSession(t.Context(), store.CreateVoiceSessionParams{ID: "voice_start_race", AccountID: "account_alice", AuthSessionID: loginSessionOf(t, env, "account_alice"), RoomID: roomID, ProviderRoomName: "voice-start-race", ParticipantIdentity: "publisher", Purpose: "hardware_control"})
			if err != nil {
				t.Fatal(err)
			}
			var service *voicemedia.Service
			recorder := newVoiceRecorderRoom(t, env.pool)
			recorder.start = func(ctx context.Context, prefix string) {
				// Reconciliation commits the recording before the start
				// request returns, and Stop may follow it.
				capture, err := q.GetActiveLiveKitCaptureForVoiceSession(ctx, textForVoiceTest(voice.ID))
				if err != nil {
					t.Error(err)
					return
				}
				epoch, err := q.GetLatestVoiceMediaEpochForCapture(ctx, capture.ID)
				if err != nil {
					t.Error(err)
					return
				}
				if _, err = q.ActivateVoiceMediaEpoch(ctx, store.ActivateVoiceMediaEpochParams{ID: epoch.ID, ProviderEgressID: textForVoiceTest(prefix), FirstArchivedMs: pgtype.Int8{Int64: 600, Valid: true}}); err != nil {
					t.Error(err)
				}
				recorder.report(ctx, prefix, "active", capture.CreatedAt.Time.Add(600*time.Millisecond), 0)
				if _, err = q.TransitionLiveKitCaptureStatus(ctx, store.TransitionLiveKitCaptureStatusParams{ID: capture.ID, Status: "recording"}); err != nil {
					t.Error(err)
				}
				if stopFirst {
					if _, err = service.EndCapture(ctx, voicemedia.EndCaptureRequest{AccountID: "account_alice", CaptureSessionID: capture.ID}); err != nil {
						t.Error(err)
					}
				}
			}
			provider := recorder.provider(voicemedia.LiveKitConfig{}, env.pool)
			service = voicemedia.New(env.pool, provider, nil)
			started, err := service.BeginCapture(t.Context(), voicemedia.BeginCaptureRequest{AccountID: "account_alice", VoiceSessionID: voice.ID, RoomID: roomID})
			if err != nil {
				t.Fatalf("late start response rejected existing recording: %v", err)
			}
			want := "recording"
			if stopFirst {
				want = "finalizing"
			}
			if started.Status != want || started.ArchivedThroughMS == nil || *started.ArchivedThroughMS != 600 {
				t.Fatalf("late activation changed committed state: %+v", started)
			}
		})
	}
}

// Each Capture's stop is its own job, so a slow stop does not hold up
// another Capture's stop or reconciliation.
func TestLiveKitStopRunsPerCapture(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, _ := newHardwareVoiceCaptureEnvWithStorageAndLimitsAndConfig(t, 1<<20, 1<<30, nil)
	q := store.New(env.pool)
	stopRequests := make(chan string, 2)
	releaseStops := make(chan struct{})
	released := false
	defer func() {
		if !released {
			close(releaseStops)
		}
	}()
	// Withdrawing a directive blocks until the test releases it, so both
	// Stop workers are in flight at once.
	recorder := newVoiceRecorderRoom(t, env.pool)
	recorder.stop = func(ctx context.Context, prefix string) {
		stopRequests <- prefix
		select {
		case <-releaseStops:
		case <-ctx.Done():
		}
	}
	for _, id := range []string{"first", "second"} {
		client, accountID := alice, "account_alice"
		if id == "second" {
			// Each Capture belongs to its own login session of the Human.
			client = env.login("alice", alicePassword)
		}
		roomID := env.createRoom(client, acmeTenant, "Stop fairness "+id, "stop-fairness-"+id)
		voice, err := q.CreateVoiceSession(t.Context(), store.CreateVoiceSessionParams{ID: "voice_" + id, AccountID: accountID, AuthSessionID: loginSessionOf(t, env, accountID), RoomID: roomID, ProviderRoomName: "voice-" + id, ParticipantIdentity: "publisher-" + id, Purpose: "hardware_control"})
		if err != nil {
			t.Fatal(err)
		}
		capture, err := q.CreateLiveKitCaptureSession(t.Context(), store.CreateLiveKitCaptureSessionParams{ID: "capture_" + id, AccountID: accountID, RoomID: roomID, VoiceSessionID: voice.ID})
		if err != nil {
			t.Fatal(err)
		}
		epoch, err := q.CreateVoiceMediaEpoch(t.Context(), store.CreateVoiceMediaEpochParams{ID: "epoch_" + id, VoiceSessionID: voice.ID, CaptureSessionID: capture.ID, StagingPrefix: "voice-staging/" + capture.ID + "/epoch-0"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = q.ActivateVoiceMediaEpoch(t.Context(), store.ActivateVoiceMediaEpochParams{ID: epoch.ID, ProviderEgressID: textForVoiceTest(epoch.StagingPrefix), FirstArchivedMs: pgtype.Int8{Valid: true}}); err != nil {
			t.Fatal(err)
		}
		recorder.direct(voice.ProviderRoomName, epoch.StagingPrefix)
		recorder.report(t.Context(), epoch.StagingPrefix, "active", time.Now(), 0)
		if _, err = q.TransitionLiveKitCaptureStatus(t.Context(), store.TransitionLiveKitCaptureStatusParams{ID: capture.ID, Status: "recording"}); err != nil {
			t.Fatal(err)
		}
		if id == "first" {
			if _, err = q.TransitionLiveKitCaptureStatus(t.Context(), store.TransitionLiveKitCaptureStatusParams{ID: capture.ID, Status: "finalizing"}); err != nil {
				t.Fatal(err)
			}
			if _, err = q.RequestSealVoiceMediaEpoch(t.Context(), epoch.ID); err != nil {
				t.Fatal(err)
			}
			if _, err = q.RequestVoiceCaptureStop(t.Context(), capture.ID); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err := env.pool.Exec(t.Context(), "UPDATE voice_media_epochs SET updated_at=clock_timestamp()-CASE WHEN id='epoch_first' THEN interval '10 seconds' ELSE interval '5 seconds' END"); err != nil {
		t.Fatal(err)
	}
	provider := recorder.provider(voicemedia.LiveKitConfig{}, env.pool)
	service := voicemedia.New(env.pool, provider, stoppedMediaInspector{})
	if _, err := service.RunJobStepForTest(t.Context(), voicemedia.CaptureReconcileArgs{CaptureSessionID: "capture_first"}); err != nil {
		t.Fatalf("reconcile pending Stop: %v", err)
	}
	next, err := q.ListVoiceMediaEpochsForReconcile(t.Context(), "capture_second")
	if err != nil || len(next) != 1 || next[0].ID != "epoch_second" {
		t.Fatalf("pending Stop blocked another Capture's inspection: next=%v err=%v", next, err)
	}
	if _, err := q.TransitionLiveKitCaptureStatus(t.Context(), store.TransitionLiveKitCaptureStatusParams{ID: "capture_second", Status: "finalizing"}); err != nil {
		t.Fatal(err)
	}
	if _, err := q.RequestSealVoiceMediaEpoch(t.Context(), "epoch_second"); err != nil {
		t.Fatal(err)
	}
	if _, err := q.RequestVoiceCaptureStop(t.Context(), "capture_second"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	results := make(chan error, 2)
	for _, captureID := range []string{"capture_first", "capture_second"} {
		go func() {
			_, err := service.RunJobStepForTest(ctx, voicemedia.CaptureStopArgs{CaptureSessionID: captureID})
			results <- err
		}()
	}
	seen := map[string]bool{}
	for range 2 {
		select {
		case id := <-stopRequests:
			seen[id] = true
		case <-ctx.Done():
			t.Fatal("stop requests were serialized or duplicated")
		}
	}
	if !seen["voice-staging/capture_first/epoch-0"] || !seen["voice-staging/capture_second/epoch-0"] {
		t.Fatalf("stop claims=%v", seen)
	}
	if _, err := q.GetOwedVoiceMediaStop(ctx, "capture_first"); err != nil {
		t.Fatalf("in-flight Stop is no longer owed: %v", err)
	}
	if _, err := service.RunJobStepForTest(ctx, voicemedia.CaptureReconcileArgs{CaptureSessionID: "capture_second"}); err != nil {
		t.Fatalf("media reconciliation blocked behind Stop: %v", err)
	}
	close(releaseStops)
	released = true
	for range 2 {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
}

type stoppedMediaInspector struct{}

func (stoppedMediaInspector) Materialize(context.Context, voicemedia.MaterializeRequest) (voicemedia.MaterializedAudio, error) {
	return voicemedia.MaterializedAudio{}, errors.New("unexpected materialization")
}
func (stoppedMediaInspector) SegmentCount(context.Context, string, int64) (int64, error) {
	return 0, errors.New("stopped media must not be checked for active segment progress")
}
func (stoppedMediaInspector) InspectSalvagePrefix(context.Context, string) (int64, error) {
	return 0, errors.New("stopped media must not be salvaged while sealing")
}

func TestLiveKitVoiceFinalizingCanFailAfterMediaFailure(t *testing.T) {
	allowParallelIntegrationTest(t)
	for _, name := range []string{"atomic-failure", "recover-stranded-finalizing", "absent-recorder", "lost-recorder", "lost-recorder-recent-stop", "recorder-recovered", "requested-stall"} {
		t.Run(name, func(t *testing.T) {
			// This family drives the real PostgreSQL recovery service and provider
			// protocol, not Room creation or login. Seed only its prerequisites in
			// a private DB; HTTP admission remains covered by the Voice API tests.
			pool, err := pgxpool.New(t.Context(), newIntegrationDatabase(t))
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(pool.Close)
			const roomID = "room_voice_failure"
			if _, err := pool.Exec(t.Context(), `
				INSERT INTO rooms(id,tenant_id,name,created_by_actor_id)
				VALUES('room_voice_failure','tenant_acme','Voice failure','actor_acme_alice');
				INSERT INTO room_members(room_id,tenant_id,actor_id,role,added_by_actor_id)
				VALUES('room_voice_failure','tenant_acme','actor_acme_alice','owner','actor_acme_alice');
			`); err != nil {
				t.Fatal(err)
			}
			q := store.New(pool)
			voice, err := q.CreateVoiceSession(t.Context(), store.CreateVoiceSessionParams{
				ID: "voice_session_failure", AccountID: "account_alice", RoomID: roomID, ProviderRoomName: "voice-failure", ParticipantIdentity: "publisher-failure", Purpose: "hardware_control",
			})
			if err != nil {
				t.Fatal(err)
			}
			capture, err := q.CreateLiveKitCaptureSession(t.Context(), store.CreateLiveKitCaptureSessionParams{
				ID: "capture_failure", AccountID: "account_alice", RoomID: roomID, VoiceSessionID: voice.ID,
			})
			if err != nil {
				t.Fatal(err)
			}
			if _, err = q.TransitionLiveKitCaptureStatus(t.Context(), store.TransitionLiveKitCaptureStatusParams{ID: capture.ID, Status: "finalizing"}); err != nil {
				t.Fatal(err)
			}
			epoch, err := q.CreateVoiceMediaEpoch(t.Context(), store.CreateVoiceMediaEpochParams{ID: "epoch_failure", VoiceSessionID: voice.ID, CaptureSessionID: capture.ID, StagingPrefix: "voice-staging/capture_failure/epoch-0"})
			if err != nil {
				t.Fatal(err)
			}
			if _, err = q.RequestSealVoiceMediaEpoch(t.Context(), epoch.ID); err != nil {
				t.Fatal(err)
			}
			if _, err = q.RequestVoiceCaptureStop(t.Context(), capture.ID); err != nil {
				t.Fatal(err)
			}
			recorder := newVoiceRecorderRoom(t, pool)
			if name == "requested-stall" {
				// The directive names the epoch, but its recorder never
				// uploads a segment; withdrawing it seals nothing.
				recorder.direct(voice.ProviderRoomName, epoch.StagingPrefix)
				recorder.stop = func(ctx context.Context, prefix string) {
					recorder.report(ctx, prefix, "failed", time.Time{}, 0)
				}
			}
			if name == "recorder-recovered" {
				recorder.report(t.Context(), epoch.StagingPrefix, "active", capture.CreatedAt.Time, 0)
			}
			provider := recorder.provider(voicemedia.LiveKitConfig{}, pool)
			service := voicemedia.New(pool, provider, absentMediaInspector{})
			if name == "recover-stranded-finalizing" {
				if _, err = q.MarkVoiceMediaEpochFailed(t.Context(), store.MarkVoiceMediaEpochFailedParams{ID: epoch.ID, LastFailureCode: textForVoiceTest("egress_failed_without_media")}); err != nil {
					t.Fatal(err)
				}
				if _, err = pool.Exec(t.Context(), "UPDATE voice_media_epochs SET updated_at=clock_timestamp()-interval '5 seconds' WHERE id=$1", epoch.ID); err != nil {
					t.Fatal(err)
				}
				if _, err := service.RunJobStepForTest(t.Context(), voicemedia.CaptureReconcileArgs{CaptureSessionID: capture.ID}); err != nil {
					t.Fatalf("failed epoch recovery: %v", err)
				}
			} else if name == "atomic-failure" {
				if err = q.FailVoiceMediaEpochWithoutMedia(t.Context(), epoch.ID); err != nil {
					t.Fatal(err)
				}
			} else {
				if _, err = pool.Exec(t.Context(), "UPDATE voice_media_epochs SET observed_state='unknown',created_at=clock_timestamp()-interval '2 minutes',updated_at=clock_timestamp()-interval '5 seconds' WHERE id=$1", epoch.ID); err != nil {
					t.Fatal(err)
				}
				if name == "requested-stall" {
					if _, err = pool.Exec(t.Context(), "UPDATE voice_media_epochs SET desired_state='active',observed_state='requested' WHERE id=$1", epoch.ID); err != nil {
						t.Fatal(err)
					}
					if _, err = pool.Exec(t.Context(), "UPDATE capture_sessions SET status='starting' WHERE id=$1", capture.ID); err != nil {
						t.Fatal(err)
					}
				}
				if strings.HasPrefix(name, "lost-recorder") {
					if _, err = pool.Exec(t.Context(), "UPDATE voice_media_epochs SET provider_egress_id=staging_prefix WHERE id=$1", epoch.ID); err != nil {
						t.Fatal(err)
					}
					if name == "lost-recorder" {
						if _, err = pool.Exec(t.Context(), "UPDATE capture_sessions SET stop_requested_at=clock_timestamp()-interval '2 minutes' WHERE id=$1", capture.ID); err != nil {
							t.Fatal(err)
						}
					}
				}
				if _, err := service.RunJobStepForTest(t.Context(), voicemedia.CaptureReconcileArgs{CaptureSessionID: capture.ID}); err != nil {
					t.Fatalf("reconcile missing recorder: %v", err)
				}
			}
			current, err := q.GetCaptureSessionForAccount(t.Context(), store.GetCaptureSessionForAccountParams{ID: capture.ID, AccountID: textForVoiceTest("account_alice")})
			if name == "recorder-recovered" || name == "lost-recorder-recent-stop" {
				if err != nil || current.Status != "finalizing" {
					t.Fatalf("unconfirmed provider absence failed a Capture: status=%s err=%v", current.Status, err)
				}
				return
			}
			if err != nil || current.Status != "failed" {
				t.Fatalf("Capture status=%s err=%v", current.Status, err)
			}
			closing, err := q.GetVoiceSessionForAccount(t.Context(), store.GetVoiceSessionForAccountParams{ID: voice.ID, AccountID: "account_alice"})
			if err != nil || closing.Status != "closing" {
				t.Fatalf("VoiceSession status=%s err=%v", closing.Status, err)
			}
			if terminal, err := service.EndCapture(t.Context(), voicemedia.EndCaptureRequest{AccountID: "account_alice", CaptureSessionID: capture.ID}); err != nil || terminal.Status != "failed" {
				t.Fatalf("terminal Stop status=%s err=%v", terminal.Status, err)
			}
		})
	}
}

type absentMediaInspector struct{ stoppedMediaInspector }

func (absentMediaInspector) SegmentCount(context.Context, string, int64) (int64, error) {
	return 0, nil
}

func (absentMediaInspector) InspectSalvagePrefix(context.Context, string) (int64, error) {
	return 0, voicemedia.ErrNoSalvageMedia
}

func TestLiveKitVoiceFlushSurvivesMediaSealingOrder(t *testing.T) {
	allowParallelIntegrationTest(t)
	const aliceAccountID = "account_alice"
	for _, scenario := range []struct {
		flushFirst             bool
		endedMS, wantEndMS     int64
		restart, previousFlush bool
	}{{true, 3500, 3000, false, false}, {false, 3500, 3000, false, false}, {true, 2850, 2850, false, false}, {false, 2850, 2850, false, false},
		{true, 3500, 0, true, false}, {false, 3500, 0, true, false}, {false, 3500, 3000, true, true}} {
		flushFirst := scenario.flushFirst
		name := "media-first"
		if flushFirst {
			name = "flush-first"
		}
		t.Run(name, func(t *testing.T) {
			env, alice, _ := newVoiceServiceEnv(t, func(cfg *config.Config) { cfg.Voice.RuntimeToken = "voice-test-service-token" })
			roomID := env.createRoom(alice, acmeTenant, "Voice recovery", "voice-recovery-room")
			q := store.New(env.pool)
			voice, err := q.CreateVoiceSession(t.Context(), store.CreateVoiceSessionParams{
				ID: "voice_session_recovery", AccountID: aliceAccountID, AuthSessionID: loginSessionOf(t, env, aliceAccountID), RoomID: roomID, ProviderRoomName: "voice-recovery", ParticipantIdentity: "publisher-recovery", Purpose: "hardware_control",
			})
			if err != nil {
				t.Fatal(err)
			}
			if err = q.RecordVoiceInputBoundary(t.Context(), store.RecordVoiceInputBoundaryParams{VoiceSessionID: voice.ID, Kind: "track_started", OffsetMs: 500}); err != nil {
				t.Fatal(err)
			}
			capture, err := q.CreateLiveKitCaptureSession(t.Context(), store.CreateLiveKitCaptureSessionParams{
				ID: "capture_recovery", AccountID: aliceAccountID, RoomID: roomID, VoiceSessionID: voice.ID, StartOffsetMs: 1000,
			})
			if err != nil {
				t.Fatal(err)
			}
			epoch, err := q.CreateVoiceMediaEpoch(t.Context(), store.CreateVoiceMediaEpochParams{
				ID: "epoch_recovery", VoiceSessionID: voice.ID, CaptureSessionID: capture.ID, StagingPrefix: "voice-staging/capture_recovery/epoch-0",
			})
			if err != nil {
				t.Fatal(err)
			}
			if _, err = q.ActivateVoiceMediaEpoch(t.Context(), store.ActivateVoiceMediaEpochParams{ID: epoch.ID, ProviderEgressID: textForVoiceTest("egress_recovery"), FirstArchivedMs: pgtype.Int8{Valid: true}}); err != nil {
				t.Fatal(err)
			}
			if _, err = q.TransitionLiveKitCaptureStatus(t.Context(), store.TransitionLiveKitCaptureStatusParams{ID: capture.ID, Status: "recording"}); err != nil {
				t.Fatal(err)
			}
			if scenario.restart {
				if scenario.previousFlush {
					if err = q.RecordVoiceInputBoundary(t.Context(), store.RecordVoiceInputBoundaryParams{VoiceSessionID: voice.ID, Kind: "track_ended", OffsetMs: 1400}); err != nil {
						t.Fatal(err)
					}
				}
				if err = q.RecordVoiceInputBoundary(t.Context(), store.RecordVoiceInputBoundaryParams{VoiceSessionID: voice.ID, Kind: "track_started", OffsetMs: 1500}); err != nil {
					t.Fatal(err)
				}
			}
			flush := func() {
				t.Helper()
				payload, _ := json.Marshal(map[string]any{"voice_session_id": voice.ID, "event_id": "ended-recovery", "media_epoch": 0, "lane": "live", "kind": "track_ended", "start_offset_ms": scenario.endedMS, "end_offset_ms": scenario.endedMS})
				request, err := http.NewRequestWithContext(t.Context(), http.MethodPost, env.server.URL+"/internal/v1/voice/observations", bytes.NewReader(payload))
				if err != nil {
					t.Fatal(err)
				}
				request.Header.Set("Content-Type", "application/json")
				request.Header.Set("Authorization", "Bearer voice-test-service-token")
				response, err := http.DefaultClient.Do(request)
				if err != nil {
					t.Fatal(err)
				}
				defer response.Body.Close()
				if response.StatusCode != http.StatusAccepted {
					t.Fatalf("flush status=%d", response.StatusCode)
				}
			}
			if flushFirst {
				flush()
			}
			if _, err = q.TransitionLiveKitCaptureStatus(t.Context(), store.TransitionLiveKitCaptureStatusParams{ID: capture.ID, Status: "finalizing"}); err != nil {
				t.Fatal(err)
			}
			if _, err = q.SealVoiceMediaEpochAtBoundary(t.Context(), store.SealVoiceMediaEpochAtBoundaryParams{
				ID: epoch.ID, PlaylistObjectKey: textForVoiceTest("sealed.m3u8"), ArchivedThroughMs: pgtype.Int8{Int64: 2500, Valid: true}, FinalEndMs: pgtype.Int8{Int64: 2000, Valid: true},
			}); err != nil {
				t.Fatal(err)
			}
			if !flushFirst {
				flush()
			}
			if err = q.FreezeReadyVoiceTranscripts(t.Context()); err != nil {
				t.Fatal(err)
			}
			current, err := q.GetCaptureSessionForAccount(t.Context(), store.GetCaptureSessionForAccountParams{ID: capture.ID, AccountID: textForVoiceTest(aliceAccountID)})
			if err != nil {
				t.Fatal(err)
			}
			if scenario.wantEndMS == 0 {
				if current.TranscriptEndOffsetMs.Valid {
					t.Fatal("a later stream end concealed an unconfirmed input interval")
				}
				if _, err = q.FinalizeLiveKitCapture(t.Context(), store.FinalizeLiveKitCaptureParams{ID: capture.ID}); !errors.Is(err, pgx.ErrNoRows) {
					t.Fatalf("incomplete transcript bypassed final commit fencing: %v", err)
				}
				return
			}
			if !current.TranscriptEndOffsetMs.Valid || current.TranscriptEndOffsetMs.Int64 != scenario.wantEndMS {
				t.Fatalf("transcript end=%v", current.TranscriptEndOffsetMs)
			}
			coverage, err := q.GetCaptureTranscriptAcceptedOffset(t.Context(), capture.ID)
			if err != nil || coverage < scenario.wantEndMS {
				t.Fatalf("coverage=%d err=%v", coverage, err)
			}
		})
	}
}

func textForVoiceTest(value string) pgtype.Text { return pgtype.Text{String: value, Valid: true} }

// aliceCapture reads a Capture the voice tests record as account_alice.
func aliceCapture(id string) store.GetCaptureSessionForAccountParams {
	return store.GetCaptureSessionForAccountParams{ID: id, AccountID: textForVoiceTest("account_alice")}
}
