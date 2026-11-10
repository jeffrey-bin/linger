//go:build windows

package selfupdate

import (
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

// startInstaller starts the installer outside the daemon's console and, when
// the daemon runs in a job that allows it, outside that job, so stopping the
// daemon does not end the installer.
func startInstaller(build func() *exec.Cmd) (*exec.Cmd, error) {
	flags := uint32(windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_NO_WINDOW)
	command := build()
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: flags | windows.CREATE_BREAKAWAY_FROM_JOB}
	if err := command.Start(); err == nil {
		return command, nil
	}
	// A job without breakaway rights refuses the flag; such a job is not
	// killed with the daemon either.
	command = build()
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: flags}
	return command, command.Start()
}
