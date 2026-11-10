package voicemedia

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
	"github.com/twitchtv/twirp"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type LiveKitConfig struct {
	APIURL          string
	PublicURL       string
	APIKey          string
	APISecret       string
	CredentialTTL   time.Duration
	SegmentDuration uint32
	StartTimeout    time.Duration
	StopTimeout     time.Duration
}

// LiveKitProvider owns the LiveKit Room, the Voice Runtime dispatch, and the
// recording directive. Voice Runtime records Capture media itself: TeamHub
// names the epoch to record in the Room metadata and observes the recorder
// reports it stores through the Voice Runtime API.
type LiveKitProvider struct {
	cfg      LiveKitConfig
	epochs   recordingEpochs
	rooms    *lksdk.RoomServiceClient
	dispatch *lksdk.AgentDispatchClient
	now      func() time.Time
	poll     time.Duration
}

const voiceRuntimeAgentName = "linger-voice-runtime"

// voiceRecorderAgentName is the separate Voice Runtime worker that records
// Capture media, so recording never shares an ASR job process.
const voiceRecorderAgentName = "linger-voice-recorder"

// recordingEpochs reads the recorder reports Voice Runtime stores for an epoch.
type recordingEpochs interface {
	GetVoiceMediaEpochByStagingPrefix(context.Context, string) (store.VoiceMediaEpoch, error)
}

func NewLiveKitProvider(cfg LiveKitConfig, pool *pgxpool.Pool) (*LiveKitProvider, error) {
	if err := validateLiveKitConfig(&cfg); err != nil {
		return nil, err
	}
	return &LiveKitProvider{
		cfg:      cfg,
		epochs:   store.New(pool),
		rooms:    lksdk.NewRoomServiceClient(cfg.APIURL, cfg.APIKey, cfg.APISecret),
		dispatch: lksdk.NewAgentDispatchServiceClient(cfg.APIURL, cfg.APIKey, cfg.APISecret),
		now:      time.Now, poll: 200 * time.Millisecond,
	}, nil
}

func validateLiveKitConfig(cfg *LiveKitConfig) error {
	for name, value := range map[string]string{
		"API URL": cfg.APIURL, "public URL": cfg.PublicURL, "API key": cfg.APIKey, "API secret": cfg.APISecret,
	} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("LiveKit %s is required", name)
		}
	}
	for _, raw := range []string{cfg.APIURL, cfg.PublicURL} {
		parsed, err := url.Parse(raw)
		if err != nil || parsed.Host == "" {
			return errors.New("LiveKit URLs must be absolute")
		}
	}
	if cfg.CredentialTTL <= 0 {
		cfg.CredentialTTL = 10 * time.Minute
	}
	if cfg.SegmentDuration == 0 {
		cfg.SegmentDuration = 2
	}
	if cfg.StartTimeout <= 0 {
		cfg.StartTimeout = 15 * time.Second
	}
	if cfg.StopTimeout <= 0 {
		cfg.StopTimeout = 30 * time.Second
	}
	return nil
}

func (p *LiveKitProvider) EnsureSession(ctx context.Context, session providerSession) error {
	if !session.RequirePublisher {
		if _, err := p.rooms.CreateRoom(ctx, &livekit.CreateRoomRequest{
			Name: session.RoomName, EmptyTimeout: 300, DepartureTimeout: 10, MaxParticipants: 8,
		}); err != nil {
			return err
		}
	}
	participants, err := p.rooms.ListParticipants(ctx, &livekit.ListParticipantsRequest{Room: session.RoomName})
	if session.RequirePublisher && isLiveKitNotFound(err) {
		return errPublisherAbsent
	}
	if err != nil {
		return err
	}
	participantIdentities := make(map[string]struct{}, len(participants.Participants))
	for _, participant := range participants.Participants {
		if participant != nil && participant.Identity != "" && participant.State == livekit.ParticipantInfo_ACTIVE {
			participantIdentities[participant.Identity] = struct{}{}
		}
	}
	if session.RequirePublisher {
		if _, present := participantIdentities[session.ParticipantIdentity]; !present {
			return errPublisherAbsent
		}
	}
	dispatches, err := p.dispatch.ListDispatch(ctx, &livekit.ListAgentDispatchRequest{Room: session.RoomName})
	if err != nil {
		return err
	}
	metadata := voiceRuntimeDispatchMetadata(session.CreatedAt, session.Purpose)
	agentName := voiceRuntimeAgentName
	if session.Purpose == PurposeChatLive {
		agentName = "linger-live-runtime"
	}
	if err = p.ensureAgentDispatch(ctx, session.RoomName, agentName, dispatches.AgentDispatches, metadata, participantIdentities, session.LastInputStartedAt); err != nil {
		return err
	}
	if session.Purpose != "" && session.Purpose != PurposeHardwareControl {
		return nil
	}
	// Only hardware Captures are recorded. The recorder consumes no ASR input,
	// so it keeps the initial join grace rather than the ASR input evidence.
	return p.ensureAgentDispatch(ctx, session.RoomName, voiceRecorderAgentName, dispatches.AgentDispatches, metadata, participantIdentities, time.Time{})
}

func (p *LiveKitProvider) ensureAgentDispatch(
	ctx context.Context,
	roomName, agent string,
	dispatches []*livekit.AgentDispatch,
	metadata string,
	participantIdentities map[string]struct{},
	lastInputStartedAt time.Time,
) error {
	if hasVoiceRuntimeDispatch(agent, dispatches, metadata, participantIdentities, lastInputStartedAt) {
		return nil
	}
	for _, dispatchID := range staleVoiceRuntimeDispatches(agent, dispatches, metadata, participantIdentities, lastInputStartedAt) {
		_, deleteErr := p.dispatch.DeleteDispatch(ctx, &livekit.DeleteAgentDispatchRequest{
			DispatchId: dispatchID,
			Room:       roomName,
		})
		if deleteErr != nil && !isLiveKitNotFound(deleteErr) {
			return deleteErr
		}
	}
	_, err := p.dispatch.CreateDispatch(ctx, &livekit.CreateAgentDispatchRequest{
		Room: roomName, AgentName: agent, Metadata: metadata,
	})
	return err
}

func voiceRuntimeDispatchMetadata(createdAt time.Time, purpose string) string {
	if purpose == "" {
		purpose = PurposeHardwareControl
	}
	encoded, _ := json.Marshal(struct {
		VoiceSessionCreatedAt string `json:"voice_session_created_at"`
		VoicePurpose          string `json:"voice_purpose"`
	}{VoiceSessionCreatedAt: createdAt.UTC().Format(time.RFC3339Nano), VoicePurpose: purpose})
	return string(encoded)
}

func (p *LiveKitProvider) CommitDictationTurn(ctx context.Context, session providerSession, requestID string) error {
	if session.Purpose != PurposeChatDictation {
		return ErrCaptureConflict
	}
	data, err := json.Marshal(httpapi.VoiceDictationCommitRequest{RequestId: requestID})
	if err != nil {
		return err
	}
	topic := "linger.voice.dictation.commit"
	_, err = p.rooms.SendData(ctx, &livekit.SendDataRequest{
		Room: session.RoomName, Data: data, Kind: livekit.DataPacket_RELIABLE, Topic: &topic,
	})
	return err
}

func (p *LiveKitProvider) IssuePublisherGrant(
	_ context.Context,
	session providerSession,
	generation int64,
) (PublisherGrant, error) {
	canPublish, canSubscribe, canPublishData := true, session.Purpose == PurposeChatLive, session.Purpose == PurposeChatLive
	grant := &auth.VideoGrant{
		RoomJoin: true, Room: session.RoomName,
		CanPublish: &canPublish, CanSubscribe: &canSubscribe, CanPublishData: &canPublishData,
		CanPublishSources: []string{"microphone"},
	}
	token, err := auth.NewAccessToken(p.cfg.APIKey, p.cfg.APISecret).
		SetIdentity(session.ParticipantIdentity).
		SetValidFor(p.cfg.CredentialTTL).
		SetAttributes(map[string]string{"linger.voice_generation": strconv.FormatInt(generation, 10)}).
		SetVideoGrant(grant).
		ToJWT()
	if err != nil {
		return PublisherGrant{}, err
	}
	return PublisherGrant{
		Endpoint: p.cfg.PublicURL, Credential: token,
		ExpiresAt: p.now().Add(p.cfg.CredentialTTL), Generation: generation,
	}, nil
}

func (p *LiveKitProvider) InputReadyGeneration(ctx context.Context, session providerSession, generation int64) (int64, error) {
	if generation <= 0 {
		return 0, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	participants, err := p.rooms.ListParticipants(ctx, &livekit.ListParticipantsRequest{Room: session.RoomName})
	if isLiveKitNotFound(err) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	publisherTracks := make(map[string]bool)
	for _, participant := range participants.Participants {
		if participant == nil || participant.State != livekit.ParticipantInfo_ACTIVE || participant.Identity != session.ParticipantIdentity ||
			participant.Attributes["linger.voice_generation"] != strconv.FormatInt(generation, 10) {
			continue
		}
		for _, track := range participant.Tracks {
			if track != nil && track.Sid != "" && track.Source == livekit.TrackSource_MICROPHONE {
				publisherTracks[track.Sid] = true
			}
		}
	}
	if len(publisherTracks) == 0 {
		return 0, nil
	}
	for _, participant := range participants.Participants {
		if participant == nil || participant.State != livekit.ParticipantInfo_ACTIVE || participant.Kind != livekit.ParticipantInfo_AGENT {
			continue
		}
		readyAt, timestampErr := strconv.ParseInt(participant.Attributes["linger.voice_ready_at"], 10, 64)
		age := p.now().Sub(time.UnixMilli(readyAt))
		if timestampErr != nil || readyAt <= 0 || age < -time.Second || age >= 5*time.Second {
			continue
		}
		ready, err := strconv.ParseInt(participant.Attributes["linger.voice_ready_generation"], 10, 64)
		if err == nil && ready == generation && publisherTracks[participant.Attributes["linger.voice_ready_track"]] {
			return ready, nil
		}
	}
	return 0, nil
}

func (p *LiveKitProvider) RevokePublisher(ctx context.Context, session providerSession) error {
	_, err := p.rooms.DeleteRoom(ctx, &livekit.DeleteRoomRequest{
		Room: session.RoomName,
	})
	if isLiveKitNotFound(err) {
		return nil
	}
	return err
}

func hasVoiceRuntimeDispatch(
	agent string,
	dispatches []*livekit.AgentDispatch,
	metadata string,
	participantIdentities map[string]struct{},
	lastInputStartedAt time.Time,
) bool {
	for _, dispatch := range dispatches {
		if activeVoiceRuntimeDispatch(agent, dispatch, metadata, participantIdentities, lastInputStartedAt) {
			return true
		}
	}
	return false
}

func activeVoiceRuntimeDispatch(
	agent string,
	dispatch *livekit.AgentDispatch,
	metadata string,
	participantIdentities map[string]struct{},
	lastInputStartedAt time.Time,
) bool {
	if dispatch == nil || dispatch.AgentName != agent || dispatch.Metadata != metadata {
		return false
	}
	state := dispatch.State
	if state == nil || len(state.Jobs) == 0 {
		return dispatchAwaitingAssignment(state)
	}
	for _, job := range state.Jobs {
		if job == nil || job.State == nil || job.State.Status == livekit.JobStatus_JS_PENDING {
			if dispatchAwaitingAssignment(state) {
				return true
			}
			continue
		}
		if job.State.Status == livekit.JobStatus_JS_RUNNING {
			if job.State.ParticipantIdentity == "" {
				if dispatchAwaitingAssignment(state) {
					return true
				}
				continue
			}
			if _, ok := participantIdentities[job.State.ParticipantIdentity]; ok {
				return true
			}
			// A job that already consumed input is no longer eligible for initial join grace.
			startedAt := time.Unix(0, job.State.StartedAt)
			age := time.Since(startedAt)
			joined := !lastInputStartedAt.IsZero() && !lastInputStartedAt.Before(startedAt)
			if !joined && job.State.StartedAt > 0 && age >= -5*time.Second && age < time.Minute {
				return true
			}
		}
	}
	return false
}

func dispatchAwaitingAssignment(state *livekit.AgentDispatchState) bool {
	// LiveKit can retain a dispatch with no assigned job after all workers were
	// unavailable. Registration of a later worker does not replay that request.
	if state == nil || state.CreatedAt <= 0 {
		return false
	}
	age := time.Since(time.Unix(0, state.CreatedAt))
	return age >= -5*time.Second && age < time.Minute
}

func staleVoiceRuntimeDispatches(
	agent string,
	dispatches []*livekit.AgentDispatch,
	metadata string,
	participantIdentities map[string]struct{},
	lastInputStartedAt time.Time,
) []string {
	stale := make([]string, 0, len(dispatches))
	for _, dispatch := range dispatches {
		if dispatch != nil && dispatch.AgentName == agent &&
			!activeVoiceRuntimeDispatch(agent, dispatch, metadata, participantIdentities, lastInputStartedAt) && dispatch.Id != "" {
			stale = append(stale, dispatch.Id)
		}
	}
	return stale
}

// isLiveKitNotFound reads the structured error code only. The LiveKit client
// surfaces a plain Twirp error, or a gRPC status when the response carries
// error details.
func isLiveKitNotFound(err error) bool {
	if err == nil {
		return false
	}
	var twirpErr twirp.Error
	if errors.As(err, &twirpErr) {
		return twirpErr.Code() == twirp.NotFound
	}
	return status.Code(err) == codes.NotFound
}

// recordingDirective is the Room metadata Voice Runtime follows: while it names
// an epoch, the runtime records that epoch's staging prefix. TeamHub is the
// only metadata writer.
type recordingDirective struct {
	Recording *recordingDirectiveEpoch `json:"recording,omitempty"`
}

type recordingDirectiveEpoch struct {
	StagingPrefix  string `json:"staging_prefix"`
	SegmentSeconds uint32 `json:"segment_seconds"`
}

func (p *LiveKitProvider) StartCapture(ctx context.Context, capture providerCapture) (providerObservation, error) {
	started := time.Now()
	if err := p.setRecordingDirective(ctx, capture.RoomName, &recordingDirectiveEpoch{
		StagingPrefix: capture.StagingPrefix, SegmentSeconds: p.cfg.SegmentDuration,
	}); err != nil {
		slog.WarnContext(ctx, "voice recording start failed", "phase", "directive", "error_code", providerFailureCode(err), "capture_session_id", capture.CaptureSessionID)
		return providerObservation{}, err
	}
	observation, err := p.waitForRecorderStart(ctx, capture)
	if err != nil {
		slog.WarnContext(ctx, "voice recording start failed", "phase", "activation", "error_code", providerFailureCode(err), "capture_session_id", capture.CaptureSessionID, "elapsed_ms", time.Since(started).Milliseconds())
	}
	return observation, err
}

func providerFailureCode(err error) string {
	var rpcError twirp.Error
	if errors.As(err, &rpcError) {
		return string(rpcError.Code())
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "deadline_exceeded"
	}
	if errors.Is(err, context.Canceled) {
		return "canceled"
	}
	return "provider_failed"
}

func (p *LiveKitProvider) ObserveCapture(ctx context.Context, capture providerCapture) (providerObservation, error) {
	epoch, err := p.epochs.GetVoiceMediaEpochByStagingPrefix(ctx, capture.StagingPrefix)
	if errors.Is(err, pgx.ErrNoRows) {
		return providerObservation{State: "unknown", Missing: true}, nil
	}
	if err != nil {
		return providerObservation{}, err
	}
	return observationFromRecorder(epoch, p.now()), nil
}

// StopCapture withdraws the directive. The recorder seals its playlist and
// reports available; the next reconciliation observes that.
func (p *LiveKitProvider) StopCapture(ctx context.Context, capture providerCapture) (providerObservation, error) {
	requestCtx, cancel := context.WithTimeout(ctx, p.cfg.StopTimeout)
	defer cancel()
	current, err := p.recordingDirective(requestCtx, capture.RoomName)
	if err != nil && !isLiveKitNotFound(err) {
		return providerObservation{}, err
	}
	// A recovery epoch may already own the directive; never clear its recording.
	if err == nil && current.Recording != nil && current.Recording.StagingPrefix == capture.StagingPrefix {
		if err = p.setRecordingDirective(requestCtx, capture.RoomName, nil); err != nil {
			return providerObservation{}, err
		}
	}
	observation, err := p.ObserveCapture(ctx, capture)
	if err != nil {
		return providerObservation{}, err
	}
	if observation.State == "active" {
		observation.State = "sealing"
	}
	return observation, nil
}

func (p *LiveKitProvider) recordingDirective(ctx context.Context, roomName string) (recordingDirective, error) {
	response, err := p.rooms.ListRooms(ctx, &livekit.ListRoomsRequest{Names: []string{roomName}})
	if err != nil {
		return recordingDirective{}, err
	}
	if len(response.Rooms) == 0 {
		return recordingDirective{}, twirp.NotFoundError("room does not exist")
	}
	var directive recordingDirective
	if raw := response.Rooms[0].Metadata; raw != "" {
		if err := json.Unmarshal([]byte(raw), &directive); err != nil {
			return recordingDirective{}, fmt.Errorf("voice Room metadata is invalid: %w", err)
		}
	}
	return directive, nil
}

func (p *LiveKitProvider) setRecordingDirective(ctx context.Context, roomName string, epoch *recordingDirectiveEpoch) error {
	encoded, err := json.Marshal(recordingDirective{Recording: epoch})
	if err != nil {
		return err
	}
	_, err = p.rooms.UpdateRoomMetadata(ctx, &livekit.UpdateRoomMetadataRequest{Room: roomName, Metadata: string(encoded)})
	return err
}

func (p *LiveKitProvider) waitForRecorderStart(ctx context.Context, capture providerCapture) (providerObservation, error) {
	deadlineCtx, cancel := context.WithTimeout(ctx, p.cfg.StartTimeout)
	defer cancel()
	last := providerObservation{State: "unknown", Missing: true}
	for {
		observation, err := p.ObserveCapture(deadlineCtx, capture)
		if err != nil {
			return last, err
		}
		last = observation
		if observation.State == "active" && !observation.StartedAt.IsZero() {
			return observation, nil
		}
		if observation.State == "failed" {
			return observation, errors.New("voice recorder failed")
		}
		select {
		case <-deadlineCtx.Done():
			return last, deadlineCtx.Err()
		case <-time.After(p.poll):
		}
	}
}

// observationFromRecorder maps the recorder reports. An epoch the recorder has
// not reported on is absent: recovery starts it and a finalizing epoch without
// media expires.
// A recording recorder reports after every uploaded segment. One silent for
// this long was killed without reporting, so it can no longer seal its epoch.
const recorderLostAfter = 20 * time.Second

func observationFromRecorder(epoch store.VoiceMediaEpoch, now time.Time) providerObservation {
	observation := providerObservation{State: "unknown", Missing: true, EgressID: epoch.StagingPrefix}
	if epoch.RecorderState.Valid {
		observation.Missing = false
	}
	switch epoch.RecorderState.String {
	case "active":
		observation.State = "active"
		if epoch.RecorderReportedAt.Valid && now.Sub(epoch.RecorderReportedAt.Time) > recorderLostAfter {
			observation.State = "failed"
		}
	case "available":
		observation.State = "available"
		observation.PlaylistObjectKey = epoch.StagingPrefix + ".m3u8"
	case "failed":
		observation.State = "failed"
	}
	if epoch.RecorderStartedAt.Valid {
		observation.StartedAt = epoch.RecorderStartedAt.Time
	}
	if epoch.RecorderArchivedThroughMs.Valid {
		observation.ArchivedThroughMS = epoch.RecorderArchivedThroughMs.Int64
	}
	return observation
}
