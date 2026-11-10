//go:build unix

package selfupdate

import (
	"errors"
	"os/exec"
	"syscall"
)

// interruptInstallerGroup runs the installer in its own process group so the
// interrupt also reaches its foreground child; bash runs the trap only after
// that child exits. Stage resends SIGINT every second for interruptGrace so a
// signal that lands while bash is spawning that child is not the last attempt.
func interruptInstallerGroup(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	command.Cancel = func() error { return signalInstallerGroup(command, syscall.SIGINT) }
}

// killInstallerGroup kills what is left of a canceled installer's group after
// the grace period.
func killInstallerGroup(command *exec.Cmd) {
	_ = signalInstallerGroup(command, syscall.SIGKILL)
}

func signalInstallerGroup(command *exec.Cmd, signal syscall.Signal) error {
	err := syscall.Kill(-command.Process.Pid, signal)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}
