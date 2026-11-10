package integration_test

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
)

func TestAgentRuntimeFirstSessionAfterProfileChange(t *testing.T) {
	allowParallelIntegrationTest(t)
	for _, scenario := range []string{
		"local-codex", "local-claude", "second-profile-change",
		"runtime-change", "different-loaded-revision", "different-epoch", "standalone-checkpoint",
	} {
		t.Run(scenario, func(t *testing.T) {
			env := newRuntimeStateTestEnv(t)
			provider := "codex"
			if scenario == "local-claude" {
				provider = "claude"
			}
			setProfileTestProvider(t, env, provider)
			revision := activeRuntimeConfigurationRevision(t, env.pool)
			submitted, err := env.service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{ContextKey: env.contextKey, Epoch: env.epoch,
				Inputs: []agentruntimestate.RuntimeInput{runtimeInput("first-profile-input", "trusted_turn", "", "initialize and complete")},
			})
			if err != nil {
				t.Fatal(err)
			}
			claimed, err := env.service.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{
				ClaimID: "claim-first-profile-run", ContextKey: env.contextKey, Epoch: env.epoch,
			})
			if err != nil || claimed.Run == nil || claimed.Run.RunID != submitted.RunID {
				t.Fatalf("claim first Run: %+v %v", claimed, err)
			}
			// A profile-only change advances the revision during the Run and
			// leaves the Runtime revision alone.
			if _, err := env.pool.Exec(t.Context(), `UPDATE agent_registrations SET configuration_revision=configuration_revision+1,
				instructions='Initialized working prompt',updated_at=clock_timestamp()
				WHERE agent_management_id=$1`, testRuntimeAgentID); err != nil {
				t.Fatal(err)
			}
			repairs := map[string]string{
				"second-profile-change":     "UPDATE agent_registrations SET configuration_revision=configuration_revision+1 WHERE agent_management_id='" + testRuntimeAgentID + "'",
				"runtime-change":            "UPDATE agent_registrations SET runtime_configuration_revision=configuration_revision WHERE agent_management_id='" + testRuntimeAgentID + "'",
				"different-loaded-revision": "UPDATE agent_local_runs SET claim_configuration_revision=999 WHERE run_id='" + submitted.RunID + "'",
				"different-epoch":           "UPDATE agent_local_runs SET epoch='agent-epoch-other' WHERE run_id='" + submitted.RunID + "'",
			}
			if sql := repairs[scenario]; sql != "" {
				if _, err := env.pool.Exec(t.Context(), sql); err != nil {
					t.Fatal(err)
				}
			}
			checkpoint := runtimeSessionCheckpoint(0, revision, "first-sealed-thread")
			checkpoint.ProviderKind = "local"
			finish := agentruntimestate.FinishLocalRunInput{ContextKey: env.contextKey, Epoch: env.epoch,
				RunID: submitted.RunID, Terminal: json.RawMessage(`{"type":"succeeded"}`),
				Session: &checkpoint,
			}
			if scenario == "standalone-checkpoint" {
				_, err = env.service.CheckpointRuntimeSession(t.Context(), agentruntimestate.CheckpointSessionInput{ContextKey: env.contextKey, Epoch: env.epoch, Checkpoint: checkpoint})
			} else {
				var finished agentruntimestate.FinishLocalRunResult
				finished, err = env.service.FinishLocalRun(t.Context(), finish)
				if scenario == "local-codex" || scenario == "local-claude" || scenario == "second-profile-change" {
					if err != nil || finished.Run.Status != "succeeded" || finished.Session == nil ||
						finished.Session.Revision != 1 || finished.Session.ConfigurationRevision != revision {
						t.Fatalf("first sealed Session and terminal must commit together: %+v %v", finished, err)
					}
					replay, replayErr := env.service.FinishLocalRun(t.Context(), finish)
					if replayErr != nil || replay.Session == nil || replay.Session.Revision != 1 {
						t.Fatalf("finish replay changed checkpoint: %+v %v", replay, replayErr)
					}
					checkpoint.ExpectedRevision = 1
					continued, nextErr := env.service.CheckpointRuntimeSession(t.Context(), agentruntimestate.CheckpointSessionInput{ContextKey: env.contextKey, Epoch: env.epoch, Checkpoint: checkpoint})
					if nextErr != nil || continued.Revision != 2 {
						t.Fatalf("continue original loaded Session: %+v %v", continued, nextErr)
					}
					return
				}
			}
			if !errors.Is(err, agentruntimestate.ErrConflict) && (scenario != "different-epoch" || !errors.Is(err, agentruntimestate.ErrFenced)) {
				t.Fatalf("unproven first Session accepted: %v", err)
			}
			run, err := env.service.GetLocalRun(t.Context(), env.contextKey, submitted.RunID)
			if err != nil || run.Status != "running" {
				t.Fatalf("rejected checkpoint committed a terminal: %+v %v", run, err)
			}
			session, err := env.service.GetRuntimeSession(t.Context(), env.contextKey)
			if err != nil || session != nil {
				t.Fatalf("rejected checkpoint committed a Session: %+v %v", session, err)
			}
		})
	}
}

// The Runtime transport is the Local Computer; the native provider is that
// Computer's local Runtime.
func setProfileTestProvider(t *testing.T, env runtimeStateTestEnv, native string) {
	t.Helper()
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_registrations
		SET agent_type='general',local_runtime_type=$2 WHERE agent_management_id=$1`, testRuntimeAgentID, native); err != nil {
		t.Fatal(err)
	}
}
