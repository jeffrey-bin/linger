package app

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/taskexecution"
)

func TestWorkerTaskExecutionModelPreservesCompletedEffectWitnesses(t *testing.T) {
	now := time.Date(2026, 8, 13, 9, 30, 0, 0, time.UTC)
	expiresAt := now.Add(time.Minute)
	value := taskexecution.WorkerExecution{
		Lease: &taskexecution.WorkerLease{
			TaskID: "task_1", WorkerID: "worker_1", LeaseToken: strings.Repeat("l", 32),
			LeaseGeneration: 2, LeaseExpiresAt: expiresAt,
		},
		Execution: taskexecution.Execution{
			Snapshot: taskexecution.ExecutionSnapshot{
				TaskID: "task_1", Generation: 1, Status: "running", Revision: 2,
				DesiredControl: "run", UpdatedAt: now,
			},
			Spec: taskexecution.RunSpecV1{
				SchemaVersion: 1, ResultAgentActorID: "actor_result",
				AttemptPolicy: taskexecution.DelegatedAttemptPolicyV1(),
			},
			Effects: []taskexecution.Effect{{
				ID: "effect_submit", RootOperationID: "root_1", Operation: "submit_agent_turn", Status: "succeeded",
				DispatchSequence: 1, Payload: json.RawMessage(`{"capability":"secret","input_revision":1}`),
				PayloadHash: strings.Repeat("a", 64),
				Observation: json.RawMessage(`{"participant_runs":[{"actor_id":"actor_result","agent_management_id":"agent_result","agent_run_ref":"local_run_1"}]}`),
				CreatedAt:   now,
			}},
		},
	}

	model, err := workerTaskExecutionModel(value)
	if err != nil {
		t.Fatalf("project Worker Task execution: %v", err)
	}
	if model.Lease == nil || model.Lease.LeaseToken != value.Lease.LeaseToken || model.Lease.LeaseExpiresAt != expiresAt {
		t.Fatalf("worker lease=%+v", model.Lease)
	}
	if len(model.Execution.PendingEffects) != 1 || model.Execution.PendingEffects[0].Status != "succeeded" ||
		model.Execution.PendingEffects[0].Observation == nil {
		t.Fatalf("completed effect witness=%+v", model.Execution.PendingEffects)
	}
	if _, leaked := model.Execution.PendingEffects[0].Payload["capability"]; leaked {
		t.Fatal("worker projection leaked finish capability")
	}
}
