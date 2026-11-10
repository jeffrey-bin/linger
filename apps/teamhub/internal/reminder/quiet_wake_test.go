package reminder

import (
	"errors"
	"testing"
)

func TestEventWakeRequiresGrant(t *testing.T) {
	err := EnqueueTx(t.Context(), nil, Wake{Source: SourceEvent, TenantID: "tenant", RoomID: "room", Body: "event"})
	if !errors.Is(err, ErrGrantRevoked) {
		t.Fatalf("unscoped event wake enqueued: %v", err)
	}
}
