package taskexecution

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func getExecution(ctx context.Context, queries *store.Queries, taskID string) (Execution, error) {
	snapshot, err := queries.GetTaskExecutionSnapshot(ctx, taskID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Execution{}, ErrNotFound
	}
	if err != nil {
		return Execution{}, err
	}
	if !snapshot.TaskExecutionGeneration.Valid || !snapshot.TaskExecutionRevision.Valid || !snapshot.TaskExecutionStatus.Valid {
		return Execution{}, ErrNotFound
	}
	var spec RunSpecV1
	if err := json.Unmarshal(snapshot.Spec, &spec); err != nil {
		return Execution{}, err
	}
	generation := snapshot.TaskExecutionGeneration.Int64
	participantRows, err := queries.ListTaskExecutionParticipants(ctx, store.ListTaskExecutionParticipantsParams{
		TaskID: taskID, Generation: generation,
	})
	if err != nil {
		return Execution{}, err
	}
	attemptRows, err := queries.ListTaskAttempts(ctx, store.ListTaskAttemptsParams{TaskID: taskID, Generation: generation})
	if err != nil {
		return Execution{}, err
	}
	inputRows, err := queries.ListTaskInputRevisions(ctx, store.ListTaskInputRevisionsParams{TaskID: taskID, Generation: generation})
	if err != nil {
		return Execution{}, err
	}
	effectRows, err := queries.ListTaskEffects(ctx, store.ListTaskEffectsParams{TaskID: taskID, Generation: generation})
	if err != nil {
		return Execution{}, err
	}
	factRows, err := queries.ListTaskExecutionFacts(ctx, store.ListTaskExecutionFactsParams{TaskID: taskID, Generation: generation})
	if err != nil {
		return Execution{}, err
	}
	execution := Execution{
		Snapshot: ExecutionSnapshot{
			TaskID: taskID, TenantID: snapshot.TenantID, Generation: generation,
			Status: snapshot.TaskExecutionStatus.String, Revision: snapshot.TaskExecutionRevision.Int64,
			ReasonCode: textValue(snapshot.TaskExecutionReasonCode), SourceKey: textValue(snapshot.TaskSourceKey),
			DesiredControl: textValue(snapshot.TaskDesiredControl), ControlRevision: intValue(snapshot.TaskControlRevision),
			ControlSettledRevision: intValue(snapshot.TaskControlSettledRevision),
			ControlOutcome:         textValue(snapshot.TaskControlOutcome), WorkItemState: snapshot.WorkItemState,
			Resolution:         textValue(snapshot.Resolution),
			ResultAgentActorID: snapshot.ResultAgentActorID, UpdatedAt: snapshot.TaskExecutionUpdatedAt.Time,
			CreatedAt: snapshot.GenerationCreatedAt.Time, TerminalAt: timePointer(snapshot.TerminalAt),
		},
		Spec:         spec,
		Participants: make([]Participant, 0, len(participantRows)),
		Attempts:     make([]Attempt, 0, len(attemptRows)),
		Inputs:       make([]InputRevision, 0, len(inputRows)),
		Effects:      make([]Effect, 0, len(effectRows)),
		Facts:        make([]Fact, 0, len(factRows)),
	}
	for _, row := range participantRows {
		execution.Participants = append(execution.Participants, Participant{
			ActorID: row.ActorID, AgentManagementID: row.AgentManagementID,
			ExecutionContextRef: cloneJSON(row.ExecutionContextRef),
		})
	}
	for _, row := range attemptRows {
		execution.Attempts = append(execution.Attempts, Attempt{
			ID: row.ID, Number: row.AttemptNumber, RuntimeGenerationKey: row.RuntimeGenerationKey,
			Status: row.Status, CurrentInputRevision: row.CurrentInputRevision,
			DeadlineAt: timePointer(row.DeadlineAt), StopReasonCode: textValue(row.StopReasonCode),
			CreatedAt: row.CreatedAt.Time, UpdatedAt: row.UpdatedAt.Time, FinishedAt: timePointer(row.FinishedAt),
		})
	}
	for _, row := range inputRows {
		execution.Inputs = append(execution.Inputs, InputRevision{
			AttemptID: row.AttemptID, Revision: row.InputRevision, Cause: row.Cause,
			RecipientActorIDs: cloneJSON(row.RecipientActorIds), InputManifest: cloneJSON(row.InputManifest),
			MessageEffectIDs: cloneJSON(row.MessageEffectIds), CreatedAt: row.CreatedAt.Time,
		})
	}
	for _, row := range effectRows {
		execution.Effects = append(execution.Effects, Effect{
			ID: row.ID, RootOperationID: row.RootOperationID, EffectKey: row.EffectKey,
			Operation: row.Operation, OwnerID: row.OwnerID,
			Payload: cloneJSON(row.Payload), PayloadHash: hex.EncodeToString(row.PayloadHash),
			DispatchSequence: row.DispatchSequence,
			RetryOfEffectID:  textValue(row.RetryOfEffectID), Status: row.Status,
			Observation: cloneJSON(row.Observation), Error: textValue(row.Error),
			CreatedAt: row.CreatedAt.Time, CompletedAt: timePointer(row.CompletedAt),
		})
	}
	for _, row := range factRows {
		execution.Facts = append(execution.Facts, Fact{
			ID: row.ID, ExecutionRevision: row.ExecutionRevision, Kind: row.FactKind,
			ExecutionStatus: row.ExecutionStatus, ControlSettledRevision: row.ControlSettledRevision,
			ControlRevision: intValue(row.ControlRevision), SourceOperationID: textValue(row.SourceOperationID),
			ReasonCode: textValue(row.ReasonCode),
			Payload:    cloneJSON(row.Payload), CausedByActorID: textValue(row.CausedByActorID), CreatedAt: row.CreatedAt.Time,
		})
	}
	return execution, nil
}

func textValue(value pgtype.Text) string {
	if !value.Valid {
		return ""
	}
	return value.String
}

func intValue(value pgtype.Int8) int64 {
	if !value.Valid {
		return 0
	}
	return value.Int64
}

func timePointer(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	result := value.Time
	return &result
}

func cloneJSON(value []byte) json.RawMessage {
	if len(value) == 0 {
		return nil
	}
	return append(json.RawMessage(nil), value...)
}
