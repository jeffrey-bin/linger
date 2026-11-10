package agentruntimestate

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestRuntimeStatusReasonBoundsProviderErrors(t *testing.T) {
	for _, reason := range []string{"", "process_interrupted", strings.Repeat("€✓", 700), strings.Repeat("x", 2000)} {
		got := boundedRuntimeStatusReason(reason)
		if !utf8.ValidString(got) || utf8.RuneCountInString(got) > 1000 || !strings.HasPrefix(reason, got) {
			t.Fatalf("invalid bounded reason")
		}
		if utf8.RuneCountInString(reason) <= 1000 && got != reason {
			t.Fatal("changed short reason")
		}
		if boundedRuntimeStatusReason(got) != got {
			t.Fatal("unstable replay")
		}
	}
}
