// Code generated from contracts/runner-gateway/envelope.schema.json. DO NOT EDIT.

// Package runnergateway holds the Runner Gateway message shapes the Daemon
// exchanges with the Agent Service.
package runnergateway

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// ProtocolVersion is the only Runner Gateway protocol this release speaks.
const ProtocolVersion = "2"

// Runner capabilities name host features; everything else is part of the protocol.
const (
	CapabilityBrowserConnection   = "browser_connection"
	CapabilityComputerPermissions = "computer_permissions"
)

// Message types.
const (
	TypeRunnerWelcome               = "runner.welcome"
	TypeRunnerReconciled            = "runner.reconciled"
	TypeRuntimeRegistrationSnapshot = "runtime.registration.snapshot"
	TypeAgentRunnerEnsure           = "agent_runner.ensure"
	TypeAgentRunnerRemove           = "agent_runner.remove"
	TypeExecute                     = "execute"
	TypePrepare                     = "prepare"
	TypeOperationStart              = "operation.start"
	TypeOperationInput              = "operation.input"
	TypeCancel                      = "cancel"
	TypeOperationAck                = "operation.ack"
	TypeRunnerHello                 = "runner.hello"
	TypeRunnerHeartbeat             = "runner.heartbeat"
	TypeRunnerRuntimeDiagnostics    = "runner.runtime_diagnostics"
	TypeRuntimeRegistrationObserved = "runtime.registration.observed"
	TypeAgentRunnerState            = "agent_runner.state"
	TypeExecuted                    = "executed"
	TypePrepared                    = "prepared"
	TypeOperationAccepted           = "operation.accepted"
	TypeOperationEvent              = "operation.event"
	TypeOperationInputResult        = "operation.input_result"
	TypeOperationCompleted          = "operation.completed"
	TypeOperationFailed             = "operation.failed"
	TypeOperationCancelled          = "operation.cancelled"
)

// Message discriminators within one type.
const (
	KindCLICredential      = "cli_credential"
	KindDebugHistory       = "debug_history"
	KindSkillsScan         = "skills_scan"
	KindBrowserConnect     = "browser_connect"
	KindComputerPermission = "computer_permission"
	TargetOperation        = "operation"
	TargetProvider         = "provider"
	KindSessionCompact     = "session_compact"
	KindModelInvoke        = "model_invoke"
	KindComputerTool       = "computer_tool"
	StateReady             = "ready"
	StateRemoved           = "removed"
	StateFailed            = "failed"
	OutcomeSucceeded       = "succeeded"
	OutcomeFailed          = "failed"
	OutcomeAccepted        = "accepted"
	OutcomeRejected        = "rejected"
	OutcomeClosed          = "closed"
)

// Message names one frame shape by its type and the constant fields that
// tell it apart from the other shapes of that type.
type Message struct {
	Name  string
	Type  string
	Match map[string]string
}

// AgentToDaemonMessages lists every frame the Agent Service sends.
var AgentToDaemonMessages = []Message{
	{Name: "RunnerWelcome", Type: "runner.welcome", Match: nil},
	{Name: "RunnerReconciled", Type: "runner.reconciled", Match: nil},
	{Name: "RuntimeRegistrationSnapshot", Type: "runtime.registration.snapshot", Match: nil},
	{Name: "AgentRunnerEnsure", Type: "agent_runner.ensure", Match: nil},
	{Name: "AgentRunnerRemove", Type: "agent_runner.remove", Match: nil},
	{Name: "AgentCliCredentialPut", Type: "execute", Match: map[string]string{"kind": "cli_credential"}},
	{Name: "DebugInspect", Type: "execute", Match: map[string]string{"kind": "debug_history"}},
	{Name: "CapabilitySkillsScan", Type: "execute", Match: map[string]string{"kind": "skills_scan"}},
	{Name: "CapabilityBrowserConnect", Type: "execute", Match: map[string]string{"kind": "browser_connect"}},
	{Name: "CapabilityComputerPermission", Type: "execute", Match: map[string]string{"kind": "computer_permission"}},
	{Name: "OperationPrepare", Type: "prepare", Match: map[string]string{"target": "operation"}},
	{Name: "ProviderPrepare", Type: "prepare", Match: map[string]string{"target": "provider"}},
	{Name: "SessionCompact", Type: "execute", Match: map[string]string{"kind": "session_compact"}},
	{Name: "ModelInvoke", Type: "execute", Match: map[string]string{"kind": "model_invoke"}},
	{Name: "OperationStart", Type: "operation.start", Match: nil},
	{Name: "OperationInput", Type: "operation.input", Match: nil},
	{Name: "OperationCancel", Type: "cancel", Match: map[string]string{"target": "operation"}},
	{Name: "OperationAck", Type: "operation.ack", Match: nil},
	{Name: "ComputerToolCall", Type: "execute", Match: map[string]string{"kind": "computer_tool"}},
}

// DaemonToAgentMessages lists every frame the Daemon sends.
var DaemonToAgentMessages = []Message{
	{Name: "RunnerHello", Type: "runner.hello", Match: nil},
	{Name: "RunnerHeartbeat", Type: "runner.heartbeat", Match: nil},
	{Name: "RunnerRuntimeDiagnostics", Type: "runner.runtime_diagnostics", Match: nil},
	{Name: "RuntimeRegistrationObserved", Type: "runtime.registration.observed", Match: nil},
	{Name: "AgentRunnerReady", Type: "agent_runner.state", Match: map[string]string{"state": "ready"}},
	{Name: "AgentRunnerRemoved", Type: "agent_runner.state", Match: map[string]string{"state": "removed"}},
	{Name: "AgentRunnerFailed", Type: "agent_runner.state", Match: map[string]string{"state": "failed"}},
	{Name: "AgentCliCredentialStored", Type: "executed", Match: map[string]string{"kind": "cli_credential", "outcome": "succeeded"}},
	{Name: "AgentCliCredentialFailed", Type: "executed", Match: map[string]string{"kind": "cli_credential", "outcome": "failed"}},
	{Name: "DebugInspected", Type: "executed", Match: map[string]string{"kind": "debug_history"}},
	{Name: "CapabilitySkillsScanned", Type: "executed", Match: map[string]string{"kind": "skills_scan", "outcome": "succeeded"}},
	{Name: "CapabilitySkillsFailed", Type: "executed", Match: map[string]string{"kind": "skills_scan", "outcome": "failed"}},
	{Name: "CapabilityBrowserConnected", Type: "executed", Match: map[string]string{"kind": "browser_connect", "outcome": "succeeded"}},
	{Name: "CapabilityBrowserFailed", Type: "executed", Match: map[string]string{"kind": "browser_connect", "outcome": "failed"}},
	{Name: "CapabilityComputerPermissionSucceeded", Type: "executed", Match: map[string]string{"kind": "computer_permission", "outcome": "succeeded"}},
	{Name: "CapabilityComputerPermissionFailed", Type: "executed", Match: map[string]string{"kind": "computer_permission", "outcome": "failed"}},
	{Name: "OperationPrepared", Type: "prepared", Match: map[string]string{"target": "operation"}},
	{Name: "ProviderPrepared", Type: "prepared", Match: map[string]string{"target": "provider"}},
	{Name: "SessionCompacted", Type: "executed", Match: map[string]string{"kind": "session_compact"}},
	{Name: "ModelInvoked", Type: "executed", Match: map[string]string{"kind": "model_invoke"}},
	{Name: "OperationAccepted", Type: "operation.accepted", Match: nil},
	{Name: "OperationEvent", Type: "operation.event", Match: nil},
	{Name: "OperationInputAck", Type: "operation.input_result", Match: map[string]string{"outcome": "accepted"}},
	{Name: "OperationInputRejected", Type: "operation.input_result", Match: map[string]string{"outcome": "rejected"}},
	{Name: "OperationInputClosed", Type: "operation.input_result", Match: map[string]string{"outcome": "closed"}},
	{Name: "OperationCompleted", Type: "operation.completed", Match: nil},
	{Name: "OperationFailed", Type: "operation.failed", Match: nil},
	{Name: "OperationCancelled", Type: "operation.cancelled", Match: nil},
	{Name: "ComputerToolResult", Type: "executed", Match: map[string]string{"kind": "computer_tool"}},
}

// RuntimeModel mirrors the RuntimeModel schema shape.
type RuntimeModel struct {
	ID                     string   `json:"id"`
	Label                  string   `json:"label"`
	AllowedReasoningEffort []string `json:"allowed_reasoning_effort"`
	DefaultReasoningEffort string   `json:"default_reasoning_effort,omitempty"`
	ContextWindow          *uint64  `json:"context_window,omitempty"`
	Link                   string   `json:"link,omitempty"`
	IsDefault              *bool    `json:"is_default,omitempty"`
}

// FixedFields lists the keys whose value the schema fixes for a RuntimeModel.
func (RuntimeModel) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a RuntimeModel must carry.
func (RuntimeModel) RequiredFields() []string {
	return []string{"id", "label", "allowed_reasoning_effort"}
}

// RuntimeDiagnosticError mirrors the RuntimeDiagnosticError schema shape.
type RuntimeDiagnosticError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// FixedFields lists the keys whose value the schema fixes for a RuntimeDiagnosticError.
func (RuntimeDiagnosticError) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a RuntimeDiagnosticError must carry.
func (RuntimeDiagnosticError) RequiredFields() []string { return []string{"code", "message"} }

// ManagedServiceHealth mirrors the ManagedServiceHealth schema shape.
type ManagedServiceHealth struct {
	Status     string  `json:"status"`
	HTTPStatus *uint64 `json:"http_status,omitempty"`
	CheckedAt  string  `json:"checked_at"`
}

// FixedFields lists the keys whose value the schema fixes for a ManagedServiceHealth.
func (ManagedServiceHealth) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a ManagedServiceHealth must carry.
func (ManagedServiceHealth) RequiredFields() []string { return []string{"status", "checked_at"} }

// ManagedService mirrors the ManagedService schema shape.
type ManagedService struct {
	Name       string                `json:"name"`
	Command    string                `json:"command"`
	Cwd        string                `json:"cwd"`
	LogPath    string                `json:"log_path"`
	PID        uint64                `json:"pid"`
	State      string                `json:"state"`
	ObservedAt string                `json:"observed_at"`
	LostAt     string                `json:"lost_at,omitempty"`
	StoppedAt  string                `json:"stopped_at,omitempty"`
	URL        string                `json:"url,omitempty"`
	Port       *uint64               `json:"port,omitempty"`
	Health     *ManagedServiceHealth `json:"health,omitempty"`
}

// FixedFields lists the keys whose value the schema fixes for a ManagedService.
func (ManagedService) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a ManagedService must carry.
func (ManagedService) RequiredFields() []string {
	return []string{"name", "command", "cwd", "log_path", "pid", "state", "observed_at"}
}

// RuntimeDiagnostic mirrors the RuntimeDiagnostic schema shape.
type RuntimeDiagnostic struct {
	Type              string                  `json:"type"`
	Status            string                  `json:"status"`
	Protocol          string                  `json:"protocol"`
	CheckedAt         string                  `json:"checked_at"`
	Version           string                  `json:"version,omitempty"`
	Models            []RuntimeModel          `json:"models"`
	ModelCatalogError string                  `json:"model_catalog_error,omitempty"`
	Error             *RuntimeDiagnosticError `json:"error,omitempty"`
	ManagedServices   []ManagedService        `json:"managed_services,omitempty"`
}

// FixedFields lists the keys whose value the schema fixes for a RuntimeDiagnostic.
func (RuntimeDiagnostic) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a RuntimeDiagnostic must carry.
func (RuntimeDiagnostic) RequiredFields() []string {
	return []string{"type", "status", "protocol", "checked_at", "models"}
}

// RuntimeRegistrationObservation mirrors the RuntimeRegistrationObservation schema shape.
type RuntimeRegistrationObservation struct {
	TenantID           string          `json:"tenant_id"`
	OwnerActorID       string          `json:"owner_actor_id"`
	ProviderType       string          `json:"provider_type"`
	Status             string          `json:"status"`
	Revision           uint64          `json:"revision"`
	Capabilities       []string        `json:"capabilities"`
	RuntimeDiagnostics json.RawMessage `json:"runtime_diagnostics"`
}

// FixedFields lists the keys whose value the schema fixes for a RuntimeRegistrationObservation.
func (RuntimeRegistrationObservation) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a RuntimeRegistrationObservation must carry.
func (RuntimeRegistrationObservation) RequiredFields() []string {
	return []string{"tenant_id", "owner_actor_id", "provider_type", "status", "revision", "capabilities", "runtime_diagnostics"}
}

// RuntimeRegistration mirrors the RuntimeRegistration schema shape.
type RuntimeRegistration struct {
	RegistrationID string                         `json:"registration_id"`
	Observation    RuntimeRegistrationObservation `json:"observation"`
}

// FixedFields lists the keys whose value the schema fixes for a RuntimeRegistration.
func (RuntimeRegistration) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a RuntimeRegistration must carry.
func (RuntimeRegistration) RequiredFields() []string {
	return []string{"registration_id", "observation"}
}

// ContextViewFileInput mirrors the ContextViewFileInput schema shape.
type ContextViewFileInput struct {
	RelativePath string `json:"relative_path"`
	MediaType    string `json:"media_type"`
	SizeBytes    uint64 `json:"size_bytes"`
	SHA256       string `json:"sha256"`
	Executable   *bool  `json:"executable,omitempty"`
}

// FixedFields lists the keys whose value the schema fixes for a ContextViewFileInput.
func (ContextViewFileInput) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a ContextViewFileInput must carry.
func (ContextViewFileInput) RequiredFields() []string {
	return []string{"relative_path", "media_type", "size_bytes", "sha256"}
}

// ContextViewMapping mirrors the ContextViewMapping schema shape.
type ContextViewMapping struct {
	Kind       string                 `json:"kind"`
	TargetPath string                 `json:"target_path"`
	Access     string                 `json:"access"`
	Files      []ContextViewFileInput `json:"files"`
}

// FixedFields lists the keys whose value the schema fixes for a ContextViewMapping.
func (ContextViewMapping) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a ContextViewMapping must carry.
func (ContextViewMapping) RequiredFields() []string {
	return []string{"kind", "target_path", "access", "files"}
}

// ContextViewSkill mirrors the ContextViewSkill schema shape.
type ContextViewSkill struct {
	PackageName   string `json:"package_name"`
	ManifestID    string `json:"manifest_id"`
	PackageSHA256 string `json:"package_sha256"`
}

// FixedFields lists the keys whose value the schema fixes for a ContextViewSkill.
func (ContextViewSkill) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a ContextViewSkill must carry.
func (ContextViewSkill) RequiredFields() []string {
	return []string{"package_name", "manifest_id", "package_sha256"}
}

// SharedTaskScope mirrors the SharedTaskScope schema shape.
type SharedTaskScope struct {
	Version      json.RawMessage `json:"version"`
	TenantID     string          `json:"tenant_id"`
	AgentID      string          `json:"agent_id"`
	OriginRoomID string          `json:"origin_room_id"`
	Role         string          `json:"role"`
	TaskID       string          `json:"task_id,omitempty"`
}

// FixedFields lists the keys whose value the schema fixes for a SharedTaskScope.
func (SharedTaskScope) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a SharedTaskScope must carry.
func (SharedTaskScope) RequiredFields() []string {
	return []string{"version", "tenant_id", "agent_id", "origin_room_id", "role"}
}

// ContextViewManifest mirrors the ContextViewManifest schema shape.
type ContextViewManifest struct {
	Version             json.RawMessage      `json:"version"`
	ExecutionContextKey string               `json:"execution_context_key"`
	RuntimeInstanceID   string               `json:"runtime_instance_id"`
	SharedTaskScope     *SharedTaskScope     `json:"shared_task_scope,omitempty"`
	Mappings            []ContextViewMapping `json:"mappings"`
	Skills              []ContextViewSkill   `json:"skills"`
}

// FixedFields lists the keys whose value the schema fixes for a ContextViewManifest.
func (ContextViewManifest) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a ContextViewManifest must carry.
func (ContextViewManifest) RequiredFields() []string {
	return []string{"version", "execution_context_key", "runtime_instance_id", "mappings", "skills"}
}

// LocalMcpRelayDescriptor mirrors the LocalMcpRelayDescriptor schema shape.
type LocalMcpRelayDescriptor struct {
	Name       string   `json:"name"`
	RelayURL   string   `json:"relay_url"`
	RelayToken string   `json:"relay_token"`
	ToolNames  []string `json:"tool_names"`
	ExpiresAt  string   `json:"expires_at"`
}

// FixedFields lists the keys whose value the schema fixes for a LocalMcpRelayDescriptor.
func (LocalMcpRelayDescriptor) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a LocalMcpRelayDescriptor must carry.
func (LocalMcpRelayDescriptor) RequiredFields() []string {
	return []string{"name", "relay_url", "relay_token", "tool_names", "expires_at"}
}

// LocalRunResources mirrors the LocalRunResources schema shape.
type LocalRunResources struct {
	MCPServers []LocalMcpRelayDescriptor `json:"mcp_servers"`
}

// FixedFields lists the keys whose value the schema fixes for a LocalRunResources.
func (LocalRunResources) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a LocalRunResources must carry.
func (LocalRunResources) RequiredFields() []string { return []string{"mcp_servers"} }

// WorkspaceGrant mirrors the WorkspaceGrant schema shape.
type WorkspaceGrant struct {
	GrantID  string `json:"grant_id"`
	TenantID string `json:"tenant_id"`
	Label    string `json:"label,omitempty"`
	Mode     string `json:"mode"`
	Scope    string `json:"scope,omitempty"`
}

// FixedFields lists the keys whose value the schema fixes for a WorkspaceGrant.
func (WorkspaceGrant) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a WorkspaceGrant must carry.
func (WorkspaceGrant) RequiredFields() []string { return []string{"grant_id", "tenant_id", "mode"} }

// ContextViewRef mirrors the ContextViewRef schema shape.
type ContextViewRef struct {
	ViewDigest string `json:"view_digest"`
}

// FixedFields lists the keys whose value the schema fixes for a ContextViewRef.
func (ContextViewRef) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a ContextViewRef must carry.
func (ContextViewRef) RequiredFields() []string { return []string{"view_digest"} }

// OperationScope mirrors the OperationScope schema shape.
type OperationScope struct {
	ProtocolVersion     string         `json:"protocol_version"`
	HostAccess          string         `json:"host_access"`
	ExecutionContextKey string         `json:"execution_context_key"`
	RuntimeInstanceID   string         `json:"runtime_instance_id"`
	ContextViewRef      ContextViewRef `json:"context_view_ref"`
}

// FixedFields lists the keys whose value the schema fixes for a OperationScope.
func (OperationScope) FixedFields() map[string]string {
	return map[string]string{"protocol_version": "2", "host_access": "trusted"}
}

// RequiredFields lists the keys a OperationScope must carry.
func (OperationScope) RequiredFields() []string {
	return []string{"protocol_version", "host_access", "execution_context_key", "runtime_instance_id", "context_view_ref"}
}

// ActiveOperation mirrors the ActiveOperation schema shape.
type ActiveOperation struct {
	ProtocolVersion     string         `json:"protocol_version"`
	HostAccess          string         `json:"host_access"`
	ExecutionContextKey string         `json:"execution_context_key"`
	RuntimeInstanceID   string         `json:"runtime_instance_id"`
	ContextViewRef      ContextViewRef `json:"context_view_ref"`
	TenantID            string         `json:"tenant_id"`
	RegistrationID      string         `json:"registration_id"`
	AssignmentRevision  uint64         `json:"assignment_revision"`
	RunnerID            string         `json:"runner_id"`
	AgentID             string         `json:"agent_id"`
	OperationID         string         `json:"operation_id"`
	ConnectionEpoch     uint64         `json:"connection_epoch"`
	RunnerRevision      uint64         `json:"runner_revision"`
	Generation          uint64         `json:"generation"`
	ExecutionLeaseID    string         `json:"execution_lease_id"`
	WorkspaceGrantID    string         `json:"workspace_grant_id"`
	RuntimeType         string         `json:"runtime_type"`
	Kind                string         `json:"kind"`
	LastEmittedSeq      uint64         `json:"last_emitted_seq"`
	LastAckedSeq        uint64         `json:"last_acked_seq"`
}

// FixedFields lists the keys whose value the schema fixes for a ActiveOperation.
func (ActiveOperation) FixedFields() map[string]string {
	return map[string]string{"protocol_version": "2", "host_access": "trusted", "kind": "run.start"}
}

// RequiredFields lists the keys a ActiveOperation must carry.
func (ActiveOperation) RequiredFields() []string {
	return []string{"protocol_version", "host_access", "execution_context_key", "runtime_instance_id", "context_view_ref", "tenant_id", "registration_id", "assignment_revision", "runner_id", "agent_id", "operation_id", "connection_epoch", "runner_revision", "generation", "execution_lease_id", "workspace_grant_id", "runtime_type", "kind", "last_emitted_seq", "last_acked_seq"}
}

// RuntimeConfig mirrors the RuntimeConfig schema shape.
type RuntimeConfig struct {
	Type            string `json:"type"`
	Model           string `json:"model,omitempty"`
	ReasoningEffort string `json:"reasoning_effort,omitempty"`
}

// FixedFields lists the keys whose value the schema fixes for a RuntimeConfig.
func (RuntimeConfig) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a RuntimeConfig must carry.
func (RuntimeConfig) RequiredFields() []string { return []string{"type"} }

// DebugHistoryInspectionRequest mirrors the DebugHistoryInspectionRequest schema shape.
type DebugHistoryInspectionRequest struct {
	Runtime RuntimeConfig   `json:"runtime"`
	Session json.RawMessage `json:"session"`
	Cursor  string          `json:"cursor,omitempty"`
	Limit   *uint64         `json:"limit,omitempty"`
}

// FixedFields lists the keys whose value the schema fixes for a DebugHistoryInspectionRequest.
func (DebugHistoryInspectionRequest) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a DebugHistoryInspectionRequest must carry.
func (DebugHistoryInspectionRequest) RequiredFields() []string { return []string{"runtime", "session"} }

// DebugInspect mirrors the DebugInspect schema shape.
type DebugInspect struct {
	ProtocolVersion     string                        `json:"protocol_version"`
	CommandID           string                        `json:"command_id"`
	TenantID            string                        `json:"tenant_id"`
	RegistrationID      string                        `json:"registration_id,omitempty"`
	AssignmentRevision  *uint64                       `json:"assignment_revision,omitempty"`
	RunnerID            string                        `json:"runner_id"`
	AgentID             string                        `json:"agent_id"`
	ConnectionEpoch     uint64                        `json:"connection_epoch"`
	RunnerRevision      *uint64                       `json:"runner_revision,omitempty"`
	WorkspaceGrantID    string                        `json:"workspace_grant_id"`
	ExecutionContextKey string                        `json:"execution_context_key"`
	RuntimeInstanceID   string                        `json:"runtime_instance_id"`
	ViewDigest          string                        `json:"view_digest,omitempty"`
	Type                string                        `json:"type"`
	Request             DebugHistoryInspectionRequest `json:"request"`
	DetachedHistory     *bool                         `json:"detached_history,omitempty"`
	Kind                string                        `json:"kind"`
}

// FixedFields lists the keys whose value the schema fixes for a DebugInspect.
func (DebugInspect) FixedFields() map[string]string {
	return map[string]string{"protocol_version": "2", "type": "execute", "kind": "debug_history"}
}

// RequiredFields lists the keys a DebugInspect must carry.
func (DebugInspect) RequiredFields() []string {
	return []string{"protocol_version", "command_id", "tenant_id", "runner_id", "agent_id", "connection_epoch", "workspace_grant_id", "execution_context_key", "runtime_instance_id", "type", "request", "kind"}
}

// DebugHistorySnapshot mirrors the DebugHistorySnapshot schema shape.
type DebugHistorySnapshot struct {
	ID          string `json:"id"`
	ThreadID    string `json:"thread_id"`
	CapturedAt  string `json:"captured_at"`
	RecordCount uint64 `json:"record_count"`
	TailState   string `json:"tail_state"`
}

// FixedFields lists the keys whose value the schema fixes for a DebugHistorySnapshot.
func (DebugHistorySnapshot) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a DebugHistorySnapshot must carry.
func (DebugHistorySnapshot) RequiredFields() []string {
	return []string{"id", "thread_id", "captured_at", "record_count", "tail_state"}
}

// DebugHistoryInstructionBlock mirrors the DebugHistoryInstructionBlock schema shape.
type DebugHistoryInstructionBlock struct {
	RecordOrdinal  uint64  `json:"record_ordinal"`
	RecordType     string  `json:"record_type"`
	Field          string  `json:"field"`
	ContentOrdinal *uint64 `json:"content_ordinal,omitempty"`
	Timestamp      string  `json:"timestamp,omitempty"`
	Text           string  `json:"text"`
}

// FixedFields lists the keys whose value the schema fixes for a DebugHistoryInstructionBlock.
func (DebugHistoryInstructionBlock) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a DebugHistoryInstructionBlock must carry.
func (DebugHistoryInstructionBlock) RequiredFields() []string {
	return []string{"record_ordinal", "record_type", "field", "text"}
}

// DebugHistoryInstructions mirrors the DebugHistoryInstructions schema shape.
type DebugHistoryInstructions struct {
	Status string                         `json:"status"`
	Source string                         `json:"source"`
	Reason string                         `json:"reason,omitempty"`
	Blocks []DebugHistoryInstructionBlock `json:"blocks"`
}

// FixedFields lists the keys whose value the schema fixes for a DebugHistoryInstructions.
func (DebugHistoryInstructions) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a DebugHistoryInstructions must carry.
func (DebugHistoryInstructions) RequiredFields() []string {
	return []string{"status", "source", "blocks"}
}

// DebugHistoryRedactedField mirrors the DebugHistoryRedactedField schema shape.
type DebugHistoryRedactedField struct {
	Path      string  `json:"path"`
	Reason    string  `json:"reason"`
	ByteCount *uint64 `json:"byte_count,omitempty"`
}

// FixedFields lists the keys whose value the schema fixes for a DebugHistoryRedactedField.
func (DebugHistoryRedactedField) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a DebugHistoryRedactedField must carry.
func (DebugHistoryRedactedField) RequiredFields() []string { return []string{"path", "reason"} }

// DebugHistoryRecord mirrors the DebugHistoryRecord schema shape.
type DebugHistoryRecord struct {
	Ordinal        uint64                      `json:"ordinal"`
	Timestamp      string                      `json:"timestamp,omitempty"`
	TurnID         string                      `json:"turn_id,omitempty"`
	Category       string                      `json:"category"`
	NativeType     string                      `json:"native_type"`
	ToolCallID     string                      `json:"tool_call_id,omitempty"`
	ToolName       string                      `json:"tool_name,omitempty"`
	Role           string                      `json:"role,omitempty"`
	Phase          string                      `json:"phase,omitempty"`
	NativeRecord   json.RawMessage             `json:"native_record"`
	RedactedFields []DebugHistoryRedactedField `json:"redacted_fields"`
}

// FixedFields lists the keys whose value the schema fixes for a DebugHistoryRecord.
func (DebugHistoryRecord) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a DebugHistoryRecord must carry.
func (DebugHistoryRecord) RequiredFields() []string {
	return []string{"ordinal", "category", "native_type", "native_record", "redacted_fields"}
}

// DebugHistoryInspectionResult mirrors the DebugHistoryInspectionResult schema shape.
type DebugHistoryInspectionResult struct {
	Status         string                   `json:"status"`
	ProviderKind   string                   `json:"provider_kind"`
	Reason         string                   `json:"reason,omitempty"`
	Source         string                   `json:"source,omitempty"`
	Snapshot       *DebugHistorySnapshot    `json:"snapshot,omitempty"`
	Instructions   DebugHistoryInstructions `json:"instructions"`
	Records        []DebugHistoryRecord     `json:"records"`
	PreviousCursor string                   `json:"previous_cursor,omitempty"`
}

// FixedFields lists the keys whose value the schema fixes for a DebugHistoryInspectionResult.
func (DebugHistoryInspectionResult) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a DebugHistoryInspectionResult must carry.
func (DebugHistoryInspectionResult) RequiredFields() []string {
	return []string{"status", "provider_kind", "instructions", "records"}
}

// DebugInspected mirrors the DebugInspected schema shape.
type DebugInspected struct {
	ProtocolVersion     string                       `json:"protocol_version"`
	CommandID           string                       `json:"command_id"`
	TenantID            string                       `json:"tenant_id"`
	RegistrationID      string                       `json:"registration_id,omitempty"`
	AssignmentRevision  *uint64                      `json:"assignment_revision,omitempty"`
	RunnerID            string                       `json:"runner_id"`
	AgentID             string                       `json:"agent_id"`
	ConnectionEpoch     uint64                       `json:"connection_epoch"`
	RunnerRevision      *uint64                      `json:"runner_revision,omitempty"`
	WorkspaceGrantID    string                       `json:"workspace_grant_id"`
	ExecutionContextKey string                       `json:"execution_context_key"`
	RuntimeInstanceID   string                       `json:"runtime_instance_id"`
	ViewDigest          string                       `json:"view_digest,omitempty"`
	Type                string                       `json:"type"`
	Result              DebugHistoryInspectionResult `json:"result"`
	DetachedHistory     *bool                        `json:"detached_history,omitempty"`
	Kind                string                       `json:"kind"`
}

// FixedFields lists the keys whose value the schema fixes for a DebugInspected.
func (DebugInspected) FixedFields() map[string]string {
	return map[string]string{"protocol_version": "2", "type": "executed", "kind": "debug_history"}
}

// RequiredFields lists the keys a DebugInspected must carry.
func (DebugInspected) RequiredFields() []string {
	return []string{"protocol_version", "command_id", "tenant_id", "runner_id", "agent_id", "connection_epoch", "workspace_grant_id", "execution_context_key", "runtime_instance_id", "type", "result", "kind"}
}

// LocalSkillCandidate mirrors the LocalSkillCandidate schema shape.
type LocalSkillCandidate struct {
	NativeSource    string   `json:"native_source,omitempty"`
	NativeEnabled   *bool    `json:"native_enabled,omitempty"`
	CandidateRef    string   `json:"candidate_ref"`
	Name            string   `json:"name"`
	Description     string   `json:"description"`
	PackageSHA256   string   `json:"package_sha256"`
	FileCount       uint64   `json:"file_count"`
	SizeBytes       uint64   `json:"size_bytes"`
	Normalizations  []string `json:"normalizations"`
	RiskFlags       []string `json:"risk_flags"`
	Importability   string   `json:"importability"`
	ErrorCode       string   `json:"error_code,omitempty"`
	ErrorDetail     string   `json:"error_detail,omitempty"`
	ManifestExcerpt string   `json:"manifest_excerpt,omitempty"`
}

// FixedFields lists the keys whose value the schema fixes for a LocalSkillCandidate.
func (LocalSkillCandidate) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a LocalSkillCandidate must carry.
func (LocalSkillCandidate) RequiredFields() []string {
	return []string{"candidate_ref", "name", "description", "package_sha256", "file_count", "size_bytes", "normalizations", "risk_flags", "importability"}
}

// LocalSkillCommandIdentity mirrors the LocalSkillCommandIdentity schema shape.
type LocalSkillCommandIdentity struct {
	ProtocolVersion string `json:"protocol_version"`
	CommandID       string `json:"command_id"`
	RunnerID        string `json:"runner_id"`
	TenantID        string `json:"tenant_id"`
	OwnerActorID    string `json:"owner_actor_id"`
	ConnectionEpoch uint64 `json:"connection_epoch"`
	ExpiresAt       string `json:"expires_at"`
}

// FixedFields lists the keys whose value the schema fixes for a LocalSkillCommandIdentity.
func (LocalSkillCommandIdentity) FixedFields() map[string]string {
	return map[string]string{"protocol_version": "2"}
}

// RequiredFields lists the keys a LocalSkillCommandIdentity must carry.
func (LocalSkillCommandIdentity) RequiredFields() []string {
	return []string{"protocol_version", "command_id", "runner_id", "tenant_id", "owner_actor_id", "connection_epoch", "expires_at"}
}

// CapabilitySkillsScan mirrors the CapabilitySkillsScan schema shape.
type CapabilitySkillsScan struct {
	ProtocolVersion string `json:"protocol_version"`
	CommandID       string `json:"command_id"`
	RunnerID        string `json:"runner_id"`
	TenantID        string `json:"tenant_id"`
	OwnerActorID    string `json:"owner_actor_id"`
	ConnectionEpoch uint64 `json:"connection_epoch"`
	ExpiresAt       string `json:"expires_at"`
	Type            string `json:"type"`
	ScanID          string `json:"scan_id"`
	RuntimeType     string `json:"runtime_type"`
	Kind            string `json:"kind"`
}

// FixedFields lists the keys whose value the schema fixes for a CapabilitySkillsScan.
func (CapabilitySkillsScan) FixedFields() map[string]string {
	return map[string]string{"protocol_version": "2", "type": "execute", "kind": "skills_scan"}
}

// RequiredFields lists the keys a CapabilitySkillsScan must carry.
func (CapabilitySkillsScan) RequiredFields() []string {
	return []string{"protocol_version", "command_id", "runner_id", "tenant_id", "owner_actor_id", "connection_epoch", "expires_at", "type", "scan_id", "runtime_type", "kind"}
}

// CapabilitySkillsScanned mirrors the CapabilitySkillsScanned schema shape.
type CapabilitySkillsScanned struct {
	ProtocolVersion string                `json:"protocol_version"`
	CommandID       string                `json:"command_id"`
	RunnerID        string                `json:"runner_id"`
	TenantID        string                `json:"tenant_id"`
	OwnerActorID    string                `json:"owner_actor_id"`
	ConnectionEpoch uint64                `json:"connection_epoch"`
	ExpiresAt       string                `json:"expires_at"`
	Type            string                `json:"type"`
	ScanID          string                `json:"scan_id"`
	RuntimeType     string                `json:"runtime_type"`
	Items           []LocalSkillCandidate `json:"items"`
	Kind            string                `json:"kind"`
	Outcome         string                `json:"outcome"`
}

// FixedFields lists the keys whose value the schema fixes for a CapabilitySkillsScanned.
func (CapabilitySkillsScanned) FixedFields() map[string]string {
	return map[string]string{"protocol_version": "2", "type": "executed", "kind": "skills_scan", "outcome": "succeeded"}
}

// RequiredFields lists the keys a CapabilitySkillsScanned must carry.
func (CapabilitySkillsScanned) RequiredFields() []string {
	return []string{"protocol_version", "command_id", "runner_id", "tenant_id", "owner_actor_id", "connection_epoch", "expires_at", "type", "scan_id", "runtime_type", "items", "kind", "outcome"}
}

// BrowserConnectionStatus mirrors the BrowserConnectionStatus schema shape.
type BrowserConnectionStatus struct {
	Mode         string `json:"mode"`
	State        string `json:"state"`
	Platform     string `json:"platform"`
	Browser      string `json:"browser,omitempty"`
	Profile      string `json:"profile,omitempty"`
	ConfiguredAt string `json:"configured_at,omitempty"`
	VerifiedAt   string `json:"verified_at,omitempty"`
	Message      string `json:"message,omitempty"`
}

// FixedFields lists the keys whose value the schema fixes for a BrowserConnectionStatus.
func (BrowserConnectionStatus) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a BrowserConnectionStatus must carry.
func (BrowserConnectionStatus) RequiredFields() []string {
	return []string{"mode", "state", "platform"}
}

// CapabilityBrowserConnect mirrors the CapabilityBrowserConnect schema shape.
type CapabilityBrowserConnect struct {
	ProtocolVersion string `json:"protocol_version"`
	CommandID       string `json:"command_id"`
	RunnerID        string `json:"runner_id"`
	TenantID        string `json:"tenant_id"`
	OwnerActorID    string `json:"owner_actor_id"`
	ConnectionEpoch uint64 `json:"connection_epoch"`
	ExpiresAt       string `json:"expires_at"`
	Type            string `json:"type"`
	Action          string `json:"action"`
	Profile         string `json:"profile,omitempty"`
	ExtensionToken  string `json:"extension_token,omitempty"`
	Kind            string `json:"kind"`
}

// FixedFields lists the keys whose value the schema fixes for a CapabilityBrowserConnect.
func (CapabilityBrowserConnect) FixedFields() map[string]string {
	return map[string]string{"protocol_version": "2", "type": "execute", "kind": "browser_connect"}
}

// RequiredFields lists the keys a CapabilityBrowserConnect must carry.
func (CapabilityBrowserConnect) RequiredFields() []string {
	return []string{"protocol_version", "command_id", "runner_id", "tenant_id", "owner_actor_id", "connection_epoch", "expires_at", "type", "action", "kind"}
}

// CapabilityBrowserConnected mirrors the CapabilityBrowserConnected schema shape.
type CapabilityBrowserConnected struct {
	ProtocolVersion string                  `json:"protocol_version"`
	CommandID       string                  `json:"command_id"`
	RunnerID        string                  `json:"runner_id"`
	TenantID        string                  `json:"tenant_id"`
	OwnerActorID    string                  `json:"owner_actor_id"`
	ConnectionEpoch uint64                  `json:"connection_epoch"`
	ExpiresAt       string                  `json:"expires_at"`
	Type            string                  `json:"type"`
	Action          string                  `json:"action"`
	Status          BrowserConnectionStatus `json:"status"`
	Kind            string                  `json:"kind"`
	Outcome         string                  `json:"outcome"`
}

// FixedFields lists the keys whose value the schema fixes for a CapabilityBrowserConnected.
func (CapabilityBrowserConnected) FixedFields() map[string]string {
	return map[string]string{"protocol_version": "2", "type": "executed", "kind": "browser_connect", "outcome": "succeeded"}
}

// RequiredFields lists the keys a CapabilityBrowserConnected must carry.
func (CapabilityBrowserConnected) RequiredFields() []string {
	return []string{"protocol_version", "command_id", "runner_id", "tenant_id", "owner_actor_id", "connection_epoch", "expires_at", "type", "action", "status", "kind", "outcome"}
}

// AgentRunnerError mirrors the AgentRunnerError schema shape.
type AgentRunnerError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

// FixedFields lists the keys whose value the schema fixes for a AgentRunnerError.
func (AgentRunnerError) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a AgentRunnerError must carry.
func (AgentRunnerError) RequiredFields() []string { return []string{"code", "message", "retryable"} }

// CapabilityBrowserFailed mirrors the CapabilityBrowserFailed schema shape.
type CapabilityBrowserFailed struct {
	ProtocolVersion string           `json:"protocol_version"`
	CommandID       string           `json:"command_id"`
	RunnerID        string           `json:"runner_id"`
	TenantID        string           `json:"tenant_id"`
	OwnerActorID    string           `json:"owner_actor_id"`
	ConnectionEpoch uint64           `json:"connection_epoch"`
	ExpiresAt       string           `json:"expires_at"`
	Type            string           `json:"type"`
	Action          string           `json:"action"`
	Error           AgentRunnerError `json:"error"`
	Kind            string           `json:"kind"`
	Outcome         string           `json:"outcome"`
}

// FixedFields lists the keys whose value the schema fixes for a CapabilityBrowserFailed.
func (CapabilityBrowserFailed) FixedFields() map[string]string {
	return map[string]string{"protocol_version": "2", "type": "executed", "kind": "browser_connect", "outcome": "failed"}
}

// RequiredFields lists the keys a CapabilityBrowserFailed must carry.
func (CapabilityBrowserFailed) RequiredFields() []string {
	return []string{"protocol_version", "command_id", "runner_id", "tenant_id", "owner_actor_id", "connection_epoch", "expires_at", "type", "action", "error", "kind", "outcome"}
}

// ComputerPermissionStatusSubjectsItemPermissionsItem mirrors the ComputerPermissionStatusSubjectsItemPermissionsItem schema shape.
type ComputerPermissionStatusSubjectsItemPermissionsItem struct {
	ID               string `json:"id"`
	State            string `json:"state"`
	Prompt           string `json:"prompt"`
	RelaunchRequired bool   `json:"relaunch_required"`
}

// FixedFields lists the keys whose value the schema fixes for a ComputerPermissionStatusSubjectsItemPermissionsItem.
func (ComputerPermissionStatusSubjectsItemPermissionsItem) FixedFields() map[string]string {
	return nil
}

// RequiredFields lists the keys a ComputerPermissionStatusSubjectsItemPermissionsItem must carry.
func (ComputerPermissionStatusSubjectsItemPermissionsItem) RequiredFields() []string {
	return []string{"id", "state", "prompt", "relaunch_required"}
}

// ComputerPermissionStatusSubjectsItem mirrors the ComputerPermissionStatusSubjectsItem schema shape.
type ComputerPermissionStatusSubjectsItem struct {
	Subject     string                                                `json:"subject"`
	Permissions []ComputerPermissionStatusSubjectsItemPermissionsItem `json:"permissions"`
}

// FixedFields lists the keys whose value the schema fixes for a ComputerPermissionStatusSubjectsItem.
func (ComputerPermissionStatusSubjectsItem) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a ComputerPermissionStatusSubjectsItem must carry.
func (ComputerPermissionStatusSubjectsItem) RequiredFields() []string {
	return []string{"subject", "permissions"}
}

// ComputerPermissionStatus mirrors the ComputerPermissionStatus schema shape.
type ComputerPermissionStatus struct {
	Platform string                                 `json:"platform"`
	Host     string                                 `json:"host"`
	Subjects []ComputerPermissionStatusSubjectsItem `json:"subjects"`
}

// FixedFields lists the keys whose value the schema fixes for a ComputerPermissionStatus.
func (ComputerPermissionStatus) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a ComputerPermissionStatus must carry.
func (ComputerPermissionStatus) RequiredFields() []string {
	return []string{"platform", "host", "subjects"}
}

// CapabilityComputerPermission mirrors the CapabilityComputerPermission schema shape.
type CapabilityComputerPermission struct {
	ProtocolVersion string `json:"protocol_version"`
	CommandID       string `json:"command_id"`
	RunnerID        string `json:"runner_id"`
	TenantID        string `json:"tenant_id"`
	OwnerActorID    string `json:"owner_actor_id"`
	ConnectionEpoch uint64 `json:"connection_epoch"`
	ExpiresAt       string `json:"expires_at"`
	Type            string `json:"type"`
	Action          string `json:"action"`
	Subject         string `json:"subject,omitempty"`
	Permission      string `json:"permission,omitempty"`
	Kind            string `json:"kind"`
}

// FixedFields lists the keys whose value the schema fixes for a CapabilityComputerPermission.
func (CapabilityComputerPermission) FixedFields() map[string]string {
	return map[string]string{"protocol_version": "2", "type": "execute", "kind": "computer_permission"}
}

// RequiredFields lists the keys a CapabilityComputerPermission must carry.
func (CapabilityComputerPermission) RequiredFields() []string {
	return []string{"protocol_version", "command_id", "runner_id", "tenant_id", "owner_actor_id", "connection_epoch", "expires_at", "type", "action", "kind"}
}

// CapabilityComputerPermissionSucceeded mirrors the CapabilityComputerPermissionSucceeded schema shape.
type CapabilityComputerPermissionSucceeded struct {
	ProtocolVersion string                   `json:"protocol_version"`
	CommandID       string                   `json:"command_id"`
	RunnerID        string                   `json:"runner_id"`
	TenantID        string                   `json:"tenant_id"`
	OwnerActorID    string                   `json:"owner_actor_id"`
	ConnectionEpoch uint64                   `json:"connection_epoch"`
	ExpiresAt       string                   `json:"expires_at"`
	Type            string                   `json:"type"`
	Action          string                   `json:"action"`
	Status          ComputerPermissionStatus `json:"status"`
	Kind            string                   `json:"kind"`
	Outcome         string                   `json:"outcome"`
}

// FixedFields lists the keys whose value the schema fixes for a CapabilityComputerPermissionSucceeded.
func (CapabilityComputerPermissionSucceeded) FixedFields() map[string]string {
	return map[string]string{"protocol_version": "2", "type": "executed", "kind": "computer_permission", "outcome": "succeeded"}
}

// RequiredFields lists the keys a CapabilityComputerPermissionSucceeded must carry.
func (CapabilityComputerPermissionSucceeded) RequiredFields() []string {
	return []string{"protocol_version", "command_id", "runner_id", "tenant_id", "owner_actor_id", "connection_epoch", "expires_at", "type", "action", "status", "kind", "outcome"}
}

// CapabilityComputerPermissionFailed mirrors the CapabilityComputerPermissionFailed schema shape.
type CapabilityComputerPermissionFailed struct {
	ProtocolVersion string           `json:"protocol_version"`
	CommandID       string           `json:"command_id"`
	RunnerID        string           `json:"runner_id"`
	TenantID        string           `json:"tenant_id"`
	OwnerActorID    string           `json:"owner_actor_id"`
	ConnectionEpoch uint64           `json:"connection_epoch"`
	ExpiresAt       string           `json:"expires_at"`
	Type            string           `json:"type"`
	Action          string           `json:"action"`
	Error           AgentRunnerError `json:"error"`
	Kind            string           `json:"kind"`
	Outcome         string           `json:"outcome"`
}

// FixedFields lists the keys whose value the schema fixes for a CapabilityComputerPermissionFailed.
func (CapabilityComputerPermissionFailed) FixedFields() map[string]string {
	return map[string]string{"protocol_version": "2", "type": "executed", "kind": "computer_permission", "outcome": "failed"}
}

// RequiredFields lists the keys a CapabilityComputerPermissionFailed must carry.
func (CapabilityComputerPermissionFailed) RequiredFields() []string {
	return []string{"protocol_version", "command_id", "runner_id", "tenant_id", "owner_actor_id", "connection_epoch", "expires_at", "type", "action", "error", "kind", "outcome"}
}

// CapabilitySkillsFailed mirrors the CapabilitySkillsFailed schema shape.
type CapabilitySkillsFailed struct {
	ProtocolVersion string           `json:"protocol_version"`
	CommandID       string           `json:"command_id"`
	RunnerID        string           `json:"runner_id"`
	TenantID        string           `json:"tenant_id"`
	OwnerActorID    string           `json:"owner_actor_id"`
	ConnectionEpoch uint64           `json:"connection_epoch"`
	ExpiresAt       string           `json:"expires_at"`
	Type            string           `json:"type"`
	Stage           string           `json:"stage"`
	ScanID          string           `json:"scan_id,omitempty"`
	Error           AgentRunnerError `json:"error"`
	Kind            string           `json:"kind"`
	Outcome         string           `json:"outcome"`
}

// FixedFields lists the keys whose value the schema fixes for a CapabilitySkillsFailed.
func (CapabilitySkillsFailed) FixedFields() map[string]string {
	return map[string]string{"protocol_version": "2", "type": "executed", "kind": "skills_scan", "outcome": "failed"}
}

// RequiredFields lists the keys a CapabilitySkillsFailed must carry.
func (CapabilitySkillsFailed) RequiredFields() []string {
	return []string{"protocol_version", "command_id", "runner_id", "tenant_id", "owner_actor_id", "connection_epoch", "expires_at", "type", "stage", "error", "kind", "outcome"}
}

// RunnerHelloDaemonIdentity mirrors the RunnerHelloDaemonIdentity schema shape.
type RunnerHelloDaemonIdentity struct {
	DaemonID        string `json:"daemon_id"`
	PublicKey       string `json:"public_key"`
	IdentityVersion uint64 `json:"identity_version"`
	Proof           string `json:"proof"`
}

// FixedFields lists the keys whose value the schema fixes for a RunnerHelloDaemonIdentity.
func (RunnerHelloDaemonIdentity) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a RunnerHelloDaemonIdentity must carry.
func (RunnerHelloDaemonIdentity) RequiredFields() []string {
	return []string{"daemon_id", "public_key", "identity_version", "proof"}
}

// RunnerHello mirrors the RunnerHello schema shape.
type RunnerHello struct {
	Type                 string                           `json:"type"`
	ProtocolVersion      string                           `json:"protocol_version"`
	DaemonVersion        string                           `json:"daemon_version"`
	Platform             string                           `json:"platform"`
	RunnerID             string                           `json:"runner_id"`
	DisplayName          string                           `json:"display_name,omitempty"`
	ConnectionNonce      string                           `json:"connection_nonce"`
	DaemonIdentity       RunnerHelloDaemonIdentity        `json:"daemon_identity"`
	RuntimeRegistrations []RuntimeRegistrationObservation `json:"runtime_registrations"`
	SentAt               string                           `json:"sent_at"`
	Capacity             *uint64                          `json:"capacity,omitempty"`
	Runtimes             []string                         `json:"runtimes"`
	RuntimeDiagnostics   []RuntimeDiagnostic              `json:"runtime_diagnostics"`
	Capabilities         []string                         `json:"capabilities"`
	WorkspaceGrants      []WorkspaceGrant                 `json:"workspace_grants"`
	AgentRunners         []json.RawMessage                `json:"agent_runners"`
	ActiveOperations     []ActiveOperation                `json:"active_operations"`
}

// FixedFields lists the keys whose value the schema fixes for a RunnerHello.
func (RunnerHello) FixedFields() map[string]string {
	return map[string]string{"type": "runner.hello", "protocol_version": "2"}
}

// RequiredFields lists the keys a RunnerHello must carry.
func (RunnerHello) RequiredFields() []string {
	return []string{"type", "protocol_version", "daemon_version", "platform", "runner_id", "connection_nonce", "daemon_identity", "runtime_registrations", "sent_at", "runtimes", "runtime_diagnostics", "capabilities", "workspace_grants", "agent_runners", "active_operations"}
}

// RuntimeRegistrationSnapshot mirrors the RuntimeRegistrationSnapshot schema shape.
type RuntimeRegistrationSnapshot struct {
	Type            string                `json:"type"`
	ProtocolVersion string                `json:"protocol_version"`
	CommandID       string                `json:"command_id"`
	RunnerID        string                `json:"runner_id"`
	ConnectionEpoch uint64                `json:"connection_epoch"`
	Registrations   []RuntimeRegistration `json:"registrations"`
}

// FixedFields lists the keys whose value the schema fixes for a RuntimeRegistrationSnapshot.
func (RuntimeRegistrationSnapshot) FixedFields() map[string]string {
	return map[string]string{"type": "runtime.registration.snapshot", "protocol_version": "2"}
}

// RequiredFields lists the keys a RuntimeRegistrationSnapshot must carry.
func (RuntimeRegistrationSnapshot) RequiredFields() []string {
	return []string{"type", "protocol_version", "command_id", "runner_id", "connection_epoch", "registrations"}
}

// RuntimeRegistrationObserved mirrors the RuntimeRegistrationObserved schema shape.
type RuntimeRegistrationObserved struct {
	Type            string `json:"type"`
	ProtocolVersion string `json:"protocol_version"`
	CommandID       string `json:"command_id"`
	RunnerID        string `json:"runner_id"`
	ConnectionEpoch uint64 `json:"connection_epoch"`
	ObservedCount   uint64 `json:"observed_count"`
}

// FixedFields lists the keys whose value the schema fixes for a RuntimeRegistrationObserved.
func (RuntimeRegistrationObserved) FixedFields() map[string]string {
	return map[string]string{"type": "runtime.registration.observed", "protocol_version": "2"}
}

// RequiredFields lists the keys a RuntimeRegistrationObserved must carry.
func (RuntimeRegistrationObserved) RequiredFields() []string {
	return []string{"type", "protocol_version", "command_id", "runner_id", "connection_epoch", "observed_count"}
}

// RunnerHeartbeat mirrors the RunnerHeartbeat schema shape.
type RunnerHeartbeat struct {
	Type               string           `json:"type"`
	ProtocolVersion    string           `json:"protocol_version"`
	RunnerID           string           `json:"runner_id"`
	SentAt             string           `json:"sent_at"`
	ActiveOperationIDs []string         `json:"active_operation_ids"`
	ManagedServices    []ManagedService `json:"managed_services,omitempty"`
}

// FixedFields lists the keys whose value the schema fixes for a RunnerHeartbeat.
func (RunnerHeartbeat) FixedFields() map[string]string {
	return map[string]string{"type": "runner.heartbeat", "protocol_version": "2"}
}

// RequiredFields lists the keys a RunnerHeartbeat must carry.
func (RunnerHeartbeat) RequiredFields() []string {
	return []string{"type", "protocol_version", "runner_id", "sent_at", "active_operation_ids"}
}

// RunnerRuntimeDiagnostics mirrors the RunnerRuntimeDiagnostics schema shape.
type RunnerRuntimeDiagnostics struct {
	Type               string              `json:"type"`
	ProtocolVersion    string              `json:"protocol_version"`
	RunnerID           string              `json:"runner_id"`
	SentAt             string              `json:"sent_at"`
	Revision           uint64              `json:"revision"`
	RuntimeDiagnostics []RuntimeDiagnostic `json:"runtime_diagnostics"`
}

// FixedFields lists the keys whose value the schema fixes for a RunnerRuntimeDiagnostics.
func (RunnerRuntimeDiagnostics) FixedFields() map[string]string {
	return map[string]string{"type": "runner.runtime_diagnostics", "protocol_version": "2"}
}

// RequiredFields lists the keys a RunnerRuntimeDiagnostics must carry.
func (RunnerRuntimeDiagnostics) RequiredFields() []string {
	return []string{"type", "protocol_version", "runner_id", "sent_at", "revision", "runtime_diagnostics"}
}

// RunnerReconciled mirrors the RunnerReconciled schema shape.
type RunnerReconciled struct {
	Type            string `json:"type"`
	ProtocolVersion string `json:"protocol_version"`
	RunnerID        string `json:"runner_id"`
	ConnectionEpoch uint64 `json:"connection_epoch"`
}

// FixedFields lists the keys whose value the schema fixes for a RunnerReconciled.
func (RunnerReconciled) FixedFields() map[string]string {
	return map[string]string{"type": "runner.reconciled", "protocol_version": "2"}
}

// RequiredFields lists the keys a RunnerReconciled must carry.
func (RunnerReconciled) RequiredFields() []string {
	return []string{"type", "protocol_version", "runner_id", "connection_epoch"}
}

// ComputerReleaseArchive mirrors the ComputerReleaseArchive schema shape.
type ComputerReleaseArchive struct {
	SHA256 string `json:"sha256"`
	Size   uint64 `json:"size"`
}

// FixedFields lists the keys whose value the schema fixes for a ComputerReleaseArchive.
func (ComputerReleaseArchive) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a ComputerReleaseArchive must carry.
func (ComputerReleaseArchive) RequiredFields() []string { return []string{"sha256", "size"} }

// ComputerTargetReleaseTargetsValue mirrors the ComputerTargetReleaseTargetsValue schema shape.
type ComputerTargetReleaseTargetsValue struct {
	App  ComputerReleaseArchive `json:"app"`
	Deps ComputerReleaseArchive `json:"deps"`
}

// FixedFields lists the keys whose value the schema fixes for a ComputerTargetReleaseTargetsValue.
func (ComputerTargetReleaseTargetsValue) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a ComputerTargetReleaseTargetsValue must carry.
func (ComputerTargetReleaseTargetsValue) RequiredFields() []string { return []string{"app", "deps"} }

// ComputerTargetRelease mirrors the ComputerTargetRelease schema shape.
type ComputerTargetRelease struct {
	Targets map[string]ComputerTargetReleaseTargetsValue `json:"targets"`
}

// FixedFields lists the keys whose value the schema fixes for a ComputerTargetRelease.
func (ComputerTargetRelease) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a ComputerTargetRelease must carry.
func (ComputerTargetRelease) RequiredFields() []string { return []string{"targets"} }

// RunnerWelcome mirrors the RunnerWelcome schema shape.
type RunnerWelcome struct {
	Type                  string                 `json:"type"`
	ProtocolVersion       string                 `json:"protocol_version"`
	RunnerID              string                 `json:"runner_id"`
	ConnectionID          string                 `json:"connection_id"`
	ConnectionEpoch       uint64                 `json:"connection_epoch"`
	HeartbeatIntervalMs   uint64                 `json:"heartbeat_interval_ms"`
	ReconcileOperationIDs []string               `json:"reconcile_operation_ids"`
	TargetRelease         *ComputerTargetRelease `json:"target_release,omitempty"`
	ContextContentURL     string                 `json:"context_content_url,omitempty"`
}

// FixedFields lists the keys whose value the schema fixes for a RunnerWelcome.
func (RunnerWelcome) FixedFields() map[string]string {
	return map[string]string{"type": "runner.welcome", "protocol_version": "2"}
}

// RequiredFields lists the keys a RunnerWelcome must carry.
func (RunnerWelcome) RequiredFields() []string {
	return []string{"type", "protocol_version", "runner_id", "connection_id", "connection_epoch", "heartbeat_interval_ms", "reconcile_operation_ids"}
}

// AgentRunnerWireIdentity mirrors the AgentRunnerWireIdentity schema shape.
type AgentRunnerWireIdentity struct {
	ProtocolVersion    string  `json:"protocol_version"`
	CommandID          string  `json:"command_id"`
	RunnerID           string  `json:"runner_id"`
	TenantID           string  `json:"tenant_id"`
	RegistrationID     string  `json:"registration_id,omitempty"`
	AssignmentRevision *uint64 `json:"assignment_revision,omitempty"`
	AgentID            string  `json:"agent_id"`
	ConnectionEpoch    uint64  `json:"connection_epoch"`
	RunnerRevision     uint64  `json:"runner_revision"`
}

// FixedFields lists the keys whose value the schema fixes for a AgentRunnerWireIdentity.
func (AgentRunnerWireIdentity) FixedFields() map[string]string {
	return map[string]string{"protocol_version": "2"}
}

// RequiredFields lists the keys a AgentRunnerWireIdentity must carry.
func (AgentRunnerWireIdentity) RequiredFields() []string {
	return []string{"protocol_version", "command_id", "runner_id", "tenant_id", "agent_id", "connection_epoch", "runner_revision"}
}

// AgentRunnerEnsure mirrors the AgentRunnerEnsure schema shape.
type AgentRunnerEnsure struct {
	ProtocolVersion    string        `json:"protocol_version"`
	CommandID          string        `json:"command_id"`
	RunnerID           string        `json:"runner_id"`
	TenantID           string        `json:"tenant_id"`
	RegistrationID     string        `json:"registration_id"`
	AssignmentRevision uint64        `json:"assignment_revision"`
	AgentID            string        `json:"agent_id"`
	ConnectionEpoch    uint64        `json:"connection_epoch"`
	RunnerRevision     uint64        `json:"runner_revision"`
	Type               string        `json:"type"`
	Runtime            RuntimeConfig `json:"runtime"`
	WorkspaceGrantID   string        `json:"workspace_grant_id"`
}

// FixedFields lists the keys whose value the schema fixes for a AgentRunnerEnsure.
func (AgentRunnerEnsure) FixedFields() map[string]string {
	return map[string]string{"protocol_version": "2", "type": "agent_runner.ensure"}
}

// RequiredFields lists the keys a AgentRunnerEnsure must carry.
func (AgentRunnerEnsure) RequiredFields() []string {
	return []string{"protocol_version", "command_id", "runner_id", "tenant_id", "registration_id", "assignment_revision", "agent_id", "connection_epoch", "runner_revision", "type", "runtime", "workspace_grant_id"}
}

// AgentRunnerRemove mirrors the AgentRunnerRemove schema shape.
type AgentRunnerRemove struct {
	ProtocolVersion    string  `json:"protocol_version"`
	CommandID          string  `json:"command_id"`
	RunnerID           string  `json:"runner_id"`
	TenantID           string  `json:"tenant_id"`
	RegistrationID     string  `json:"registration_id,omitempty"`
	AssignmentRevision *uint64 `json:"assignment_revision,omitempty"`
	AgentID            string  `json:"agent_id"`
	ConnectionEpoch    uint64  `json:"connection_epoch"`
	RunnerRevision     uint64  `json:"runner_revision"`
	Type               string  `json:"type"`
}

// FixedFields lists the keys whose value the schema fixes for a AgentRunnerRemove.
func (AgentRunnerRemove) FixedFields() map[string]string {
	return map[string]string{"protocol_version": "2", "type": "agent_runner.remove"}
}

// RequiredFields lists the keys a AgentRunnerRemove must carry.
func (AgentRunnerRemove) RequiredFields() []string {
	return []string{"protocol_version", "command_id", "runner_id", "tenant_id", "agent_id", "connection_epoch", "runner_revision", "type"}
}

// AgentCliProfile mirrors the AgentCliProfile schema shape.
type AgentCliProfile struct {
	URL      string `json:"url"`
	TenantID string `json:"tenant_id"`
	AgentID  string `json:"agent_id"`
}

// FixedFields lists the keys whose value the schema fixes for a AgentCliProfile.
func (AgentCliProfile) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a AgentCliProfile must carry.
func (AgentCliProfile) RequiredFields() []string { return []string{"url", "tenant_id", "agent_id"} }

// AgentCliCredentialReport mirrors the AgentCliCredentialReport schema shape.
type AgentCliCredentialReport struct {
	SHA256             string          `json:"sha256"`
	AssignmentRevision uint64          `json:"assignment_revision"`
	Profile            AgentCliProfile `json:"profile"`
}

// FixedFields lists the keys whose value the schema fixes for a AgentCliCredentialReport.
func (AgentCliCredentialReport) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a AgentCliCredentialReport must carry.
func (AgentCliCredentialReport) RequiredFields() []string {
	return []string{"sha256", "assignment_revision", "profile"}
}

// AgentRunnerReady mirrors the AgentRunnerReady schema shape.
type AgentRunnerReady struct {
	ProtocolVersion    string                    `json:"protocol_version"`
	CommandID          string                    `json:"command_id"`
	RunnerID           string                    `json:"runner_id"`
	TenantID           string                    `json:"tenant_id"`
	RegistrationID     string                    `json:"registration_id"`
	AssignmentRevision uint64                    `json:"assignment_revision"`
	AgentID            string                    `json:"agent_id"`
	ConnectionEpoch    uint64                    `json:"connection_epoch"`
	RunnerRevision     uint64                    `json:"runner_revision"`
	Type               string                    `json:"type"`
	RunnerPID          uint64                    `json:"runner_pid"`
	CLICredential      *AgentCliCredentialReport `json:"cli_credential,omitempty"`
	State              string                    `json:"state"`
}

// FixedFields lists the keys whose value the schema fixes for a AgentRunnerReady.
func (AgentRunnerReady) FixedFields() map[string]string {
	return map[string]string{"protocol_version": "2", "type": "agent_runner.state", "state": "ready"}
}

// RequiredFields lists the keys a AgentRunnerReady must carry.
func (AgentRunnerReady) RequiredFields() []string {
	return []string{"protocol_version", "command_id", "runner_id", "tenant_id", "registration_id", "assignment_revision", "agent_id", "connection_epoch", "runner_revision", "type", "runner_pid", "state"}
}

// AgentRunnerRemoved mirrors the AgentRunnerRemoved schema shape.
type AgentRunnerRemoved struct {
	ProtocolVersion    string  `json:"protocol_version"`
	CommandID          string  `json:"command_id"`
	RunnerID           string  `json:"runner_id"`
	TenantID           string  `json:"tenant_id"`
	RegistrationID     string  `json:"registration_id,omitempty"`
	AssignmentRevision *uint64 `json:"assignment_revision,omitempty"`
	AgentID            string  `json:"agent_id"`
	ConnectionEpoch    uint64  `json:"connection_epoch"`
	RunnerRevision     uint64  `json:"runner_revision"`
	Type               string  `json:"type"`
	State              string  `json:"state"`
}

// FixedFields lists the keys whose value the schema fixes for a AgentRunnerRemoved.
func (AgentRunnerRemoved) FixedFields() map[string]string {
	return map[string]string{"protocol_version": "2", "type": "agent_runner.state", "state": "removed"}
}

// RequiredFields lists the keys a AgentRunnerRemoved must carry.
func (AgentRunnerRemoved) RequiredFields() []string {
	return []string{"protocol_version", "command_id", "runner_id", "tenant_id", "agent_id", "connection_epoch", "runner_revision", "type", "state"}
}

// AgentRunnerFailed mirrors the AgentRunnerFailed schema shape.
type AgentRunnerFailed struct {
	ProtocolVersion    string           `json:"protocol_version"`
	CommandID          string           `json:"command_id"`
	RunnerID           string           `json:"runner_id"`
	TenantID           string           `json:"tenant_id"`
	RegistrationID     string           `json:"registration_id,omitempty"`
	AssignmentRevision *uint64          `json:"assignment_revision,omitempty"`
	AgentID            string           `json:"agent_id"`
	ConnectionEpoch    uint64           `json:"connection_epoch"`
	RunnerRevision     uint64           `json:"runner_revision"`
	Type               string           `json:"type"`
	Error              AgentRunnerError `json:"error"`
	State              string           `json:"state"`
}

// FixedFields lists the keys whose value the schema fixes for a AgentRunnerFailed.
func (AgentRunnerFailed) FixedFields() map[string]string {
	return map[string]string{"protocol_version": "2", "type": "agent_runner.state", "state": "failed"}
}

// RequiredFields lists the keys a AgentRunnerFailed must carry.
func (AgentRunnerFailed) RequiredFields() []string {
	return []string{"protocol_version", "command_id", "runner_id", "tenant_id", "agent_id", "connection_epoch", "runner_revision", "type", "error", "state"}
}

// AgentCliCredentialPut mirrors the AgentCliCredentialPut schema shape.
type AgentCliCredentialPut struct {
	ProtocolVersion    string          `json:"protocol_version"`
	CommandID          string          `json:"command_id"`
	RunnerID           string          `json:"runner_id"`
	TenantID           string          `json:"tenant_id"`
	RegistrationID     string          `json:"registration_id"`
	AssignmentRevision uint64          `json:"assignment_revision"`
	AgentID            string          `json:"agent_id"`
	ConnectionEpoch    uint64          `json:"connection_epoch"`
	RunnerRevision     uint64          `json:"runner_revision"`
	Type               string          `json:"type"`
	Profile            AgentCliProfile `json:"profile"`
	AccessToken        string          `json:"access_token"`
	Kind               string          `json:"kind"`
}

// FixedFields lists the keys whose value the schema fixes for a AgentCliCredentialPut.
func (AgentCliCredentialPut) FixedFields() map[string]string {
	return map[string]string{"protocol_version": "2", "type": "execute", "kind": "cli_credential"}
}

// RequiredFields lists the keys a AgentCliCredentialPut must carry.
func (AgentCliCredentialPut) RequiredFields() []string {
	return []string{"protocol_version", "command_id", "runner_id", "tenant_id", "registration_id", "assignment_revision", "agent_id", "connection_epoch", "runner_revision", "type", "profile", "access_token", "kind"}
}

// AgentCliCredentialStored mirrors the AgentCliCredentialStored schema shape.
type AgentCliCredentialStored struct {
	ProtocolVersion    string `json:"protocol_version"`
	CommandID          string `json:"command_id"`
	RunnerID           string `json:"runner_id"`
	TenantID           string `json:"tenant_id"`
	RegistrationID     string `json:"registration_id"`
	AssignmentRevision uint64 `json:"assignment_revision"`
	AgentID            string `json:"agent_id"`
	ConnectionEpoch    uint64 `json:"connection_epoch"`
	RunnerRevision     uint64 `json:"runner_revision"`
	Type               string `json:"type"`
	SHA256             string `json:"sha256"`
	Kind               string `json:"kind"`
	Outcome            string `json:"outcome"`
}

// FixedFields lists the keys whose value the schema fixes for a AgentCliCredentialStored.
func (AgentCliCredentialStored) FixedFields() map[string]string {
	return map[string]string{"protocol_version": "2", "type": "executed", "kind": "cli_credential", "outcome": "succeeded"}
}

// RequiredFields lists the keys a AgentCliCredentialStored must carry.
func (AgentCliCredentialStored) RequiredFields() []string {
	return []string{"protocol_version", "command_id", "runner_id", "tenant_id", "registration_id", "assignment_revision", "agent_id", "connection_epoch", "runner_revision", "type", "sha256", "kind", "outcome"}
}

// AgentCliCredentialFailed mirrors the AgentCliCredentialFailed schema shape.
type AgentCliCredentialFailed struct {
	ProtocolVersion    string           `json:"protocol_version"`
	CommandID          string           `json:"command_id"`
	RunnerID           string           `json:"runner_id"`
	TenantID           string           `json:"tenant_id"`
	RegistrationID     string           `json:"registration_id"`
	AssignmentRevision uint64           `json:"assignment_revision"`
	AgentID            string           `json:"agent_id"`
	ConnectionEpoch    uint64           `json:"connection_epoch"`
	RunnerRevision     uint64           `json:"runner_revision"`
	Type               string           `json:"type"`
	Error              AgentRunnerError `json:"error"`
	Kind               string           `json:"kind"`
	Outcome            string           `json:"outcome"`
}

// FixedFields lists the keys whose value the schema fixes for a AgentCliCredentialFailed.
func (AgentCliCredentialFailed) FixedFields() map[string]string {
	return map[string]string{"protocol_version": "2", "type": "executed", "kind": "cli_credential", "outcome": "failed"}
}

// RequiredFields lists the keys a AgentCliCredentialFailed must carry.
func (AgentCliCredentialFailed) RequiredFields() []string {
	return []string{"protocol_version", "command_id", "runner_id", "tenant_id", "registration_id", "assignment_revision", "agent_id", "connection_epoch", "runner_revision", "type", "error", "kind", "outcome"}
}

// SessionOptions mirrors the SessionOptions schema shape.
type SessionOptions struct {
	ThreadName            string `json:"thread_name"`
	BaseInstructions      string `json:"base_instructions,omitempty"`
	DeveloperInstructions string `json:"developer_instructions,omitempty"`
}

// FixedFields lists the keys whose value the schema fixes for a SessionOptions.
func (SessionOptions) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a SessionOptions must carry.
func (SessionOptions) RequiredFields() []string { return []string{"thread_name"} }

// AgentInputRuntimeResponse mirrors the AgentInputRuntimeResponse schema shape.
type AgentInputRuntimeResponse struct {
	RequestID string          `json:"request_id"`
	Payload   json.RawMessage `json:"payload"`
}

// FixedFields lists the keys whose value the schema fixes for a AgentInputRuntimeResponse.
func (AgentInputRuntimeResponse) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a AgentInputRuntimeResponse must carry.
func (AgentInputRuntimeResponse) RequiredFields() []string { return []string{"request_id", "payload"} }

// AgentInput mirrors the AgentInput schema shape.
type AgentInput struct {
	Type            string                     `json:"type"`
	Text            string                     `json:"text"`
	RuntimeResponse *AgentInputRuntimeResponse `json:"runtime_response,omitempty"`
}

// FixedFields lists the keys whose value the schema fixes for a AgentInput.
func (AgentInput) FixedFields() map[string]string { return map[string]string{"type": "text"} }

// RequiredFields lists the keys a AgentInput must carry.
func (AgentInput) RequiredFields() []string { return []string{"type", "text"} }

// ContextRunContext mirrors the ContextRunContext schema shape.
type ContextRunContext struct {
	HumanInteractions *bool    `json:"human_interactions,omitempty"`
	PermissionReview  *bool    `json:"permission_review,omitempty"`
	ExecutionRunRef   string   `json:"execution_run_ref"`
	SourceInboxIDs    []string `json:"source_inbox_ids"`
}

// FixedFields lists the keys whose value the schema fixes for a ContextRunContext.
func (ContextRunContext) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a ContextRunContext must carry.
func (ContextRunContext) RequiredFields() []string {
	return []string{"execution_run_ref", "source_inbox_ids"}
}

// CliRunContextScope mirrors the CliRunContextScope schema shape.
type CliRunContextScope struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

// FixedFields lists the keys whose value the schema fixes for a CliRunContextScope.
func (CliRunContextScope) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a CliRunContextScope must carry.
func (CliRunContextScope) RequiredFields() []string { return []string{"kind", "id"} }

// CliRunContext mirrors the CliRunContext schema shape.
type CliRunContext struct {
	RunID string              `json:"run_id,omitempty"`
	Scope *CliRunContextScope `json:"scope,omitempty"`
}

// FixedFields lists the keys whose value the schema fixes for a CliRunContext.
func (CliRunContext) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a CliRunContext must carry.
func (CliRunContext) RequiredFields() []string { return nil }

// ContextRunStartRequest mirrors the ContextRunStartRequest schema shape.
type ContextRunStartRequest struct {
	Kind           string            `json:"kind"`
	Runtime        RuntimeConfig     `json:"runtime"`
	SessionOptions SessionOptions    `json:"session_options"`
	Session        json.RawMessage   `json:"session"`
	Input          AgentInput        `json:"input"`
	RunContext     ContextRunContext `json:"run_context"`
	CLIRunContext  *CliRunContext    `json:"cli_run_context,omitempty"`
	RunResources   LocalRunResources `json:"run_resources"`
}

// FixedFields lists the keys whose value the schema fixes for a ContextRunStartRequest.
func (ContextRunStartRequest) FixedFields() map[string]string {
	return map[string]string{"kind": "run.start"}
}

// RequiredFields lists the keys a ContextRunStartRequest must carry.
func (ContextRunStartRequest) RequiredFields() []string {
	return []string{"kind", "runtime", "session_options", "session", "input", "run_context", "run_resources"}
}

// OperationStart mirrors the OperationStart schema shape.
type OperationStart struct {
	ProtocolVersion     string          `json:"protocol_version"`
	HostAccess          string          `json:"host_access"`
	ExecutionContextKey string          `json:"execution_context_key"`
	RuntimeInstanceID   string          `json:"runtime_instance_id"`
	ContextViewRef      ContextViewRef  `json:"context_view_ref"`
	Type                string          `json:"type"`
	CommandID           string          `json:"command_id"`
	TenantID            string          `json:"tenant_id"`
	RegistrationID      string          `json:"registration_id"`
	AssignmentRevision  uint64          `json:"assignment_revision"`
	RunnerID            string          `json:"runner_id"`
	AgentID             string          `json:"agent_id"`
	OperationID         string          `json:"operation_id"`
	ConnectionEpoch     uint64          `json:"connection_epoch"`
	RunnerRevision      uint64          `json:"runner_revision"`
	Generation          uint64          `json:"generation"`
	ExecutionLeaseID    string          `json:"execution_lease_id"`
	WorkspaceGrantID    string          `json:"workspace_grant_id"`
	RuntimeType         string          `json:"runtime_type"`
	Request             json.RawMessage `json:"request"`
}

// FixedFields lists the keys whose value the schema fixes for a OperationStart.
func (OperationStart) FixedFields() map[string]string {
	return map[string]string{"protocol_version": "2", "host_access": "trusted", "type": "operation.start"}
}

// RequiredFields lists the keys a OperationStart must carry.
func (OperationStart) RequiredFields() []string {
	return []string{"protocol_version", "host_access", "execution_context_key", "runtime_instance_id", "context_view_ref", "type", "command_id", "tenant_id", "registration_id", "assignment_revision", "runner_id", "agent_id", "operation_id", "connection_epoch", "runner_revision", "generation", "execution_lease_id", "workspace_grant_id", "runtime_type", "request"}
}

// OperationPrepare mirrors the OperationPrepare schema shape.
type OperationPrepare struct {
	ProtocolVersion     string                    `json:"protocol_version"`
	HostAccess          string                    `json:"host_access"`
	ExecutionContextKey string                    `json:"execution_context_key"`
	RuntimeInstanceID   string                    `json:"runtime_instance_id"`
	ContextViewRef      ContextViewRef            `json:"context_view_ref"`
	TenantID            string                    `json:"tenant_id"`
	RegistrationID      string                    `json:"registration_id"`
	AssignmentRevision  uint64                    `json:"assignment_revision"`
	RunnerID            string                    `json:"runner_id"`
	AgentID             string                    `json:"agent_id"`
	OperationID         string                    `json:"operation_id"`
	ConnectionEpoch     uint64                    `json:"connection_epoch"`
	RunnerRevision      uint64                    `json:"runner_revision"`
	Generation          uint64                    `json:"generation"`
	ExecutionLeaseID    string                    `json:"execution_lease_id"`
	WorkspaceGrantID    string                    `json:"workspace_grant_id"`
	RuntimeType         string                    `json:"runtime_type"`
	Type                string                    `json:"type"`
	CommandID           string                    `json:"command_id"`
	Runtime             RuntimeConfig             `json:"runtime"`
	SessionOptions      SessionOptions            `json:"session_options"`
	Session             json.RawMessage           `json:"session"`
	PermissionReview    *bool                     `json:"permission_review,omitempty"`
	MCPRelays           []LocalMcpRelayDescriptor `json:"mcp_relays"`
	Target              string                    `json:"target"`
}

// FixedFields lists the keys whose value the schema fixes for a OperationPrepare.
func (OperationPrepare) FixedFields() map[string]string {
	return map[string]string{"protocol_version": "2", "host_access": "trusted", "type": "prepare", "target": "operation"}
}

// RequiredFields lists the keys a OperationPrepare must carry.
func (OperationPrepare) RequiredFields() []string {
	return []string{"protocol_version", "host_access", "execution_context_key", "runtime_instance_id", "context_view_ref", "tenant_id", "registration_id", "assignment_revision", "runner_id", "agent_id", "operation_id", "connection_epoch", "runner_revision", "generation", "execution_lease_id", "workspace_grant_id", "runtime_type", "type", "command_id", "runtime", "session_options", "session", "mcp_relays", "target"}
}

// OperationIdentity mirrors the OperationIdentity schema shape.
type OperationIdentity struct {
	ProtocolVersion     string         `json:"protocol_version"`
	HostAccess          string         `json:"host_access"`
	ExecutionContextKey string         `json:"execution_context_key"`
	RuntimeInstanceID   string         `json:"runtime_instance_id"`
	ContextViewRef      ContextViewRef `json:"context_view_ref"`
	TenantID            string         `json:"tenant_id"`
	RegistrationID      string         `json:"registration_id"`
	AssignmentRevision  uint64         `json:"assignment_revision"`
	RunnerID            string         `json:"runner_id"`
	AgentID             string         `json:"agent_id"`
	OperationID         string         `json:"operation_id"`
	ConnectionEpoch     uint64         `json:"connection_epoch"`
	RunnerRevision      uint64         `json:"runner_revision"`
	Generation          uint64         `json:"generation"`
	ExecutionLeaseID    string         `json:"execution_lease_id"`
	WorkspaceGrantID    string         `json:"workspace_grant_id"`
	RuntimeType         string         `json:"runtime_type"`
}

// FixedFields lists the keys whose value the schema fixes for a OperationIdentity.
func (OperationIdentity) FixedFields() map[string]string {
	return map[string]string{"protocol_version": "2", "host_access": "trusted"}
}

// RequiredFields lists the keys a OperationIdentity must carry.
func (OperationIdentity) RequiredFields() []string {
	return []string{"protocol_version", "host_access", "execution_context_key", "runtime_instance_id", "context_view_ref", "tenant_id", "registration_id", "assignment_revision", "runner_id", "agent_id", "operation_id", "connection_epoch", "runner_revision", "generation", "execution_lease_id", "workspace_grant_id", "runtime_type"}
}

// OperationInput mirrors the OperationInput schema shape.
type OperationInput struct {
	ProtocolVersion     string         `json:"protocol_version"`
	HostAccess          string         `json:"host_access"`
	ExecutionContextKey string         `json:"execution_context_key"`
	RuntimeInstanceID   string         `json:"runtime_instance_id"`
	ContextViewRef      ContextViewRef `json:"context_view_ref"`
	TenantID            string         `json:"tenant_id"`
	RegistrationID      string         `json:"registration_id"`
	AssignmentRevision  uint64         `json:"assignment_revision"`
	RunnerID            string         `json:"runner_id"`
	AgentID             string         `json:"agent_id"`
	OperationID         string         `json:"operation_id"`
	ConnectionEpoch     uint64         `json:"connection_epoch"`
	RunnerRevision      uint64         `json:"runner_revision"`
	Generation          uint64         `json:"generation"`
	ExecutionLeaseID    string         `json:"execution_lease_id"`
	WorkspaceGrantID    string         `json:"workspace_grant_id"`
	RuntimeType         string         `json:"runtime_type"`
	Type                string         `json:"type"`
	CommandID           string         `json:"command_id"`
	ExpectedTurnID      string         `json:"expected_turn_id"`
	InputContextViewRef ContextViewRef `json:"input_context_view_ref"`
	Input               AgentInput     `json:"input"`
}

// FixedFields lists the keys whose value the schema fixes for a OperationInput.
func (OperationInput) FixedFields() map[string]string {
	return map[string]string{"protocol_version": "2", "host_access": "trusted", "type": "operation.input"}
}

// RequiredFields lists the keys a OperationInput must carry.
func (OperationInput) RequiredFields() []string {
	return []string{"protocol_version", "host_access", "execution_context_key", "runtime_instance_id", "context_view_ref", "tenant_id", "registration_id", "assignment_revision", "runner_id", "agent_id", "operation_id", "connection_epoch", "runner_revision", "generation", "execution_lease_id", "workspace_grant_id", "runtime_type", "type", "command_id", "expected_turn_id", "input_context_view_ref", "input"}
}

// OperationCancel mirrors the OperationCancel schema shape.
type OperationCancel struct {
	ProtocolVersion     string         `json:"protocol_version"`
	HostAccess          string         `json:"host_access"`
	ExecutionContextKey string         `json:"execution_context_key"`
	RuntimeInstanceID   string         `json:"runtime_instance_id"`
	ContextViewRef      ContextViewRef `json:"context_view_ref"`
	TenantID            string         `json:"tenant_id"`
	RegistrationID      string         `json:"registration_id"`
	AssignmentRevision  uint64         `json:"assignment_revision"`
	RunnerID            string         `json:"runner_id"`
	AgentID             string         `json:"agent_id"`
	OperationID         string         `json:"operation_id"`
	ConnectionEpoch     uint64         `json:"connection_epoch"`
	RunnerRevision      uint64         `json:"runner_revision"`
	Generation          uint64         `json:"generation"`
	ExecutionLeaseID    string         `json:"execution_lease_id"`
	WorkspaceGrantID    string         `json:"workspace_grant_id"`
	RuntimeType         string         `json:"runtime_type"`
	Type                string         `json:"type"`
	CommandID           string         `json:"command_id"`
	Reason              string         `json:"reason"`
	Target              string         `json:"target"`
}

// FixedFields lists the keys whose value the schema fixes for a OperationCancel.
func (OperationCancel) FixedFields() map[string]string {
	return map[string]string{"protocol_version": "2", "host_access": "trusted", "type": "cancel", "target": "operation"}
}

// RequiredFields lists the keys a OperationCancel must carry.
func (OperationCancel) RequiredFields() []string {
	return []string{"protocol_version", "host_access", "execution_context_key", "runtime_instance_id", "context_view_ref", "tenant_id", "registration_id", "assignment_revision", "runner_id", "agent_id", "operation_id", "connection_epoch", "runner_revision", "generation", "execution_lease_id", "workspace_grant_id", "runtime_type", "type", "command_id", "reason", "target"}
}

// OperationAck mirrors the OperationAck schema shape.
type OperationAck struct {
	ProtocolVersion     string         `json:"protocol_version"`
	HostAccess          string         `json:"host_access"`
	ExecutionContextKey string         `json:"execution_context_key"`
	RuntimeInstanceID   string         `json:"runtime_instance_id"`
	ContextViewRef      ContextViewRef `json:"context_view_ref"`
	TenantID            string         `json:"tenant_id"`
	RegistrationID      string         `json:"registration_id"`
	AssignmentRevision  uint64         `json:"assignment_revision"`
	RunnerID            string         `json:"runner_id"`
	AgentID             string         `json:"agent_id"`
	OperationID         string         `json:"operation_id"`
	ConnectionEpoch     uint64         `json:"connection_epoch"`
	RunnerRevision      uint64         `json:"runner_revision"`
	Generation          uint64         `json:"generation"`
	ExecutionLeaseID    string         `json:"execution_lease_id"`
	WorkspaceGrantID    string         `json:"workspace_grant_id"`
	RuntimeType         string         `json:"runtime_type"`
	Type                string         `json:"type"`
	CommandID           string         `json:"command_id"`
	ThroughSeq          uint64         `json:"through_seq"`
}

// FixedFields lists the keys whose value the schema fixes for a OperationAck.
func (OperationAck) FixedFields() map[string]string {
	return map[string]string{"protocol_version": "2", "host_access": "trusted", "type": "operation.ack"}
}

// RequiredFields lists the keys a OperationAck must carry.
func (OperationAck) RequiredFields() []string {
	return []string{"protocol_version", "host_access", "execution_context_key", "runtime_instance_id", "context_view_ref", "tenant_id", "registration_id", "assignment_revision", "runner_id", "agent_id", "operation_id", "connection_epoch", "runner_revision", "generation", "execution_lease_id", "workspace_grant_id", "runtime_type", "type", "command_id", "through_seq"}
}

// OperationAccepted mirrors the OperationAccepted schema shape.
type OperationAccepted struct {
	ProtocolVersion     string          `json:"protocol_version"`
	HostAccess          string          `json:"host_access"`
	ExecutionContextKey string          `json:"execution_context_key"`
	RuntimeInstanceID   string          `json:"runtime_instance_id"`
	ContextViewRef      ContextViewRef  `json:"context_view_ref"`
	TenantID            string          `json:"tenant_id"`
	RegistrationID      string          `json:"registration_id"`
	AssignmentRevision  uint64          `json:"assignment_revision"`
	RunnerID            string          `json:"runner_id"`
	AgentID             string          `json:"agent_id"`
	OperationID         string          `json:"operation_id"`
	ConnectionEpoch     uint64          `json:"connection_epoch"`
	RunnerRevision      uint64          `json:"runner_revision"`
	Generation          uint64          `json:"generation"`
	ExecutionLeaseID    string          `json:"execution_lease_id"`
	WorkspaceGrantID    string          `json:"workspace_grant_id"`
	RuntimeType         string          `json:"runtime_type"`
	Type                string          `json:"type"`
	Seq                 uint64          `json:"seq"`
	CommandID           string          `json:"command_id"`
	RunnerPID           uint64          `json:"runner_pid"`
	RuntimePID          *uint64         `json:"runtime_pid,omitempty"`
	Session             json.RawMessage `json:"session,omitempty"`
}

// FixedFields lists the keys whose value the schema fixes for a OperationAccepted.
func (OperationAccepted) FixedFields() map[string]string {
	return map[string]string{"protocol_version": "2", "host_access": "trusted", "type": "operation.accepted"}
}

// RequiredFields lists the keys a OperationAccepted must carry.
func (OperationAccepted) RequiredFields() []string {
	return []string{"protocol_version", "host_access", "execution_context_key", "runtime_instance_id", "context_view_ref", "tenant_id", "registration_id", "assignment_revision", "runner_id", "agent_id", "operation_id", "connection_epoch", "runner_revision", "generation", "execution_lease_id", "workspace_grant_id", "runtime_type", "type", "seq", "command_id", "runner_pid"}
}

// NativeResumeMeasurement mirrors the NativeResumeMeasurement schema shape.
type NativeResumeMeasurement struct {
	DurationMs uint64 `json:"duration_ms"`
	Result     string `json:"result"`
}

// FixedFields lists the keys whose value the schema fixes for a NativeResumeMeasurement.
func (NativeResumeMeasurement) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a NativeResumeMeasurement must carry.
func (NativeResumeMeasurement) RequiredFields() []string { return []string{"duration_ms", "result"} }

// OperationPrepared mirrors the OperationPrepared schema shape.
type OperationPrepared struct {
	ProtocolVersion     string                   `json:"protocol_version"`
	HostAccess          string                   `json:"host_access"`
	ExecutionContextKey string                   `json:"execution_context_key"`
	RuntimeInstanceID   string                   `json:"runtime_instance_id"`
	ContextViewRef      ContextViewRef           `json:"context_view_ref"`
	TenantID            string                   `json:"tenant_id"`
	RegistrationID      string                   `json:"registration_id"`
	AssignmentRevision  uint64                   `json:"assignment_revision"`
	RunnerID            string                   `json:"runner_id"`
	AgentID             string                   `json:"agent_id"`
	OperationID         string                   `json:"operation_id"`
	ConnectionEpoch     uint64                   `json:"connection_epoch"`
	RunnerRevision      uint64                   `json:"runner_revision"`
	Generation          uint64                   `json:"generation"`
	ExecutionLeaseID    string                   `json:"execution_lease_id"`
	WorkspaceGrantID    string                   `json:"workspace_grant_id"`
	RuntimeType         string                   `json:"runtime_type"`
	Type                string                   `json:"type"`
	CommandID           string                   `json:"command_id"`
	PrepareCommandID    string                   `json:"prepare_command_id"`
	Prepared            bool                     `json:"prepared"`
	PrepareNativeResume *NativeResumeMeasurement `json:"prepare_native_resume,omitempty"`
	Outcome             string                   `json:"outcome"`
	DurationMs          uint64                   `json:"duration_ms"`
	Error               *AgentRunnerError        `json:"error,omitempty"`
	Reason              string                   `json:"reason,omitempty"`
	Target              string                   `json:"target"`
}

// FixedFields lists the keys whose value the schema fixes for a OperationPrepared.
func (OperationPrepared) FixedFields() map[string]string {
	return map[string]string{"protocol_version": "2", "host_access": "trusted", "type": "prepared", "target": "operation"}
}

// RequiredFields lists the keys a OperationPrepared must carry.
func (OperationPrepared) RequiredFields() []string {
	return []string{"protocol_version", "host_access", "execution_context_key", "runtime_instance_id", "context_view_ref", "tenant_id", "registration_id", "assignment_revision", "runner_id", "agent_id", "operation_id", "connection_epoch", "runner_revision", "generation", "execution_lease_id", "workspace_grant_id", "runtime_type", "type", "command_id", "prepare_command_id", "prepared", "outcome", "duration_ms", "target"}
}

// ProviderPrepareRunContext mirrors the ProviderPrepareRunContext schema shape.
type ProviderPrepareRunContext struct {
	HumanInteractions *bool `json:"human_interactions,omitempty"`
	PermissionReview  *bool `json:"permission_review,omitempty"`
}

// FixedFields lists the keys whose value the schema fixes for a ProviderPrepareRunContext.
func (ProviderPrepareRunContext) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a ProviderPrepareRunContext must carry.
func (ProviderPrepareRunContext) RequiredFields() []string { return nil }

// ProviderPrepare mirrors the ProviderPrepare schema shape.
type ProviderPrepare struct {
	Type                string                     `json:"type"`
	CommandID           string                     `json:"command_id"`
	PrepareID           string                     `json:"prepare_id"`
	ProtocolVersion     string                     `json:"protocol_version"`
	HostAccess          string                     `json:"host_access"`
	TenantID            string                     `json:"tenant_id"`
	RegistrationID      string                     `json:"registration_id"`
	AssignmentRevision  uint64                     `json:"assignment_revision"`
	RunnerID            string                     `json:"runner_id"`
	RunnerRevision      uint64                     `json:"runner_revision"`
	ConnectionEpoch     uint64                     `json:"connection_epoch"`
	AgentID             string                     `json:"agent_id"`
	WorkspaceGrantID    string                     `json:"workspace_grant_id"`
	RuntimeType         string                     `json:"runtime_type"`
	ExecutionContextKey string                     `json:"execution_context_key"`
	RuntimeInstanceID   string                     `json:"runtime_instance_id"`
	ContextViewRef      ContextViewRef             `json:"context_view_ref"`
	Runtime             RuntimeConfig              `json:"runtime"`
	SessionOptions      SessionOptions             `json:"session_options"`
	Session             json.RawMessage            `json:"session"`
	RunContext          *ProviderPrepareRunContext `json:"run_context,omitempty"`
	Target              string                     `json:"target"`
}

// FixedFields lists the keys whose value the schema fixes for a ProviderPrepare.
func (ProviderPrepare) FixedFields() map[string]string {
	return map[string]string{"type": "prepare", "protocol_version": "2", "host_access": "trusted", "target": "provider"}
}

// RequiredFields lists the keys a ProviderPrepare must carry.
func (ProviderPrepare) RequiredFields() []string {
	return []string{"type", "command_id", "prepare_id", "protocol_version", "host_access", "tenant_id", "registration_id", "assignment_revision", "runner_id", "runner_revision", "connection_epoch", "agent_id", "workspace_grant_id", "runtime_type", "execution_context_key", "runtime_instance_id", "context_view_ref", "runtime", "session_options", "session", "target"}
}

// SessionCompact mirrors the SessionCompact schema shape.
type SessionCompact struct {
	Type                string `json:"type"`
	CommandID           string `json:"command_id"`
	CompactID           string `json:"compact_id"`
	ProtocolVersion     string `json:"protocol_version"`
	RunnerID            string `json:"runner_id"`
	ConnectionEpoch     uint64 `json:"connection_epoch"`
	AgentID             string `json:"agent_id"`
	RuntimeType         string `json:"runtime_type"`
	ExecutionContextKey string `json:"execution_context_key"`
	Instructions        string `json:"instructions,omitempty"`
	Kind                string `json:"kind"`
}

// FixedFields lists the keys whose value the schema fixes for a SessionCompact.
func (SessionCompact) FixedFields() map[string]string {
	return map[string]string{"type": "execute", "protocol_version": "2", "kind": "session_compact"}
}

// RequiredFields lists the keys a SessionCompact must carry.
func (SessionCompact) RequiredFields() []string {
	return []string{"type", "command_id", "compact_id", "protocol_version", "runner_id", "connection_epoch", "agent_id", "runtime_type", "execution_context_key", "kind"}
}

// ModelInvokeFile mirrors the ModelInvokeFile schema shape.
type ModelInvokeFile struct {
	Path          string `json:"path"`
	ContentBase64 string `json:"content_base64"`
}

// FixedFields lists the keys whose value the schema fixes for a ModelInvokeFile.
func (ModelInvokeFile) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a ModelInvokeFile must carry.
func (ModelInvokeFile) RequiredFields() []string { return []string{"path", "content_base64"} }

// ModelInvoke mirrors the ModelInvoke schema shape.
type ModelInvoke struct {
	Type            string            `json:"type"`
	CommandID       string            `json:"command_id"`
	InvokeID        string            `json:"invoke_id"`
	ProtocolVersion string            `json:"protocol_version"`
	RunnerID        string            `json:"runner_id"`
	ConnectionEpoch uint64            `json:"connection_epoch"`
	TenantID        string            `json:"tenant_id"`
	OwnerActorID    string            `json:"owner_actor_id"`
	AgentID         string            `json:"agent_id"`
	RuntimeType     string            `json:"runtime_type"`
	Mode            string            `json:"mode"`
	ReasoningEffort string            `json:"reasoning_effort"`
	Instructions    string            `json:"instructions,omitempty"`
	Input           string            `json:"input"`
	OutputSchema    json.RawMessage   `json:"output_schema,omitempty"`
	WorkspaceFiles  []ModelInvokeFile `json:"workspace_files,omitempty"`
	TimeoutMs       uint64            `json:"timeout_ms"`
	Kind            string            `json:"kind"`
	MaxOutputChars  *uint64           `json:"max_output_chars,omitempty"`
	SessionKey      string            `json:"session_key,omitempty"`
}

// FixedFields lists the keys whose value the schema fixes for a ModelInvoke.
func (ModelInvoke) FixedFields() map[string]string {
	return map[string]string{"type": "execute", "protocol_version": "2", "kind": "model_invoke"}
}

// RequiredFields lists the keys a ModelInvoke must carry.
func (ModelInvoke) RequiredFields() []string {
	return []string{"type", "command_id", "invoke_id", "protocol_version", "runner_id", "connection_epoch", "tenant_id", "owner_actor_id", "agent_id", "runtime_type", "mode", "reasoning_effort", "input", "timeout_ms", "kind"}
}

// ModelInvokedUsage mirrors the ModelInvokedUsage schema shape.
type ModelInvokedUsage struct {
	InputTokens       uint64 `json:"input_tokens"`
	CachedInputTokens uint64 `json:"cached_input_tokens"`
	OutputTokens      uint64 `json:"output_tokens"`
}

// FixedFields lists the keys whose value the schema fixes for a ModelInvokedUsage.
func (ModelInvokedUsage) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a ModelInvokedUsage must carry.
func (ModelInvokedUsage) RequiredFields() []string {
	return []string{"input_tokens", "cached_input_tokens", "output_tokens"}
}

// ModelInvoked mirrors the ModelInvoked schema shape.
type ModelInvoked struct {
	Type           string             `json:"type"`
	CommandID      string             `json:"command_id"`
	RunnerID       string             `json:"runner_id"`
	InvokeID       string             `json:"invoke_id"`
	Outcome        string             `json:"outcome"`
	Text           string             `json:"text,omitempty"`
	WorkspaceFiles []ModelInvokeFile  `json:"workspace_files,omitempty"`
	Model          string             `json:"model,omitempty"`
	RuntimeVersion string             `json:"runtime_version,omitempty"`
	Usage          *ModelInvokedUsage `json:"usage,omitempty"`
	Reason         string             `json:"reason,omitempty"`
	DurationMs     uint64             `json:"duration_ms"`
	Kind           string             `json:"kind"`
}

// FixedFields lists the keys whose value the schema fixes for a ModelInvoked.
func (ModelInvoked) FixedFields() map[string]string {
	return map[string]string{"type": "executed", "kind": "model_invoke"}
}

// RequiredFields lists the keys a ModelInvoked must carry.
func (ModelInvoked) RequiredFields() []string {
	return []string{"type", "command_id", "runner_id", "invoke_id", "outcome", "duration_ms", "kind"}
}

// SessionCompacted mirrors the SessionCompacted schema shape.
type SessionCompacted struct {
	Type                string  `json:"type"`
	CommandID           string  `json:"command_id"`
	RunnerID            string  `json:"runner_id"`
	CompactID           string  `json:"compact_id"`
	ExecutionContextKey string  `json:"execution_context_key"`
	Outcome             string  `json:"outcome"`
	PreTokens           *uint64 `json:"pre_tokens,omitempty"`
	Reason              string  `json:"reason,omitempty"`
	DurationMs          uint64  `json:"duration_ms"`
	Kind                string  `json:"kind"`
}

// FixedFields lists the keys whose value the schema fixes for a SessionCompacted.
func (SessionCompacted) FixedFields() map[string]string {
	return map[string]string{"type": "executed", "kind": "session_compact"}
}

// RequiredFields lists the keys a SessionCompacted must carry.
func (SessionCompacted) RequiredFields() []string {
	return []string{"type", "command_id", "runner_id", "compact_id", "execution_context_key", "outcome", "duration_ms", "kind"}
}

// ProviderPrepared mirrors the ProviderPrepared schema shape.
type ProviderPrepared struct {
	Type                string `json:"type"`
	CommandID           string `json:"command_id"`
	RunnerID            string `json:"runner_id"`
	PrepareID           string `json:"prepare_id"`
	ExecutionContextKey string `json:"execution_context_key"`
	Outcome             string `json:"outcome"`
	Reason              string `json:"reason,omitempty"`
	DurationMs          uint64 `json:"duration_ms"`
	Target              string `json:"target"`
}

// FixedFields lists the keys whose value the schema fixes for a ProviderPrepared.
func (ProviderPrepared) FixedFields() map[string]string {
	return map[string]string{"type": "prepared", "target": "provider"}
}

// RequiredFields lists the keys a ProviderPrepared must carry.
func (ProviderPrepared) RequiredFields() []string {
	return []string{"type", "command_id", "runner_id", "prepare_id", "execution_context_key", "outcome", "duration_ms", "target"}
}

// RunPlanStep mirrors the RunPlanStep schema shape.
type RunPlanStep struct {
	Content string `json:"content"`
	Status  string `json:"status"`
}

// FixedFields lists the keys whose value the schema fixes for a RunPlanStep.
func (RunPlanStep) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a RunPlanStep must carry.
func (RunPlanStep) RequiredFields() []string { return []string{"content", "status"} }

// RunActivityContentBlock mirrors the RunActivityContentBlock schema shape.
type RunActivityContentBlock struct {
	Format  string `json:"format"`
	Label   string `json:"label,omitempty"`
	Content string `json:"content"`
}

// FixedFields lists the keys whose value the schema fixes for a RunActivityContentBlock.
func (RunActivityContentBlock) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a RunActivityContentBlock must carry.
func (RunActivityContentBlock) RequiredFields() []string { return []string{"format", "content"} }

// OperationEvent mirrors the OperationEvent schema shape.
type OperationEvent struct {
	ProtocolVersion     string          `json:"protocol_version"`
	HostAccess          string          `json:"host_access"`
	ExecutionContextKey string          `json:"execution_context_key"`
	RuntimeInstanceID   string          `json:"runtime_instance_id"`
	ContextViewRef      ContextViewRef  `json:"context_view_ref"`
	TenantID            string          `json:"tenant_id"`
	RegistrationID      string          `json:"registration_id"`
	AssignmentRevision  uint64          `json:"assignment_revision"`
	RunnerID            string          `json:"runner_id"`
	AgentID             string          `json:"agent_id"`
	OperationID         string          `json:"operation_id"`
	ConnectionEpoch     uint64          `json:"connection_epoch"`
	RunnerRevision      uint64          `json:"runner_revision"`
	Generation          uint64          `json:"generation"`
	ExecutionLeaseID    string          `json:"execution_lease_id"`
	WorkspaceGrantID    string          `json:"workspace_grant_id"`
	RuntimeType         string          `json:"runtime_type"`
	Type                string          `json:"type"`
	Seq                 uint64          `json:"seq"`
	Event               json.RawMessage `json:"event"`
}

// FixedFields lists the keys whose value the schema fixes for a OperationEvent.
func (OperationEvent) FixedFields() map[string]string {
	return map[string]string{"protocol_version": "2", "host_access": "trusted", "type": "operation.event"}
}

// RequiredFields lists the keys a OperationEvent must carry.
func (OperationEvent) RequiredFields() []string {
	return []string{"protocol_version", "host_access", "execution_context_key", "runtime_instance_id", "context_view_ref", "tenant_id", "registration_id", "assignment_revision", "runner_id", "agent_id", "operation_id", "connection_epoch", "runner_revision", "generation", "execution_lease_id", "workspace_grant_id", "runtime_type", "type", "seq", "event"}
}

// OperationInputAck mirrors the OperationInputAck schema shape.
type OperationInputAck struct {
	ProtocolVersion     string         `json:"protocol_version"`
	HostAccess          string         `json:"host_access"`
	ExecutionContextKey string         `json:"execution_context_key"`
	RuntimeInstanceID   string         `json:"runtime_instance_id"`
	ContextViewRef      ContextViewRef `json:"context_view_ref"`
	TenantID            string         `json:"tenant_id"`
	RegistrationID      string         `json:"registration_id"`
	AssignmentRevision  uint64         `json:"assignment_revision"`
	RunnerID            string         `json:"runner_id"`
	AgentID             string         `json:"agent_id"`
	OperationID         string         `json:"operation_id"`
	ConnectionEpoch     uint64         `json:"connection_epoch"`
	RunnerRevision      uint64         `json:"runner_revision"`
	Generation          uint64         `json:"generation"`
	ExecutionLeaseID    string         `json:"execution_lease_id"`
	WorkspaceGrantID    string         `json:"workspace_grant_id"`
	RuntimeType         string         `json:"runtime_type"`
	Type                string         `json:"type"`
	Seq                 uint64         `json:"seq"`
	CommandID           string         `json:"command_id"`
	TurnID              string         `json:"turn_id"`
	Outcome             string         `json:"outcome"`
}

// FixedFields lists the keys whose value the schema fixes for a OperationInputAck.
func (OperationInputAck) FixedFields() map[string]string {
	return map[string]string{"protocol_version": "2", "host_access": "trusted", "type": "operation.input_result", "outcome": "accepted"}
}

// RequiredFields lists the keys a OperationInputAck must carry.
func (OperationInputAck) RequiredFields() []string {
	return []string{"protocol_version", "host_access", "execution_context_key", "runtime_instance_id", "context_view_ref", "tenant_id", "registration_id", "assignment_revision", "runner_id", "agent_id", "operation_id", "connection_epoch", "runner_revision", "generation", "execution_lease_id", "workspace_grant_id", "runtime_type", "type", "seq", "command_id", "turn_id", "outcome"}
}

// OperationInputClosed mirrors the OperationInputClosed schema shape.
type OperationInputClosed struct {
	ProtocolVersion     string         `json:"protocol_version"`
	HostAccess          string         `json:"host_access"`
	ExecutionContextKey string         `json:"execution_context_key"`
	RuntimeInstanceID   string         `json:"runtime_instance_id"`
	ContextViewRef      ContextViewRef `json:"context_view_ref"`
	TenantID            string         `json:"tenant_id"`
	RegistrationID      string         `json:"registration_id"`
	AssignmentRevision  uint64         `json:"assignment_revision"`
	RunnerID            string         `json:"runner_id"`
	AgentID             string         `json:"agent_id"`
	OperationID         string         `json:"operation_id"`
	ConnectionEpoch     uint64         `json:"connection_epoch"`
	RunnerRevision      uint64         `json:"runner_revision"`
	Generation          uint64         `json:"generation"`
	ExecutionLeaseID    string         `json:"execution_lease_id"`
	WorkspaceGrantID    string         `json:"workspace_grant_id"`
	RuntimeType         string         `json:"runtime_type"`
	Type                string         `json:"type"`
	CommandID           string         `json:"command_id"`
	ExpectedTurnID      string         `json:"expected_turn_id"`
	Effect              string         `json:"effect"`
	Outcome             string         `json:"outcome"`
}

// FixedFields lists the keys whose value the schema fixes for a OperationInputClosed.
func (OperationInputClosed) FixedFields() map[string]string {
	return map[string]string{"protocol_version": "2", "host_access": "trusted", "type": "operation.input_result", "outcome": "closed"}
}

// RequiredFields lists the keys a OperationInputClosed must carry.
func (OperationInputClosed) RequiredFields() []string {
	return []string{"protocol_version", "host_access", "execution_context_key", "runtime_instance_id", "context_view_ref", "tenant_id", "registration_id", "assignment_revision", "runner_id", "agent_id", "operation_id", "connection_epoch", "runner_revision", "generation", "execution_lease_id", "workspace_grant_id", "runtime_type", "type", "command_id", "expected_turn_id", "effect", "outcome"}
}

// OperationInputRejected mirrors the OperationInputRejected schema shape.
type OperationInputRejected struct {
	ProtocolVersion     string         `json:"protocol_version"`
	HostAccess          string         `json:"host_access"`
	ExecutionContextKey string         `json:"execution_context_key"`
	RuntimeInstanceID   string         `json:"runtime_instance_id"`
	ContextViewRef      ContextViewRef `json:"context_view_ref"`
	TenantID            string         `json:"tenant_id"`
	RegistrationID      string         `json:"registration_id"`
	AssignmentRevision  uint64         `json:"assignment_revision"`
	RunnerID            string         `json:"runner_id"`
	AgentID             string         `json:"agent_id"`
	OperationID         string         `json:"operation_id"`
	ConnectionEpoch     uint64         `json:"connection_epoch"`
	RunnerRevision      uint64         `json:"runner_revision"`
	Generation          uint64         `json:"generation"`
	ExecutionLeaseID    string         `json:"execution_lease_id"`
	WorkspaceGrantID    string         `json:"workspace_grant_id"`
	RuntimeType         string         `json:"runtime_type"`
	Type                string         `json:"type"`
	Seq                 uint64         `json:"seq"`
	CommandID           string         `json:"command_id"`
	ExpectedTurnID      string         `json:"expected_turn_id"`
	ActualTurnID        string         `json:"actual_turn_id,omitempty"`
	Effect              string         `json:"effect"`
	Reason              string         `json:"reason"`
	Message             string         `json:"message"`
	Outcome             string         `json:"outcome"`
}

// FixedFields lists the keys whose value the schema fixes for a OperationInputRejected.
func (OperationInputRejected) FixedFields() map[string]string {
	return map[string]string{"protocol_version": "2", "host_access": "trusted", "type": "operation.input_result", "outcome": "rejected"}
}

// RequiredFields lists the keys a OperationInputRejected must carry.
func (OperationInputRejected) RequiredFields() []string {
	return []string{"protocol_version", "host_access", "execution_context_key", "runtime_instance_id", "context_view_ref", "tenant_id", "registration_id", "assignment_revision", "runner_id", "agent_id", "operation_id", "connection_epoch", "runner_revision", "generation", "execution_lease_id", "workspace_grant_id", "runtime_type", "type", "seq", "command_id", "expected_turn_id", "effect", "reason", "message", "outcome"}
}

// RunTokenCounts mirrors the RunTokenCounts schema shape.
type RunTokenCounts struct {
	Input      uint64  `json:"input"`
	CacheRead  uint64  `json:"cache_read"`
	CacheWrite uint64  `json:"cache_write"`
	Output     uint64  `json:"output"`
	Reasoning  *uint64 `json:"reasoning,omitempty"`
}

// FixedFields lists the keys whose value the schema fixes for a RunTokenCounts.
func (RunTokenCounts) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a RunTokenCounts must carry.
func (RunTokenCounts) RequiredFields() []string {
	return []string{"input", "cache_read", "cache_write", "output"}
}

// RunUsageItem mirrors the RunUsageItem schema shape.
type RunUsageItem struct {
	Input           uint64          `json:"input"`
	CacheRead       uint64          `json:"cache_read"`
	CacheWrite      uint64          `json:"cache_write"`
	Output          uint64          `json:"output"`
	Reasoning       *uint64         `json:"reasoning,omitempty"`
	Model           string          `json:"model"`
	Provider        string          `json:"provider"`
	Last            *RunTokenCounts `json:"last,omitempty"`
	CompactionCount *uint64         `json:"compaction_count,omitempty"`
}

// FixedFields lists the keys whose value the schema fixes for a RunUsageItem.
func (RunUsageItem) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a RunUsageItem must carry.
func (RunUsageItem) RequiredFields() []string {
	return []string{"input", "cache_read", "cache_write", "output", "model", "provider"}
}

// RunResult mirrors the RunResult schema shape.
type RunResult struct {
	Type                string                   `json:"type"`
	FinalResponse       string                   `json:"final_response"`
	Session             json.RawMessage          `json:"session"`
	NativeResume        *NativeResumeMeasurement `json:"native_resume,omitempty"`
	PrepareNativeResume *NativeResumeMeasurement `json:"prepare_native_resume,omitempty"`
	Usage               []RunUsageItem           `json:"usage,omitempty"`
}

// FixedFields lists the keys whose value the schema fixes for a RunResult.
func (RunResult) FixedFields() map[string]string { return map[string]string{"type": "run"} }

// RequiredFields lists the keys a RunResult must carry.
func (RunResult) RequiredFields() []string { return []string{"type", "final_response", "session"} }

// OperationCompleted mirrors the OperationCompleted schema shape.
type OperationCompleted struct {
	ProtocolVersion     string          `json:"protocol_version"`
	HostAccess          string          `json:"host_access"`
	ExecutionContextKey string          `json:"execution_context_key"`
	RuntimeInstanceID   string          `json:"runtime_instance_id"`
	ContextViewRef      ContextViewRef  `json:"context_view_ref"`
	TenantID            string          `json:"tenant_id"`
	RegistrationID      string          `json:"registration_id"`
	AssignmentRevision  uint64          `json:"assignment_revision"`
	RunnerID            string          `json:"runner_id"`
	AgentID             string          `json:"agent_id"`
	OperationID         string          `json:"operation_id"`
	ConnectionEpoch     uint64          `json:"connection_epoch"`
	RunnerRevision      uint64          `json:"runner_revision"`
	Generation          uint64          `json:"generation"`
	ExecutionLeaseID    string          `json:"execution_lease_id"`
	WorkspaceGrantID    string          `json:"workspace_grant_id"`
	RuntimeType         string          `json:"runtime_type"`
	Type                string          `json:"type"`
	Seq                 uint64          `json:"seq"`
	Result              json.RawMessage `json:"result"`
}

// FixedFields lists the keys whose value the schema fixes for a OperationCompleted.
func (OperationCompleted) FixedFields() map[string]string {
	return map[string]string{"protocol_version": "2", "host_access": "trusted", "type": "operation.completed"}
}

// RequiredFields lists the keys a OperationCompleted must carry.
func (OperationCompleted) RequiredFields() []string {
	return []string{"protocol_version", "host_access", "execution_context_key", "runtime_instance_id", "context_view_ref", "tenant_id", "registration_id", "assignment_revision", "runner_id", "agent_id", "operation_id", "connection_epoch", "runner_revision", "generation", "execution_lease_id", "workspace_grant_id", "runtime_type", "type", "seq", "result"}
}

// RuntimeExecutionFailure mirrors the RuntimeExecutionFailure schema shape.
type RuntimeExecutionFailure struct {
	Code           string `json:"code"`
	RuntimeType    string `json:"runtime_type"`
	RuntimeVersion string `json:"runtime_version,omitempty"`
}

// FixedFields lists the keys whose value the schema fixes for a RuntimeExecutionFailure.
func (RuntimeExecutionFailure) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a RuntimeExecutionFailure must carry.
func (RuntimeExecutionFailure) RequiredFields() []string { return []string{"code", "runtime_type"} }

// RuntimeFailureDiagnostics mirrors the RuntimeFailureDiagnostics schema shape.
type RuntimeFailureDiagnostics struct {
	ExitCode   *int64  `json:"exitCode,omitempty"`
	Signal     string  `json:"signal,omitempty"`
	Code       string  `json:"code,omitempty"`
	StatusCode *uint64 `json:"statusCode,omitempty"`
}

// FixedFields lists the keys whose value the schema fixes for a RuntimeFailureDiagnostics.
func (RuntimeFailureDiagnostics) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a RuntimeFailureDiagnostics must carry.
func (RuntimeFailureDiagnostics) RequiredFields() []string { return nil }

// OperationFailedError mirrors the OperationFailedError schema shape.
type OperationFailedError struct {
	Code        string                     `json:"code"`
	Message     string                     `json:"message"`
	Retryable   bool                       `json:"retryable"`
	Failure     *RuntimeExecutionFailure   `json:"failure,omitempty"`
	Diagnostics *RuntimeFailureDiagnostics `json:"diagnostics,omitempty"`
}

// FixedFields lists the keys whose value the schema fixes for a OperationFailedError.
func (OperationFailedError) FixedFields() map[string]string { return nil }

// RequiredFields lists the keys a OperationFailedError must carry.
func (OperationFailedError) RequiredFields() []string {
	return []string{"code", "message", "retryable"}
}

// OperationFailed mirrors the OperationFailed schema shape.
type OperationFailed struct {
	ProtocolVersion     string                   `json:"protocol_version"`
	HostAccess          string                   `json:"host_access"`
	ExecutionContextKey string                   `json:"execution_context_key"`
	RuntimeInstanceID   string                   `json:"runtime_instance_id"`
	ContextViewRef      ContextViewRef           `json:"context_view_ref"`
	TenantID            string                   `json:"tenant_id"`
	RegistrationID      string                   `json:"registration_id"`
	AssignmentRevision  uint64                   `json:"assignment_revision"`
	RunnerID            string                   `json:"runner_id"`
	AgentID             string                   `json:"agent_id"`
	OperationID         string                   `json:"operation_id"`
	ConnectionEpoch     uint64                   `json:"connection_epoch"`
	RunnerRevision      uint64                   `json:"runner_revision"`
	Generation          uint64                   `json:"generation"`
	ExecutionLeaseID    string                   `json:"execution_lease_id"`
	WorkspaceGrantID    string                   `json:"workspace_grant_id"`
	RuntimeType         string                   `json:"runtime_type"`
	NativeResume        *NativeResumeMeasurement `json:"native_resume,omitempty"`
	PrepareNativeResume *NativeResumeMeasurement `json:"prepare_native_resume,omitempty"`
	Usage               []RunUsageItem           `json:"usage,omitempty"`
	Type                string                   `json:"type"`
	Seq                 uint64                   `json:"seq"`
	Stage               string                   `json:"stage,omitempty"`
	Error               OperationFailedError     `json:"error"`
}

// FixedFields lists the keys whose value the schema fixes for a OperationFailed.
func (OperationFailed) FixedFields() map[string]string {
	return map[string]string{"protocol_version": "2", "host_access": "trusted", "type": "operation.failed"}
}

// RequiredFields lists the keys a OperationFailed must carry.
func (OperationFailed) RequiredFields() []string {
	return []string{"protocol_version", "host_access", "execution_context_key", "runtime_instance_id", "context_view_ref", "tenant_id", "registration_id", "assignment_revision", "runner_id", "agent_id", "operation_id", "connection_epoch", "runner_revision", "generation", "execution_lease_id", "workspace_grant_id", "runtime_type", "type", "seq", "error"}
}

// OperationCancelled mirrors the OperationCancelled schema shape.
type OperationCancelled struct {
	ProtocolVersion     string                   `json:"protocol_version"`
	HostAccess          string                   `json:"host_access"`
	ExecutionContextKey string                   `json:"execution_context_key"`
	RuntimeInstanceID   string                   `json:"runtime_instance_id"`
	ContextViewRef      ContextViewRef           `json:"context_view_ref"`
	TenantID            string                   `json:"tenant_id"`
	RegistrationID      string                   `json:"registration_id"`
	AssignmentRevision  uint64                   `json:"assignment_revision"`
	RunnerID            string                   `json:"runner_id"`
	AgentID             string                   `json:"agent_id"`
	OperationID         string                   `json:"operation_id"`
	ConnectionEpoch     uint64                   `json:"connection_epoch"`
	RunnerRevision      uint64                   `json:"runner_revision"`
	Generation          uint64                   `json:"generation"`
	ExecutionLeaseID    string                   `json:"execution_lease_id"`
	WorkspaceGrantID    string                   `json:"workspace_grant_id"`
	RuntimeType         string                   `json:"runtime_type"`
	NativeResume        *NativeResumeMeasurement `json:"native_resume,omitempty"`
	PrepareNativeResume *NativeResumeMeasurement `json:"prepare_native_resume,omitempty"`
	Usage               []RunUsageItem           `json:"usage,omitempty"`
	Type                string                   `json:"type"`
	Seq                 uint64                   `json:"seq"`
	Reason              string                   `json:"reason"`
}

// FixedFields lists the keys whose value the schema fixes for a OperationCancelled.
func (OperationCancelled) FixedFields() map[string]string {
	return map[string]string{"protocol_version": "2", "host_access": "trusted", "type": "operation.cancelled"}
}

// RequiredFields lists the keys a OperationCancelled must carry.
func (OperationCancelled) RequiredFields() []string {
	return []string{"protocol_version", "host_access", "execution_context_key", "runtime_instance_id", "context_view_ref", "tenant_id", "registration_id", "assignment_revision", "runner_id", "agent_id", "operation_id", "connection_epoch", "runner_revision", "generation", "execution_lease_id", "workspace_grant_id", "runtime_type", "type", "seq", "reason"}
}

// ComputerToolCall mirrors the ComputerToolCall schema shape.
type ComputerToolCall struct {
	Type            string           `json:"type"`
	ProtocolVersion string           `json:"protocol_version"`
	CommandID       string           `json:"command_id"`
	RunnerID        string           `json:"runner_id"`
	ConnectionEpoch uint64           `json:"connection_epoch"`
	TenantID        string           `json:"tenant_id"`
	OwnerActorID    string           `json:"owner_actor_id"`
	AgentID         string           `json:"agent_id"`
	ToolSessionID   string           `json:"tool_session_id"`
	Server          string           `json:"server"`
	ToolName        string           `json:"tool_name"`
	Arguments       json.RawMessage  `json:"arguments"`
	TaskScope       *SharedTaskScope `json:"task_scope,omitempty"`
	DeadlineMs      uint64           `json:"deadline_ms"`
	Kind            string           `json:"kind"`
}

// FixedFields lists the keys whose value the schema fixes for a ComputerToolCall.
func (ComputerToolCall) FixedFields() map[string]string {
	return map[string]string{"type": "execute", "protocol_version": "2", "kind": "computer_tool"}
}

// RequiredFields lists the keys a ComputerToolCall must carry.
func (ComputerToolCall) RequiredFields() []string {
	return []string{"type", "protocol_version", "command_id", "runner_id", "connection_epoch", "tenant_id", "owner_actor_id", "agent_id", "tool_session_id", "server", "tool_name", "arguments", "deadline_ms", "kind"}
}

// ComputerToolResult mirrors the ComputerToolResult schema shape.
type ComputerToolResult struct {
	Type            string          `json:"type"`
	ProtocolVersion string          `json:"protocol_version"`
	CommandID       string          `json:"command_id"`
	RunnerID        string          `json:"runner_id"`
	ConnectionEpoch uint64          `json:"connection_epoch"`
	TenantID        string          `json:"tenant_id"`
	OwnerActorID    string          `json:"owner_actor_id"`
	AgentID         string          `json:"agent_id"`
	Result          json.RawMessage `json:"result"`
	Kind            string          `json:"kind"`
}

// FixedFields lists the keys whose value the schema fixes for a ComputerToolResult.
func (ComputerToolResult) FixedFields() map[string]string {
	return map[string]string{"type": "executed", "protocol_version": "2", "kind": "computer_tool"}
}

// RequiredFields lists the keys a ComputerToolResult must carry.
func (ComputerToolResult) RequiredFields() []string {
	return []string{"type", "protocol_version", "command_id", "runner_id", "connection_epoch", "tenant_id", "owner_actor_id", "agent_id", "result", "kind"}
}

// Shape is a generated message shape.
type Shape interface {
	RequiredFields() []string
	FixedFields() map[string]string
}

// Decode reads data into value, rejecting unknown and missing top-level keys
// and top-level values other than the ones the schema fixes.
func Decode(data []byte, value Shape) error {
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(data, &keys); err != nil {
		return err
	}
	for _, key := range value.RequiredFields() {
		if raw, ok := keys[key]; !ok || string(raw) == "null" {
			return fmt.Errorf("%T requires %s", value, key)
		}
	}
	for key, want := range value.FixedFields() {
		var got string
		if raw, ok := keys[key]; ok && (json.Unmarshal(raw, &got) != nil || got != want) {
			return fmt.Errorf("%T requires %s %q", value, key, want)
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	return decoder.Decode(value)
}

// Discriminate names the shape of a frame among messages.
func Discriminate(data []byte, messages []Message) (Message, error) {
	var head map[string]json.RawMessage
	if err := json.Unmarshal(data, &head); err != nil {
		return Message{}, err
	}
	var frameType string
	if err := json.Unmarshal(head["type"], &frameType); err != nil {
		return Message{}, fmt.Errorf("frame type: %w", err)
	}
	for _, message := range messages {
		if message.Type != frameType {
			continue
		}
		matched := true
		for key, want := range message.Match {
			var value string
			if json.Unmarshal(head[key], &value) != nil || value != want {
				matched = false
			}
		}
		if matched {
			return message, nil
		}
	}
	return Message{}, fmt.Errorf("unknown Runner Gateway frame type %q", frameType)
}
