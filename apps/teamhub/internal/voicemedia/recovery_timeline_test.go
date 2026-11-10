package voicemedia

import (
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func TestRecoveryTimelineKeepsSpliceSidesAndCommandOrder(t *testing.T) {
	ranges := []store.CaptureMediaRange{
		{Kind: "media", StartOffsetMs: 0, EndOffsetMs: 1000},
		{Kind: "gap", StartOffsetMs: 1000, EndOffsetMs: 2000},
		{Kind: "media", StartOffsetMs: 2000, EndOffsetMs: 3000},
		{Kind: "gap", StartOffsetMs: 3000, EndOffsetMs: 4000},
	}
	const origin = 5000
	for _, test := range []struct {
		name   string
		offset int64
		start  bool
		want   int64
	}{
		{"initial start", 0, true, 5000},
		{"pre-gap end", 1000, false, 6000},
		{"post-gap start", 1000, true, 7000},
		{"post-gap end", 1200, false, 7200},
		{"final end before tail gap", 2000, false, 8000},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := recoveryWallOffset(ranges, origin, test.offset, test.start); got != test.want {
				t.Fatalf("wall offset=%d want=%d", got, test.want)
			}
		})
	}
	// A COMMIT accepted at 6500 during the gap must precede the next sentence,
	// so the archive's post-gap speech cannot become part of the submitted task.
	if nextStart := recoveryWallOffset(ranges, origin, 1000, true); nextStart <= 6500 {
		t.Fatalf("post-gap speech moved before accepted COMMIT: %d", nextStart)
	}
}
