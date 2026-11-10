package localtools

import (
	"errors"
	"testing"
)

// The tests drive fake Cua services, so the real lock screen must not refuse
// their calls.
func init() { screenLocked = func() bool { return false } }

func TestDesktopReadyRefusesTheMacLockScreen(t *testing.T) {
	previous := screenLocked
	t.Cleanup(func() { screenLocked = previous })
	screenLocked = func() bool { return true }
	if err := desktopReady(); !errors.Is(err, errDesktopLocked) {
		t.Fatalf("desktopReady() = %v, want the lock screen error", err)
	}
	screenLocked = func() bool { return false }
	if err := desktopReady(); err != nil {
		t.Fatalf("desktopReady() = %v on an unlocked screen", err)
	}
}
