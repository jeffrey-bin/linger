//go:build windows

// Package winprocess uses process handles and creation times, never a naked PID,
// for recovery. Holding the verified handle prevents PID reuse races.
package winprocess

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unsafe"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
	"golang.org/x/sys/windows"
)

type Identity struct {
	PID            int    `json:"pid"`
	ProcessGroupID int    `json:"processGroupId"`
	StartTime      string `json:"startTime"`
}

func Inspect(pid int) (*Identity, error) {
	handle, identity, err := open(pid, 0, nil)
	if handle != 0 {
		windows.CloseHandle(handle)
	}
	return identity, err
}

// OpenMatching returns a handle only for the recorded process generation owned
// by this user. A reused or inaccessible PID is not the recorded process.
func OpenMatching(expected Identity, access uint32) (windows.Handle, *Identity, error) {
	if !Valid(expected) {
		return 0, nil, errors.New("invalid Windows process identity")
	}
	return open(expected.PID, access, &expected)
}

func open(pid int, access uint32, expected *Identity) (windows.Handle, *Identity, error) {
	if pid < 1 || uint64(pid) > uint64(^uint32(0)) {
		return 0, nil, errors.New("invalid process identity")
	}
	const queryAccess = windows.PROCESS_QUERY_LIMITED_INFORMATION | windows.SYNCHRONIZE
	handle, err := windows.OpenProcess(queryAccess, false, uint32(pid))
	if errors.Is(err, windows.ERROR_INVALID_PARAMETER) || errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		return 0, nil, nil
	}
	if err != nil {
		return 0, nil, err
	}
	fail := func(err error) (windows.Handle, *Identity, error) { windows.CloseHandle(handle); return 0, nil, err }
	state, err := windows.WaitForSingleObject(handle, 0)
	if err != nil {
		return fail(err)
	}
	if state == windows.WAIT_OBJECT_0 {
		return fail(nil)
	}
	var created, exited, kernel, userTime windows.Filetime
	if err := windows.GetProcessTimes(handle, &created, &exited, &kernel, &userTime); err != nil {
		return fail(err)
	}
	stamp := uint64(created.HighDateTime)<<32 | uint64(created.LowDateTime)
	identity := &Identity{PID: pid, ProcessGroupID: pid, StartTime: "windows:" + strconv.FormatUint(stamp, 10)}
	if expected != nil && *identity != *expected {
		return fail(nil)
	}
	var token windows.Token
	if err := windows.OpenProcessToken(handle, windows.TOKEN_QUERY, &token); err != nil {
		if expected == nil && errors.Is(err, windows.ERROR_ACCESS_DENIED) {
			return fail(nil)
		}
		return fail(err)
	}
	user, err := token.GetTokenUser()
	token.Close()
	if err != nil {
		return fail(err)
	}
	current, err := privatefs.CurrentSID()
	if err != nil {
		return fail(err)
	}
	if !windows.EqualSid(user.User.Sid, current) {
		if expected == nil {
			return fail(nil)
		}
		return fail(errors.New("process is not owned by the current user"))
	}
	if access & ^uint32(queryAccess) != 0 {
		// Keep the query handle until the stronger handle has been checked, so
		// termination never acts on an unchecked PID after the ownership check.
		strong, err := windows.OpenProcess(access|queryAccess, false, uint32(pid))
		if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
			return fail(nil)
		}
		if err != nil {
			return fail(err)
		}
		var actual windows.Filetime
		if err := windows.GetProcessTimes(strong, &actual, &exited, &kernel, &userTime); err != nil {
			windows.CloseHandle(strong)
			return fail(err)
		}
		if actual != created {
			windows.CloseHandle(strong)
			return fail(nil)
		}
		windows.CloseHandle(handle)
		handle = strong
	}
	return handle, identity, nil
}
func Valid(identity Identity) bool {
	if identity.PID < 1 || identity.ProcessGroupID != identity.PID || !strings.HasPrefix(identity.StartTime, "windows:") {
		return false
	}
	stamp, err := strconv.ParseUint(strings.TrimPrefix(identity.StartTime, "windows:"), 10, 64)
	return err == nil && stamp > 0
}
func Terminate(ctx context.Context, expected Identity) error {
	if !Valid(expected) {
		return errors.New("invalid Windows process identity")
	}
	handle, current, err := OpenMatching(expected, windows.PROCESS_TERMINATE)
	if handle != 0 {
		defer windows.CloseHandle(handle)
	}
	if err != nil || current == nil {
		return err
	}
	if err := windows.TerminateProcess(handle, 1); err != nil {
		return err
	}
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	for {
		result, err := windows.WaitForSingleObject(handle, 20)
		if err != nil {
			return err
		}
		if result == windows.WAIT_OBJECT_0 {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return errors.New("process did not exit")
		default:
		}
	}
}

// Resume starts a suspended child only after ownership has been established.
func Resume(pid int) error {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPTHREAD, 0)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ThreadEntry32{Size: uint32(unsafe.Sizeof(windows.ThreadEntry32{}))}
	resumed := 0
	for err = windows.Thread32First(snapshot, &entry); err == nil; err = windows.Thread32Next(snapshot, &entry) {
		if entry.OwnerProcessID != uint32(pid) {
			continue
		}
		thread, e := windows.OpenThread(windows.THREAD_SUSPEND_RESUME, false, entry.ThreadID)
		if e != nil {
			return e
		}
		_, e = windows.ResumeThread(thread)
		windows.CloseHandle(thread)
		if e != nil {
			return e
		}
		resumed++
	}
	if err != nil && !errors.Is(err, windows.ERROR_NO_MORE_FILES) {
		return err
	}
	if resumed == 0 {
		return fmt.Errorf("no initial thread for process %d", pid)
	}
	return nil
}
