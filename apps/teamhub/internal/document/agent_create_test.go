package document

import (
	"errors"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
)

func TestValidateAgentDocumentCreateInput(t *testing.T) {
	t.Parallel()

	valid := CreateAgentDocumentInput{
		Principal:          &agentcredential.Principal{AgentActorID: "actor-a"},
		TargetKind:         "room",
		TargetID:           "room-a",
		SourceInvocationID: "invocation-a",
		Title:              "Draft",
		Markdown:           "# Draft",
	}
	requestHash, err := validateAgentDocumentCreateInput(valid)
	if err != nil || len(requestHash) != 32 {
		t.Fatalf("validateAgentDocumentCreateInput() hash=%x error=%v", requestHash, err)
	}

	testCases := map[string]func(CreateAgentDocumentInput) CreateAgentDocumentInput{
		"missing principal": func(input CreateAgentDocumentInput) CreateAgentDocumentInput {
			input.Principal = nil
			return input
		},
		"long invocation": func(input CreateAgentDocumentInput) CreateAgentDocumentInput {
			input.SourceInvocationID = strings.Repeat("i", 256)
			return input
		},
		"empty title": func(input CreateAgentDocumentInput) CreateAgentDocumentInput {
			input.Title = ""
			return input
		},
		"long title": func(input CreateAgentDocumentInput) CreateAgentDocumentInput {
			input.Title = strings.Repeat("t", 256)
			return input
		},
		"invalid title UTF-8": func(input CreateAgentDocumentInput) CreateAgentDocumentInput {
			input.Title = string([]byte{0xff})
			return input
		},
		"oversized markdown": func(input CreateAgentDocumentInput) CreateAgentDocumentInput {
			input.Markdown = strings.Repeat("m", 1048577)
			return input
		},
	}
	for name, mutate := range testCases {

		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if _, err := validateAgentDocumentCreateInput(mutate(valid)); !errors.Is(err, ErrInvalidInput) {
				t.Fatalf("validateAgentDocumentCreateInput() error = %v, want ErrInvalidInput", err)
			}
		})
	}
}
