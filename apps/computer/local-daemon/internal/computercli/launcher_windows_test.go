//go:build windows

package computercli

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
	"time"
	"unsafe"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/winprocess"
	"golang.org/x/sys/windows"
)

const (
	detachedJobHelperKey = "LINGER_TEST_DETACHED_JOB_HELPER"
	detachedJobReadyKey  = "LINGER_TEST_DETACHED_JOB_READY"
)

func TestDetachedDaemonSurvivesSessionJobClose(t *testing.T) {
	runDetachedJobHelper(t)
	session := startInSessionJob(t, windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|windows.JOB_OBJECT_LIMIT_BREAKAWAY_OK)
	session.closeJob(t)
	if state, err := windows.WaitForSingleObject(session.child, 1000); err != nil || state != uint32(windows.WAIT_TIMEOUT) {
		t.Fatalf("daemon ended with its session Job: state=%d err=%v", state, err)
	}
}

func TestDetachedDaemonStartsInsideJobWithoutBreakaway(t *testing.T) {
	runDetachedJobHelper(t)
	session := startInSessionJob(t, windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
	session.closeJob(t)
	if state, err := windows.WaitForSingleObject(session.child, 10_000); err != nil || state != windows.WAIT_OBJECT_0 {
		t.Fatalf("daemon outlived the Job its owner kept it in: state=%d err=%v", state, err)
	}
}

// runDetachedJobHelper plays the session process or its daemon when the test
// binary was started as a helper, and never returns in that case.
func runDetachedJobHelper(t *testing.T) {
	mode := os.Getenv(detachedJobHelperKey)
	if mode == "" {
		return
	}
	if mode == "parent" {
		child, err := startDetached(func() *exec.Cmd {
			command := exec.Command(os.Args[0], "-test.run=^"+t.Name()+"$")
			command.Env = append(os.Environ(), detachedJobHelperKey+"=child")
			return command
		})
		if err != nil {
			_ = os.WriteFile(os.Getenv(detachedJobReadyKey), []byte(err.Error()), 0o600)
			t.Fatal(err)
		}
		if err := os.WriteFile(os.Getenv(detachedJobReadyKey), []byte(strconv.Itoa(child.Process.Pid)), 0o600); err != nil {
			_ = child.Process.Kill()
			t.Fatal(err)
		}
	}
	for {
		time.Sleep(time.Hour)
	}
}

// sessionJob is a session helper in its own Job and the daemon it started
// detached.
type sessionJob struct {
	job    windows.Handle
	parent *exec.Cmd
	child  windows.Handle
}

// startInSessionJob runs a session helper inside a new Job with limitFlags.
func startInSessionJob(t *testing.T, limitFlags uint32) *sessionJob {
	t.Helper()
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	session := &sessionJob{job: job}
	t.Cleanup(func() {
		if session.job != 0 {
			_ = windows.CloseHandle(session.job)
		}
	})
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = limitFlags
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		t.Fatal(err)
	}
	ready := filepath.Join(t.TempDir(), "child-pid")
	parent := exec.Command(os.Args[0], "-test.run=^"+t.Name()+"$")
	parent.Env = append(os.Environ(), detachedJobHelperKey+"=parent", detachedJobReadyKey+"="+ready)
	// Establish an owned session Job before the helper can spawn its daemon.
	parent.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_SUSPENDED | windows.CREATE_BREAKAWAY_FROM_JOB | windows.CREATE_NO_WINDOW}
	if err := parent.Start(); err != nil {
		t.Fatal(err)
	}
	session.parent = parent
	t.Cleanup(func() { _ = parent.Process.Kill(); _ = parent.Wait() })
	handle, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(parent.Process.Pid))
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(handle)
	if err := windows.AssignProcessToJobObject(job, handle); err != nil {
		t.Fatal(err)
	}
	if err := winprocess.Resume(parent.Process.Pid); err != nil {
		t.Fatal(err)
	}
	var pid int
	for deadline := time.Now().Add(30 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		if data, err := os.ReadFile(ready); err == nil && len(data) > 0 {
			pid, err = strconv.Atoi(string(data))
			if err != nil {
				t.Fatalf("helper failed: %s", data)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("session helper did not report its child")
		}
	}
	child, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_TERMINATE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		t.Fatal(err)
	}
	session.child = child
	t.Cleanup(func() { _ = windows.TerminateProcess(child, 0); _ = windows.CloseHandle(child) })
	return session
}

// closeJob closes the last Job handle and waits for the session helper, which
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE ends.
func (s *sessionJob) closeJob(t *testing.T) {
	t.Helper()
	job := s.job
	s.job = 0
	if err := windows.CloseHandle(job); err != nil {
		t.Fatal(err)
	}
	// Windows may report exit code zero for JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
	// The indefinitely waiting helper exiting is the evidence, not its code.
	_ = s.parent.Wait()
}
