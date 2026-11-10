//go:build !windows

package computercli

import (
	"errors"
	"os/exec"
	"syscall"
	"time"
)

// startDetached starts the command built by build in its own session.
func startDetached(build func() *exec.Cmd) (*exec.Cmd, error) {
	child := build()
	child.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	return child, child.Start()
}

func inspectChild(int) any { return nil }

func processExists(pid int) bool {
	return !errors.Is(syscall.Kill(pid, 0), syscall.ESRCH)
}

// terminateSpawnedDaemon stops a Daemon this command started but that never
// became ready, with its whole session's process group.
func terminateSpawnedDaemon(child *exec.Cmd, _ any, done <-chan struct{}) error {
	select {
	case <-done:
		return nil
	default:
	}
	group := child.Process.Pid
	_ = syscall.Kill(-group, syscall.SIGTERM)
	if groupExitsWithin(group, 2*time.Second) {
		return nil
	}
	_ = syscall.Kill(-group, syscall.SIGKILL)
	if groupExitsWithin(group, 2*time.Second) {
		return nil
	}
	return newError(categoryDaemonLifecycle, "Failed daemon process tree did not terminate")
}

func groupExists(group int) bool {
	err := syscall.Kill(-group, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

func groupExitsWithin(group int, budget time.Duration) bool {
	deadline := time.Now().Add(budget)
	for groupExists(group) {
		if !time.Now().Before(deadline) {
			return false
		}
		time.Sleep(25 * time.Millisecond)
	}
	return true
}
