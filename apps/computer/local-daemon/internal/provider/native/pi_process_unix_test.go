//go:build !windows

package native

import "syscall"

// piProcessGone reports whether pid no longer names a live process.
func piProcessGone(pid int) bool {
	return syscall.Kill(pid, 0) == syscall.ESRCH
}
