package voicemedia

import (
	"context"
	"errors"
	"time"
)

var (
	// ErrLiveUnavailable reports that the Room has no Agent that can join Live.
	ErrLiveUnavailable         = errors.New("Live requires an eligible Room Agent")
	ErrProviderUnavailable     = errors.New("voice media provider is unavailable")
	ErrSessionClosed           = errors.New("voice session is closed")
	ErrCaptureConflict         = errors.New("voice capture state conflicts with the requested operation")
	ErrTranscriptIncomplete    = errors.New("voice capture transcript is incomplete")
	ErrTranscriptIntegrityLost = errors.New("voice capture has an unconfirmed input interval")
	ErrNoSalvageMedia          = errors.New("voice media salvage prefix has no segments")
	errPublisherAbsent         = errors.New("voice publisher is absent")
)

const (
	PurposeHardwareControl = "hardware_control"
	PurposeChatDictation   = "chat_dictation"
	PurposeChatLive        = "chat_live"
)

type VoiceSession struct {
	ID                   string
	TenantID             string
	RoomID               string
	CreatedByActorID     string
	Status               string
	Purpose              string
	CredentialGeneration int64
	InputReadyGeneration *int64
	InputStartedOffsetMs *int64
	InputEndedOffsetMs   *int64
	LastFailureCode      string
	PartialTranscript    string
	PartialStartOffsetMs *int64
	PartialEndOffsetMs   *int64
	CreatedAt            time.Time
	UpdatedAt            time.Time
	ClosedAt             *time.Time
}

type CreateVoiceSessionRequest struct {
	AccountID string
	// AuthSessionID is the login session the VoiceSession belongs to.
	AuthSessionID string
	RoomID        string
	Purpose       string
}

type PublisherGrant struct {
	Endpoint   string
	Credential string
	ExpiresAt  time.Time
	Generation int64
}

type Capture struct {
	SourceAudioDocumentVersionID string
	TranscriptRecoveryStatus     string
	TranscriptRecoveryProgressMS int64
	TranscriptRecoveryTotalMS    int64
	AudioDocumentVersionID       string
	TranscriptDocumentVersionID  string
	ID                           string
	VoiceSessionID               string
	RoomID                       string
	Status                       string
	RequestedStartOffsetMS       int64
	ArchivedThroughMS            *int64
	GapCount                     int64
	GapDurationMS                int64
	LastFailureCode              string
	CreatedAt                    time.Time
	UpdatedAt                    time.Time
}

type BeginCaptureRequest struct {
	AccountID      string
	VoiceSessionID string
	RoomID         string
	StartOffsetMS  int64
}

type EndCaptureRequest struct {
	AccountID        string
	CaptureSessionID string
	EndOffsetMS      int64
}

type MaterializeRequest struct {
	AccountID        string
	CaptureSessionID string
	FromMS           int64
	ThroughMS        int64
	Purpose          string
}

type MaterializedAudio struct {
	ObjectKey  string
	Filename   string
	MediaType  string
	DurationMS int64
	SizeBytes  int64
	SHA256     string
}

type Plane interface {
	CreateVoiceSession(context.Context, CreateVoiceSessionRequest) (VoiceSession, error)
	GetVoiceSession(context.Context, string, string) (VoiceSession, error)
	GetActiveVoiceSession(context.Context, string, string, string) (VoiceSession, error)
	IssuePublisherGrant(context.Context, string, string) (PublisherGrant, error)
	CloseVoiceSession(context.Context, string, string) (VoiceSession, error)
	BeginCapture(context.Context, BeginCaptureRequest) (Capture, error)
	GetCapture(context.Context, string, string) (Capture, error)
	GetActiveCapture(context.Context, string, string) (Capture, error)
	EndCapture(context.Context, EndCaptureRequest) (Capture, error)
	RecordPublisherAbsence(context.Context, string, string, int64, int64) error
	RetryTranscriptRecovery(context.Context, string, string) error
	WakeMaterialization(context.Context, string) error
}

type providerSession struct {
	Purpose             string
	RequirePublisher    bool
	VoiceSessionID      string
	RoomName            string
	ParticipantIdentity string
	CreatedAt           time.Time
	LastInputStartedAt  time.Time
}

type providerCapture struct {
	VoiceSessionID   string
	CaptureSessionID string
	EpochID          string
	EpochIndex       int32
	RoomName         string
	StagingPrefix    string
	EgressID         string
}

type providerObservation struct {
	State             string
	StartedAt         time.Time
	Missing           bool
	EgressID          string
	PlaylistObjectKey string
	ArchivedThroughMS int64
}

type provider interface {
	EnsureSession(context.Context, providerSession) error
	IssuePublisherGrant(context.Context, providerSession, int64) (PublisherGrant, error)
	RevokePublisher(context.Context, providerSession) error
	StartCapture(context.Context, providerCapture) (providerObservation, error)
	ObserveCapture(context.Context, providerCapture) (providerObservation, error)
	StopCapture(context.Context, providerCapture) (providerObservation, error)
}

type inputReadinessProvider interface {
	InputReadyGeneration(context.Context, providerSession, int64) (int64, error)
}

type dictationCommitProvider interface {
	CommitDictationTurn(context.Context, providerSession, string) error
}

type materializer interface {
	Materialize(context.Context, MaterializeRequest) (MaterializedAudio, error)
}

type stagingCleaner interface {
	DeleteCaptureStaging(context.Context, string) error
}

type salvageInspector interface {
	InspectSalvagePrefix(context.Context, string) (int64, error)
	SegmentCount(context.Context, string, int64) (int64, error)
}
