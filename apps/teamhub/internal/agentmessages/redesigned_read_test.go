package agentmessages

import (
	"errors"
	"testing"
)

func TestReadRejectsMixedModesDuplicateIDsAndModeSpecificPaging(t *testing.T) {
	for _, input := range []ReadInput{
		{}, {InboxID: "room:room_one", ThreadID: "thread_one"}, {MessageIDs: []string{"one", "one"}}, {MessageIDs: []string{"one"}, Limit: 1}, {ListInboxes: true, Cursor: "cursor"}, {MessageIDs: []string{}}, {ThreadID: "bad/id"},
	} {
		if err := validateReadInput(input); !errors.Is(err, ErrInvalid) {
			t.Fatalf("accepted invalid input %+v: %v", input, err)
		}
	}
	for _, input := range []ReadInput{{InboxID: "room:room_one"}, {ThreadID: "thread_one"}, {MessageIDs: []string{"message_b", "message_a"}}, {ListInboxes: true}} {
		if err := validateReadInput(input); err != nil {
			t.Fatalf("rejected valid input %+v: %v", input, err)
		}
	}
}
func TestReadBatchOrderCoversEveryRequestedIDWithoutExistenceHints(t *testing.T) {
	requested := []string{"message_b", "message_missing", "message_a"}
	got, unavailable := orderReadMessages(requested, []Message{{MessageID: "message_a"}, {MessageID: "message_b"}})
	if len(got) != 2 || got[0].MessageID != "message_b" || got[1].MessageID != "message_a" || len(unavailable) != 1 || unavailable[0] != "message_missing" {
		t.Fatalf("order/coverage changed: %+v %+v", got, unavailable)
	}
}
