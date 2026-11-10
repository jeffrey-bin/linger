package agentsendmessage

import (
	"slices"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/teammd"
)

func TestTeamMdAnnouncementNotifiesAppointedOrchestrator(t *testing.T) {
	document := teammd.Document{
		Orchestrator: teammd.Participant{Name: "Coordinator", ActorID: "coordinator"},
		Members: []teammd.Participant{
			{Name: "Publisher", ActorID: "publisher"},
			{Name: "Reviewer", ActorID: "reviewer"},
		},
	}
	for _, test := range []struct {
		name      string
		publisher string
		want      []string
	}{
		{"self orchestrates", "coordinator", []string{"publisher", "reviewer"}},
		{"appoints another Agent", "publisher", []string{"coordinator", "reviewer"}},
		{"publisher is outside the team", "other", []string{"coordinator", "publisher", "reviewer"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			content, notified := teamMdMessageContent(document, test.publisher, map[string]string{
				"coordinator": "Coordinator", "publisher": "Publisher", "reviewer": "Reviewer",
			})
			if !slices.Equal(notified, test.want) {
				t.Fatalf("notified=%v want=%v", notified, test.want)
			}
			var mentions []string
			var raw strings.Builder
			for _, segment := range content.Segments {
				raw.WriteString(segment.Content)
				if segment.Type == "reference" && segment.TargetType == "agent" {
					mentions = append(mentions, segment.Target)
				}
			}
			if !slices.Equal(mentions, test.want) || raw.String() != content.RawMessage {
				t.Fatalf("announcement=%+v mentions=%v want=%v", content, mentions, test.want)
			}
		})
	}
}
