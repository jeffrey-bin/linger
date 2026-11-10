package typedcard

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/taskexecution"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/workitem"
)

// DelegatedTaskInput is one Task a Room's Meta delegates to its own AlterEgo.
// The caller has already authorized the Agent and its Room.
type DelegatedTaskInput struct {
	TenantID          string
	OriginRoomID      string
	Agent             store.Actor
	AgentManagementID string
	// Sponsor owns the Work Room; it must be a Human with an Account.
	Sponsor     store.Actor
	Name        string
	Requirement string
	SourceKey   string
	Hidden      bool
}

type DelegatedTaskResult struct {
	TaskID     string
	WorkRoomID string
}

// CreateDelegatedTaskInTx creates the Task, its Work Room and the first
// execution generation in the caller's transaction. The AlterEgo is the only
// participant, and the origin Room's Meta is the frozen coordinator.
func CreateDelegatedTaskInTx(
	ctx context.Context,
	tx pgx.Tx,
	queries *store.Queries,
	input DelegatedTaskInput,
) (DelegatedTaskResult, error) {
	if input.TenantID == "" || input.OriginRoomID == "" || input.Agent.ID == "" || input.Agent.Kind != "agent" ||
		input.AgentManagementID == "" || input.Sponsor.ID == "" || !input.Sponsor.AccountID.Valid ||
		strings.TrimSpace(input.Name) == "" || strings.TrimSpace(input.Requirement) == "" || input.SourceKey == "" {
		return DelegatedTaskResult{}, ErrInvalid
	}
	coordinatorContextKey, err := agentruntimestate.EncodeContextRef(agentruntimestate.ContextRef{
		Kind: "meta", AgentID: input.AgentManagementID, RoomID: input.OriginRoomID,
	})
	if err != nil {
		return DelegatedTaskResult{}, ErrInvalid
	}
	originRoomID := input.OriginRoomID
	if input.Hidden {
		originRoomID = ""
	}
	item, err := workitem.CreateTaskForApprovedCreation(ctx, tx, queries, input.Agent, workitem.CreateInput{
		Kind: "task", Title: input.Name, Description: input.Requirement, Priority: "medium",
		AssigneeActorIDs: []string{input.Agent.ID}, OriginRoomID: originRoomID,
	})
	if err != nil {
		return DelegatedTaskResult{}, mapCreationDecisionError(err)
	}
	content, err := messagecreation.Normalize([]messagecreation.Segment{{Type: "text", Content: input.Requirement}})
	if err != nil {
		return DelegatedTaskResult{}, ErrInvalid
	}
	workRoom, err := createTaskWorkRoom(
		ctx, queries, input.TenantID, item.ID, input.Name, "", content.Segments,
		input.Agent, input.Sponsor, []string{input.Agent.ID},
	)
	if err != nil {
		return DelegatedTaskResult{}, mapCreationDecisionError(err)
	}
	executionContextRef, err := json.Marshal(map[string]string{
		"kind": "alter_ego", "agentId": input.AgentManagementID, "taskId": item.ID,
	})
	if err != nil {
		return DelegatedTaskResult{}, err
	}
	inputID := "task_description_" + item.ID
	inputManifest, err := json.Marshal(map[string]any{
		"kind": "task_creation", "room_id": workRoom.ID, "input_id": inputID,
		"raw_message": content.RawMessage, "segments": content.Segments,
	})
	if err != nil {
		return DelegatedTaskResult{}, err
	}
	segments, err := json.Marshal(content.Segments)
	if err != nil {
		return DelegatedTaskResult{}, err
	}
	if _, err := taskexecution.CreateManagedGeneration(ctx, tx, queries, taskexecution.CreateManagedGenerationInput{
		TaskID: item.ID, TenantID: input.TenantID, WorkItemVersion: item.Version,
		SourceKey: input.SourceKey,
		RunSpec: taskexecution.RunSpecV1{
			SchemaVersion: 1, ResultAgentActorID: input.Agent.ID,
			AttemptPolicy: taskexecution.DelegatedAttemptPolicyV1(),
		},
		Participant: taskexecution.ParticipantInput{
			ActorID: input.Agent.ID, AgentManagementID: input.AgentManagementID,
			ExecutionContextRef: executionContextRef,
		},
		InitialInputManifest: inputManifest,
		InitialMessage: taskexecution.TurnMessageInput{
			MessageID: inputID, RawMessage: content.RawMessage, Segments: segments,
			Author: &taskexecution.TurnMessageAuthor{
				ActorID: input.Agent.ID, Kind: input.Agent.Kind, DisplayName: input.Agent.DisplayName,
			},
		},
		CausedByActorID:    input.Agent.ID,
		CoordinatorActorID: input.Agent.ID, CoordinatorContextKey: coordinatorContextKey,
	}); err != nil {
		return DelegatedTaskResult{}, mapCreationDecisionError(err)
	}
	if err := workitem.InitializeTaskWorkRoomInboxCursors(ctx, tx, input.TenantID, item.ID); err != nil {
		return DelegatedTaskResult{}, mapCreationDecisionError(err)
	}
	refreshed, err := queries.GetTypedCardWorkItem(ctx, item.ID)
	if err != nil {
		return DelegatedTaskResult{}, err
	}
	item, err = workitem.LoadItem(ctx, queries, refreshed)
	if err != nil {
		return DelegatedTaskResult{}, err
	}
	// A hidden Task is not linked to its Room, but the Room still hears it
	// started, so the indicator above its composer lists it.
	announced := item
	if input.Hidden {
		announced.OriginRoomID = &input.OriginRoomID
	}
	if err := appendWorkItemChangedEvent(ctx, queries, announced, input.Agent.ID); err != nil {
		return DelegatedTaskResult{}, err
	}
	return DelegatedTaskResult{TaskID: item.ID, WorkRoomID: workRoom.ID}, nil
}
