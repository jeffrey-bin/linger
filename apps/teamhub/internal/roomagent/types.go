package roomagent

import (
	"context"
	"errors"
	"time"
)

// AgentManagement is the cross-process boundary through which TeamHub wakes
// Agent Service after it commits a change to an Agent registration row.
type AgentManagement interface {
	NotifyAgentRegistrationChanged(ctx context.Context, agentID string) error
}

type LocalAgentRuntimeStatus struct {
	ObservedAt       time.Time
	ConnectionStatus string
	AgentID          string
	ComputerID       string
	DisplayName      string
	ComputerStatus   string
	RuntimeType      string
	Status           string
	Version          string
	ErrorCode        string
	Message          string
}

type RuntimeContextRef struct {
	Kind       string
	AgentID    string
	RoomID     string
	TaskID     string
	DocumentID string
}

type RuntimeContextTarget struct {
	TenantID   string
	ContextKey string
	Ref        RuntimeContextRef
}

type RuntimeHistoryReadOptions struct {
	Cursor *string
	Limit  *int
}

// RuntimeHistory is one page of sanitized native Runtime history.
type RuntimeHistory struct {
	Status         string
	ProviderKind   string
	Reason         string
	Records        []RuntimeHistoryRecord
	PreviousCursor string
}

type RuntimeHistoryRecord struct {
	Ordinal        int
	Timestamp      *time.Time
	TurnID         string
	Category       string
	NativeType     string
	ToolCallID     string
	ToolName       string
	Role           string
	Phase          string
	NativeRecord   map[string]any
	RedactedFields []RuntimeHistoryRedactedField
}

type RuntimeHistoryRedactedField struct {
	Path      string
	Reason    string
	ByteCount *int64
}

var (
	ErrLocalComputerNotFound           = errors.New("Local Computer was not found")
	ErrLocalComputerHasAgents          = errors.New("Local Computer still has assigned Agents")
	ErrLocalComputerBusy               = errors.New("Local Computer still has active Operations")
	ErrLocalSkillCapabilityUnavailable = errors.New("Local Computer does not support local Skill scanning")
	ErrLocalComputerOffline            = errors.New("Local Computer is offline")
	ErrLocalBrowserUnsupported         = errors.New("Local Computer does not support browser connection")
	ErrLocalBrowserConnectionFailed    = errors.New("Local Computer browser connection failed")
	ErrLocalBrowserConnectionTimeout   = errors.New("Local Computer did not answer the browser connection command")
)

// LocalComputerManagement is TeamHub's seam for Local Computer commands that
// need the connected Computer; TeamHub lists and enrolls Computers itself.
type LocalComputerManagement interface {
	RemoveLocalComputer(ctx context.Context, tenantID, ownerActorID, computerID string) error
	ScanLocalSkills(ctx context.Context, command LocalSkillScanCommand) (LocalSkillScan, error)
	ConnectLocalBrowser(ctx context.Context, command LocalBrowserConnectionCommand) (LocalBrowserConnectionStatus, error)
	LocalComputerPermissions(ctx context.Context, command LocalComputerPermissionCommand) (LocalComputerPermissionStatus, error)
}

// LocalBrowserConnectionAction selects how a browser connection command changes the Computer.
type LocalBrowserConnectionAction string

const (
	LocalBrowserConnectionStatusAction LocalBrowserConnectionAction = "status"
	LocalBrowserConnectionConfigure    LocalBrowserConnectionAction = "configure"
	LocalBrowserConnectionDisconnect   LocalBrowserConnectionAction = "disconnect"
)

// LocalBrowserConnectionCommand reads or changes which browser the owner's Agents drive.
// ExtensionToken is set only for configure; it must never be logged or persisted.
type LocalBrowserConnectionCommand struct {
	TenantID, OwnerActorID, ComputerID string
	Action                             LocalBrowserConnectionAction
	Profile, ExtensionToken            string
}

// LocalBrowserConnectionError is a Computer-reported failure with its stable
// code, such as a rejected token or a missing extension. It is also
// ErrLocalBrowserConnectionFailed.
type LocalBrowserConnectionError struct{ Code string }

func (e *LocalBrowserConnectionError) Error() string {
	return ErrLocalBrowserConnectionFailed.Error() + ": " + e.Code
}

func (e *LocalBrowserConnectionError) Is(target error) bool {
	return target == ErrLocalBrowserConnectionFailed
}

// LocalBrowserConnectionStatus is the Computer-reported browser state without any token.
type LocalBrowserConnectionStatus struct {
	Mode, State, Platform, Browser, Profile, Message string
	ConfiguredAt, VerifiedAt                         *time.Time
}

type LocalSkillScanCommand struct {
	TenantID, OwnerActorID, ComputerID string
	CommandID, ScanID, RuntimeType     string
	ExpiresAt                          time.Time
}

type LocalSkillCandidate struct {
	NativeSource                                   *string `json:"native_source,omitempty"`
	NativeEnabled                                  *bool   `json:"native_enabled,omitempty"`
	CandidateRef, Name, Description, PackageSHA256 string
	FileCount                                      int
	SizeBytes                                      int64
	Normalizations, RiskFlags                      []string
	Importability, ErrorCode, ErrorDetail          string
	ManifestExcerpt                                string
}

type LocalSkillScan struct {
	ScanID, ComputerID, RuntimeType string
	ExpiresAt                       time.Time
	Items                           []LocalSkillCandidate
}

// RunManagement is TeamHub's outbound cancellation seam over the same Agent Service adapter.
type RunManagement interface {
	CancelRun(ctx context.Context, command RunCancelCommand) (RunCancelResult, error)
}

type RunCancelCommand struct {
	RequestID string
	RunID     string
	AgentID   string
	RoomID    string
}

type RunCancelResult struct {
	RunID  string
	Status string
}
