package document

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
)

func TestValidateSemanticMutationInputRejectsInvalidOperations(t *testing.T) {
	t.Parallel()

	validInput := ApplySemanticMutationInput{
		Principal:          &agentcredential.Principal{AgentActorID: "actor"},
		TargetKind:         "document",
		TargetID:           "document_plan",
		DocumentID:         "document_plan",
		SourceInvocationID: "invocation",
		SchemaVersion:      "blocknote-semantic-v1",
	}
	testCases := map[string]json.RawMessage{
		"invalid JSON":         json.RawMessage(`{"kind":"set_title"}`),
		"empty operations":     json.RawMessage(`[]`),
		"empty append":         json.RawMessage(`[{"kind":"append_blocks","blocks":[]}]`),
		"append with anchor":   json.RawMessage(`[{"kind":"append_blocks","stable_block_id":"guessed","blocks":[{}]}]`),
		"unknown operation":    json.RawMessage(`[{"kind":"unknown","title":"Agent title"}]`),
		"unknown field":        json.RawMessage(`[{"kind":"set_title","title":"Agent title","document_id":"override"}]`),
		"empty title":          json.RawMessage(`[{"kind":"set_title","title":""}]`),
		"invalid position":     json.RawMessage(`[{"kind":"insert_blocks","position":"inside","stable_block_id":"block","blocks":[{}]}]`),
		"missing block IDs":    json.RawMessage(`[{"kind":"delete_blocks","stable_block_ids":[]}]`),
		"null updated block":   json.RawMessage(`[{"kind":"update_block","stable_block_id":"block","block":null}]`),
		"new block missing id": json.RawMessage(`[{"kind":"insert_blocks","position":"after","stable_block_id":"block","blocks":[{"type":"paragraph","content":"New"}]}]`),
		"child missing id":     json.RawMessage(`[{"kind":"insert_blocks","position":"after","stable_block_id":"block","blocks":[{"id":"new","children":[{"type":"paragraph"}]}]}]`),
		"duplicate block id":   json.RawMessage(`[{"kind":"insert_blocks","position":"after","stable_block_id":"block","blocks":[{"id":"new"},{"id":"new"}]}]`),
		"invalid new block id": json.RawMessage(`[{"kind":"insert_blocks","position":"after","stable_block_id":"block","blocks":[{"id":"new block"}]}]`),
	}

	for name, semanticChange := range testCases {

		t.Run(name, func(t *testing.T) {
			t.Parallel()
			input := validInput
			input.SemanticChange = semanticChange
			if _, _, err := validateSemanticMutationInput(input); !errors.Is(err, ErrInvalidInput) {
				t.Fatalf("validateSemanticMutationInput() error = %v, want ErrInvalidInput", err)
			}
		})
	}
}

func TestValidateSemanticMutationInputCanonicalizesEquivalentOperations(t *testing.T) {
	t.Parallel()

	base := ApplySemanticMutationInput{
		Principal:          &agentcredential.Principal{AgentActorID: "actor"},
		TargetKind:         "document",
		TargetID:           "document_plan",
		DocumentID:         "document_plan",
		SourceInvocationID: "invocation",
		SchemaVersion:      "blocknote-semantic-v1",
	}
	first := base
	first.SemanticChange = json.RawMessage("[ { \"title\" : \"Agent title\", \"kind\" : \"set_title\" } ]")
	second := base
	second.SemanticChange = json.RawMessage(`[{"title":"Agent title","kind":"set_title"}]`)

	firstCanonical, firstHash, firstErr := validateSemanticMutationInput(first)
	secondCanonical, secondHash, secondErr := validateSemanticMutationInput(second)
	if firstErr != nil || secondErr != nil {
		t.Fatalf("validateSemanticMutationInput() errors = %v, %v", firstErr, secondErr)
	}
	if string(firstCanonical) != string(secondCanonical) || firstHash != secondHash {
		t.Fatalf("equivalent operations differ: canonical %q/%q hash %x/%x", firstCanonical, secondCanonical, firstHash, secondHash)
	}
}

func TestValidateAppendBlocksNeedsNoExistingAnchor(t *testing.T) {
	if err := validateSemanticOperation(json.RawMessage(`{"kind":"append_blocks","blocks":[{"id":"new-block","type":"paragraph","content":"Appended"}]}`)); err != nil {
		t.Fatal(err)
	}
}
