package agentruntimestate

import (
	"encoding/json"
	"time"
)

type LocalComputerOwner struct {
	TenantID     string `json:"tenant_id"`
	OwnerActorID string `json:"owner_actor_id"`
}

type LocalComputer struct {
	Platform             string             `json:"platform,omitempty"`
	ComputerID           string             `json:"computer_id"`
	DisplayName          string             `json:"display_name"`
	Owner                LocalComputerOwner `json:"owner"`
	Status               string             `json:"status"`
	CredentialGeneration int64              `json:"credential_generation"`
	LastSeenAt           *time.Time         `json:"last_seen_at,omitempty"`
	Capacity             *int32             `json:"capacity,omitempty"`
	Runtimes             json.RawMessage    `json:"runtimes"`
	RuntimeDiagnostics   json.RawMessage    `json:"runtime_diagnostics"`
	WorkspaceGrants      json.RawMessage    `json:"workspace_grants"`
}

type LocalComputerCredentialInput struct {
	ComputerID string             `json:"computer_id"`
	Owner      LocalComputerOwner `json:"owner"`
}

// ConnectLocalComputerInput is a Computer's hello as the Runner Gateway
// accepted it, with the credential it presented.
type ConnectLocalComputerInput struct {
	ComputerID           string
	Owner                LocalComputerOwner
	CredentialGeneration int64
	DaemonID             string
	DaemonPublicKey      []byte
	IdentityVersion      int64
	// Status is offline while the Computer's Agent Runners are reconciled.
	Status             string
	SeenAt             time.Time
	DisplayName        string
	Platform           string
	Capacity           *int32
	Runtimes           json.RawMessage
	RuntimeDiagnostics json.RawMessage
	WorkspaceGrants    json.RawMessage
	DaemonVersion      string
	// RecommendedVersion is empty when the deployment ships no Computer release.
	RecommendedVersion string
}

// RunnerPlacement is an active Agent placed on a Computer. Its Agent Runner
// should be ready there; the Agent Service computes the Runner from it.
type RunnerPlacement struct {
	AgentID            string
	ActorID            string
	TenantID           string
	OwnerActorID       string
	RuntimeType        string
	Model              string
	ReasoningEffort    string
	WorkspaceGrantID   string
	AssignmentRevision int64
}

// ConnectLocalComputerResult is the recorded Computer and the active Agents
// placed on it, from which the Agent Service computes its Agent Runners.
type ConnectLocalComputerResult struct {
	Computer   LocalComputer
	Placements []RunnerPlacement
}

type TouchLocalComputerInput struct {
	ComputerID string    `json:"computer_id"`
	Status     string    `json:"status"`
	SeenAt     time.Time `json:"seen_at"`
	// Runtimes and RuntimeDiagnostics are empty when the touch does not
	// report them; the stored ones are kept.
	Runtimes           json.RawMessage `json:"runtimes,omitempty"`
	RuntimeDiagnostics json.RawMessage `json:"runtime_diagnostics,omitempty"`
	// ActiveOperations is nil when the heartbeat does not report it.
	ActiveOperations *int32 `json:"active_operations,omitempty"`
	// DaemonVersion and RecommendedVersion are empty when the touch carries no
	// hello; the stored values are kept.
	DaemonVersion      string `json:"daemon_version,omitempty"`
	RecommendedVersion string `json:"recommended_version,omitempty"`
}

type CreateLocalComputerEnrollmentInput struct {
	EnrollmentID           string             `json:"enrollment_id"`
	ComputerID             string             `json:"computer_id"`
	DisplayName            string             `json:"display_name"`
	Owner                  LocalComputerOwner `json:"owner"`
	RedirectURI            string             `json:"redirect_uri"`
	CodeChallenge          string             `json:"code_challenge"`
	AuthorizationCodeHash  []byte             `json:"authorization_code_hash"`
	ExpiresAt              time.Time          `json:"expires_at"`
	RenewsExistingComputer bool               `json:"renews_existing_computer"`
}

type ConsumeLocalComputerEnrollmentInput struct {
	EnrollmentID          string `json:"enrollment_id"`
	RedirectURI           string `json:"redirect_uri"`
	CodeChallenge         string `json:"code_challenge"`
	AuthorizationCodeHash []byte `json:"authorization_code_hash"`
}

type LocalComputerEnrollment struct {
	EnrollmentID           string             `json:"enrollment_id"`
	ComputerID             string             `json:"computer_id"`
	DisplayName            string             `json:"display_name"`
	Owner                  LocalComputerOwner `json:"owner"`
	ExpiresAt              time.Time          `json:"expires_at"`
	RenewsExistingComputer bool               `json:"renews_existing_computer"`
}

type ConsumeLocalComputerEnrollmentResult struct {
	Available            bool                     `json:"available"`
	Enrollment           *LocalComputerEnrollment `json:"enrollment,omitempty"`
	Computer             *LocalComputer           `json:"computer,omitempty"`
	CredentialGeneration *int64                   `json:"credential_generation,omitempty"`
}
