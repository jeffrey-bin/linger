package agentruntimestate

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

var (
	ErrInvalid                 = errors.New("agent runtime state input is invalid")
	ErrNotFound                = errors.New("agent runtime state was not found")
	ErrConflict                = errors.New("agent runtime state conflict")
	ErrIdempotencyConflict     = errors.New("agent runtime request was repeated with different input")
	ErrFenced                  = errors.New("agent runtime context identity or Agent Service epoch is no longer authoritative")
	ErrInboxNotAuthorized      = errors.New("agent runtime context cannot receive this inbox")
	ErrRunnerReceiptRunSettled = fmt.Errorf("runner receipt Local Run is settled: %w", ErrFenced)
	ErrDependency              = errors.New("agent runtime state dependency failed")
)

// ErrDaemonIdentityInUse means another Computer that was not removed already
// holds the Daemon Identity a Computer connected with.
var ErrDaemonIdentityInUse = fmt.Errorf("Daemon Identity is held by another Local Computer: %w", ErrConflict)

// ErrRemoved means the Local Computer was removed and cannot be renewed.
var ErrRemoved = errors.New("Local Computer was removed")

type ContextRef struct {
	Kind       string `json:"kind"`
	AgentID    string `json:"agent_id"`
	TaskID     string `json:"task_id,omitempty"`
	RoomID     string `json:"room_id,omitempty"`
	DocumentID string `json:"document_id,omitempty"`
}

type Context struct {
	Ref               ContextRef `json:"ref"`
	ContextKey        string     `json:"context_key"`
	TenantID          string     `json:"tenant_id"`
	AgentActorID      string     `json:"agent_actor_id"`
	RoomKind          string     `json:"room_kind,omitempty"`
	MembershipEpochID string     `json:"membership_epoch_id,omitempty"`
	TargetResidency   string     `json:"target_residency"`
	StateRevision     int64      `json:"state_revision"`
	NextInputSequence int64      `json:"next_input_sequence"`
	TerminalReason    string     `json:"terminal_reason,omitempty"`
	TerminatedAt      *time.Time `json:"terminated_at,omitempty"`
	// SharedTaskScope names the shared Task directory this Context reads
	// (Room Meta) or writes (alter_ego of a Meta-coordinated Task).
	SharedTaskScope *SharedTaskScope `json:"shared_task_scope,omitempty"`
}

type SharedTaskScope struct {
	Version      int    `json:"version"`
	TenantID     string `json:"tenant_id"`
	AgentID      string `json:"agent_id"`
	OriginRoomID string `json:"origin_room_id"`
	Role         string `json:"role"`
	TaskID       string `json:"task_id,omitempty"`
}

type EnsureContextInput struct {
	Ref             ContextRef `json:"ref"`
	TargetResidency string     `json:"target_residency"`
}

type EnsureContextResult struct {
	Created bool    `json:"created"`
	Context Context `json:"context"`
}

type ReconcileMetaContextsInput struct {
	Limit  int    `json:"limit"`
	Cursor string `json:"cursor,omitempty"`
}

type ReconcileMetaContextsResult struct {
	ExaminedCount      int      `json:"examined_count"`
	ExistingCount      int      `json:"existing_count"`
	CreatedCount       int      `json:"created_count"`
	CreatedContextKeys []string `json:"created_context_keys"`
	NextCursor         string   `json:"next_cursor,omitempty"`
}

type SetContextResidencyInput struct {
	ContextKey       string `json:"context_key"`
	ExpectedRevision int64  `json:"expected_revision"`
	TargetResidency  string `json:"target_residency"`
}

type DeleteContextInput struct {
	ContextKey       string `json:"context_key"`
	ExpectedRevision int64  `json:"expected_revision"`
}

type RuntimeInput struct {
	InputID         string          `json:"input_id"`
	Payload         json.RawMessage `json:"payload"`
	SourceKind      string          `json:"source_kind"`
	SourceMessageID string          `json:"source_message_id,omitempty"`
	SourceInboxID   string          `json:"source_inbox_id,omitempty"`
}

type StoredRuntimeInput struct {
	RuntimeInput
	Sequence        int64           `json:"sequence"`
	Status          string          `json:"status"`
	SelectionResult json.RawMessage `json:"selection_result,omitempty"`
	SteerGroupID    string          `json:"steer_group_id,omitempty"`
	LocalRunID      string          `json:"local_run_id,omitempty"`
	SteerOutcome    string          `json:"steer_outcome,omitempty"`
	CreatedAt       time.Time       `json:"created_at"`
}

// ContextState is what accepting input committed to its Context. The Agent
// Service applies it to its record instead of reading the Context again.
type ContextState struct {
	StateRevision     int64  `json:"state_revision"`
	TargetResidency   string `json:"target_residency"`
	NextInputSequence int64  `json:"next_input_sequence"`
}

type AcceptTrustedNotificationInput struct {
	ContextKey      string       `json:"context_key"`
	Epoch           string       `json:"epoch"`
	ExecutionRunRef string       `json:"execution_run_ref"`
	Input           RuntimeInput `json:"input"`
}

type AcceptTrustedNotificationResult struct {
	Status       string `json:"status"`
	SteerGroupID string `json:"steer_group_id,omitempty"`
}

type SubmitTrustedTurnInput struct {
	ContextKey string         `json:"context_key"`
	Epoch      string         `json:"epoch"`
	Inputs     []RuntimeInput `json:"inputs"`
}

type SubmitTrustedTurnResult struct {
	RunID   string        `json:"run_id"`
	Created bool          `json:"created"`
	Context *ContextState `json:"context,omitempty"`
}

type LocalRun struct {
	CancellationRequested bool            `json:"cancellation_requested"`
	RunID                 string          `json:"run_id"`
	ContextKey            string          `json:"context_key"`
	Status                string          `json:"status"`
	AttemptCount          int             `json:"attempt_count"`
	InitialInputIDs       []string        `json:"initial_input_ids"`
	SteerInputIDs         []string        `json:"steer_input_ids"`
	Terminal              json.RawMessage `json:"terminal,omitempty"`
}

type ClaimLocalRunInput struct {
	ContextKey string `json:"context_key"`
	Epoch      string `json:"epoch"`
	// ClaimID names one claim, so a claim repeated after a lost response
	// receives the same Run.
	ClaimID string `json:"claim_id"`
}

type ClaimedLocalRun struct {
	CancellationRequested bool                 `json:"cancellation_requested"`
	RunID                 string               `json:"run_id"`
	AttemptCount          int                  `json:"attempt_count"`
	Inputs                []StoredRuntimeInput `json:"inputs"`
	// ProfileUpdate is the Agent's current profile when this Context's
	// Session started under an older one, returned with the claim
	// that first takes the Run.
	ProfileUpdate *ProfileUpdate `json:"profile_update,omitempty"`
	// ContinuesContext reports that the Context received input before this
	// Run's first input.
	ContinuesContext bool `json:"continues_context"`
}

type ProfileUpdate struct {
	ConfigurationRevision int64  `json:"configuration_revision"`
	Name                  string `json:"name"`
	Instructions          string `json:"instructions"`
}

type ClaimLocalRunResult struct {
	Run *ClaimedLocalRun `json:"run,omitempty"`
}

type RequeueLocalRunInput struct {
	ContextKey string `json:"context_key"`
	Epoch      string `json:"epoch"`
	RunID      string `json:"run_id"`
}

type RuntimeSessionCheckpoint struct {
	ExpectedRevision      int64           `json:"expected_revision"`
	ProviderKind          string          `json:"provider_kind"`
	SchemaVersion         int64           `json:"schema_version"`
	Session               json.RawMessage `json:"session"`
	ThreadID              string          `json:"thread_id,omitempty"`
	ConfigurationRevision int64           `json:"configuration_revision"`
}

type RuntimeSession struct {
	RuntimeSessionCheckpoint
	Revision                        int64     `json:"revision"`
	UpdatedAt                       time.Time `json:"updated_at"`
	CompatibleConfigurationRevision int64     `json:"compatible_configuration_revision,omitempty"`
}

type ClearRuntimeSessionInput struct {
	ContextKey                           string `json:"context_key"`
	Epoch                                string `json:"epoch"`
	ConfigurationRevision                int64  `json:"configuration_revision"`
	ExpectedCurrentConfigurationRevision *int64 `json:"expected_current_configuration_revision,omitempty"`
}

type ClearRuntimeSessionResult struct {
	Cleared bool `json:"cleared"`
}

type FinishLocalRunInput struct {
	ContextKey string                    `json:"context_key"`
	Epoch      string                    `json:"epoch"`
	RunID      string                    `json:"run_id"`
	Terminal   json.RawMessage           `json:"terminal"`
	Session    *RuntimeSessionCheckpoint `json:"session,omitempty"`
}

type FinishLocalRunResult struct {
	Run     LocalRun        `json:"run"`
	Session *RuntimeSession `json:"session,omitempty"`
}

type CancelLocalRunInput struct {
	ContextKey string `json:"context_key"`
	Epoch      string `json:"epoch"`
	RunID      string `json:"run_id"`
}

type CancelLocalRunResult struct {
	Status string `json:"status"`
}

type EnqueueSteerInput struct {
	ContextKey string `json:"context_key"`
	Epoch      string `json:"epoch"`
	GroupID    string `json:"group_id"`
}

type EnqueueSteerResult struct {
	RunID string `json:"run_id"`
}

type AssignSteerRunInput struct {
	ContextKey string `json:"context_key"`
	Epoch      string `json:"epoch"`
	GroupID    string `json:"group_id"`
	RunID      string `json:"run_id"`
}

type CompleteSteerInput struct {
	ContextKey string `json:"context_key"`
	Epoch      string `json:"epoch"`
	GroupID    string `json:"group_id"`
	RunID      string `json:"run_id"`
	Outcome    string `json:"outcome"`
}

type CheckpointSessionInput struct {
	ContextKey string                   `json:"context_key"`
	Epoch      string                   `json:"epoch"`
	Checkpoint RuntimeSessionCheckpoint `json:"checkpoint"`
}

type OpenStatusInput struct {
	ContextKey       string   `json:"context_key"`
	Epoch            string   `json:"epoch"`
	LocalRunID       string   `json:"local_run_id"`
	InitialSourceIDs []string `json:"initial_source_ids"`
}

// OpenStatusResult names the Room that shows a Run's status; Opened is false
// when no Room may show it.
type OpenStatusResult struct {
	Opened bool   `json:"opened"`
	RoomID string `json:"room_id,omitempty"`
}

// OfferedPresentationEvent is one event of a batch with its idempotency key.
type OfferedPresentationEvent struct {
	CommandID string          `json:"command_id"`
	Event     json.RawMessage `json:"event"`
}

// OfferPresentationEventsInput is one ordered batch of a Run's events.
type OfferPresentationEventsInput struct {
	LocalRunID string                     `json:"local_run_id"`
	Events     []OfferedPresentationEvent `json:"events"`
}

type OfferPresentationEventResult struct {
	Accepted     bool  `json:"accepted"`
	EventOrdinal int64 `json:"event_ordinal"`
}
