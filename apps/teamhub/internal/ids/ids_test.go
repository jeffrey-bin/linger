package ids

import (
	"regexp"
	"testing"
)

func TestNewFormatAndUniqueness(t *testing.T) {
	pattern := regexp.MustCompile(`^room_[0-9a-f]{32}$`)
	first, second := New("room"), New("room")
	if !pattern.MatchString(first) || !pattern.MatchString(second) {
		t.Fatalf("ids=%q,%q want room_<32 hex>", first, second)
	}
	if first == second {
		t.Fatalf("ids must be unique, got %q twice", first)
	}
}
