package process

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// The test binary is the child executable on every platform; no shell or live
// model participates. The grandchild deliberately keeps inherited pipes open.
func TestOwnedChildFixture(t *testing.T) {
	mode := os.Getenv("LINGER_OWNERSHIP_FIXTURE")
	if mode == "" {
		return
	}
	switch mode {
	case "echo":
		_, _ = fmt.Fprint(os.Stdout, "fixture stdout")
		fmt.Fprint(os.Stderr, "fixture stderr")
		os.Exit(7)
	case "wait":
		time.Sleep(time.Hour)
	case "tree", "orphan":
		child := exec.Command(os.Args[0], "-test.run=^TestOwnedChildFixture$")
		child.Env = append(os.Environ(), "LINGER_OWNERSHIP_FIXTURE=wait")
		child.Stdout, child.Stderr = os.Stdout, os.Stderr
		if err := child.Start(); err != nil {
			os.Exit(8)
		}
		if err := os.WriteFile(os.Getenv("LINGER_OWNERSHIP_READY"), []byte(fmt.Sprint(child.Process.Pid)), 0600); err != nil {
			os.Exit(9)
		}
		if mode == "orphan" {
			os.Exit(0)
		}
		_, _ = io.Copy(io.Discard, os.Stdin)
	}
	os.Exit(0)
}

func fixture(t *testing.T, mode string) *exec.Cmd {
	t.Helper()
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(binary, "-test.run=^TestOwnedChildFixture$")
	cmd.Env = append(os.Environ(), "LINGER_OWNERSHIP_FIXTURE="+mode)
	return cmd
}

func TestOwnedOutputAndExitEvidence(t *testing.T) {
	output, err := CombinedOutput(t.Context(), fixture(t, "echo"), time.Second)
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 7 || !bytes.Contains(output, []byte("stdout")) || !bytes.Contains(output, []byte("stderr")) {
		t.Fatalf("combined=%q error=%v", output, err)
	}
}

func TestOwnedTreeCancellationAndInheritedPipes(t *testing.T) {
	for _, mode := range []string{"tree", "orphan"} {
		t.Run(mode, func(t *testing.T) {
			cmd := fixture(t, mode)
			marker := filepath.Join(t.TempDir(), "ready")
			cmd.Env = append(cmd.Env, "LINGER_OWNERSHIP_READY="+marker)
			stdin, err := cmd.StdinPipe()
			if err != nil {
				t.Fatal(err)
			}
			defer stdin.Close()
			var output bytes.Buffer
			cmd.Stdout, cmd.Stderr = &output, &output
			ctx, cancel := context.WithCancelCause(t.Context())
			defer cancel(context.Canceled)
			done := make(chan error, 1)
			go func() { done <- Run(ctx, cmd, 100*time.Millisecond) }()
			deadline := time.Now().Add(15 * time.Second)
			for {
				if _, err := os.Stat(marker); err == nil {
					break
				}
				select {
				case err := <-done:
					t.Fatalf("exited before ready: %v", err)
				default:
				}
				if time.Now().After(deadline) {
					t.Fatal("fixture failed to signal readiness")
				}
				time.Sleep(10 * time.Millisecond)
			}
			cause := errors.New("fixture cancellation")
			if mode == "tree" {
				cancel(cause)
			}
			select {
			case err := <-done:
				if mode == "tree" && !errors.Is(err, cause) {
					t.Fatalf("lost cancellation cause: %v", err)
				}
				if mode == "orphan" && err != nil && !errors.Is(err, exec.ErrWaitDelay) {
					t.Fatal(err)
				}
			case <-time.After(15 * time.Second):
				t.Fatal("owned descendants kept helper alive")
			}
			if _, ok := launches.Load(cmd); ok {
				t.Fatal("ownership record leaked")
			}
			// Releasing ownership must not make a subsequent cleanup check succeed.
			if WaitEmpty(cmd, 0) {
				t.Fatal("unowned command reported as verified")
			}
		})
	}
}

func TestOwnedStartFailureAndPreCancelledContext(t *testing.T) {
	cmd := exec.Command(filepath.Join(t.TempDir(), "absent"))
	if err := Start(cmd); err == nil {
		t.Fatal("missing executable started")
	}
	if _, ok := launches.Load(cmd); ok {
		t.Fatal("failed launch retained ownership")
	}
	if err := Signal(cmd, syscall.SIGKILL); !errors.Is(err, os.ErrProcessDone) {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	cmd = fixture(t, "echo")
	if err := Run(ctx, cmd, time.Second); !errors.Is(err, context.Canceled) || cmd.Process != nil {
		t.Fatalf("pre-cancelled launch: %v", err)
	}
}

func TestOwnedCancellationDuringStart(t *testing.T) {
	for i := 0; i < 16; i++ {
		ctx, cancel := context.WithCancel(t.Context())
		base := fixture(t, "wait")
		cmd := exec.CommandContext(ctx, base.Path, base.Args[1:]...)
		cmd.Env = base.Env
		cmd.Cancel = func() error { return Signal(cmd, syscall.SIGKILL) }
		started := make(chan error, 1)
		go func() { started <- Start(cmd) }()
		cancel()
		if err := <-started; err != nil {
			if !strings.Contains(err.Error(), "context canceled") {
				t.Fatal(err)
			}
			continue
		}
		_ = cmd.Wait()
		if !WaitEmpty(cmd, time.Second) {
			t.Fatal("cancel raced ownership")
		}
		Release(cmd)
	}
}
