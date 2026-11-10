package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/taskexecution"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

type taskExecutionService interface {
	ResolveAgentParticipantTaskByWorkRoom(context.Context, string, string) (taskexecution.ParticipantTaskResolution, error)
	GetExecutionForHuman(context.Context, string, string) (taskexecution.Execution, error)
	ClaimExecution(context.Context, taskexecution.WorkerClaimInput) (taskexecution.WorkerExecution, bool, *time.Duration, error)
	GetExecutionForWorker(context.Context, taskexecution.WorkerLeaseInput) (taskexecution.WorkerExecution, error)
	HeartbeatExecution(context.Context, taskexecution.WorkerHeartbeatInput) (taskexecution.WorkerLease, error)
	TransitionExecution(context.Context, taskexecution.WorkerTransitionInput) (taskexecution.WorkerExecution, error)
}

func (a *App) resolveAgentParticipantTaskByWorkRoom(c *gin.Context) {
	params := contractParams[teamhubinternal.ResolveAgentParticipantTaskByWorkRoomParams](c)
	resolution, err := a.taskExecutions.ResolveAgentParticipantTaskByWorkRoom(
		c.Request.Context(), c.Param("agentId"), params.WorkRoomId,
	)
	if a.writeTaskExecutionError(c, "resolve Agent participant Task by Work Room", err) {
		return
	}
	c.JSON(http.StatusOK, teamhubinternal.AgentParticipantTaskResolution{
		TaskId:              resolution.TaskID,
		WorkRoomId:          resolution.WorkRoomID,
		ExecutionGeneration: resolution.ExecutionGeneration,
	})
}

func (a *App) claimTaskExecution(c *gin.Context) {
	var request teamhubinternal.TaskWorkerClaimRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Task Worker claim is invalid")
		return
	}
	value, found, nextDelay, err := a.taskExecutions.ClaimExecution(c.Request.Context(), taskexecution.WorkerClaimInput{
		WorkerID: request.WorkerId, LeaseSeconds: request.LeaseSeconds,
	})
	if a.writeTaskExecutionError(c, "claim Task execution", err) {
		return
	}
	if !found {
		// The delay comes from the database clock, so Worker clock skew
		// cannot move it.
		if nextDelay != nil {
			c.Header("Task-Next-Claim-Delay-Ms", strconv.FormatInt(nextDelay.Milliseconds(), 10))
		}
		c.Status(http.StatusNoContent)
		return
	}
	model, err := workerTaskExecutionModel(value)
	if err != nil {
		a.internalError(c, "project claimed Task execution", err)
		return
	}
	c.JSON(http.StatusOK, model)
}

func (a *App) getTaskExecution(c *gin.Context) {
	params := contractParams[teamhubinternal.GetTaskExecutionParams](c)
	value, err := a.taskExecutions.GetExecutionForWorker(c.Request.Context(), taskexecution.WorkerLeaseInput{
		TaskID: c.Param("taskId"), WorkerID: params.WorkerId,
		LeaseToken: params.TaskLeaseToken, LeaseGeneration: params.LeaseGeneration,
	})
	if a.writeTaskExecutionError(c, "get Task Worker execution", err) {
		return
	}
	model, err := workerTaskExecutionModel(value)
	if err != nil {
		a.internalError(c, "project Task Worker execution", err)
		return
	}
	c.JSON(http.StatusOK, model)
}

func (a *App) heartbeatTaskExecution(c *gin.Context) {
	params := contractParams[teamhubinternal.HeartbeatTaskExecutionParams](c)
	var request teamhubinternal.TaskWorkerHeartbeatRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Task Worker heartbeat is invalid")
		return
	}
	lease, err := a.taskExecutions.HeartbeatExecution(c.Request.Context(), taskexecution.WorkerHeartbeatInput{
		WorkerLeaseInput: taskexecution.WorkerLeaseInput{
			TaskID: c.Param("taskId"), WorkerID: request.WorkerId,
			LeaseToken: params.TaskLeaseToken, LeaseGeneration: request.LeaseGeneration,
		},
		LeaseSeconds: request.LeaseSeconds,
	})
	if a.writeTaskExecutionError(c, "heartbeat Task execution", err) {
		return
	}
	c.JSON(http.StatusOK, taskWorkerLeaseModel(lease))
}

func (a *App) transitionTaskExecution(c *gin.Context) {
	params := contractParams[teamhubinternal.TransitionTaskExecutionParams](c)
	var request teamhubinternal.TaskWorkerTransitionRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Task Worker transition is invalid")
		return
	}
	payload := json.RawMessage(`{}`)
	if request.Payload != nil {
		encoded, err := json.Marshal(*request.Payload)
		if err != nil {
			a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Task Worker transition payload is invalid")
			return
		}
		payload = encoded
	}
	operationID := ""
	if request.OperationId != nil {
		operationID = *request.OperationId
	}
	value, err := a.taskExecutions.TransitionExecution(c.Request.Context(), taskexecution.WorkerTransitionInput{
		WorkerLeaseInput: taskexecution.WorkerLeaseInput{
			TaskID: c.Param("taskId"), WorkerID: request.WorkerId,
			LeaseToken: params.TaskLeaseToken, LeaseGeneration: request.LeaseGeneration,
		},
		ExecutionGeneration: request.ExecutionGeneration, ExpectedExecutionRevision: request.ExpectedExecutionRevision,
		ExpectedControlRevision: request.ExpectedControlRevision, Transition: string(request.Transition),
		OperationID: operationID, Payload: payload,
	})
	if a.writeTaskExecutionError(c, "transition Task execution", err) {
		return
	}
	model, err := workerTaskExecutionModel(value)
	if err != nil {
		a.internalError(c, "project transitioned Task execution", err)
		return
	}
	c.JSON(http.StatusOK, model)
}

func workerTaskExecutionModel(value taskexecution.WorkerExecution) (teamhubinternal.TaskWorkerExecution, error) {
	value.Execution.Effects = taskexecution.WorkerEffects(value.Execution)
	execution, err := taskExecutionModel(value.Execution)
	if err != nil {
		return teamhubinternal.TaskWorkerExecution{}, err
	}
	model := teamhubinternal.TaskWorkerExecution{Execution: execution}
	if value.Lease != nil {
		lease := taskWorkerLeaseModel(*value.Lease)
		model.Lease = &lease
	}
	return model, nil
}

func taskWorkerLeaseModel(lease taskexecution.WorkerLease) teamhubinternal.TaskWorkerLease {
	return teamhubinternal.TaskWorkerLease{
		TaskId: lease.TaskID, WorkerId: lease.WorkerID, LeaseToken: lease.LeaseToken,
		LeaseGeneration: lease.LeaseGeneration, LeaseExpiresAt: lease.LeaseExpiresAt,
	}
}

func taskExecutionModel(execution taskexecution.Execution) (teamhubinternal.TaskExecution, error) {
	runSpec, err := convertJSON[teamhubinternal.TaskRunSpecV1](execution.Spec)
	if err != nil {
		return teamhubinternal.TaskExecution{}, err
	}
	model := teamhubinternal.TaskExecution{
		TaskId: execution.Snapshot.TaskID, Generation: execution.Snapshot.Generation,
		Status: teamhubinternal.TaskExecutionStatus(execution.Snapshot.Status), ExecutionRevision: execution.Snapshot.Revision,
		DesiredControl:  teamhubinternal.TaskExecutionDesiredControl(execution.Snapshot.DesiredControl),
		ControlRevision: execution.Snapshot.ControlRevision, ControlSettledRevision: execution.Snapshot.ControlSettledRevision,
		RunSpec: runSpec, Participants: make([]teamhubinternal.TaskExecutionParticipant, 0, len(execution.Participants)),
		PendingEffects:     make([]teamhubinternal.TaskEffect, 0),
		ExecutionFacts:     make([]teamhubinternal.TaskExecutionFact, 0, len(execution.Facts)),
		ExecutionUpdatedAt: execution.Snapshot.UpdatedAt,
	}
	model.ReasonCode = taskStringPointer(execution.Snapshot.ReasonCode)
	for _, participant := range execution.Participants {
		contextRef, err := rawJSONObject(participant.ExecutionContextRef)
		if err != nil {
			return teamhubinternal.TaskExecution{}, err
		}
		model.Participants = append(model.Participants, teamhubinternal.TaskExecutionParticipant{
			ActorId: participant.ActorID, AgentId: participant.AgentManagementID,
			ExecutionContextRef: contextRef,
		})
	}
	for index := len(execution.Attempts) - 1; index >= 0; index-- {
		attempt := execution.Attempts[index]
		if attempt.Number < 1 {
			continue
		}
		model.CurrentAttempt = &teamhubinternal.TaskAttemptSummary{
			Id: attempt.ID, AttemptNumber: attempt.Number,
			Status: teamhubinternal.TaskAttemptSummaryStatus(attempt.Status), CurrentInputRevision: attempt.CurrentInputRevision,
			DeadlineAt: attempt.DeadlineAt, StopReasonCode: taskStringPointer(attempt.StopReasonCode),
			CreatedAt: attempt.CreatedAt, FinishedAt: attempt.FinishedAt,
		}
		break
	}
	for _, effect := range execution.Effects {
		payload, err := rawJSONObject(effect.Payload)
		if err != nil {
			return teamhubinternal.TaskExecution{}, err
		}
		delete(payload, "capability")
		observation, err := optionalRawJSONObject(effect.Observation)
		if err != nil {
			return teamhubinternal.TaskExecution{}, err
		}
		model.PendingEffects = append(model.PendingEffects, teamhubinternal.TaskEffect{
			Id: effect.ID, RootOperationId: effect.RootOperationID,
			Operation: teamhubinternal.TaskEffectOperation(effect.Operation), Status: teamhubinternal.TaskEffectStatus(effect.Status),
			DispatchSequence: effect.DispatchSequence, Payload: payload, PayloadHash: effect.PayloadHash,
			Observation: observation, Error: taskStringPointer(effect.Error), CreatedAt: effect.CreatedAt, CompletedAt: effect.CompletedAt,
		})
	}
	for _, fact := range execution.Facts {
		payload, err := rawJSONObject(fact.Payload)
		if err != nil {
			return teamhubinternal.TaskExecution{}, err
		}
		model.ExecutionFacts = append(model.ExecutionFacts, teamhubinternal.TaskExecutionFact{
			Id: fact.ID, ExecutionRevision: fact.ExecutionRevision,
			FactKind: teamhubinternal.TaskExecutionFactFactKind(fact.Kind), ExecutionStatus: teamhubinternal.TaskExecutionStatus(fact.ExecutionStatus),
			ControlSettledRevision: fact.ControlSettledRevision, ReasonCode: taskStringPointer(fact.ReasonCode),
			Payload: payload, CreatedAt: fact.CreatedAt,
		})
	}
	return model, nil
}

func rawJSONObject(raw json.RawMessage) (map[string]interface{}, error) {
	if len(raw) == 0 {
		return map[string]interface{}{}, nil
	}
	var result map[string]interface{}
	if err := json.Unmarshal(raw, &result); err != nil || result == nil {
		return nil, fmt.Errorf("decode JSON object: %w", err)
	}
	return result, nil
}

func optionalRawJSONObject(raw json.RawMessage) (*map[string]interface{}, error) {
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}
	value, err := rawJSONObject(raw)
	if err != nil {
		return nil, err
	}
	return &value, nil
}

func taskStringPointer(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func (a *App) writeTaskExecutionError(c *gin.Context, action string, err error) bool {
	if err == nil {
		return false
	}
	switch {
	case errors.Is(err, taskexecution.ErrInvalid):
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Task execution input is invalid")
	case errors.Is(err, taskexecution.ErrNotFound):
		a.writeError(c, http.StatusNotFound, "TASK_EXECUTION_NOT_FOUND", "Task execution was not found")
	case errors.Is(err, taskexecution.ErrForbidden):
		a.writeError(c, http.StatusForbidden, "TASK_EXECUTION_FORBIDDEN", "Task execution action is not allowed")
	case errors.Is(err, taskexecution.ErrIdempotencyConflict):
		a.writeError(c, http.StatusConflict, "IDEMPOTENCY_KEY_REUSED", "idempotency key was used with different input")
	case errors.Is(err, taskexecution.ErrConflict):
		a.writeError(c, http.StatusConflict, "TASK_EXECUTION_CONFLICT", "Task execution state conflicts with the request")
	default:
		a.internalError(c, action, err)
	}
	return true
}
