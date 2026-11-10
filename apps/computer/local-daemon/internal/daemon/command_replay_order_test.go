package daemon

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
)

func TestCommandReplayIgnoresObjectOrderWithoutLosingPrecision(t *testing.T) {
	original := protocol.Command{CommandID: "input-1", Input: json.RawMessage(`{"text":"hello","nested":{"large":9007199254740993,"items":[1,2]}}`)}
	reordered := original
	reordered.Input = json.RawMessage(`{"nested":{"items":[1,2],"large":9007199254740993},"text":"hello"}`)
	firstDigest, err := commandDigest(original)
	if err != nil {
		t.Fatal(err)
	}
	if nextDigest, err := commandDigest(reordered); err != nil || firstDigest != nextDigest {
		t.Fatalf("reordered input differs: %v", err)
	}
	for _, changed := range []string{
		`{"text":"hello","nested":{"large":9007199254740992,"items":[1,2]}}`,
		`{"text":"hello","nested":{"large":9007199254740993,"items":[2,1]}}`,
	} {
		reordered.Input = json.RawMessage(changed)
		if changedDigest, err := commandDigest(reordered); err != nil || changedDigest == firstDigest {
			t.Fatalf("changed input accepted: %v", err)
		}
	}
	ledger, identity := begunLedger(t, "operation")
	original.Type, original.OperationID = protocol.CommandOperationInput, identity.OperationID
	if result, err := ledger.BeginInput(t.Context(), identity, original); err != nil || result.Disposition != BeginInputNew {
		t.Fatalf("first input: %+v, %v", result, err)
	}
	reordered = original
	reordered.Input = json.RawMessage(`{"nested":{"items":[1,2],"large":9007199254740993},"text":"hello"}`)
	if result, err := ledger.BeginInput(t.Context(), identity, reordered); err != nil || result.Disposition != BeginInputPending {
		t.Fatalf("reordered replay: %+v, %v", result, err)
	}
	reordered.Input = json.RawMessage(`{"text":"changed"}`)
	if _, err := ledger.BeginInput(t.Context(), identity, reordered); !errors.Is(err, ErrLedgerIdentityConflict) {
		t.Fatalf("changed replay: %v", err)
	}
}
