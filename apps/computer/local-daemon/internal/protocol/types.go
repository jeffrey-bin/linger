package protocol

import (
	"encoding/json"
	"time"

	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

// Command is the host-facing command envelope. The daemon core only depends on
// this local model; the Linger transport owns wire encoding and authentication.
type Command struct {
	Type                  string          `json:"type"`
	CommandID             string          `json:"command_id"`
	ProtocolVersion       string          `json:"protocol_version"`
	HostAccess            string          `json:"host_access,omitempty"`
	TenantID              string          `json:"tenant_id,omitempty"`
	RunnerID              string          `json:"runner_id,omitempty"`
	ExecutionContextKey   string          `json:"execution_context_key,omitempty"`
	RuntimeInstanceID     string          `json:"runtime_instance_id,omitempty"`
	ContextViewRef        json.RawMessage `json:"context_view_ref,omitempty"`
	OwnerActorID          string          `json:"owner_actor_id,omitempty"`
	RegistrationID        string          `json:"registration_id,omitempty"`
	AssignmentRevision    uint64          `json:"assignment_revision,omitempty"`
	AgentID               string          `json:"agent_id,omitempty"`
	OperationID           string          `json:"operation_id,omitempty"`
	OperationKind         string          `json:"-"`
	ConnectionEpoch       uint64          `json:"connection_epoch,omitempty"`
	RunnerRevision        uint64          `json:"runner_revision,omitempty"`
	Generation            uint64          `json:"generation,omitempty"`
	ExecutionLeaseID      string          `json:"execution_lease_id,omitempty"`
	WorkspaceGrantID      string          `json:"workspace_grant_id,omitempty"`
	RuntimeType           string          `json:"runtime_type,omitempty"`
	ViewDigest            string          `json:"view_digest,omitempty"`
	ExpectedTurnID        string          `json:"expected_turn_id,omitempty"`
	InputContextViewRef   json.RawMessage `json:"input_context_view_ref,omitempty"`
	Input                 json.RawMessage `json:"input,omitempty"`
	HeartbeatIntervalMs   int64           `json:"heartbeat_interval_ms,omitempty"`
	ThroughSequence       uint64          `json:"through_seq,omitempty"`
	ReconcileOperationIDs []string        `json:"reconcile_operation_ids,omitempty"`
	ContextContentURL     string          `json:"context_content_url,omitempty"`
	TargetRelease         *TargetRelease  `json:"target_release,omitempty"`
	Payload               json.RawMessage `json:"payload,omitempty"`
}

// TargetRelease is the Computer build the Agent's own image ships, keyed by
// release target such as darwin-arm64.
type TargetRelease struct {
	Targets map[string]TargetReleaseFiles `json:"targets"`
}

// TargetReleaseFiles names the app and dependency archives of one target.
type TargetReleaseFiles struct {
	App  ReleaseFile `json:"app"`
	Deps ReleaseFile `json:"deps"`
}

// ReleaseFile identifies one release archive by content.
type ReleaseFile struct {
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

// Event is the host-facing event envelope. The Daemon keeps an Operation's
// unacknowledged events and its terminal in memory until the Gateway
// acknowledges them.
type Event struct {
	Type                string          `json:"type"`
	Stage               string          `json:"stage,omitempty"`
	CommandID           string          `json:"command_id,omitempty"`
	ProtocolVersion     string          `json:"protocol_version"`
	HostAccess          string          `json:"host_access,omitempty"`
	TenantID            string          `json:"tenant_id,omitempty"`
	RunnerID            string          `json:"runner_id,omitempty"`
	ExecutionContextKey string          `json:"execution_context_key,omitempty"`
	RuntimeInstanceID   string          `json:"runtime_instance_id,omitempty"`
	ContextViewRef      json.RawMessage `json:"context_view_ref,omitempty"`
	OwnerActorID        string          `json:"owner_actor_id,omitempty"`
	RegistrationID      string          `json:"registration_id,omitempty"`
	AssignmentRevision  uint64          `json:"assignment_revision,omitempty"`
	AgentID             string          `json:"agent_id,omitempty"`
	OperationID         string          `json:"operation_id,omitempty"`
	ConnectionEpoch     uint64          `json:"connection_epoch,omitempty"`
	RunnerRevision      uint64          `json:"runner_revision,omitempty"`
	Generation          uint64          `json:"generation,omitempty"`
	ExecutionLeaseID    string          `json:"execution_lease_id,omitempty"`
	WorkspaceGrantID    string          `json:"workspace_grant_id,omitempty"`
	RuntimeType         string          `json:"runtime_type,omitempty"`
	ViewDigest          string          `json:"view_digest,omitempty"`
	ThroughSequence     uint64          `json:"through_seq,omitempty"`
	Sequence            uint64          `json:"seq,omitempty"`
	Revision            uint64          `json:"revision,omitempty"`
	SentAt              time.Time       `json:"sent_at"`
	Payload             json.RawMessage `json:"payload,omitempty"`
}

// Version is the only Runner Gateway protocol this Daemon speaks.
const Version = wire.ProtocolVersion

// Route names one wire message shape inside the Daemon: its type, joined by
// ":" with the discriminator values of a type that carries several shapes.
// Command.Type and Event.Type hold routes, so a handler never re-reads the
// discriminator.
func Route(message wire.Message) string {
	route := message.Type
	for _, key := range []string{"target", "kind", "state", "outcome"} {
		if value, ok := message.Match[key]; ok {
			route += ":" + value
		}
	}
	return route
}

// Command routes, one per Agent frame shape.
const (
	CommandRunnerWelcome                = wire.TypeRunnerWelcome
	CommandRunnerReconciled             = wire.TypeRunnerReconciled
	CommandRegistrationSnapshot         = wire.TypeRuntimeRegistrationSnapshot
	CommandAgentRunnerEnsure            = wire.TypeAgentRunnerEnsure
	CommandAgentRunnerRemove            = wire.TypeAgentRunnerRemove
	CommandAgentCLICredentialPut        = wire.TypeExecute + ":" + wire.KindCLICredential
	CommandDebugInspect                 = wire.TypeExecute + ":" + wire.KindDebugHistory
	CommandCapabilitySkillsScan         = wire.TypeExecute + ":" + wire.KindSkillsScan
	CommandCapabilityBrowserConnect     = wire.TypeExecute + ":" + wire.KindBrowserConnect
	CommandCapabilityComputerPermission = wire.TypeExecute + ":" + wire.KindComputerPermission
	CommandSessionCompact               = wire.TypeExecute + ":" + wire.KindSessionCompact
	CommandModelInvoke                  = wire.TypeExecute + ":" + wire.KindModelInvoke
	CommandComputerToolCall             = wire.TypeExecute + ":" + wire.KindComputerTool
	CommandOperationPrepare             = wire.TypePrepare + ":" + wire.TargetOperation
	CommandProviderPrepare              = wire.TypePrepare + ":" + wire.TargetProvider
	CommandOperationCancel              = wire.TypeCancel + ":" + wire.TargetOperation
	CommandOperationStart               = wire.TypeOperationStart
	CommandOperationInput               = wire.TypeOperationInput
	CommandOperationAck                 = wire.TypeOperationAck
)

// Event routes, one per Daemon frame shape.
const (
	EventDaemonHello                           = wire.TypeRunnerHello
	EventRunnerHeartbeat                       = wire.TypeRunnerHeartbeat
	EventRuntimeObserved                       = wire.TypeRuntimeRegistrationObserved
	EventRuntimeDiagnostics                    = wire.TypeRunnerRuntimeDiagnostics
	EventAgentRunnerReady                      = wire.TypeAgentRunnerState + ":" + wire.StateReady
	EventAgentRunnerRemoved                    = wire.TypeAgentRunnerState + ":" + wire.StateRemoved
	EventAgentRunnerFailed                     = wire.TypeAgentRunnerState + ":" + wire.StateFailed
	EventAgentCLICredentialStored              = wire.TypeExecuted + ":" + wire.KindCLICredential + ":" + wire.OutcomeSucceeded
	EventAgentCLICredentialFailed              = wire.TypeExecuted + ":" + wire.KindCLICredential + ":" + wire.OutcomeFailed
	EventDebugInspected                        = wire.TypeExecuted + ":" + wire.KindDebugHistory
	EventCapabilitySkillsScanned               = wire.TypeExecuted + ":" + wire.KindSkillsScan + ":" + wire.OutcomeSucceeded
	EventCapabilitySkillsFailed                = wire.TypeExecuted + ":" + wire.KindSkillsScan + ":" + wire.OutcomeFailed
	EventCapabilityBrowserConnected            = wire.TypeExecuted + ":" + wire.KindBrowserConnect + ":" + wire.OutcomeSucceeded
	EventCapabilityBrowserFailed               = wire.TypeExecuted + ":" + wire.KindBrowserConnect + ":" + wire.OutcomeFailed
	EventCapabilityComputerPermissionSucceeded = wire.TypeExecuted + ":" + wire.KindComputerPermission + ":" + wire.OutcomeSucceeded
	EventCapabilityComputerPermissionFailed    = wire.TypeExecuted + ":" + wire.KindComputerPermission + ":" + wire.OutcomeFailed
	EventSessionCompacted                      = wire.TypeExecuted + ":" + wire.KindSessionCompact
	EventModelInvoked                          = wire.TypeExecuted + ":" + wire.KindModelInvoke
	EventComputerToolResult                    = wire.TypeExecuted + ":" + wire.KindComputerTool
	EventOperationPrepared                     = wire.TypePrepared + ":" + wire.TargetOperation
	EventProviderPrepared                      = wire.TypePrepared + ":" + wire.TargetProvider
	EventOperationAccepted                     = wire.TypeOperationAccepted
	EventOperationEvent                        = wire.TypeOperationEvent
	EventOperationInputAck                     = wire.TypeOperationInputResult + ":" + wire.OutcomeAccepted
	EventOperationInputRejected                = wire.TypeOperationInputResult + ":" + wire.OutcomeRejected
	EventOperationInputClosed                  = wire.TypeOperationInputResult + ":" + wire.OutcomeClosed
	EventOperationCompleted                    = wire.TypeOperationCompleted
	EventOperationFailed                       = wire.TypeOperationFailed
	EventOperationCancelled                    = wire.TypeOperationCancelled
)
