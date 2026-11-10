//go:build windows

package native

import "golang.org/x/sys/windows"

// piProcessGone reports whether pid no longer names a running process.
func piProcessGone(pid int) bool {
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return true
	}
	defer windows.CloseHandle(handle)
	event, err := windows.WaitForSingleObject(handle, 0)
	return err == nil && event == windows.WAIT_OBJECT_0
}
