package proactive

import (
	"testing"
	"time"
	_ "time/tzdata"
)

// Existing fixtures use Shanghai wall times regardless of the test host.
func init() {
	var err error
	time.Local, err = time.LoadLocation("Asia/Shanghai")
	if err != nil {
		panic(err)
	}
}

func TestDayAndQuietHoursFollowDeploymentZone(t *testing.T) {
	previous := time.Local
	time.Local = time.FixedZone("west", -7*60*60)
	t.Cleanup(func() { time.Local = previous })
	instant := time.Date(2026, 10, 21, 5, 0, 0, 0, time.UTC)
	if got := Day(instant).Format(time.DateOnly); got != "2026-10-20" {
		t.Fatalf("day = %s", got)
	}
	if !quietHour(instant) {
		t.Fatal("22:00 local should be quiet")
	}
}
