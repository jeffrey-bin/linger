//go:build !windows

package control

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// startOwner runs a process that leads its own session, like the Daemon, and
// records it as the state directory's owner.
func startOwner(t *testing.T, stateDirectory string) (*exec.Cmd, processRecord) {
	t.Helper()
	child := exec.Command("/bin/sh", "-c", "sleep 30 & sleep 30; wait")
	child.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { _ = child.Wait(); close(done) }()
	t.Cleanup(func() {
		_ = syscall.Kill(-child.Process.Pid, syscall.SIGKILL)
		<-done
	})
	var record processRecord
	deadline := time.Now().Add(5 * time.Second)
	for {
		table, err := readProcessTable(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if found, ok := find(table, child.Process.Pid); ok && found.ProcessGroupID == child.Process.Pid {
			record = found
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("owner process did not appear")
		}
		time.Sleep(20 * time.Millisecond)
	}
	return child, record
}

func writeTestOwner(t *testing.T, stateDirectory string, record processRecord) {
	t.Helper()
	owner := Owner{PID: record.PID, ProcessGroupID: record.ProcessGroupID, StartTime: record.StartTime, Nonce: "owner-nonce"}
	if err := writeOwner(filepath.Join(stateDirectory, lockDirectoryName), owner); err != nil {
		t.Fatal(err)
	}
}

func TestStopOwnerTerminatesTheRecordedDaemonGroup(t *testing.T) {
	state := t.TempDir()
	if stopped, err := OwnerStopped(context.Background(), state); err != nil || !stopped {
		t.Fatalf("no owner: stopped=%v err=%v", stopped, err)
	}
	if found, err := StopOwner(context.Background(), state); err != nil || found {
		t.Fatalf("no owner: found=%v err=%v", found, err)
	}
	child, record := startOwner(t, state)
	writeTestOwner(t, state, record)
	if stopped, err := OwnerStopped(context.Background(), state); err != nil || stopped {
		t.Fatalf("live owner: stopped=%v err=%v", stopped, err)
	}
	if found, err := StopOwner(context.Background(), state); err != nil || !found {
		t.Fatalf("stop: found=%v err=%v", found, err)
	}
	if err := syscall.Kill(-child.Process.Pid, 0); err == nil {
		t.Fatal("owner process group survived")
	}
	if stopped, err := OwnerStopped(context.Background(), state); err != nil || !stopped {
		t.Fatalf("after stop: stopped=%v err=%v", stopped, err)
	}
}

func TestStopOwnerNeverSignalsAReusedProcessGeneration(t *testing.T) {
	state := t.TempDir()
	child, record := startOwner(t, state)
	record.StartTime = "another generation"
	writeTestOwner(t, state, record)
	if found, err := StopOwner(context.Background(), state); err != nil || !found {
		t.Fatalf("found=%v err=%v", found, err)
	}
	if err := syscall.Kill(child.Process.Pid, 0); err != nil {
		t.Fatalf("a different process generation was signalled: %v", err)
	}
}

func TestOwnerRecordMustBePrivate(t *testing.T) {
	state := t.TempDir()
	_, record := startOwner(t, state)
	writeTestOwner(t, state, record)
	if err := os.Chmod(filepath.Join(state, lockDirectoryName, ownerFileName), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := OwnerStopped(context.Background(), state); err == nil {
		t.Fatal("a readable owner record was trusted")
	}
}
