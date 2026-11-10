package taskexecution

import (
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func TestInspectCurrentAttemptRunsClassifiesCurrentInputTerminals(t *testing.T) {
	tests := []struct {
		name             string
		observation      string
		allTerminal      bool
		allSucceeded     bool
		failed, canceled bool
	}{
		{
			name: "all succeeded",
			observation: `{
				"participant_runs":[
					{"actor_id":"actor_1","agent_management_id":"agent_1","agent_run_ref":"run_1"},
					{"actor_id":"actor_2","agent_management_id":"agent_2","agent_run_ref":"run_2"}
				],
				"participant_terminals":[
					{"agent_run_ref":"run_1","status":"succeeded"},
					{"agent_run_ref":"run_2","status":"succeeded"}
				]
			}`,
			allTerminal: true, allSucceeded: true,
		},
		{
			name: "one failed while another runs",
			observation: `{
				"participant_runs":[
					{"actor_id":"actor_1","agent_management_id":"agent_1","agent_run_ref":"run_1"},
					{"actor_id":"actor_2","agent_management_id":"agent_2","agent_run_ref":"run_2"}
				],
				"participant_terminals":[{"agent_run_ref":"run_1","status":"failed"}]
			}`,
			failed: true,
		},
		{
			name: "one canceled while another runs",
			observation: `{
				"participant_runs":[
					{"actor_id":"actor_1","agent_management_id":"agent_1","agent_run_ref":"run_1"},
					{"actor_id":"actor_2","agent_management_id":"agent_2","agent_run_ref":"run_2"}
				],
				"participant_terminals":[{"agent_run_ref":"run_2","status":"canceled"}]
			}`,
			canceled: true,
		},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			input := store.TaskInputRevision{MessageEffectIds: []byte(`["effect_current"]`)}
			effects := []store.TaskEffect{{
				ID: "effect_current", Operation: "submit_agent_turn", Status: "succeeded",
				Observation: []byte(testCase.observation),
			}}
			result, err := inspectCurrentAttemptRuns(input, effects)
			if err != nil {
				t.Fatal(err)
			}
			if result.allTerminal != testCase.allTerminal || result.allSucceeded != testCase.allSucceeded ||
				result.failed != testCase.failed || result.canceled != testCase.canceled {
				t.Fatalf("classification=%+v", result)
			}
		})
	}
}

func TestInspectCurrentAttemptRunsFencesOldEffects(t *testing.T) {
	input := store.TaskInputRevision{MessageEffectIds: []byte(`["effect_current"]`)}
	effects := []store.TaskEffect{
		{
			ID: "effect_old", Operation: "submit_agent_turn", Status: "succeeded",
			Observation: []byte(`{
				"participant_runs":[{"actor_id":"actor_1","agent_management_id":"agent_1","agent_run_ref":"run_old"}],
				"participant_terminals":[{"agent_run_ref":"run_old","status":"failed"}]
			}`),
		},
		{ID: "effect_current", Operation: "submit_agent_turn", Status: "pending"},
	}
	result, err := inspectCurrentAttemptRuns(input, effects)
	if err != nil {
		t.Fatal(err)
	}
	if result.failed || result.canceled || result.allTerminal || result.allSucceeded {
		t.Fatalf("old effect escaped current InputRevision fence: %+v", result)
	}
}

func TestInspectCurrentAttemptRunsKeepsTheReportedRunAndError(t *testing.T) {
	input := store.TaskInputRevision{MessageEffectIds: []byte(`["effect_current"]`)}
	effects := []store.TaskEffect{{
		ID: "effect_current", Operation: "submit_agent_turn", Status: "succeeded",
		Observation: []byte(`{
			"participant_runs":[{"actor_id":"actor_1","agent_management_id":"agent_1","agent_run_ref":"run_1"}],
			"participant_terminals":[{"agent_run_ref":"run_1","status":"failed","terminal_message":"provider quota exceeded"}]
		}`),
	}}
	result, err := inspectCurrentAttemptRuns(input, effects)
	if err != nil {
		t.Fatal(err)
	}
	if !result.failed || result.failureMessage != "provider quota exceeded" || result.lastRun.AgentRunRef != "run_1" {
		t.Fatalf("classification=%+v", result)
	}
	effects[0].Status, effects[0].Observation = "failed", []byte(`{"failure_code":"CONTEXT_ACTIVATION_RUNTIME_FAILED","retryable":true}`)
	result, err = inspectCurrentAttemptRuns(input, effects)
	if err != nil || !result.failed || result.failureMessage != "the AlterEgo could not start: CONTEXT_ACTIVATION_RUNTIME_FAILED" {
		t.Fatalf("activation failure=%+v err=%v", result, err)
	}
}
