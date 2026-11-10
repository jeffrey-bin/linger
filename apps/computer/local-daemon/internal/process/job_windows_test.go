//go:build windows

package process

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestHiddenConsoleAndJobAreEstablishedBeforeExecution(t *testing.T) {
	cmd := fixture(t, "wait")
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_UNICODE_ENVIRONMENT}
	Prepare(cmd)
	if !cmd.SysProcAttr.HideWindow || cmd.SysProcAttr.CreationFlags&windows.CREATE_NEW_CONSOLE == 0 || cmd.SysProcAttr.CreationFlags&windows.CREATE_UNICODE_ENVIRONMENT == 0 {
		t.Fatal("console configuration lost")
	}
	if err := Start(cmd); err != nil {
		t.Fatal(err)
	}
	defer Release(cmd)
	if WaitEmpty(cmd, 0) {
		t.Fatal("running child missing from job")
	}
	if err := Signal(cmd, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Wait(); err == nil {
		t.Fatal("killed child succeeded")
	}
	if !WaitEmpty(cmd, 3*time.Second) {
		t.Fatal("job termination unconfirmed")
	}
}

func TestUnstartedWindowsCommandIsNotOwned(t *testing.T) {
	cmd := exec.Command("not-started")
	if WaitEmpty(cmd, 0) {
		t.Fatal("unstarted command reported empty job")
	}
}

// Job accounting drops a process as soon as it starts to exit; a confirmed
// empty job must also mean every descendant's process object is signalled.
func TestEmptyJobWaitsForDescendantTeardown(t *testing.T) {
	cmd := fixture(t, "tree")
	marker := filepath.Join(t.TempDir(), "ready")
	cmd.Env = append(cmd.Env, "LINGER_OWNERSHIP_READY="+marker)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()
	if err := Start(cmd); err != nil {
		t.Fatal(err)
	}
	defer Release(cmd)
	var pid int
	for deadline := time.Now().Add(15 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		if data, err := os.ReadFile(marker); err == nil {
			pid, err = strconv.Atoi(string(data))
			if err != nil {
				t.Fatal(err)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("fixture failed to signal readiness")
		}
	}
	grandchild, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(grandchild)
	if err := Signal(cmd, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Wait() }()
	if !WaitEmpty(cmd, 3*time.Second) {
		t.Fatal("job termination unconfirmed")
	}
	if event, err := windows.WaitForSingleObject(grandchild, 0); err != nil || event != windows.WAIT_OBJECT_0 {
		t.Fatalf("grandchild %d still running after confirmed cleanup", pid)
	}
}
