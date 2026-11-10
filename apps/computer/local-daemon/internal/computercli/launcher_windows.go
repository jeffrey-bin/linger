//go:build windows

package computercli

import (
	"context"
	"errors"
	"os/exec"
	"syscall"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/winprocess"
	"golang.org/x/sys/windows"
)

// startDetached starts the command built by build without a console. A
// detached console still inherits the SSH session's Job, so it also leaves
// that Job when the Job allows breakaway, and a session close does not kill an
// already connected Daemon. A failed Start leaves the Cmd unusable, so the
// fallback starts a freshly built one.
func startDetached(build func() *exec.Cmd) (*exec.Cmd, error) {
	flags := uint32(windows.CREATE_NEW_PROCESS_GROUP | windows.DETACHED_PROCESS)
	child := build()
	child.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: flags | windows.CREATE_BREAKAWAY_FROM_JOB}
	err := child.Start()
	if !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		return child, err
	}
	// A Job without breakaway rights refuses the flag with access denied. Its
	// owner chose to keep descendants inside, so the Daemon stays in it.
	child = build()
	child.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: flags}
	return child, child.Start()
}

func inspectChild(pid int) any {
	identity, err := winprocess.Inspect(pid)
	if err != nil || identity == nil {
		return nil
	}
	return *identity
}

func processExists(pid int) bool {
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return !errors.Is(err, windows.ERROR_INVALID_PARAMETER)
	}
	defer windows.CloseHandle(handle)
	state, err := windows.WaitForSingleObject(handle, 0)
	return err != nil || state != windows.WAIT_OBJECT_0
}

// terminateSpawnedDaemon stops a Daemon this command started but that never
// became ready. A recorded identity never targets a reused PID.
func terminateSpawnedDaemon(child *exec.Cmd, identity any, done <-chan struct{}) error {
	select {
	case <-done:
		return nil
	default:
	}
	if recorded, ok := identity.(winprocess.Identity); ok {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return winprocess.Terminate(ctx, recorded)
	}
	if err := child.Process.Kill(); err != nil {
		return newError(categoryDaemonLifecycle, "Failed daemon process could not be stopped")
	}
	select {
	case <-done:
		return nil
	case <-time.After(2 * time.Second):
		return newError(categoryDaemonLifecycle, "Failed daemon process did not terminate")
	}
}
