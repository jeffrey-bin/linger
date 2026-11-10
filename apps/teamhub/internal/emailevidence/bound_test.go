package emailevidence

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestBoundMessageInputsJSONPreservesValidEnvelopes(t *testing.T) {
	raw, err := json.Marshal([]MessageInput{
		{ThreadID: "thread-1", MessageID: "first", Direction: DirectionOutbound, Body: strings.Repeat("€", 100)},
		{ThreadID: "thread-1", MessageID: "second", Direction: DirectionInbound, Body: strings.Repeat("content", 100)},
	})
	if err != nil {
		t.Fatal(err)
	}
	bounded, err := BoundMessageInputsJSON(raw, 640)
	if err != nil {
		t.Fatal(err)
	}
	if len(bounded) > 640 || !json.Valid(bounded) {
		t.Fatalf("invalid bounded document len=%d raw=%s", len(bounded), bounded)
	}
	var inputs []MessageInput
	if err = json.Unmarshal(bounded, &inputs); err != nil {
		t.Fatal(err)
	}
	if len(inputs) != 2 || inputs[0].MessageID != "first" || inputs[1].MessageID != "second" || !utf8.ValidString(inputs[0].Body) {
		t.Fatalf("message envelope changed: %+v", inputs)
	}
}

func TestBoundMessageInputsJSONRejectsMetadataLargerThanLimit(t *testing.T) {
	raw, err := json.Marshal([]MessageInput{{ThreadID: strings.Repeat("thread", 20), MessageID: "message", Direction: DirectionOutbound, Body: "body"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = BoundMessageInputsJSON(raw, 32); err == nil {
		t.Fatal("expected metadata limit error")
	}
}
