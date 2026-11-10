package integration_test

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func TestAgentRuntimeRunnerOperationUsageLandsOnTheRunOnce(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	submitted, err := env.service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{ContextKey: env.contextKey, Epoch: env.epoch,
		Inputs: []agentruntimestate.RuntimeInput{runtimeInput("operation-usage-input", "trusted_turn", "", "once")},
	})
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := env.service.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{ClaimID: "operation-usage-claim", ContextKey: env.contextKey, Epoch: env.epoch})
	if err != nil || claimed.Run == nil {
		t.Fatalf("claim: %+v %v", claimed, err)
	}
	record := func(service *agentruntimestate.Service, operationID, usage string) error {
		input := agentruntimestate.RecordRunOperationInput{
			ContextKey: env.contextKey, Epoch: env.epoch, RunID: submitted.RunID,
			OperationID: operationID, RuntimeType: "codex",
		}
		if usage != "" {
			input.Usage = json.RawMessage(usage)
		}
		return service.RecordRunOperation(t.Context(), input)
	}
	const usage = `[{"provider":"openai","model":"usage-test-model","input":10,"cache_read":20,"cache_write":0,"output":30,"reasoning":8,"last":{"input":2,"cache_read":3,"cache_write":0,"output":4},"compaction_count":1},{"provider":"openai","model":"<synthetic>","input":5,"cache_read":0,"cache_write":0,"output":0}]`
	const earlierUsage = `[{"provider":"openai","model":"usage-test-model","input":1,"cache_read":0,"cache_write":0,"output":0}]`
	// A Run may run several Operations; each is recorded as it starts.
	for _, operationID := range []string{"operation-earlier", "operation-latest"} {
		if err := record(env.service, operationID, ""); err != nil {
			t.Fatalf("record start of %s: %v", operationID, err)
		}
	}
	if err := record(env.service, "operation-earlier", earlierUsage); err != nil {
		t.Fatal(err)
	}
	if err := record(env.service, "operation-latest", usage); err != nil {
		t.Fatal(err)
	}
	// A repeated terminal after a service restart counts each Operation once.
	restarted := agentruntimestate.New(env.pool)
	if err := record(restarted, "operation-latest", usage); err != nil {
		t.Fatal(err)
	}
	if err := record(restarted, "operation-latest", ""); err != nil {
		t.Fatal(err)
	}
	var durableTotal int64
	if err := env.pool.QueryRow(t.Context(), `SELECT input_tokens FROM agent_usage_totals WHERE provider='openai' AND model='usage-test-model'`).Scan(&durableTotal); err != nil || durableTotal != 11 {
		t.Fatalf("durable total=%d %v", durableTotal, err)
	}
	if err := env.service.RecordRunOperation(t.Context(), agentruntimestate.RecordRunOperationInput{
		ContextKey: env.contextKey, Epoch: "epoch-earlier", RunID: submitted.RunID, OperationID: "operation-fenced", RuntimeType: "codex",
	}); !errors.Is(err, agentruntimestate.ErrFenced) {
		t.Fatalf("Operation of an earlier epoch: err=%v, want fenced", err)
	}
	if _, err := env.service.FinishLocalRun(t.Context(), agentruntimestate.FinishLocalRunInput{ContextKey: env.contextKey, Epoch: env.epoch, RunID: submitted.RunID,
		Terminal: json.RawMessage(`{"type":"canceled","reason":"finished locally"}`),
	}); err != nil {
		t.Fatal(err)
	}
	// Message activities resolve both native Operations after the terminal commit.
	nativeOperations, err := store.New(env.pool).ListAgentRuntimeNativeOperationIDs(t.Context(), submitted.RunID)
	if err != nil || len(nativeOperations) != 2 || nativeOperations[0] != "operation-earlier" || nativeOperations[1] != "operation-latest" {
		t.Fatalf("native operations=%v err=%v", nativeOperations, err)
	}
	if unrelated, err := store.New(env.pool).ListAgentRuntimeNativeOperationIDs(t.Context(), "unrelated-run"); err != nil || len(unrelated) != 0 {
		t.Fatalf("unrelated operations=%v err=%v", unrelated, err)
	}
}
