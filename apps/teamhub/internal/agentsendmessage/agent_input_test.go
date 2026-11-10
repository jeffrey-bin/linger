package agentsendmessage

import (
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
)

func TestAgentMessageInputDoesNotRequireRuntimeProvenance(t *testing.T) {
	input := Input{
		InvocationID:    validInvocationID,
		InboxID:         "room:room_one",
		messageSegments: []messagecreation.Segment{{Type: "text", Content: "A direct Agent message"}},
	}
	normalized, err := normalizeInput(input)
	if err != nil {
		t.Fatalf("business input without a Run or source Inbox: %v", err)
	}
	if len(normalized.sourceInboxIDs) != 0 {
		t.Fatal("normalization fabricated runtime provenance")
	}
	input.InvocationID = ""
	if _, err := normalizeInput(input); err == nil {
		t.Fatal("a write still requires an operation identity")
	}
}
