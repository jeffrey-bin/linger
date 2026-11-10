package native

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"os/exec"
	"syscall"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/process"
)

const (
	defaultPipeBudget = 2 * time.Second
	helperStderrTail  = 32 << 10
)

// ownedCommand is the package's only construction of operating-system
// children. The child runs inv.Program with Leading then args, in exactly
// inv.Env, prepared for process-tree ownership. Cancelling ctx kills the
// whole owned tree. Long-lived processes pass a context that outlives the
// Operation and drive the tree with the process-tree lifecycle.
func ownedCommand(ctx context.Context, inv Invocation, args ...string) *exec.Cmd {
	if ctx == nil {
		ctx = context.Background()
	}
	cmd := exec.CommandContext(ctx, inv.Program, inv.Args(args...)...)
	if inv.Env != nil {
		cmd.Env = append([]string{}, inv.Env...)
	}
	cmd.Cancel = func() error { return process.Signal(cmd, syscall.SIGKILL) }
	process.Prepare(cmd)
	return cmd
}

func pipeBudget(cmd *exec.Cmd) time.Duration {
	if cmd.WaitDelay > 0 {
		return cmd.WaitDelay
	}
	return defaultPipeBudget
}

// runOutput runs a bounded helper and returns its whole stdout. Unless the
// caller assigned stderr, a 32 KiB stderr tail is attached to an exit error.
func runOutput(ctx context.Context, cmd *exec.Cmd) ([]byte, error) {
	if cmd.Stdout != nil {
		return nil, errors.New("helper output requires unassigned stdout")
	}
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	var tail *errorTail
	if cmd.Stderr == nil {
		tail = newErrorTail(nil, helperStderrTail)
		cmd.Stderr = tail
	}
	err := process.Run(ctx, cmd, pipeBudget(cmd))
	var exitErr *exec.ExitError
	if tail != nil && errors.As(err, &exitErr) {
		exitErr.Stderr = tail.raw()
	}
	return stdout.Bytes(), err
}

// runCombined runs a bounded helper with stdout and stderr in one buffer.
func runCombined(ctx context.Context, cmd *exec.Cmd) ([]byte, error) {
	if cmd.Stdout != nil || cmd.Stderr != nil {
		return nil, errors.New("combined helper output requires unassigned stdout and stderr")
	}
	var output bytes.Buffer
	cmd.Stdout, cmd.Stderr = &output, &output
	err := process.Run(ctx, cmd, pipeBudget(cmd))
	return output.Bytes(), err
}

// logRuntimeLaunch records a long-lived provider launch without any argv
// token: wrapper values, flags and prompt text never reach the log.
func logRuntimeLaunch(logger *slog.Logger, kind, protocol string, cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	if logger == nil {
		logger = slog.Default()
	}
	logger.Info("runtime launch", "provider", kind, "protocol", protocol, "exec", cmd.Path, "arg_count", max(len(cmd.Args)-1, 0))
}
