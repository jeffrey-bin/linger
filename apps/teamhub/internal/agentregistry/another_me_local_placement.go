package agentregistry

import (
	"errors"
	"slices"

	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

var errAnotherMeComputerUnavailable = errors.New("no Local Computer is ready for Another Me")

type anotherMeLocalPlacement struct {
	ComputerID       string
	RuntimeType      string
	WorkspaceGrantID string
	Model            string
	ReasoningEffort  string
}

// chooseAnotherMeLocalPlacement chooses where a new Another Me runs: the first
// online Computer with any ready Runtime, its first writable workspace grant,
// and the model that Runtime runs by default, else the first it reports.
func chooseAnotherMeLocalPlacement(computers []httpapi.LocalComputer) (anotherMeLocalPlacement, error) {
	for _, computer := range computers {
		grantID := writableWorkspaceGrant(computer.WorkspaceGrants)
		if computer.Status != httpapi.LocalComputerStatusOnline || computer.UpgradeRequired || grantID == "" {
			continue
		}
		for _, runtime := range computer.Runtimes {
			if runtime.Status != httpapi.LocalRuntimeDiagnosticStatusReady || len(runtime.Models) == 0 {
				continue
			}
			model := runtime.Models[0]
			if index := slices.IndexFunc(runtime.Models, func(candidate httpapi.AgentModel) bool {
				return candidate.IsDefault != nil && *candidate.IsDefault
			}); index >= 0 {
				model = runtime.Models[index]
			}
			return anotherMeLocalPlacement{
				ComputerID: computer.ComputerId, RuntimeType: string(runtime.Type), WorkspaceGrantID: grantID,
				Model: model.Id, ReasoningEffort: placementReasoningEffort(model),
			}, nil
		}
	}
	return anotherMeLocalPlacement{}, errAnotherMeComputerUnavailable
}

// placementReasoningEffort keeps the model default and otherwise takes the
// first allowed effort, because a model that offers efforts needs one.
func placementReasoningEffort(model httpapi.AgentModel) string {
	if model.DefaultReasoningEffort != nil {
		return string(*model.DefaultReasoningEffort)
	}
	if model.AllowedReasoningEffort == nil || len(*model.AllowedReasoningEffort) == 0 {
		return ""
	}
	return string((*model.AllowedReasoningEffort)[0])
}

func writableWorkspaceGrant(grants []httpapi.LocalComputerWorkspaceGrant) string {
	for _, grant := range grants {
		if grant.Mode == httpapi.WorkspaceWrite {
			return grant.GrantId
		}
	}
	return ""
}
