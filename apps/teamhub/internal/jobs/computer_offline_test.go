package jobs

import (
	"testing"
	"time"
)

func TestComputerOfflineWaitExpiresAfterTheLimit(t *testing.T) {
	now := time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)
	if ComputerOfflineWaitExpired(now.Add(-ComputerOfflineWaitLimit+time.Second), now) {
		t.Fatal("expired before the limit")
	}
	if !ComputerOfflineWaitExpired(now.Add(-ComputerOfflineWaitLimit), now) {
		t.Fatal("not expired at the limit")
	}
	if ComputerOfflineWaitExpired(time.Time{}, now) {
		t.Fatal("an unknown start must not expire")
	}
}
