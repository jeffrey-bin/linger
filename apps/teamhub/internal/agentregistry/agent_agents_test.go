package agentregistry

import (
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/collaboration"
)

func TestAgentProfileChangeAcceptsOnlyContractLimits(t *testing.T) {
	text := func(value string) *string { return &value }
	valid := AgentProfileChange{Name: text("Release Coordinator"), Description: text(""), Instructions: text("Coordinate releases.")}
	if !ValidAgentProfileChange(valid) {
		t.Fatal("valid change was rejected")
	}
	for name, change := range map[string]AgentProfileChange{
		"blank name":        {Name: text("")},
		"long name":         {Name: text(strings.Repeat("€", 121))},
		"long description":  {Description: text(strings.Repeat("d", 1001))},
		"blank prompt":      {Instructions: text("")},
		"long prompt":       {Instructions: text(strings.Repeat("p", 50001))},
		"bootstrap prompt":  {Instructions: text(collaboration.GeneralAgentUninitializedInstructions)},
		"invalid utf8 name": {Name: text(string([]byte{0xff}))},
	} {
		if ValidAgentProfileChange(change) {
			t.Fatalf("%s accepted", name)
		}
	}
	if !(AgentProfileChange{}).Empty() || valid.Empty() {
		t.Fatal("empty() misreports provided fields")
	}
}

func TestProfileBootstrapUsesOnlyCurrentCLICommand(t *testing.T) {
	if !strings.Contains(collaboration.GeneralAgentUninitializedInstructions, "run teamhub agent update once") ||
		strings.Contains(collaboration.GeneralAgentUninitializedInstructions, "teamhub profile") ||
		strings.Contains(collaboration.GeneralAgentUninitializedInstructions, "set_profile") {
		t.Fatal("bootstrap instructions recommend a retired command")
	}
	if !collaboration.IsUninitializedAgentProfile(collaboration.GeneralAgentUninitializedInstructions) || collaboration.IsUninitializedAgentProfile("Custom working prompt") {
		t.Fatal("bootstrap marker is not matched exactly")
	}
}

func TestAgentUpdateCardShowsOnlyChangedFields(t *testing.T) {
	name := "Reviewer"
	target := sponsorAgent{name: "Writer"}
	target.registration.ActorID, target.registration.Description, target.registration.Instructions = "actor_writer", "Writes", "Write well."
	card := agentUpdateCard(target, AgentProfileChange{Name: &name})
	if card.Action != "update" || card.AgentName != "Writer" || card.TargetActorID != "actor_writer" ||
		len(card.Changes) != 1 || card.Changes[0].Field != "name" || *card.Changes[0].Before != "Writer" || card.Changes[0].After != "Reviewer" {
		t.Fatalf("card = %+v", card)
	}
}
