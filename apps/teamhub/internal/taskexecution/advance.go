package taskexecution

import (
	"context"
	"encoding/json"
	"fmt"
)

// WorkerEffects exposes Runtime work and observations. Domain effects remain in
// the Task ledger and are executed by TeamHub, never by the Agent dispatcher.
func WorkerEffects(execution Execution) []Effect {
	result := make([]Effect, 0, len(execution.Effects))
	for _, effect := range execution.Effects {
		switch effect.Operation {
		case "cleanup_runtime":
			result = append(result, effect)
		case "submit_agent_turn":
			if !liveEffect(effect) || execution.Snapshot.Status == "running" {
				result = append(result, effect)
			}
		}
	}
	return result
}

// advanceExecution reconciles a running Task's current Attempt under the
// existing Worker lease. Each step commits its own durable witness, so a crash
// resumes from them.
func (s *Service) advanceExecution(ctx context.Context, input WorkerTransitionInput) (WorkerExecution, error) {
	var payload struct{}
	if decodeWorkerPayload(input.Payload, &payload) != nil || input.ExpectedControlRevision == nil {
		return WorkerExecution{}, ErrInvalid
	}
	current, err := s.GetExecutionForWorker(ctx, input.WorkerLeaseInput)
	if err != nil {
		return WorkerExecution{}, err
	}
	if current.Execution.Snapshot.Generation != input.ExecutionGeneration || current.Execution.Snapshot.Revision != input.ExpectedExecutionRevision || current.Execution.Snapshot.ControlRevision != *input.ExpectedControlRevision {
		return WorkerExecution{}, ErrConflict
	}
	for current.Lease != nil {
		if err := ctx.Err(); err != nil {
			return WorkerExecution{}, err
		}
		execution := current.Execution
		snapshot := execution.Snapshot
		control := snapshot.ControlRevision
		input.ExpectedExecutionRevision = snapshot.Revision
		input.ExpectedControlRevision = &control
		input.Payload = json.RawMessage(`{}`)
		input.OperationID = fmt.Sprintf("task-advance:%s:%d:%d", input.TaskID, input.ExecutionGeneration, snapshot.Revision)

		switch {
		case snapshot.Status == "running":
			input.Transition = "reconcile_attempt"
		default:
			return current, nil
		}
		current, err = s.applyExecutionTransition(ctx, input)
		if err != nil {
			return WorkerExecution{}, err
		}
		if current.Execution.Snapshot.Revision == snapshot.Revision {
			return current, nil
		}
	}
	return current, nil
}

func liveEffect(effect Effect) bool {
	return effect.Status == "pending" || effect.Status == "dispatching"
}
