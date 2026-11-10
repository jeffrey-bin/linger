// Package process owns command lifetimes and managed child services. Unix
// commands use a dedicated process group; Windows commands join their
// configured job before resuming.
package process

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

type ownership struct {
	mu       sync.Mutex
	resource platformResource
	started  bool
}

// Keys represent launches, not reusable operating-system process numbers.
var launches sync.Map // *exec.Cmd -> *ownership

// Prepare establishes process attributes before Start. It allocates no handles.
func Prepare(cmd *exec.Cmd) { prepareScriptLauncher(cmd); preparePlatform(cmd) }

// Start registers ownership before exec.Cmd can dispatch cancellation. The
// per-launch mutex keeps cancellation from racing Windows job assignment.
func Start(cmd *exec.Cmd) error { return start(cmd, runOptions{}) }

type runOptions struct{ windowed, directChildOnly bool }

func start(cmd *exec.Cmd, options runOptions) error {
	lease := &ownership{}
	lease.mu.Lock()
	if _, exists := launches.LoadOrStore(cmd, lease); exists {
		lease.mu.Unlock()
		return errors.New("command already has process ownership")
	}
	Prepare(cmd)
	err := lease.resource.create(cmd, options)
	if err == nil {
		err = cmd.Start()
	}
	if err == nil {
		err = lease.resource.attach(cmd)
		lease.started = err == nil
	}
	lease.mu.Unlock()
	if err != nil {
		// Wait must run outside the lock: it may wait for a concurrent Cancel.
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}
		Release(cmd)
		return fmt.Errorf("start owned command: %w", err)
	}
	return nil
}

func Signal(cmd *exec.Cmd, signal syscall.Signal) error {
	v, ok := launches.Load(cmd)
	if !ok {
		return os.ErrProcessDone
	}
	lease := v.(*ownership)
	lease.mu.Lock()
	defer lease.mu.Unlock()
	if !lease.started {
		return os.ErrProcessDone
	}
	return lease.resource.signal(signal)
}

// WaitEmpty verifies the owned OS container. It does not infer successful
// cleanup from the leader's exit. Missing ownership is not proof of cleanup.
func WaitEmpty(cmd *exec.Cmd, budget time.Duration) bool {
	deadline := time.NewTimer(max(budget, 0))
	defer deadline.Stop()
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		v, ok := launches.Load(cmd)
		if !ok {
			return false
		}
		lease := v.(*ownership)
		lease.mu.Lock()
		empty, err := lease.resource.empty()
		started := lease.started
		lease.mu.Unlock()
		if !started || err != nil {
			return false
		}
		if empty {
			return true
		}
		select {
		case <-deadline.C:
			return false
		case <-tick.C:
		}
	}
}

// Release drops the launch record and OS handles after the caller has reaped
// the command. Callers requiring cleanup confirmation must use WaitEmpty first.
func Release(cmd *exec.Cmd) {
	if v, ok := launches.LoadAndDelete(cmd); ok {
		lease := v.(*ownership)
		lease.mu.Lock()
		defer lease.mu.Unlock()
		lease.resource.close()
	}
}

// Run handles a bounded helper operation, including descendants holding pipes.
// Longer-lived protocol clients use Start/Signal/WaitEmpty/Release directly.
func Run(ctx context.Context, cmd *exec.Cmd, pipeBudget time.Duration) error {
	return runOwned(ctx, cmd, pipeBudget, runOptions{})
}
func RunWindowed(ctx context.Context, cmd *exec.Cmd, pipeBudget time.Duration) error {
	return runOwned(ctx, cmd, pipeBudget, runOptions{windowed: true})
}
func RunDirectChild(ctx context.Context, cmd *exec.Cmd, pipeBudget time.Duration) error {
	return runOwned(ctx, cmd, pipeBudget, runOptions{directChildOnly: true})
}
func runOwned(ctx context.Context, cmd *exec.Cmd, pipeBudget time.Duration, options runOptions) error {
	if ctx.Err() != nil {
		return context.Cause(ctx)
	}
	cmd.WaitDelay = pipeBudget
	if cmd.WaitDelay <= 0 {
		cmd.WaitDelay = time.Second
	}
	if cmd.Cancel != nil {
		cmd.Cancel = func() error { return Signal(cmd, syscall.SIGKILL) }
	}
	if err := start(cmd, options); err != nil {
		return err
	}
	defer Release(cmd)
	finished := make(chan error, 1)
	go func() { finished <- cmd.Wait() }()
	var result error
	select {
	case result = <-finished:
	case <-ctx.Done():
		_ = Signal(cmd, syscall.SIGTERM)
		grace := time.NewTimer(time.Second)
		select {
		case <-finished:
		case <-grace.C:
			_ = Signal(cmd, syscall.SIGKILL)
			<-finished
		}
		grace.Stop()
		result = context.Cause(ctx)
	}
	stopErr := Signal(cmd, syscall.SIGKILL)
	if !WaitEmpty(cmd, 5*time.Second) {
		return errors.Join(result, stopErr, errors.New("owned command cleanup could not be confirmed"))
	}
	return result
}

func CombinedOutput(ctx context.Context, cmd *exec.Cmd, pipeBudget time.Duration) ([]byte, error) {
	if cmd.Stdout != nil || cmd.Stderr != nil {
		return nil, errors.New("combined output requires unset stdout and stderr")
	}
	var output bytes.Buffer
	cmd.Stdout, cmd.Stderr = &output, &output
	err := Run(ctx, cmd, pipeBudget)
	return output.Bytes(), err
}
