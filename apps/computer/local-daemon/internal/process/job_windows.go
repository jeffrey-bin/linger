//go:build windows

package process

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
	"unsafe"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/winprocess"
	"golang.org/x/sys/windows"
)

// platformResource is the launch's job plus a SYNCHRONIZE handle to every
// member it has seen. A job's active count drops when a process starts to
// exit, before its teardown finishes, so emptiness also waits for each seen
// member's process object to be signalled.
type platformResource struct {
	handle  windows.Handle
	members map[uint32]windows.Handle
}
type jobAccounting struct {
	User, Kernel, PeriodUser, PeriodKernel int64
	PageFaults, Total, Active, Terminated  uint32
}

func HideWindow(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = new(syscall.SysProcAttr)
	}
	cmd.SysProcAttr.HideWindow = true
	cmd.SysProcAttr.CreationFlags |= windows.CREATE_NEW_CONSOLE
}
func preparePlatform(cmd *exec.Cmd) { HideWindow(cmd) }
func (r *platformResource) create(cmd *exec.Cmd, options runOptions) error {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return err
	}
	r.handle = job
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if options.directChildOnly {
		limits.BasicLimitInformation.LimitFlags |= windows.JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK
	}
	if options.windowed {
		cmd.SysProcAttr.HideWindow = false
		cmd.SysProcAttr.CreationFlags &^= windows.CREATE_NEW_CONSOLE
	}
	_, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits)))
	cmd.SysProcAttr.CreationFlags |= windows.CREATE_SUSPENDED
	return err
}
func (r *platformResource) attach(cmd *exec.Cmd) error {
	process, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
	if err != nil {
		return err
	}
	defer windows.CloseHandle(process)
	if err := windows.AssignProcessToJobObject(r.handle, process); err != nil {
		return err
	}
	return winprocess.Resume(cmd.Process.Pid)
}
func (r *platformResource) signal(syscall.Signal) error {
	if r.handle == 0 {
		return os.ErrProcessDone
	}
	// empty also records current members, so a terminated process stays
	// observable after it leaves the job's active count.
	if empty, err := r.empty(); err == nil && empty {
		return nil
	}
	return windows.TerminateJobObject(r.handle, 1)
}
func (r *platformResource) empty() (bool, error) {
	if r.handle == 0 {
		return false, os.ErrProcessDone
	}
	r.track()
	var accounting jobAccounting
	err := windows.QueryInformationJobObject(r.handle, windows.JobObjectBasicAccountingInformation, uintptr(unsafe.Pointer(&accounting)), uint32(unsafe.Sizeof(accounting)), nil)
	if err != nil || accounting.Active != 0 {
		return false, err
	}
	for pid, process := range r.members {
		if event, err := windows.WaitForSingleObject(process, 0); err != nil || event != windows.WAIT_OBJECT_0 {
			return false, err
		}
		_ = windows.CloseHandle(process)
		delete(r.members, pid)
	}
	return true, nil
}

// track opens a SYNCHRONIZE handle to each job member not yet seen. A member
// that cannot be opened has already gone.
func (r *platformResource) track() {
	for _, pid := range r.memberIDs() {
		if _, seen := r.members[pid]; seen {
			continue
		}
		process, err := windows.OpenProcess(windows.SYNCHRONIZE, false, pid)
		if err != nil {
			continue
		}
		if r.members == nil {
			r.members = map[uint32]windows.Handle{}
		}
		r.members[pid] = process
	}
}

// memberIDs lists the job's current process ids (JOBOBJECT_BASIC_PROCESS_ID_LIST).
func (r *platformResource) memberIDs() []uint32 {
	const header = 8
	word := unsafe.Sizeof(uintptr(0))
	capacity := 16
	for {
		buffer := make([]uintptr, (header+uintptr(capacity)*word+word-1)/word)
		err := windows.QueryInformationJobObject(r.handle, windows.JobObjectBasicProcessIdList, uintptr(unsafe.Pointer(&buffer[0])), uint32(uintptr(len(buffer))*word), nil)
		assigned := *(*uint32)(unsafe.Pointer(&buffer[0]))
		listed := *(*uint32)(unsafe.Add(unsafe.Pointer(&buffer[0]), 4))
		if errors.Is(err, windows.ERROR_MORE_DATA) || (err == nil && listed < assigned) {
			capacity = int(assigned) + 16
			continue
		}
		if err != nil {
			return nil
		}
		ids := make([]uint32, 0, listed)
		for i := range uintptr(listed) {
			ids = append(ids, uint32(*(*uintptr)(unsafe.Add(unsafe.Pointer(&buffer[0]), header+i*word))))
		}
		return ids
	}
}
func (r *platformResource) close() {
	for pid, process := range r.members {
		_ = windows.CloseHandle(process)
		delete(r.members, pid)
	}
	if r.handle != 0 {
		windows.CloseHandle(r.handle)
		r.handle = 0
	}
}
func ExitSignal(*os.ProcessState) string { return "" }
