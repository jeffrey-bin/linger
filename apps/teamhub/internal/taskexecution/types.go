package taskexecution

import (
	"encoding/json"
	"errors"
	"time"
)

var (
	ErrInvalid             = errors.New("task execution input is invalid")
	ErrNotFound            = errors.New("task execution was not found")
	ErrForbidden           = errors.New("task execution operation is forbidden")
	ErrConflict            = errors.New("task execution state conflicts with the request")
	ErrIdempotencyConflict = errors.New("task execution idempotency key reused")
)

// RunSpecV1 is a Task generation's immutable execution contract. Its result
// Agent is the Agent whose AlterEgo runs the Task.
type RunSpecV1 struct {
	SchemaVersion      int             `json:"schema_version"`
	ResultAgentActorID string          `json:"result_agent_actor_id"`
	AttemptPolicy      AttemptPolicyV1 `json:"attempt_policy"`
}

type AttemptPolicyV1 struct {
	PolicyVersion       int   `json:"policy_version"`
	MaxRetries          int   `json:"max_retries"`
	TimeoutSeconds      int64 `json:"timeout_seconds"`
	RetryOnAgentFailure bool  `json:"retry_on_agent_failure"`
	RetryOnTimeout      bool  `json:"retry_on_timeout"`
}

type ParticipantInput struct {
	ActorID             string          `json:"actor_id"`
	AgentManagementID   string          `json:"agent_management_id"`
	ExecutionContextRef json.RawMessage `json:"execution_context_ref"`
}

type ParticipantTaskResolution struct {
	TaskID              string `json:"task_id"`
	WorkRoomID          string `json:"work_room_id"`
	ExecutionGeneration int64  `json:"execution_generation"`
}

type CreateManagedGenerationInput struct {
	TaskID          string
	TenantID        string
	EventRoomID     string
	WorkItemVersion int64
	SourceKey       string
	RunSpec         RunSpecV1
	// Participant is the AlterEgo of RunSpec's result Agent, the Task's only
	// participant.
	Participant           ParticipantInput
	InitialInputManifest  json.RawMessage
	InitialMessage        TurnMessageInput
	CausedByActorID       string
	CoordinatorActorID    string
	CoordinatorContextKey string
}

// TurnMessageInput is the executable message snapshot frozen into a
// submit_agent_turn effect. It is independent from mutable Room projections.
type TurnMessageInput struct {
	MessageID  string             `json:"message_id"`
	RawMessage string             `json:"raw_message"`
	Segments   json.RawMessage    `json:"segments"`
	Author     *TurnMessageAuthor `json:"author,omitempty"`
}

// TurnMessageAuthor is the immutable sender identity of a public Task input.
// Private Meta Inbox wakes keep their independent author_actor_id correlation.
type TurnMessageAuthor struct {
	ActorID     string `json:"actor_id"`
	Kind        string `json:"kind"`
	DisplayName string `json:"display_name"`
}

type CreateManagedGenerationResult struct {
	Execution         Execution `json:"execution"`
	InitialCapability string    `json:"initial_capability"`
	InitialEffectID   string    `json:"initial_effect_id"`
}

type WorkerClaimInput struct {
	WorkerID     string
	LeaseSeconds int
}

type WorkerLeaseInput struct {
	TaskID          string
	WorkerID        string
	LeaseToken      string
	LeaseGeneration int64
}

type WorkerHeartbeatInput struct {
	WorkerLeaseInput
	LeaseSeconds int
}

type WorkerTransitionInput struct {
	WorkerLeaseInput
	ExecutionGeneration       int64
	ExpectedExecutionRevision int64
	ExpectedControlRevision   *int64
	Transition                string
	OperationID               string
	Payload                   json.RawMessage
}

type WorkerLease struct {
	TaskID          string    `json:"task_id"`
	WorkerID        string    `json:"worker_id"`
	LeaseToken      string    `json:"lease_token"`
	LeaseGeneration int64     `json:"lease_generation"`
	LeaseExpiresAt  time.Time `json:"lease_expires_at"`
}

type WorkerExecution struct {
	Lease     *WorkerLease `json:"lease,omitempty"`
	Execution Execution    `json:"execution"`
}

type Execution struct {
	Snapshot     ExecutionSnapshot `json:"snapshot"`
	Spec         RunSpecV1         `json:"spec"`
	Participants []Participant     `json:"participants"`
	Attempts     []Attempt         `json:"attempts"`
	Inputs       []InputRevision   `json:"input_revisions"`
	Effects      []Effect          `json:"effects"`
	Facts        []Fact            `json:"facts"`
}

type ExecutionSnapshot struct {
	TaskID                 string     `json:"task_id"`
	TenantID               string     `json:"tenant_id"`
	Generation             int64      `json:"generation"`
	Status                 string     `json:"status"`
	Revision               int64      `json:"revision"`
	ReasonCode             string     `json:"reason_code,omitempty"`
	SourceKey              string     `json:"source_key,omitempty"`
	DesiredControl         string     `json:"desired_control"`
	ControlRevision        int64      `json:"control_revision"`
	ControlSettledRevision int64      `json:"control_settled_revision"`
	ControlOutcome         string     `json:"control_outcome,omitempty"`
	WorkItemState          string     `json:"work_item_state"`
	Resolution             string     `json:"resolution,omitempty"`
	ResultAgentActorID     string     `json:"result_agent_actor_id"`
	UpdatedAt              time.Time  `json:"updated_at"`
	CreatedAt              time.Time  `json:"created_at"`
	TerminalAt             *time.Time `json:"terminal_at,omitempty"`
}

type Participant struct {
	ActorID             string          `json:"actor_id"`
	AgentManagementID   string          `json:"agent_management_id"`
	ExecutionContextRef json.RawMessage `json:"execution_context_ref"`
}

type Attempt struct {
	ID                   string     `json:"id"`
	Number               int64      `json:"number"`
	RuntimeGenerationKey string     `json:"runtime_generation_key"`
	Status               string     `json:"status"`
	CurrentInputRevision int64      `json:"current_input_revision"`
	DeadlineAt           *time.Time `json:"deadline_at,omitempty"`
	StopReasonCode       string     `json:"stop_reason_code,omitempty"`
	CreatedAt            time.Time  `json:"created_at"`
	UpdatedAt            time.Time  `json:"updated_at"`
	FinishedAt           *time.Time `json:"finished_at,omitempty"`
}

type InputRevision struct {
	AttemptID         string          `json:"attempt_id"`
	Revision          int64           `json:"revision"`
	Cause             string          `json:"cause"`
	RecipientActorIDs json.RawMessage `json:"recipient_actor_ids"`
	InputManifest     json.RawMessage `json:"input_manifest"`
	MessageEffectIDs  json.RawMessage `json:"message_effect_ids"`
	CreatedAt         time.Time       `json:"created_at"`
}

type Effect struct {
	ID               string          `json:"id"`
	RootOperationID  string          `json:"root_operation_id"`
	EffectKey        string          `json:"effect_key"`
	Operation        string          `json:"operation"`
	OwnerID          string          `json:"owner_id"`
	Payload          json.RawMessage `json:"payload"`
	PayloadHash      string          `json:"payload_hash"`
	DispatchSequence int64           `json:"dispatch_sequence"`
	RetryOfEffectID  string          `json:"retry_of_effect_id,omitempty"`
	Status           string          `json:"status"`
	Observation      json.RawMessage `json:"observation,omitempty"`
	Error            string          `json:"error,omitempty"`
	CreatedAt        time.Time       `json:"created_at"`
	CompletedAt      *time.Time      `json:"completed_at,omitempty"`
}

type Fact struct {
	ID                     string          `json:"id"`
	ExecutionRevision      int64           `json:"execution_revision"`
	Kind                   string          `json:"kind"`
	ExecutionStatus        string          `json:"execution_status"`
	ControlSettledRevision int64           `json:"control_settled_revision"`
	ControlRevision        int64           `json:"control_revision,omitempty"`
	SourceOperationID      string          `json:"source_operation_id,omitempty"`
	ReasonCode             string          `json:"reason_code,omitempty"`
	Payload                json.RawMessage `json:"payload"`
	CausedByActorID        string          `json:"caused_by_actor_id,omitempty"`
	CreatedAt              time.Time       `json:"created_at"`
}
