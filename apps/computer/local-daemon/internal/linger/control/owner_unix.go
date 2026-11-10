//go:build !windows

package control

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// OwnerStopped reports whether the Daemon recorded for stateDirectory is gone.
// Any process with its PID, or any member of its process group, counts as alive.
func OwnerStopped(ctx context.Context, stateDirectory string) (bool, error) {
	owner, err := readOwner(filepath.Join(stateDirectory, lockDirectoryName))
	if errors.Is(err, os.ErrNotExist) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	table, err := readProcessTable(ctx)
	if err != nil {
		return false, err
	}
	for _, record := range table {
		if record.PID == owner.PID && !record.terminal() {
			return false, nil
		}
	}
	return !groupExists(owner.ProcessGroupID), nil
}

// StopOwner terminates the recorded Daemon generation, its descendants and its
// process group. It reports whether an ownership record existed.
func StopOwner(ctx context.Context, stateDirectory string) (bool, error) {
	owner, err := readOwner(filepath.Join(stateDirectory, lockDirectoryName))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	expected := processRecord{PID: owner.PID, ProcessGroupID: owner.ProcessGroupID, StartTime: owner.StartTime}
	return true, terminateProcessGroup(ctx, expected, 10*time.Second, 2*time.Second)
}

func groupExists(group int) bool {
	err := syscall.Kill(-group, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

type trackedGroup struct {
	expected  processRecord
	processes map[int]processRecord
}

// terminateProcessGroup never signals a reused PID or a process group whose
// live leader is a different generation.
func terminateProcessGroup(ctx context.Context, expected processRecord, grace, force time.Duration) error {
	table, err := readProcessTable(ctx)
	if err != nil {
		return err
	}
	root, rootFound := find(table, expected.PID)
	if rootFound && !root.same(expected) {
		return nil
	}
	if rootFound && root.ProcessGroupID != root.PID {
		return fmt.Errorf("Computer daemon process %d does not own its process group", root.PID)
	}
	group := ownedGroup(table, expected)
	if !rootFound && len(group) == 0 {
		return nil
	}
	tracked := trackedGroup{expected: expected, processes: map[int]processRecord{}}
	tracked.add(table, group)
	if stopped, err := tracked.stopWithin(ctx, syscall.SIGTERM, grace); stopped || err != nil {
		return err
	}
	stopped, err := tracked.stopWithin(ctx, syscall.SIGKILL, force)
	if err == nil && !stopped {
		err = fmt.Errorf("Computer daemon process %d did not exit after SIGKILL", expected.PID)
	}
	return err
}

func (t *trackedGroup) add(table []processRecord, group []processRecord) {
	if root, ok := find(table, t.expected.PID); ok && root.same(t.expected) {
		pending := []int{root.PID}
		t.processes[root.PID] = root
		for len(pending) > 0 {
			parent := pending[len(pending)-1]
			pending = pending[:len(pending)-1]
			for _, record := range table {
				if record.ParentPID == parent && !record.terminal() {
					if _, seen := t.processes[record.PID]; !seen {
						t.processes[record.PID] = record
						pending = append(pending, record.PID)
					}
				}
			}
		}
	}
	for _, record := range group {
		t.processes[record.PID] = record
	}
}

func (t *trackedGroup) stopWithin(ctx context.Context, signal syscall.Signal, budget time.Duration) (bool, error) {
	deadline := time.Now().Add(budget)
	for {
		table, err := readProcessTable(ctx)
		if err != nil {
			return false, err
		}
		group := ownedGroup(table, t.expected)
		t.add(table, group)
		live := make([]processRecord, 0, len(t.processes))
		for _, tracked := range t.processes {
			if current, ok := find(table, tracked.PID); ok && current.same(tracked) && !current.terminal() {
				live = append(live, current)
			}
		}
		if len(group) == 0 && len(live) == 0 {
			return true, nil
		}
		signalled := map[int]bool{}
		for _, member := range group {
			if member.same(t.expected) {
				sendSignal(-t.expected.ProcessGroupID, signal)
				signalled[t.expected.ProcessGroupID] = true
				break
			}
		}
		for _, process := range live {
			if process.PID == process.ProcessGroupID && !signalled[process.ProcessGroupID] {
				sendSignal(-process.ProcessGroupID, signal)
				signalled[process.ProcessGroupID] = true
			}
		}
		for _, process := range live {
			if !signalled[process.ProcessGroupID] {
				sendSignal(process.PID, signal)
			}
		}
		if !time.Now().Before(deadline) {
			return false, nil
		}
		select {
		case <-ctx.Done():
			return false, ctx.Err()
		case <-time.After(min(25*time.Millisecond, time.Until(deadline))):
		}
	}
}

// ownedGroup returns the live members of the expected process group, or none
// when a different generation now leads it.
func ownedGroup(table []processRecord, expected processRecord) []processRecord {
	var members []processRecord
	for _, record := range table {
		if record.ProcessGroupID == expected.ProcessGroupID && !record.terminal() {
			if record.PID == expected.ProcessGroupID && !record.same(expected) {
				return nil
			}
			members = append(members, record)
		}
	}
	return members
}

func find(table []processRecord, pid int) (processRecord, bool) {
	for _, record := range table {
		if record.PID == pid {
			return record, true
		}
	}
	return processRecord{}, false
}

func sendSignal(pid int, signal syscall.Signal) {
	_ = syscall.Kill(pid, signal)
}
