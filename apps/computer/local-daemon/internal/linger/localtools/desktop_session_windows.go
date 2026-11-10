package localtools

import (
	"errors"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	wtsapi32                     = windows.NewLazySystemDLL("wtsapi32.dll")
	procWTSQuerySessionInfo      = wtsapi32.NewProc("WTSQuerySessionInformationW")
	user32                       = windows.NewLazySystemDLL("user32.dll")
	procOpenInputDesktop         = user32.NewProc("OpenInputDesktop")
	procCloseDesktop             = user32.NewProc("CloseDesktop")
	procGetUserObjectInformation = user32.NewProc("GetUserObjectInformationW")
)

// interactiveSession rejects session 0, where services and SSH logons run
// without a visible desktop. Cua there exits instead of driving the user.
func interactiveSession() error {
	var session uint32
	if err := windows.ProcessIdToSessionId(windows.GetCurrentProcessId(), &session); err != nil {
		return err
	}
	if session == 0 {
		return errors.New("COMPUTER_SESSION_NONINTERACTIVE: the Computer runs outside a signed-in Windows desktop (session 0); start it from the signed-in user's desktop")
	}
	return nil
}

// desktopReady reports the lock screen and secure desktops (UAC, Ctrl+Alt+Del).
// Input is never sent there and the Computer never elevates to reach them.
// The Windows 10+ lock screen runs on the Default desktop, so the session's
// lock flag decides it; the input desktop name catches secure desktops.
func desktopReady() error {
	const wtsCurrentSession, wtsSessionInfoEx, wtsSessionStateLock = 0xFFFFFFFF, 25, 0
	var info *[5]uint32
	var size uint32
	if ok, _, _ := procWTSQuerySessionInfo.Call(0, wtsCurrentSession, wtsSessionInfoEx, uintptr(unsafe.Pointer(&info)), uintptr(unsafe.Pointer(&size))); ok != 0 {
		// WTSINFOEXW: Level, then an 8-byte aligned union of SessionId,
		// SessionState, and SessionFlags.
		locked := size >= 20 && info[0] == 1 && info[4] == wtsSessionStateLock
		windows.WTSFreeMemory(uintptr(unsafe.Pointer(info)))
		if locked {
			return errDesktopLocked
		}
	}
	const desktopReadObjects, uoiName = 0x0001, 2
	handle, _, _ := procOpenInputDesktop.Call(0, 0, desktopReadObjects)
	if handle == 0 {
		return errDesktopLocked
	}
	defer procCloseDesktop.Call(handle)
	var name [64]uint16
	var needed uint32
	ok, _, _ := procGetUserObjectInformation.Call(handle, uoiName, uintptr(unsafe.Pointer(&name[0])), uintptr(len(name)*2), uintptr(unsafe.Pointer(&needed)))
	if ok == 0 || windows.UTF16ToString(name[:]) != "Default" {
		return errDesktopLocked
	}
	return nil
}

var errDesktopLocked = errors.New("COMPUTER_DESKTOP_LOCKED: Windows shows the lock screen or a secure desktop; ask the user to unlock it, then retry. No input was sent")
