package native

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestPiCatalogPreservesContextCauseAfterChildCleanup(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX shell")
	}
	for _, kind := range []string{"deadline", "cancel"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			program := filepath.Join(root, "pi")
			pidFile := filepath.Join(root, "pid")
			if err := os.WriteFile(program, []byte("#!/bin/sh\necho $$ > \"$HOME/pid\"\nexec /bin/sleep 60\n"), 0700); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancelCause(t.Context())
			defer cancel(nil)
			bounded, stop := context.WithTimeout(ctx, time.Second)
			defer stop()
			done := make(chan error, 1)
			go func() {
				_, err := DiscoverPiModels(bounded, NewInvocation(program, nil).WithEnvironment(map[string]string{"HOME": root}))
				done <- err
			}()
			var encoded []byte
			deadline := time.Now().Add(3 * time.Second)
			for time.Now().Before(deadline) {
				if data, err := os.ReadFile(pidFile); err == nil {
					encoded = data
					break
				}
				time.Sleep(time.Millisecond * 5)
			}
			if len(encoded) == 0 {
				t.Fatal("catalog child did not start")
			}
			want := context.DeadlineExceeded
			if kind == "cancel" {
				want = context.Canceled
				cancel(errors.New("secret-cancel-cause"))
			}
			err := <-done
			if !errors.Is(err, want) || strings.Contains(err.Error(), "secret") {
				t.Fatalf("context cause lost or disclosed: %v", err)
			}
			pid, err := strconv.Atoi(strings.TrimSpace(string(encoded)))
			if err != nil {
				t.Fatal(err)
			}
			child, err := os.FindProcess(pid)
			if err != nil {
				t.Fatal(err)
			}
			defer child.Release()
			if child.Signal(syscall.Signal(0)) == nil {
				t.Fatal("catalog child survived cancellation")
			}
		})
	}
}

func TestPiCatalogMasksNonContextFailure(t *testing.T) {
	inv := fixtureInvocation(t, "print", map[string]string{"FIXTURE_STDOUT": "secret-output", "FIXTURE_EXIT": "1"})
	_, err := DiscoverPiModels(t.Context(), inv)
	if !errors.Is(err, errPiNoModels) || strings.Contains(err.Error(), "secret") {
		t.Fatalf("unsafe catalog failure: %v", err)
	}
}
