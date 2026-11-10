package voicemedia

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"google.golang.org/protobuf/proto"
)

func TestLiveKitDictationCommitUsesReliableServerData(t *testing.T) {
	var sent livekit.SendDataRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/SendData") {
			t.Errorf("unexpected media API method %s", r.URL.Path)
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
		}
		if err := proto.Unmarshal(body, &sent); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/protobuf")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	provider, err := NewLiveKitProvider(LiveKitConfig{APIURL: server.URL, PublicURL: server.URL, APIKey: "test", APISecret: "test"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := provider.CommitDictationTurn(t.Context(), providerSession{RoomName: "voice-chat", Purpose: PurposeHardwareControl}, "commit-1"); !errors.Is(err, ErrCaptureConflict) {
		t.Fatalf("hardware control accepted dictation commit: %v", err)
	}
	if err := provider.CommitDictationTurn(t.Context(), providerSession{RoomName: "voice-chat", Purpose: PurposeChatDictation}, "commit-1"); err != nil {
		t.Fatal(err)
	}
	if sent.Room != "voice-chat" || sent.Kind != livekit.DataPacket_RELIABLE || sent.GetTopic() != "linger.voice.dictation.commit" || string(sent.Data) != `{"request_id":"commit-1"}` {
		t.Fatalf("unexpected dictation control packet: %+v", &sent)
	}
	var metadata map[string]string
	if err := json.Unmarshal([]byte(voiceRuntimeDispatchMetadata(time.Unix(100, 0), PurposeChatDictation)), &metadata); err != nil {
		t.Fatal(err)
	}
	if metadata["voice_purpose"] != PurposeChatDictation || metadata["voice_session_created_at"] != "1970-01-01T00:01:40Z" {
		t.Fatalf("dictation dispatch metadata=%v", metadata)
	}
}

func TestLiveKitPublisherGrantIsShortLivedAndPublishOnly(t *testing.T) {
	provider, err := NewLiveKitProvider(LiveKitConfig{
		APIURL: "http://127.0.0.1:7880", PublicURL: "ws://127.0.0.1:7880",
		APIKey: "test-key", APISecret: "test-secret-at-least-thirty-two-bytes",
		CredentialTTL: 5 * time.Minute, SegmentDuration: 2,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	provider.now = func() time.Time { return time.Unix(1_800_000_000, 0) }
	grant, err := provider.IssuePublisherGrant(context.Background(), providerSession{
		RoomName: "voice-room", ParticipantIdentity: "voice-publisher",
	}, 7)
	if err != nil {
		t.Fatal(err)
	}
	if grant.Endpoint != "ws://127.0.0.1:7880" || grant.Generation != 7 ||
		!grant.ExpiresAt.Equal(time.Unix(1_800_000_000, 0).Add(5*time.Minute)) {
		t.Fatalf("unexpected grant metadata: %+v", grant)
	}
	verifier, err := auth.ParseAPIToken(grant.Credential)
	if err != nil {
		t.Fatal(err)
	}
	_, claims, err := verifier.Verify("test-secret-at-least-thirty-two-bytes")
	if err != nil {
		t.Fatal(err)
	}
	if claims.Identity != "voice-publisher" || claims.Video == nil || !claims.Video.RoomJoin ||
		claims.Video.Room != "voice-room" || !claims.Video.GetCanPublish() ||
		claims.Video.GetCanSubscribe() || claims.Video.GetCanPublishData() {
		t.Fatalf("publisher grant is over- or under-privileged: %+v", claims)
	}
	if claims.Attributes["linger.voice_generation"] != "7" {
		t.Fatal("publisher generation is not bound to the signed grant")
	}
}

func TestInputReadinessRequiresCurrentTrustedAgentAndPublisher(t *testing.T) {
	for _, test := range []struct {
		name                string
		kind                livekit.ParticipantInfo_Kind
		generation          string
		publisher           bool
		track               string
		publisherGeneration string
		want                int64
	}{
		{"publisher cannot acknowledge itself", livekit.ParticipantInfo_STANDARD, "2", true, "current-track", "2", 0},
		{"stale agent", livekit.ParticipantInfo_AGENT, "1", true, "current-track", "2", 0},
		{"current agent", livekit.ParticipantInfo_AGENT, "2", true, "current-track", "2", 2},
		{"publisher absent", livekit.ParticipantInfo_AGENT, "2", false, "current-track", "2", 0},
		{"old track after reconnect", livekit.ParticipantInfo_AGENT, "2", true, "old-track", "2", 0},
		{"track not yet acknowledged", livekit.ParticipantInfo_AGENT, "2", true, "", "2", 0},
		{"stale publisher", livekit.ParticipantInfo_AGENT, "2", true, "current-track", "1", 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				items := []*livekit.ParticipantInfo{{Identity: "consumer", Kind: test.kind, State: livekit.ParticipantInfo_ACTIVE, Attributes: map[string]string{
					"linger.voice_ready_generation": test.generation,
					"linger.voice_ready_track":      test.track,
					"linger.voice_ready_at":         strconv.FormatInt(time.Now().UnixMilli(), 10),
				}}}
				if test.publisher {
					items = append(items, &livekit.ParticipantInfo{
						Identity:   "publisher",
						State:      livekit.ParticipantInfo_ACTIVE,
						Attributes: map[string]string{"linger.voice_generation": test.publisherGeneration},
						Tracks:     []*livekit.TrackInfo{{Sid: "current-track", Source: livekit.TrackSource_MICROPHONE}},
					})
				}
				body, _ := proto.Marshal(&livekit.ListParticipantsResponse{Participants: items})
				w.Header().Set("Content-Type", "application/protobuf")
				_, _ = w.Write(body)
			}))
			defer server.Close()
			provider, err := NewLiveKitProvider(LiveKitConfig{APIURL: server.URL, PublicURL: server.URL, APIKey: "test", APISecret: "test"}, nil)
			if err != nil {
				t.Fatal(err)
			}
			ready, err := provider.InputReadyGeneration(t.Context(), providerSession{RoomName: "voice-room", ParticipantIdentity: "publisher"}, 2)
			if err != nil || ready != test.want {
				t.Fatalf("ready=%d want=%d err=%v", ready, test.want, err)
			}
		})
	}
}

func TestVoiceReadinessRejectsExpiredAndDisconnectedAgent(t *testing.T) {
	now := time.Now()
	for _, test := range []struct {
		name  string
		age   time.Duration
		state livekit.ParticipantInfo_State
		want  int64
	}{
		{"fresh", time.Second, livekit.ParticipantInfo_ACTIVE, 2},
		{"expired", 6 * time.Second, livekit.ParticipantInfo_ACTIVE, 0},
		{"future", -10 * time.Second, livekit.ParticipantInfo_ACTIVE, 0},
		{"disconnected", time.Second, livekit.ParticipantInfo_DISCONNECTED, 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, _ := proto.Marshal(&livekit.ListParticipantsResponse{Participants: []*livekit.ParticipantInfo{
					{Identity: "publisher", State: livekit.ParticipantInfo_ACTIVE,
						Attributes: map[string]string{"linger.voice_generation": "2"},
						Tracks:     []*livekit.TrackInfo{{Sid: "microphone", Source: livekit.TrackSource_MICROPHONE}}},
					{Identity: "consumer", State: test.state, Kind: livekit.ParticipantInfo_AGENT,
						Attributes: map[string]string{
							"linger.voice_ready_generation": "2",
							"linger.voice_ready_track":      "microphone",
							"linger.voice_ready_at":         strconv.FormatInt(now.Add(-test.age).UnixMilli(), 10),
						}},
				}})
				w.Header().Set("Content-Type", "application/protobuf")
				_, _ = w.Write(body)
			}))
			defer server.Close()
			provider, err := NewLiveKitProvider(LiveKitConfig{APIURL: server.URL, PublicURL: server.URL, APIKey: "test", APISecret: "test"}, nil)
			if err != nil {
				t.Fatal(err)
			}
			provider.now = func() time.Time { return now }
			ready, err := provider.InputReadyGeneration(t.Context(), providerSession{RoomName: "voice-room", ParticipantIdentity: "publisher"}, 2)
			if err != nil || ready != test.want {
				t.Fatalf("ready=%d want=%d err=%v", ready, test.want, err)
			}
		})
	}
}

type fakeRecordingEpochs map[string]store.VoiceMediaEpoch

func (f fakeRecordingEpochs) GetVoiceMediaEpochByStagingPrefix(_ context.Context, prefix string) (store.VoiceMediaEpoch, error) {
	epoch, ok := f[prefix]
	if !ok {
		return store.VoiceMediaEpoch{}, pgx.ErrNoRows
	}
	return epoch, nil
}

func reportedEpoch(prefix, state string, startedAt time.Time, archivedMS int64) store.VoiceMediaEpoch {
	epoch := store.VoiceMediaEpoch{StagingPrefix: prefix}
	if state != "" {
		epoch.RecorderState = pgtype.Text{String: state, Valid: true}
	}
	if !startedAt.IsZero() {
		epoch.RecorderStartedAt = pgtype.Timestamptz{Time: startedAt, Valid: true}
	}
	epoch.RecorderArchivedThroughMs = pgtype.Int8{Int64: archivedMS, Valid: true}
	return epoch
}

func TestObservationFromRecorderReflectsTheReportedState(t *testing.T) {
	startedAt := time.Date(2026, 10, 27, 1, 0, 0, 0, time.UTC)
	prefix := "voice-staging/capture/epoch-0"
	for _, test := range []struct {
		state, want, playlist string
		missing               bool
	}{
		{state: "", want: "unknown", missing: true},
		{state: "active", want: "active"},
		{state: "available", want: "available", playlist: prefix + ".m3u8"},
		{state: "failed", want: "failed"},
	} {
		observation := observationFromRecorder(reportedEpoch(prefix, test.state, startedAt, 12_000), startedAt)
		if observation.State != test.want || observation.Missing != test.missing || observation.PlaylistObjectKey != test.playlist || observation.ArchivedThroughMS != 12_000 ||
			!observation.StartedAt.Equal(startedAt) || observation.EgressID != prefix {
			t.Fatalf("recorder state %q gave observation %+v", test.state, observation)
		}
	}
}

func TestSilentActiveRecorderIsObservedAsLost(t *testing.T) {
	reportedAt := time.Date(2026, 10, 27, 1, 0, 0, 0, time.UTC)
	epoch := reportedEpoch("voice-staging/capture/epoch-0", "active", reportedAt, 6_000)
	epoch.RecorderReportedAt = pgtype.Timestamptz{Time: reportedAt, Valid: true}
	if observation := observationFromRecorder(epoch, reportedAt.Add(recorderLostAfter)); observation.State != "active" {
		t.Fatalf("recorder within the report window must stay active: %+v", observation)
	}
	if observation := observationFromRecorder(epoch, reportedAt.Add(recorderLostAfter+time.Second)); observation.State != "failed" || observation.ArchivedThroughMS != 6_000 {
		t.Fatalf("silent recorder must be lost with its archived prefix: %+v", observation)
	}
}

func TestObserveCaptureOfAnUnknownEpochIsMissing(t *testing.T) {
	provider, err := NewLiveKitProvider(LiveKitConfig{APIURL: "http://127.0.0.1:7880", PublicURL: "ws://127.0.0.1", APIKey: "test", APISecret: "test"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	provider.epochs = fakeRecordingEpochs{}
	observation, err := provider.ObserveCapture(t.Context(), providerCapture{StagingPrefix: "voice-staging/absent/epoch-0"})
	if err != nil || observation.State != "unknown" || !observation.Missing {
		t.Fatalf("absent epoch observation=%+v err=%v", observation, err)
	}
}

// recordingRoomServer serves ListRooms with the given metadata and records
// every UpdateRoomMetadata request.
func recordingRoomServer(t *testing.T, metadata string, updates chan<- string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
		}
		var result proto.Message
		switch {
		case strings.HasSuffix(r.URL.Path, "/ListRooms"):
			result = &livekit.ListRoomsResponse{Rooms: []*livekit.Room{{Name: "voice-room", Metadata: metadata}}}
		case strings.HasSuffix(r.URL.Path, "/UpdateRoomMetadata"):
			var request livekit.UpdateRoomMetadataRequest
			if err := proto.Unmarshal(body, &request); err != nil {
				t.Error(err)
			}
			updates <- request.Metadata
			result = &livekit.Room{Name: request.Room, Metadata: request.Metadata}
		default:
			t.Errorf("unexpected provider request %s", r.URL.Path)
			return
		}
		encoded, err := proto.Marshal(result)
		if err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/protobuf")
		_, _ = w.Write(encoded)
	}))
}

func TestStartCaptureNamesTheEpochAndWaitsForTheFirstSample(t *testing.T) {
	updates := make(chan string, 2)
	server := recordingRoomServer(t, "", updates)
	defer server.Close()
	provider, err := NewLiveKitProvider(LiveKitConfig{APIURL: server.URL, PublicURL: "ws://127.0.0.1", APIKey: "test", APISecret: "test", SegmentDuration: 2}, nil)
	if err != nil {
		t.Fatal(err)
	}
	prefix := "voice-staging/capture/epoch-0"
	startedAt := time.Now().UTC()
	provider.epochs = fakeRecordingEpochs{prefix: reportedEpoch(prefix, "active", startedAt, 0)}
	observation, err := provider.StartCapture(t.Context(), providerCapture{RoomName: "voice-room", CaptureSessionID: "capture", StagingPrefix: prefix})
	if err != nil || observation.State != "active" || !observation.StartedAt.Equal(startedAt) {
		t.Fatalf("start observation=%+v err=%v", observation, err)
	}
	var directive recordingDirective
	if err := json.Unmarshal([]byte(<-updates), &directive); err != nil || directive.Recording == nil ||
		directive.Recording.StagingPrefix != prefix || directive.Recording.SegmentSeconds != 2 {
		t.Fatalf("Room metadata must name the epoch to record: %+v err=%v", directive, err)
	}
}

func TestStartCaptureFailsWhenTheRecorderReportsFailure(t *testing.T) {
	server := recordingRoomServer(t, "", make(chan string, 2))
	defer server.Close()
	provider, err := NewLiveKitProvider(LiveKitConfig{APIURL: server.URL, PublicURL: "ws://127.0.0.1", APIKey: "test", APISecret: "test"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	prefix := "voice-staging/capture/epoch-0"
	provider.epochs = fakeRecordingEpochs{prefix: reportedEpoch(prefix, "failed", time.Time{}, 0)}
	observation, err := provider.StartCapture(t.Context(), providerCapture{RoomName: "voice-room", StagingPrefix: prefix})
	if err == nil || observation.State != "failed" {
		t.Fatalf("failed recorder must fail the start: observation=%+v err=%v", observation, err)
	}
}

func TestStopCaptureClearsOnlyItsOwnDirective(t *testing.T) {
	prefix := "voice-staging/capture/epoch-0"
	for _, test := range []struct {
		name, metadata string
		cleared        bool
	}{
		{name: "own", metadata: `{"recording":{"staging_prefix":"voice-staging/capture/epoch-0","segment_seconds":2}}`, cleared: true},
		{name: "recovery epoch", metadata: `{"recording":{"staging_prefix":"voice-staging/capture/epoch-1","segment_seconds":2}}`},
		{name: "already cleared", metadata: `{}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			updates := make(chan string, 2)
			server := recordingRoomServer(t, test.metadata, updates)
			defer server.Close()
			provider, err := NewLiveKitProvider(LiveKitConfig{APIURL: server.URL, PublicURL: "ws://127.0.0.1", APIKey: "test", APISecret: "test"}, nil)
			if err != nil {
				t.Fatal(err)
			}
			provider.epochs = fakeRecordingEpochs{prefix: reportedEpoch(prefix, "active", time.Now(), 4_000)}
			observation, err := provider.StopCapture(t.Context(), providerCapture{RoomName: "voice-room", StagingPrefix: prefix})
			if err != nil || observation.State != "sealing" {
				t.Fatalf("accepted stop must report sealing: observation=%+v err=%v", observation, err)
			}
			if cleared := len(updates) == 1; cleared != test.cleared {
				t.Fatalf("directive cleared=%t, want %t", cleared, test.cleared)
			}
			if test.cleared {
				if metadata := <-updates; metadata != `{}` {
					t.Fatalf("cleared directive metadata=%q", metadata)
				}
			}
		})
	}
}

func TestLiveKitConfigRejectsIncompleteProvider(t *testing.T) {
	if _, err := NewLiveKitProvider(LiveKitConfig{APIURL: "http://127.0.0.1:7880"}, nil); err == nil {
		t.Fatal("expected incomplete LiveKit configuration to fail")
	}
}

func TestVoiceRuntimeDispatchDetectionIsIdempotent(t *testing.T) {
	createdAt := time.Date(2026, 9, 3, 12, 0, 0, 0, time.UTC)
	metadata := voiceRuntimeDispatchMetadata(createdAt, PurposeHardwareControl)
	dispatches := []*livekit.AgentDispatch{
		{AgentName: "another-agent"},
		{
			AgentName: voiceRuntimeAgentName, Metadata: metadata,
			State: &livekit.AgentDispatchState{Jobs: []*livekit.Job{{
				State: &livekit.JobState{
					Status:              livekit.JobStatus_JS_RUNNING,
					ParticipantIdentity: "agent-job-1",
				},
			}}},
		},
	}
	if !hasVoiceRuntimeDispatch(voiceRuntimeAgentName, dispatches, metadata, map[string]struct{}{"agent-job-1": {}}, time.Time{}) {
		t.Fatal("existing Voice Runtime dispatch was not detected")
	}
	if hasVoiceRuntimeDispatch(voiceRuntimeAgentName, dispatches[:1], metadata, nil, time.Time{}) {
		t.Fatal("unrelated dispatch was treated as Voice Runtime")
	}
}

func TestRunningVoiceRuntimeDispatchRequiresItsAgentParticipant(t *testing.T) {
	metadata := voiceRuntimeDispatchMetadata(time.Date(2026, 9, 3, 12, 0, 0, 0, time.UTC), PurposeHardwareControl)
	dispatch := &livekit.AgentDispatch{
		Id: "dispatch-1", AgentName: voiceRuntimeAgentName, Metadata: metadata,
		State: &livekit.AgentDispatchState{Jobs: []*livekit.Job{{
			State: &livekit.JobState{
				Status:              livekit.JobStatus_JS_RUNNING,
				ParticipantIdentity: "agent-job-1",
			},
		}}},
	}
	if hasVoiceRuntimeDispatch(voiceRuntimeAgentName, []*livekit.AgentDispatch{dispatch}, metadata, nil, time.Time{}) {
		t.Fatal("stranded running job without its agent participant was treated as active")
	}
	participants := map[string]struct{}{"agent-job-1": {}}
	if !hasVoiceRuntimeDispatch(voiceRuntimeAgentName, []*livekit.AgentDispatch{dispatch}, metadata, participants, time.Time{}) {
		t.Fatal("running job with its agent participant was treated as stale")
	}
	if got := staleVoiceRuntimeDispatches(voiceRuntimeAgentName, []*livekit.AgentDispatch{dispatch}, metadata, nil, time.Time{}); len(got) != 1 || got[0] != "dispatch-1" {
		t.Fatalf("stale dispatches=%v want=[dispatch-1]", got)
	}
}

func TestStartingVoiceRuntimeDispatchIsNotReplacedBeforeItJoins(t *testing.T) {
	metadata := voiceRuntimeDispatchMetadata(time.Now(), PurposeHardwareControl)
	dispatch := &livekit.AgentDispatch{AgentName: voiceRuntimeAgentName, Metadata: metadata,
		State: &livekit.AgentDispatchState{Jobs: []*livekit.Job{{State: &livekit.JobState{
			Status: livekit.JobStatus_JS_RUNNING, ParticipantIdentity: "joining-agent", StartedAt: time.Now().Add(-10 * time.Second).UnixNano(),
		}}}},
	}
	if !hasVoiceRuntimeDispatch(voiceRuntimeAgentName, []*livekit.AgentDispatch{dispatch}, metadata, nil, time.Time{}) {
		t.Fatal("starting job was treated as an orphan before its join grace elapsed")
	}
	if hasVoiceRuntimeDispatch(voiceRuntimeAgentName, []*livekit.AgentDispatch{dispatch}, metadata, nil, time.Now().Add(-9*time.Second)) {
		t.Fatal("crashed job that already consumed input retained initial join grace")
	}
	if !hasVoiceRuntimeDispatch(voiceRuntimeAgentName, []*livekit.AgentDispatch{dispatch}, metadata, nil, time.Now().Add(-20*time.Second)) {
		t.Fatal("a newer job inherited its predecessor's completed join")
	}
	dispatch.State.Jobs[0].State.StartedAt = time.Now().Add(-2 * time.Minute).UnixNano()
	if hasVoiceRuntimeDispatch(voiceRuntimeAgentName, []*livekit.AgentDispatch{dispatch}, metadata, nil, time.Time{}) {
		t.Fatal("expired join grace retained an orphan job")
	}
}

func TestUnassignedVoiceRuntimeDispatchExpiresAfterWorkerOutage(t *testing.T) {
	metadata := voiceRuntimeDispatchMetadata(time.Now(), PurposeHardwareControl)
	for _, jobs := range [][]*livekit.Job{nil, {{State: &livekit.JobState{Status: livekit.JobStatus_JS_PENDING}}}, {{State: &livekit.JobState{Status: livekit.JobStatus_JS_RUNNING}}}} {
		dispatch := &livekit.AgentDispatch{Id: "unassigned", AgentName: voiceRuntimeAgentName, Metadata: metadata,
			State: &livekit.AgentDispatchState{CreatedAt: time.Now().Add(-10 * time.Second).UnixNano(), Jobs: jobs}}
		if !hasVoiceRuntimeDispatch(voiceRuntimeAgentName, []*livekit.AgentDispatch{dispatch}, metadata, nil, time.Time{}) {
			t.Fatal("a fresh dispatch lost its assignment grace")
		}
		dispatch.State.CreatedAt = time.Now().Add(-2 * time.Minute).UnixNano()
		if hasVoiceRuntimeDispatch(voiceRuntimeAgentName, []*livekit.AgentDispatch{dispatch}, metadata, nil, time.Time{}) {
			t.Fatal("an unassigned dispatch permanently blocked a replacement worker")
		}
		if got := staleVoiceRuntimeDispatches(voiceRuntimeAgentName, []*livekit.AgentDispatch{dispatch}, metadata, nil, time.Time{}); len(got) != 1 || got[0] != "unassigned" {
			t.Fatal("expired dispatch was not scheduled for replacement")
		}
	}
}

func TestClosingVoiceSessionRemovesTheWholeProviderRoom(t *testing.T) {
	methods := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		methods <- r.URL.Path
		w.Header().Set("Content-Type", "application/protobuf")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	provider, err := NewLiveKitProvider(LiveKitConfig{APIURL: server.URL, PublicURL: "ws://127.0.0.1", APIKey: "test", APISecret: "test-secret"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = provider.RevokePublisher(t.Context(), providerSession{RoomName: "voice-room", ParticipantIdentity: "publisher"}); err != nil {
		t.Fatal(err)
	}
	if method := <-methods; method != "/twirp/livekit.RoomService/DeleteRoom" {
		t.Fatalf("close used %s; the worker room must be removed", method)
	}
}

func TestBackgroundDispatchDoesNotAllocateAnIdleRoom(t *testing.T) {
	methods := make(chan string, 4)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		methods <- r.URL.Path
		w.Header().Set("Content-Type", "application/protobuf")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	provider, err := NewLiveKitProvider(LiveKitConfig{APIURL: server.URL, PublicURL: "ws://127.0.0.1", APIKey: "test", APISecret: "test-secret"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = provider.EnsureSession(t.Context(), providerSession{RoomName: "voice-room", ParticipantIdentity: "publisher", RequirePublisher: true}); !errors.Is(err, errPublisherAbsent) {
		t.Fatal(err)
	}
	if len(methods) != 1 {
		t.Fatalf("idle reconciliation made %d calls", len(methods))
	}
	if method := <-methods; method != "/twirp/livekit.RoomService/ListParticipants" {
		t.Fatalf("unexpected idle call %s", method)
	}
}

func TestHardwareSessionDispatchesASRAndRecorderSeparately(t *testing.T) {
	for _, test := range []struct {
		purpose string
		want    []string
	}{
		{purpose: PurposeHardwareControl, want: []string{voiceRuntimeAgentName, voiceRecorderAgentName}},
		{purpose: PurposeChatDictation, want: []string{voiceRuntimeAgentName}},
	} {
		t.Run(test.purpose, func(t *testing.T) {
			created := make(chan string, 4)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, err := io.ReadAll(r.Body)
				if err != nil {
					t.Error(err)
				}
				var result proto.Message = &livekit.ListParticipantsResponse{}
				switch {
				case strings.HasSuffix(r.URL.Path, "/CreateRoom"):
					result = &livekit.Room{Name: "voice-room"}
				case strings.HasSuffix(r.URL.Path, "/ListDispatch"):
					result = &livekit.ListAgentDispatchResponse{}
				case strings.HasSuffix(r.URL.Path, "/CreateDispatch"):
					var request livekit.CreateAgentDispatchRequest
					if err := proto.Unmarshal(body, &request); err != nil {
						t.Error(err)
					}
					created <- request.AgentName
					result = &livekit.AgentDispatch{Id: "dispatch-" + request.AgentName, AgentName: request.AgentName}
				}
				encoded, err := proto.Marshal(result)
				if err != nil {
					t.Error(err)
				}
				w.Header().Set("Content-Type", "application/protobuf")
				_, _ = w.Write(encoded)
			}))
			defer server.Close()
			provider, err := NewLiveKitProvider(LiveKitConfig{APIURL: server.URL, PublicURL: "ws://127.0.0.1", APIKey: "test", APISecret: "test-secret"}, nil)
			if err != nil {
				t.Fatal(err)
			}
			if err = provider.EnsureSession(t.Context(), providerSession{RoomName: "voice-room", Purpose: test.purpose, CreatedAt: time.Now()}); err != nil {
				t.Fatal(err)
			}
			close(created)
			var agents []string
			for agent := range created {
				agents = append(agents, agent)
			}
			if strings.Join(agents, ",") != strings.Join(test.want, ",") {
				t.Fatalf("dispatched agents=%v, want %v", agents, test.want)
			}
		})
	}
}

func TestTerminalVoiceRuntimeDispatchMustBeReplaced(t *testing.T) {
	metadata := voiceRuntimeDispatchMetadata(time.Date(2026, 9, 3, 12, 0, 0, 0, time.UTC), PurposeHardwareControl)
	for _, status := range []livekit.JobStatus{
		livekit.JobStatus_JS_SUCCESS,
		livekit.JobStatus_JS_FAILED,
	} {
		dispatch := &livekit.AgentDispatch{
			Id: "dispatch-1", AgentName: voiceRuntimeAgentName, Metadata: metadata,
			State: &livekit.AgentDispatchState{Jobs: []*livekit.Job{{
				State: &livekit.JobState{Status: status},
			}}},
		}
		if hasVoiceRuntimeDispatch(voiceRuntimeAgentName, []*livekit.AgentDispatch{dispatch}, metadata, nil, time.Time{}) {
			t.Fatalf("terminal %s dispatch was treated as active", status)
		}
		if got := staleVoiceRuntimeDispatches(voiceRuntimeAgentName, []*livekit.AgentDispatch{dispatch}, metadata, nil, time.Time{}); len(got) != 1 || got[0] != "dispatch-1" {
			t.Fatalf("stale dispatches=%v want=[dispatch-1]", got)
		}
	}
}

func TestVoiceRuntimeDispatchWithWrongSessionEpochMustBeReplaced(t *testing.T) {
	dispatch := &livekit.AgentDispatch{
		Id: "dispatch-1", AgentName: voiceRuntimeAgentName, Metadata: `{}`,
	}
	expected := voiceRuntimeDispatchMetadata(time.Date(2026, 9, 3, 12, 0, 0, 0, time.UTC), PurposeHardwareControl)
	if hasVoiceRuntimeDispatch(voiceRuntimeAgentName, []*livekit.AgentDispatch{dispatch}, expected, nil, time.Time{}) {
		t.Fatal("dispatch with stale epoch metadata was treated as active")
	}
	if got := staleVoiceRuntimeDispatches(voiceRuntimeAgentName, []*livekit.AgentDispatch{dispatch}, expected, nil, time.Time{}); len(got) != 1 {
		t.Fatalf("stale dispatches=%v want one", got)
	}
}
