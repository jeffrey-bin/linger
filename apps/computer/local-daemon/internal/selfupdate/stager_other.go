//go:build !unix

package selfupdate

import (
	"os"
	"os/exec"
)

// Windows has no process groups to signal and does not self-update; the
// interrupt goes to the installer process only.
func interruptInstallerGroup(command *exec.Cmd) {
	command.Cancel = func() error { return command.Process.Signal(os.Interrupt) }
}

func killInstallerGroup(*exec.Cmd) {}
