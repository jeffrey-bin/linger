//go:build darwin || linux

package privatefs

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"

	"golang.org/x/sys/unix"
)

func TestPublishFallbackPreservesOneCompleteIdentity(t *testing.T) {
	for _, unsupported := range []error{unix.ENOSYS, unix.EINVAL, unix.ENOTSUP} {
		t.Run(unsupported.Error(), func(t *testing.T) {
			root := t.TempDir()
			destination := filepath.Join(root, "identity")
			const count = 12
			results := make([]error, count)
			var group sync.WaitGroup
			start := make(chan struct{})
			for i := range results {
				source := filepath.Join(root, fmt.Sprintf("temp-%d", i))
				if err := os.WriteFile(source, bytes.Repeat([]byte{byte(i)}, 1024), 0o600); err != nil {
					t.Fatal(err)
				}
				group.Add(1)
				go func() {
					defer group.Done()
					<-start
					results[i] = publishWithFallback(source, destination, unsupported)
				}()
			}
			close(start)
			group.Wait()
			winner := -1
			for i, err := range results {
				if err == nil {
					if winner != -1 {
						t.Fatal("more than one publisher succeeded")
					}
					winner = i
				} else if !errors.Is(err, os.ErrExist) {
					t.Fatal(err)
				}
			}
			data, err := ReadFile(destination, 2048)
			if winner < 0 || err != nil || !bytes.Equal(data, bytes.Repeat([]byte{byte(winner)}, 1024)) {
				t.Fatalf("winner=%d data=%x err=%v", winner, data, err)
			}
		})
	}
}

func TestPublishFallbackLockRecoversAfterProcessExit(t *testing.T) {
	const childDirectory = "LINGER_TEST_PRIVATEFS_LOCK_DIR"
	if root := os.Getenv(childDirectory); root != "" {
		file, err := openWrite(filepath.Join(root, ".linger-privatefs-publish.lock"), false)
		if err != nil {
			t.Fatal(err)
		}
		if err := unix.Flock(int(file.Fd()), unix.LOCK_EX); err != nil {
			t.Fatal(err)
		}
		os.Exit(0) // Deliberately do not unlock or close the file.
	}
	root := t.TempDir()
	child := exec.Command(os.Args[0], "-test.run=^TestPublishFallbackLockRecoversAfterProcessExit$")
	child.Env = append(os.Environ(), childDirectory+"="+root)
	if output, err := child.CombinedOutput(); err != nil {
		t.Fatalf("lock holder: %v: %s", err, output)
	}
	source, destination := filepath.Join(root, "temp"), filepath.Join(root, "identity")
	if err := os.WriteFile(source, []byte("complete"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := publishWithFallback(source, destination, unix.ENOTSUP); err != nil {
		t.Fatal(err)
	}
	if data, err := ReadFile(destination, 20); err != nil || string(data) != "complete" {
		t.Fatalf("data=%q err=%v", data, err)
	}
}

func TestPublishFallbackDoesNotHideOtherErrors(t *testing.T) {
	root := t.TempDir()
	source, destination := filepath.Join(root, "temp"), filepath.Join(root, "identity")
	if err := os.WriteFile(source, []byte("complete"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := publishWithFallback(source, destination, unix.EACCES); !errors.Is(err, unix.EACCES) {
		t.Fatalf("permission error=%v", err)
	}
	if _, err := os.Lstat(destination); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unexpected destination: %v", err)
	}
}
