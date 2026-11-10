package integration_test

import (
	"errors"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
)

// A deployment gap must not turn a queued, unstarted input into a failed
// execution. PostgreSQL, not an in-memory dispatch retry, owns the queued work.
func TestAgentDeploymentPreservesQueuedInboxAndClaimsOnce(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	useAllActionableRuntimeAgent(t, env)
	runID := queueRuntimeInboxMessage(t, env, "deployment-message", "1", "run after recovery", false).RunID
	// Advance only persisted waiting age: no real eight-minute sleep is needed.
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_local_runs SET created_at=clock_timestamp()-interval '8 minutes' WHERE run_id=$1`, runID); err != nil {
		t.Fatal(err)
	}
	replacement := agentruntimestate.New(env.pool)
	const epoch = "agent-after-deployment"
	started, err := replacement.StartEpoch(t.Context(), epoch)
	if err != nil || len(started.InterruptedRunIDs) != 0 || len(started.WaitingContextKeys) != 1 || started.WaitingContextKeys[0] != env.contextKey {
		t.Fatalf("epoch start=%+v err=%v", started, err)
	}
	queued, err := replacement.GetLocalRun(t.Context(), env.contextKey, runID)
	if err != nil || queued.Status != "queued" {
		t.Fatalf("queued run=%+v err=%v", queued, err)
	}
	if _, err := env.service.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{ClaimID: "stale-deployment-claim", ContextKey: env.contextKey, Epoch: env.epoch}); !errors.Is(err, agentruntimestate.ErrFenced) {
		t.Fatalf("stale process claim=%v", err)
	}
	claim := agentruntimestate.ClaimLocalRunInput{ClaimID: "claim-after-deployment", ContextKey: env.contextKey, Epoch: epoch}
	first, err := replacement.ClaimLocalRun(t.Context(), claim)
	if err != nil || first.Run == nil || first.Run.RunID != runID || first.Run.AttemptCount != 1 {
		t.Fatalf("claim=%+v err=%v", first, err)
	}
	replayed, err := agentruntimestate.New(env.pool).ClaimLocalRun(t.Context(), claim)
	if err != nil || replayed.Run == nil || replayed.Run.RunID != runID || replayed.Run.AttemptCount != 1 {
		t.Fatalf("claim replay=%+v err=%v", replayed, err)
	}
	claim.ClaimID = "duplicate-deployment-claim"
	duplicate, err := replacement.ClaimLocalRun(t.Context(), claim)
	if err != nil || duplicate.Run != nil {
		t.Fatalf("duplicate claim=%+v err=%v", duplicate, err)
	}
	var runs, inputs int
	if err := env.pool.QueryRow(t.Context(), `SELECT (SELECT count(*) FROM agent_local_runs WHERE context_key=$1),(SELECT count(*) FROM agent_runtime_inputs WHERE context_key=$1)`, env.contextKey).Scan(&runs, &inputs); err != nil {
		t.Fatal(err)
	}
	if runs != 1 || inputs != 1 {
		t.Fatalf("runs=%d inputs=%d, want one each", runs, inputs)
	}
}
