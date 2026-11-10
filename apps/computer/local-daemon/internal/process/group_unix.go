//go:build !windows

package process

import (
	"errors"
	"os"
	"os/exec"
	"syscall"

	"golang.org/x/sys/unix"
)

type platformResource struct{ group int }

func preparePlatform(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = new(syscall.SysProcAttr)
	}
	cmd.SysProcAttr.Setpgid = true
}
func (*platformResource) create(*exec.Cmd, runOptions) error { return nil }
func (r *platformResource) attach(cmd *exec.Cmd) error       { r.group = cmd.Process.Pid; return nil }
func (r *platformResource) signal(sig syscall.Signal) error {
	if r.group <= 0 {
		return os.ErrProcessDone
	}
	err := syscall.Kill(-r.group, sig)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}
func (r *platformResource) empty() (bool, error) {
	if r.group <= 0 {
		return false, os.ErrProcessDone
	}
	err := syscall.Kill(-r.group, 0)
	if errors.Is(err, syscall.ESRCH) {
		return true, nil
	}
	// EPERM is evidence that a process still exists, including the brief
	// Darwin exit/reap window. Keep observing within the cleanup budget.
	if errors.Is(err, syscall.EPERM) {
		return false, nil
	}
	return false, err
}
func (*platformResource) close() {}
func HideWindow(*exec.Cmd)       {}
func ExitSignal(state *os.ProcessState) string {
	if state == nil {
		return ""
	}
	if status, ok := state.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		return unix.SignalName(status.Signal())
	}
	return ""
}
