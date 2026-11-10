package integration_test

import (
	"encoding/json"
	"errors"
	"slices"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
)

const testRuntimeEpoch = "agent-epoch-a"

// A newly started Agent Service interrupts the Runs of the previous epoch and
// keeps queued Runs; the previous epoch can no longer write.
func TestAgentServiceEpochInterruptsRunningRunsAndKeepsQueuedRuns(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	useAllActionableRuntimeAgent(t, env)
	running, err := env.service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{
		ContextKey: env.contextKey, Epoch: env.epoch,
		Inputs: []agentruntimestate.RuntimeInput{runtimeInput("epoch-running-input", "trusted_turn", "room:"+testRuntimeInboxRoom, "run")},
	})
	if err != nil {
		t.Fatalf("submit running Run: %v", err)
	}
	if claimed, err := env.service.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{
		ContextKey: env.contextKey, Epoch: env.epoch, ClaimID: "claim-epoch-running",
	}); err != nil || claimed.Run == nil || claimed.Run.RunID != running.RunID {
		t.Fatalf("claim running Run: result=%+v err=%v", claimed, err)
	}
	queued, err := env.service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{
		ContextKey: env.contextKey, Epoch: env.epoch,
		Inputs: []agentruntimestate.RuntimeInput{runtimeInput("epoch-queued-input", "trusted_turn", "", "queued")},
	})
	if err != nil {
		t.Fatalf("submit queued Run: %v", err)
	}
	messageSteer := queueRuntimeInboxMessage(t, env, "epoch-message-steer", "1", "steer", true)
	if messageSteer.Status != "steering" {
		t.Fatalf("queue Message steer: %+v", messageSteer)
	}
	acceptTrustedSteerGroup(t, env, running.RunID, "epoch-trusted-steer", "accept-epoch-trusted-steer")

	started, err := env.service.StartEpoch(t.Context(), "agent-epoch-b")
	if err != nil {
		t.Fatalf("start the next epoch: %v", err)
	}
	if !slices.Equal(started.InterruptedRunIDs, []string{running.RunID}) || !slices.Contains(started.WaitingContextKeys, env.contextKey) {
		t.Fatalf("epoch start=%+v", started)
	}
	interrupted, err := env.service.GetLocalRun(t.Context(), env.contextKey, running.RunID)
	var terminal struct {
		Type  string `json:"type"`
		Error string `json:"error"`
	}
	if err != nil || interrupted.Status != "failed" || json.Unmarshal(interrupted.Terminal, &terminal) != nil ||
		terminal.Error != "process_interrupted" {
		t.Fatalf("interrupted Run: run=%+v err=%v", interrupted, err)
	}
	stillQueued, err := env.service.GetLocalRun(t.Context(), env.contextKey, queued.RunID)
	if err != nil || stillQueued.Status != "queued" {
		t.Fatalf("queued Run after epoch start: run=%+v err=%v", stillQueued, err)
	}
	if outcome := runtimeSteerOutcome(t, env, "epoch-trusted-steer"); outcome != "uncertain" {
		t.Fatalf("trusted steer outcome=%q, want uncertain", outcome)
	}
	var messageRun string
	if err := env.pool.QueryRow(t.Context(), `SELECT run.status FROM agent_runtime_inputs input
		JOIN agent_local_runs run ON run.run_id=input.local_run_id
		WHERE input.context_key=$1 AND input.input_id=$2 AND input.status='handled'`, env.contextKey, messageSteer.InputID).Scan(&messageRun); err != nil || messageRun != "queued" {
		t.Fatalf("Message steer became Run status=%q err=%v, want queued", messageRun, err)
	}

	stale := agentruntimestate.SubmitTrustedTurnInput{
		ContextKey: env.contextKey, Epoch: env.epoch,
		Inputs: []agentruntimestate.RuntimeInput{runtimeInput("epoch-stale-input", "trusted_turn", "", "stale")},
	}
	if _, err := env.service.SubmitTrustedTurn(t.Context(), stale); !errors.Is(err, agentruntimestate.ErrFenced) {
		t.Fatalf("previous epoch write error=%v, want fenced", err)
	}
	stale.Epoch = "agent-epoch-b"
	if _, err := env.service.SubmitTrustedTurn(t.Context(), stale); err != nil {
		t.Fatalf("current epoch write: %v", err)
	}
	reclaimed, err := env.service.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{
		ContextKey: env.contextKey, Epoch: "agent-epoch-b", ClaimID: "claim-epoch-b",
	})
	if err != nil || reclaimed.Run == nil || reclaimed.Run.RunID != queued.RunID {
		t.Fatalf("claim the kept queued Run: result=%+v err=%v", reclaimed, err)
	}
	repeated, err := env.service.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{
		ContextKey: env.contextKey, Epoch: "agent-epoch-b", ClaimID: "claim-epoch-b",
	})
	if err != nil || repeated.Run == nil || repeated.Run.RunID != queued.RunID || repeated.Run.AttemptCount != reclaimed.Run.AttemptCount {
		t.Fatalf("repeated claim: result=%+v err=%v", repeated, err)
	}
	other, err := env.service.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{
		ContextKey: env.contextKey, Epoch: "agent-epoch-b", ClaimID: "claim-epoch-b-other",
	})
	if err != nil || other.Run != nil {
		t.Fatalf("second claim while a Run is running: result=%+v err=%v", other, err)
	}
}

func startRuntimeEpoch(t *testing.T, service *agentruntimestate.Service, epoch string) {
	t.Helper()
	if _, err := service.StartEpoch(t.Context(), epoch); err != nil {
		t.Fatalf("start Agent Service epoch %s: %v", epoch, err)
	}
}

func runtimeSteerOutcome(t *testing.T, env runtimeStateTestEnv, inputID string) string {
	t.Helper()
	var outcome *string
	if err := env.pool.QueryRow(t.Context(), `SELECT steer_outcome FROM agent_runtime_inputs WHERE context_key=$1 AND input_id=$2`,
		env.contextKey, inputID).Scan(&outcome); err != nil {
		t.Fatalf("read steer outcome of %s: %v", inputID, err)
	}
	if outcome == nil {
		return ""
	}
	return *outcome
}
