package agentsendmessage

import (
	"testing"
	"time"
)

func TestPresentationPauseDurations(t *testing.T) {
	if got := pauseDuration(PresentationPauseNone); got != 0 {
		t.Fatalf("none duration = %v, want 0", got)
	}
	if got := pauseDuration(PresentationPauseBrief); got != time.Second {
		t.Fatalf("brief duration = %v, want 1s", got)
	}
	if got := pauseDuration(PresentationPauseNatural); got != 1500*time.Millisecond {
		t.Fatalf("natural duration = %v, want 1.5s", got)
	}
}

func TestHashItemsTracksMessageSourceAndContent(t *testing.T) {
	items := []PresentationItem{{Content: "first", PauseBefore: PresentationPauseNone}, {Content: "second", PauseBefore: PresentationPauseBrief}}
	base := string(hashItems("room_1", "", items))
	if base == string(hashItems("room_1", "message_source", items)) {
		t.Fatal("business source must be part of idempotency")
	}
	items[1].Content = "changed"
	if base == string(hashItems("room_1", "", items)) {
		t.Fatal("message content must change request hash")
	}
}
