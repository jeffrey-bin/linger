package agentregistry

import (
	"errors"
	"testing"

	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func TestChooseAnotherMeLocalPlacementUsesAnyReadyRuntime(t *testing.T) {
	grants := []httpapi.LocalComputerWorkspaceGrant{{GrantId: "grant_files", Mode: httpapi.WorkspaceWrite}}
	efforts := func(values ...httpapi.AgentReasoningEffort) *[]httpapi.AgentReasoningEffort { return &values }
	high := httpapi.AgentReasoningEffort("high")
	isDefault := true
	for _, test := range []struct {
		name     string
		runtimes []httpapi.LocalComputerRuntime
		want     anotherMeLocalPlacement
	}{{
		name: "Claude model without a default effort",
		runtimes: []httpapi.LocalComputerRuntime{{Type: "claude", Status: "ready", Models: []httpapi.AgentModel{{
			Id: "claude-sonnet", AllowedReasoningEffort: efforts("medium", "high"),
		}}}},
		want: anotherMeLocalPlacement{ComputerID: "computer_1", RuntimeType: "claude", WorkspaceGrantID: "grant_files", Model: "claude-sonnet", ReasoningEffort: "medium"},
	}, {
		name: "Codex when Claude is not ready",
		runtimes: []httpapi.LocalComputerRuntime{
			{Type: "claude", Status: "not_installed"},
			{Type: "codex", Status: "ready", Models: []httpapi.AgentModel{{Id: "codex-default"}}},
		},
		want: anotherMeLocalPlacement{ComputerID: "computer_1", RuntimeType: "codex", WorkspaceGrantID: "grant_files", Model: "codex-default"},
	}, {
		name: "model default effort",
		runtimes: []httpapi.LocalComputerRuntime{{Type: "codex", Status: "ready", Models: []httpapi.AgentModel{{
			Id: "gpt", AllowedReasoningEffort: efforts("medium", "high"), DefaultReasoningEffort: &high,
		}}}},
		want: anotherMeLocalPlacement{ComputerID: "computer_1", RuntimeType: "codex", WorkspaceGrantID: "grant_files", Model: "gpt", ReasoningEffort: "high"},
	}, {
		name: "the Runtime's default model",
		runtimes: []httpapi.LocalComputerRuntime{{Type: "codex", Status: "ready", Models: []httpapi.AgentModel{
			{Id: "gpt-mini"}, {Id: "gpt", IsDefault: &isDefault},
		}}},
		want: anotherMeLocalPlacement{ComputerID: "computer_1", RuntimeType: "codex", WorkspaceGrantID: "grant_files", Model: "gpt"},
	}} {
		t.Run(test.name, func(t *testing.T) {
			got, err := chooseAnotherMeLocalPlacement([]httpapi.LocalComputer{{
				ComputerId: "computer_1", Status: httpapi.LocalComputerStatusOnline, Runtimes: test.runtimes, WorkspaceGrants: grants,
			}})
			if err != nil || got != test.want {
				t.Fatalf("placement=%+v err=%v, want %+v", got, err, test.want)
			}
		})
	}
}

func TestChooseAnotherMeLocalPlacementWaitsForAnOnlineComputer(t *testing.T) {
	_, err := chooseAnotherMeLocalPlacement([]httpapi.LocalComputer{{
		ComputerId: "computer_1", Status: httpapi.LocalComputerStatusOffline,
		WorkspaceGrants: []httpapi.LocalComputerWorkspaceGrant{{GrantId: "grant_files", Mode: httpapi.WorkspaceWrite}},
		Runtimes:        []httpapi.LocalComputerRuntime{{Type: "codex", Status: "ready", Models: []httpapi.AgentModel{{Id: "codex-default"}}}},
	}})
	if !errors.Is(err, errAnotherMeComputerUnavailable) {
		t.Fatalf("err=%v, want %v", err, errAnotherMeComputerUnavailable)
	}
}
