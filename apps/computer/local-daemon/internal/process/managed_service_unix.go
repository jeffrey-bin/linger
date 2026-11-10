//go:build !windows

package process

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func startManagedProcess(ctx context.Context, input ManagedServiceStart, environment map[string]string, logPath string) (managedProcessIdentity, error) {
	if err := ctx.Err(); err != nil {
		return managedProcessIdentity{}, context.Cause(ctx)
	}
	log, err := os.OpenFile(logPath, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return managedProcessIdentity{}, err
	}
	defer log.Close()
	command := exec.Command(input.Command, input.Args...)
	command.Dir = input.Cwd
	command.Env = managedEnvironmentList(environment)
	command.Stdin = nil
	command.Stdout = log
	command.Stderr = log
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := command.Start(); err != nil {
		return managedProcessIdentity{}, err
	}
	pid := command.Process.Pid
	identity, err := inspectManagedProcess(pid)
	if err != nil || identity == nil || identity.ProcessGroupID != pid {
		_ = syscall.Kill(-pid, syscall.SIGKILL)
		_ = command.Process.Kill()
		_, _ = command.Process.Wait()
		return managedProcessIdentity{}, errors.New("managed service did not own its process group")
	}
	go func() { _ = command.Wait() }()
	return *identity, nil
}

func sameManagedProcess(expected managedProcessIdentity) (bool, error) {
	current, err := inspectManagedProcess(expected.PID)
	if err != nil {
		return false, err
	}
	return current != nil && *current == expected, nil
}

func terminateManagedProcess(ctx context.Context, identity managedProcessIdentity) error {
	live, err := sameManagedProcess(identity)
	if err != nil || !live {
		return err
	}
	if err := syscall.Kill(-identity.ProcessGroupID, syscall.SIGTERM); err != nil && !errors.Is(err, syscall.ESRCH) {
		return fmt.Errorf("signal managed service process group with TERM: %w", err)
	}
	if waitManagedGroup(ctx, identity.ProcessGroupID, 5*time.Second) {
		return nil
	}
	if err := syscall.Kill(-identity.ProcessGroupID, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
		return fmt.Errorf("signal managed service process group with KILL: %w", err)
	}
	if !waitManagedGroup(ctx, identity.ProcessGroupID, 2*time.Second) {
		return errors.New("managed service process group did not exit")
	}
	return nil
}

func waitManagedGroup(ctx context.Context, processGroupID int, timeout time.Duration) bool {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		if err := syscall.Kill(-processGroupID, 0); errors.Is(err, syscall.ESRCH) {
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-deadline.C:
			return false
		case <-ticker.C:
		}
	}
}

func inspectManagedProcess(pid int) (*managedProcessIdentity, error) {
	if runtime.GOOS == "linux" {
		return inspectLinuxManagedProcess(pid, os.ReadFile)
	}
	command := exec.Command("/bin/ps", "-o", "pgid=", "-o", "lstart=", "-p", strconv.Itoa(pid))
	output, err := command.Output()
	if exitErr := (*exec.ExitError)(nil); errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	fields := strings.Fields(strings.TrimSpace(string(output)))
	if len(fields) < 2 {
		return nil, errors.New("managed service process identity is incomplete")
	}
	group, err := strconv.Atoi(fields[0])
	if err != nil {
		return nil, err
	}
	return &managedProcessIdentity{PID: pid, ProcessGroupID: group, StartToken: "darwin:" + strings.Join(fields[1:], " ")}, nil
}

func inspectLinuxManagedProcess(pid int, readFile func(string) ([]byte, error)) (*managedProcessIdentity, error) {
	data, err := readFile(fmt.Sprintf("/proc/%d/stat", pid))
	if errors.Is(err, os.ErrNotExist) || errors.Is(err, syscall.ESRCH) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	end := strings.LastIndexByte(string(data), ')')
	if end < 0 {
		return nil, errors.New("managed service process stat is invalid")
	}
	fields := strings.Fields(string(data)[end+1:])
	if len(fields) <= 19 {
		return nil, errors.New("managed service process stat is incomplete")
	}
	group, err := strconv.Atoi(fields[2])
	if err != nil {
		return nil, err
	}
	return &managedProcessIdentity{PID: pid, ProcessGroupID: group, StartToken: "linux:" + fields[19]}, nil
}
