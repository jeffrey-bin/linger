//go:build windows

package process

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/winprocess"
	"golang.org/x/sys/windows"
)

type managedSupervisorInput struct {
	Start       ManagedServiceStart `json:"start"`
	Environment map[string]string   `json:"environment"`
	LogPath     string              `json:"log_path"`
}

type managedSupervisorReady struct {
	Identity managedProcessIdentity `json:"identity"`
	Error    string                 `json:"error,omitempty"`
}

// A separate supervisor owns the Job handle. It survives a Daemon restart;
// killing/crashing the supervisor closes the Job and kills all service children.
func startManagedProcess(ctx context.Context, input ManagedServiceStart, environment map[string]string, logPath string) (managedProcessIdentity, error) {
	executable, err := os.Executable()
	if err != nil {
		return managedProcessIdentity{}, err
	}
	encoded, err := json.Marshal(managedSupervisorInput{Start: input, Environment: environment, LogPath: logPath})
	if err != nil {
		return managedProcessIdentity{}, err
	}
	command := exec.Command(executable, "supervise-service")
	command.Stdin = strings.NewReader(string(encoded))
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.DETACHED_PROCESS}
	log, err := privatefs.OpenLog(logPath)
	if err != nil {
		return managedProcessIdentity{}, err
	}
	defer log.Close()
	command.Stderr = log
	stdout, err := command.StdoutPipe()
	if err != nil {
		return managedProcessIdentity{}, err
	}
	if err := command.Start(); err != nil {
		return managedProcessIdentity{}, err
	}
	result := make(chan managedSupervisorReady, 1)
	go func() {
		var ready managedSupervisorReady
		if json.NewDecoder(io.LimitReader(stdout, 8192)).Decode(&ready) != nil {
			ready.Error = "managed service supervisor did not report readiness"
		}
		result <- ready
	}()
	timeout := time.NewTimer(15 * time.Second)
	defer timeout.Stop()
	var ready managedSupervisorReady
	select {
	case ready = <-result:
	case <-ctx.Done():
		ready.Error = "managed service startup cancelled"
	case <-timeout.C:
		ready.Error = "managed service startup timed out"
	}
	_ = stdout.Close()
	if ready.Error != "" {
		_ = command.Process.Kill()
		_ = command.Wait()
		return managedProcessIdentity{}, errors.New(ready.Error)
	}
	identity, err := winprocess.Inspect(command.Process.Pid)
	if err != nil || identity == nil || ready.Identity.PID != identity.PID || ready.Identity.ProcessGroupID != identity.PID || ready.Identity.StartToken != identity.StartTime {
		_ = command.Process.Kill()
		_ = command.Wait()
		return managedProcessIdentity{}, errors.New("managed service supervisor identity changed")
	}
	go func() { _ = command.Wait() }()
	return ready.Identity, nil
}

// SuperviseManagedService is an internal process entry. The request is read from
// stdin so the executable, environment and argv never enter supervisor argv.
func SuperviseManagedService(input io.Reader, output io.Writer) (resultErr error) {
	var request managedSupervisorInput
	decoder := json.NewDecoder(io.LimitReader(input, 1024*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return errors.New("invalid managed supervisor request")
	}
	if err := validateManagedServiceStart(request.Start); err != nil {
		return err
	}
	self, err := winprocess.Inspect(os.Getpid())
	if err != nil || self == nil {
		return errors.New("managed service supervisor identity unavailable")
	}
	identity := managedProcessIdentity{PID: self.PID, ProcessGroupID: self.PID, StartToken: self.StartTime}
	job, err := createServiceJob(identity)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(job)
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		return err
	}
	log, err := privatefs.OpenLog(request.LogPath)
	if err != nil {
		return err
	}
	defer log.Close()
	command := exec.Command(request.Start.Command, request.Start.Args...)
	command.Env = managedEnvironmentList(request.Environment)
	prepareScriptLauncher(command)
	command.Dir = request.Start.Cwd
	command.Stdin = nil
	command.Stdout = log
	command.Stderr = log
	if command.SysProcAttr == nil {
		command.SysProcAttr = &syscall.SysProcAttr{}
	}
	command.SysProcAttr.HideWindow = true
	command.SysProcAttr.CreationFlags |= windows.CREATE_SUSPENDED | windows.CREATE_NEW_CONSOLE
	if err := command.Start(); err != nil {
		return err
	}
	owned := false
	defer func() {
		if !owned {
			_ = command.Process.Kill()
			_ = command.Wait()
		}
	}()
	process, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(command.Process.Pid))
	if err != nil {
		return err
	}
	err = windows.AssignProcessToJobObject(job, process)
	windows.CloseHandle(process)
	if err != nil {
		return err
	}
	if err := winprocess.Resume(command.Process.Pid); err != nil {
		return err
	}
	owned = true
	if err := json.NewEncoder(output).Encode(managedSupervisorReady{Identity: identity}); err != nil {
		_ = windows.TerminateJobObject(job, 1)
		_ = command.Wait()
		return err
	}
	if closer, ok := output.(io.Closer); ok {
		_ = closer.Close()
	}
	// Exit of the root service also reaps any detached descendants.
	_ = command.Wait()
	return windows.TerminateJobObject(job, 0)
}

func serviceJobName(identity managedProcessIdentity) string {
	// Recovery can run in a different login session (for example SSH after a
	// desktop start). The private ACL still restricts the global object.
	return fmt.Sprintf(`Global\LingerComputerService-%d-%s`, identity.PID, strings.TrimPrefix(identity.StartToken, "windows:"))
}

func sameManagedProcess(expected managedProcessIdentity) (bool, error) {
	handle, identity, err := winprocess.OpenMatching(winprocess.Identity{PID: expected.PID, ProcessGroupID: expected.ProcessGroupID, StartTime: expected.StartToken}, 0)
	if handle != 0 {
		defer windows.CloseHandle(handle)
	}
	if err != nil {
		return false, err
	}
	if identity == nil || identity.ProcessGroupID != expected.ProcessGroupID || identity.StartTime != expected.StartToken {
		return false, nil
	}
	job, err := openServiceJob(expected)
	if err != nil {
		return false, err
	}
	windows.CloseHandle(job)
	return true, nil
}

var (
	openJobObject   = windows.NewLazySystemDLL("kernel32.dll").NewProc("OpenJobObjectW")
	createJobObject = windows.NewLazySystemDLL("kernel32.dll").NewProc("CreateJobObjectW")
)

func createServiceJob(identity managedProcessIdentity) (windows.Handle, error) {
	name, err := windows.UTF16PtrFromString(serviceJobName(identity))
	if err != nil {
		return 0, err
	}
	descriptor, err := privatefs.SecurityDescriptor()
	if err != nil {
		return 0, err
	}
	attrs := &windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: descriptor}
	value, _, callErr := createJobObject.Call(uintptr(unsafe.Pointer(attrs)), uintptr(unsafe.Pointer(name)))
	if value == 0 {
		return 0, callErr
	}
	// The normal wrapper discards ERROR_ALREADY_EXISTS on a valid handle.
	// Never adopt an object whose security descriptor was chosen elsewhere.
	if errors.Is(callErr, windows.ERROR_ALREADY_EXISTS) {
		windows.CloseHandle(windows.Handle(value))
		return 0, errors.New("managed service Job already exists")
	}
	return windows.Handle(value), nil
}

func openServiceJob(identity managedProcessIdentity) (windows.Handle, error) {
	if !winprocess.Valid(winprocess.Identity{PID: identity.PID, ProcessGroupID: identity.ProcessGroupID, StartTime: identity.StartToken}) {
		return 0, errors.New("invalid managed service process identity")
	}
	name, err := windows.UTF16PtrFromString(serviceJobName(identity))
	if err != nil {
		return 0, err
	}
	value, _, callErr := openJobObject.Call(uintptr(0x0008|0x0004), 0, uintptr(unsafe.Pointer(name)))
	if value == 0 {
		return 0, fmt.Errorf("open owned service Job: %w", callErr)
	}
	return windows.Handle(value), nil
}
func terminateManagedProcess(ctx context.Context, expected managedProcessIdentity) error {
	// Keep the supervisor handle open throughout Job lookup and termination.
	handle, current, err := winprocess.OpenMatching(winprocess.Identity{PID: expected.PID, ProcessGroupID: expected.ProcessGroupID, StartTime: expected.StartToken}, windows.PROCESS_TERMINATE)
	if handle != 0 {
		defer windows.CloseHandle(handle)
	}
	if err != nil || current == nil {
		return err
	}
	if current.ProcessGroupID != expected.ProcessGroupID || current.StartTime != expected.StartToken {
		return errors.New("managed service process generation changed")
	}
	job, err := openServiceJob(expected)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(job)
	if err := windows.TerminateJobObject(job, 1); err != nil {
		return err
	}
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	for {
		state, err := windows.WaitForSingleObject(handle, 20)
		if err != nil {
			return err
		}
		if state == windows.WAIT_OBJECT_0 {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return errors.New("managed service supervisor did not exit")
		default:
		}
	}
}
