package integration_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/livekit/protocol/livekit"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
	"google.golang.org/protobuf/proto"
)

func TestLiveKitPublisherDepartureReleasesSessionAfterGrace(t *testing.T) {
	allowParallelIntegrationTest(t)
	for _, scenario := range []string{"idle", "recording", "publisher-returned", "credential-renewed", "input-resumed", "provider-outage"} {
		t.Run(scenario, func(t *testing.T) {
			env, alice, _ := newHardwareVoiceCaptureEnvWithStorageAndLimitsAndConfig(t, 1<<20, 1<<30, nil)
			queries := store.New(env.pool)
			roomID := env.createRoom(alice, acmeTenant, "Voice departure", "departure-room")
			session, err := queries.CreateVoiceSession(t.Context(), store.CreateVoiceSessionParams{ID: "voice_departure", AccountID: "account_alice", AuthSessionID: loginSessionOf(t, env, "account_alice"), RoomID: roomID, ProviderRoomName: "voice-departure", ParticipantIdentity: "publisher", Purpose: "hardware_control"})
			if err != nil {
				t.Fatal(err)
			}
			if scenario == "recording" {
				capture, err := queries.CreateLiveKitCaptureSession(t.Context(), store.CreateLiveKitCaptureSessionParams{ID: "capture_departure", AccountID: "account_alice", RoomID: roomID, VoiceSessionID: session.ID})
				if err != nil {
					t.Fatal(err)
				}
				if _, err = queries.CreateVoiceMediaEpoch(t.Context(), store.CreateVoiceMediaEpochParams{ID: "epoch_departure", VoiceSessionID: session.ID, CaptureSessionID: capture.ID, StagingPrefix: "voice/departure"}); err != nil {
					t.Fatal(err)
				}
				if _, err = queries.TransitionLiveKitCaptureStatus(t.Context(), store.TransitionLiveKitCaptureStatusParams{ID: capture.ID, Status: "recording"}); err != nil {
					t.Fatal(err)
				}
			}
			var publisherPresent, renewCredential, inputResumed, unavailable, deleted atomic.Bool
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				if strings.HasSuffix(request.URL.Path, "/ListParticipants") {
					if unavailable.Load() {
						response.Header().Set("Content-Type", "application/json")
						response.WriteHeader(http.StatusServiceUnavailable)
						_, _ = response.Write([]byte(`{"code":"unavailable","msg":"test outage"}`))
						return
					}
					if renewCredential.Load() {
						if _, err := queries.AdvanceVoiceSessionCredentialGeneration(request.Context(), session.ID); err != nil {
							t.Error(err)
						}
					}
					if inputResumed.Load() {
						if err := queries.RecordVoiceInputBoundary(request.Context(), store.RecordVoiceInputBoundaryParams{VoiceSessionID: session.ID, Kind: "track_started", OffsetMs: 100}); err != nil {
							t.Error(err)
						}
					}
					participants := &livekit.ListParticipantsResponse{}
					if publisherPresent.Load() {
						participants.Participants = []*livekit.ParticipantInfo{{Identity: "publisher", State: livekit.ParticipantInfo_ACTIVE}}
					}
					encoded, err := proto.Marshal(participants)
					if err != nil {
						t.Error(err)
					}
					response.Header().Set("Content-Type", "application/protobuf")
					_, _ = response.Write(encoded)
					return
				}
				if strings.HasSuffix(request.URL.Path, "/CreateRoom") {
					t.Error("reconciliation must not recreate an absent publisher room")
				}
				if strings.HasSuffix(request.URL.Path, "/DeleteRoom") {
					deleted.Store(true)
				}
				response.Header().Set("Content-Type", "application/protobuf")
				response.WriteHeader(http.StatusOK)
			}))
			defer server.Close()
			provider, err := voicemedia.NewLiveKitProvider(voicemedia.LiveKitConfig{APIURL: server.URL, PublicURL: server.URL, APIKey: "test", APISecret: "test"}, env.pool)
			if err != nil {
				t.Fatal(err)
			}
			service := voicemedia.New(env.pool, provider, nil)
			ageSession := func() {
				t.Helper()
				if _, err := env.pool.Exec(t.Context(), "UPDATE voice_sessions SET updated_at=clock_timestamp()-interval '61 seconds' WHERE id=$1", session.ID); err != nil {
					t.Fatal(err)
				}
			}
			readSession := func() store.VoiceSession {
				t.Helper()
				current, err := queries.GetVoiceSessionForAccount(t.Context(), store.GetVoiceSessionForAccountParams{AccountID: "account_alice", ID: session.ID})
				if err != nil {
					t.Fatal(err)
				}
				return current
			}
			reconcile := func() (time.Duration, error) {
				return service.RunJobStepForTest(t.Context(), voicemedia.VoiceSessionReconcileArgs{VoiceSessionID: session.ID})
			}
			ageSession()
			if _, err := reconcile(); err != nil {
				t.Fatalf("first absence: %v", err)
			}
			if current := readSession(); current.Status != "reconnecting" || current.LastFailureCode.String != "publisher_absent" || deleted.Load() {
				t.Fatalf("first absence must preserve session during grace: %s %s deleted=%v", current.Status, current.LastFailureCode.String, deleted.Load())
			}
			if next, err := reconcile(); err != nil || next < 30*time.Second {
				t.Fatalf("grace must not be consumed by another step: next=%v err=%v", next, err)
			}
			publisherPresent.Store(scenario == "publisher-returned")
			renewCredential.Store(scenario == "credential-renewed")
			inputResumed.Store(scenario == "input-resumed")
			unavailable.Store(scenario == "provider-outage")
			ageSession()
			if _, reconcileErr := reconcile(); (reconcileErr != nil) != unavailable.Load() {
				t.Fatalf("second observation: err=%v", reconcileErr)
			}
			switch scenario {
			case "publisher-returned", "credential-renewed", "input-resumed", "provider-outage":
				if current := readSession(); current.Status == "closed" || current.Status == "closing" || deleted.Load() {
					t.Fatalf("publisher recovery or provider outage must not close the session: %s", current.Status)
				}
				if publisherPresent.Load() && readSession().LastFailureCode.Valid {
					t.Fatal("a returning publisher must clear the absence deadline")
				}
				return
			case "recording":
				capture, err := queries.GetCaptureSessionForAccount(t.Context(), store.GetCaptureSessionForAccountParams{ID: "capture_departure", AccountID: pgtype.Text{String: "account_alice", Valid: true}})
				if err != nil || capture.Status != "finalizing" || readSession().Status != "closing" || deleted.Load() {
					t.Fatalf("departure must stop the capture before deleting its room: status=%s err=%v", capture.Status, err)
				}
				ageSession()
				if _, err := reconcile(); err != nil || deleted.Load() {
					t.Fatalf("finalization must retain late-final callback authority: err=%v", err)
				}
				if _, err := env.pool.Exec(t.Context(), "UPDATE capture_sessions SET status='recovering' WHERE id=$1", capture.ID); err != nil {
					t.Fatal(err)
				}
				ageSession()
				if _, err := reconcile(); err != nil {
					t.Fatalf("close after capture stops: %v", err)
				}
			}
			if readSession().Status != "closed" || !deleted.Load() {
				t.Fatal("expired publisher must release both the DB session and LiveKit room")
			}
			if _, err := queries.CreateVoiceSession(t.Context(), store.CreateVoiceSessionParams{ID: "voice_after_departure", AccountID: "account_alice", AuthSessionID: loginSessionOf(t, env, "account_alice"), RoomID: roomID, ProviderRoomName: "voice-after-departure", ParticipantIdentity: "new-publisher", Purpose: "hardware_control"}); err != nil {
				t.Fatalf("old session still blocks a new recording: %v", err)
			}
		})
	}
}
