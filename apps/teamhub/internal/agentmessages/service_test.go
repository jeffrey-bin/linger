package agentmessages

import (
	"errors"
	"testing"
	"time"
)

func TestHistoryCursorPreservesPagingPositionAndRejectsMalformedRequests(t *testing.T) {
	message := Message{MessageID: "message_history", CreatedAt: time.Date(2026, 10, 10, 8, 0, 1, 123456000, time.UTC)}
	params, err := readParams(Reader{TenantID: "tenant", ActorID: "actor"}, encodeCursor(message), 1)
	if err != nil || params.CursorID != message.MessageID || !params.CursorTime.Time.Equal(message.CreatedAt) || params.PageLimit != 2 {
		t.Fatalf("page position changed: %+v err=%v", params, err)
	}
	for _, input := range []struct {
		cursor string
		limit  int
	}{
		{"not-a-cursor", 1}, {"", -1}, {"", 101},
	} {
		if _, err := readParams(Reader{}, input.cursor, input.limit); !errors.Is(err, ErrInvalid) {
			t.Fatalf("invalid page accepted: %+v err=%v", input, err)
		}
	}
}
