package localtools

import (
	"bytes"
	"errors"
	"os/exec"
)

// macOS reports missing permissions through Cua, but not the lock screen:
// while it shows, every window reads as an empty, degraded tree and every
// input is refused, so the Agent would keep trying other routes.
func interactiveSession() error { return nil }

// screenLocked reads the console session's lock flag, as loginwindow sets it.
var screenLocked = func() bool {
	output, err := exec.Command("/usr/sbin/ioreg", "-n", "Root", "-d1", "-k", "IOConsoleUsers").Output()
	return err == nil && bytes.Contains(output, []byte(`"CGSSessionScreenIsLocked"=Yes`))
}

func desktopReady() error {
	if screenLocked() {
		return errDesktopLocked
	}
	return nil
}

var errDesktopLocked = errors.New("COMPUTER_DESKTOP_LOCKED: the Mac shows the lock screen, so no window can be read or used. Tell the user and stop until they unlock it; do not try other routes. No input was sent")
