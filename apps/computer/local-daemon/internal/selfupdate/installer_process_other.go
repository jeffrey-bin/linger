//go:build !windows

package selfupdate

import "os/exec"

// startInstaller starts the Windows installer; other platforms run it only
// in tests.
func startInstaller(build func() *exec.Cmd) (*exec.Cmd, error) {
	command := build()
	return command, command.Start()
}
