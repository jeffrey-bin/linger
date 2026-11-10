package app

import (
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/voice"
)

func TestPocketNoteDayTurnsOverAtLocalMidnight(t *testing.T) {
	lastSecond := time.Date(2026, 10, 1, 23, 59, 59, 0, time.Local)
	cases := []struct {
		now  time.Time
		want string
	}{
		{lastSecond, "2026-10-01"},
		{lastSecond.Add(time.Second), "2026-10-02"},
		// The same instant written from another zone keeps the local day.
		{lastSecond.Add(time.Second).In(time.FixedZone("PDT", -7*3600)), "2026-10-02"},
	}
	for _, tc := range cases {
		if got := voice.PocketNoteDay(tc.now).Format(voice.PocketNoteDateLayout); got != tc.want {
			t.Errorf("voice.PocketNoteDay(%s) = %s, want %s", tc.now, got, tc.want)
		}
	}
}
