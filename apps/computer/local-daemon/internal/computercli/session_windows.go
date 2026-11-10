//go:build windows

package computercli

import (
	"errors"
	"unsafe"

	"golang.org/x/sys/windows"
)

// checkUserSession refuses an elevated terminal: the Daemon must run as the
// ordinary user whose Computer it serves.
func checkUserSession() error {
	elevated, err := elevatedSession()
	if err != nil {
		return err
	}
	if elevated {
		return newError(categoryConfiguration, "Windows login, daemon start, and daemon restart require a non-elevated terminal. Open ordinary PowerShell or Command Prompt and retry.")
	}
	return nil
}

// elevatedSession reports whether this process runs with an elevated token.
func elevatedSession() (bool, error) {
	var elevated, length uint32
	err := windows.GetTokenInformation(windows.GetCurrentProcessToken(), windows.TokenElevation, (*byte)(unsafe.Pointer(&elevated)), uint32(unsafe.Sizeof(elevated)), &length) //nolint:gosec // TokenElevation fills one fixed-size DWORD
	if err != nil {
		return false, err
	}
	if length != uint32(unsafe.Sizeof(elevated)) {
		return false, errors.New("invalid process token elevation information")
	}
	return elevated != 0, nil
}
