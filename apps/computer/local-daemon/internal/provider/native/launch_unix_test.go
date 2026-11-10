//go:build !windows

package native

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func shellInvocation(script string) Invocation {
	return NewInvocation("/bin/sh", []string{"-c", script}).WithEnvironment(map[string]string{"PATH": "/usr/bin:/bin"})
}

func TestHelperOutputAndCombinedModes(t *testing.T) {
	ctx := context.Background()
	stdout, err := runOutput(ctx, ownedCommand(ctx, shellInvocation("printf stdout; printf stderr >&2; exit 7")))
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) || exitErr.ExitCode() != 7 || string(exitErr.Stderr) != "stderr" {
		t.Fatalf("error = %#v", err)
	}
	if string(stdout) != "stdout" {
		t.Fatalf("stdout = %q", stdout)
	}
	combined, err := runCombined(ctx, ownedCommand(ctx, shellInvocation("printf first; printf second >&2")))
	if err != nil || string(combined) != "firstsecond" {
		t.Fatalf("combined = %q, %v", combined, err)
	}
}

func TestHelperCancellationKillsWholeTree(t *testing.T) {
	receipt := filepath.Join(t.TempDir(), "pids")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := runOutput(ctx, ownedCommand(ctx, shellInvocation(`sleep 40 & echo "$$ $!" > `+receipt+`; wait`)))
		done <- err
	}()
	pids := waitForPIDs(t, receipt, 2)
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancelled run succeeded")
		}
	case <-time.After(8 * time.Second):
		t.Fatal("cancelled run did not return")
	}
	waitGone(t, pids, 5*time.Second)
}

func waitForPIDs(t *testing.T, path string, count int) []int {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(path)
		fields := strings.Fields(string(data))
		if err == nil && len(fields) == count && strings.HasSuffix(string(data), "\n") {
			pids := make([]int, 0, count)
			for _, field := range fields {
				pid, err := strconv.Atoi(field)
				if err != nil {
					t.Fatal(err)
				}
				pids = append(pids, pid)
			}
			return pids
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no PID receipt at %s", path)
	return nil
}

func waitGone(t *testing.T, pids []int, budget time.Duration) {
	t.Helper()
	deadline := time.Now().Add(budget)
	for _, pid := range pids {
		for syscall.Kill(pid, 0) == nil || errors.Is(syscall.Kill(pid, 0), syscall.EPERM) {
			if time.Now().After(deadline) {
				t.Fatalf("process %d survived", pid)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
}

func TestProcessExitDiagnostics(t *testing.T) {
	ctx := context.Background()
	for script, want := range map[string]RuntimeFailureDiagnostics{
		"exit 3":        {ExitCode: intPointer(3)},
		"kill -SEGV $$": {Signal: "SIGSEGV"},
	} {
		_, err := runOutput(ctx, ownedCommand(ctx, shellInvocation(script)))
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) {
			t.Fatalf("%s: error = %v", script, err)
		}
		got := processExitDiagnostics(exitErr.ProcessState)
		if got.Signal != want.Signal || (want.ExitCode == nil) != (got.ExitCode == nil) || (want.ExitCode != nil && *got.ExitCode != *want.ExitCode) || got.Code != "" || got.StatusCode != nil {
			t.Fatalf("%s: diagnostics = %+v", script, got)
		}
	}
	if !processExitDiagnostics(nil).empty() {
		t.Fatal("nil state must give no diagnostics")
	}
}
