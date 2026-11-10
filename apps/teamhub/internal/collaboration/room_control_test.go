package collaboration

import (
	"slices"
	"testing"
)

func TestSubtractRoomIDs(t *testing.T) {
	if got := subtractRoomIDs(nil, []string{"a"}); got == nil || len(got) != 0 {
		t.Fatalf("nil ids = %v", got)
	}
	if got := subtractRoomIDs([]string{"a", "b"}, nil); !slices.Equal(got, []string{"a", "b"}) {
		t.Fatalf("no exclude = %v", got)
	}
	if got := subtractRoomIDs([]string{"a", "b", "c"}, []string{"b"}); !slices.Equal(got, []string{"a", "c"}) {
		t.Fatalf("subtract = %v", got)
	}
}
