//go:build !windows

package process

import (
	"errors"
	"os"
	"strings"
	"syscall"
	"testing"
)

func TestInspectLinuxManagedProcessReadFailures(t *testing.T) {
	for _, test := range []struct {
		name  string
		cause error
		gone  bool
	}{
		{"missing", syscall.ENOENT, true},
		{"exited_during_read", syscall.ESRCH, true},
		{"permission_denied", syscall.EPERM, false},
		{"read_failure", syscall.EIO, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			readErr := &os.PathError{Op: "read", Path: "/proc/123/stat", Err: test.cause}
			identity, err := inspectLinuxManagedProcess(123, func(path string) ([]byte, error) {
				if path != readErr.Path {
					t.Fatalf("path = %q", path)
				}
				return nil, readErr
			})
			if identity != nil {
				t.Fatalf("identity = %+v", identity)
			}
			if test.gone && err != nil {
				t.Fatalf("exited process remained an error: %v", err)
			}
			if !test.gone && !errors.Is(err, test.cause) {
				t.Fatalf("error = %v, want %v", err, test.cause)
			}
		})
	}
}

func TestInspectLinuxManagedProcessRetainsIdentity(t *testing.T) {
	fields := strings.Fields("S 1 123 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 456")
	identity, err := inspectLinuxManagedProcess(123, func(string) ([]byte, error) {
		return []byte("123 (worker (child)) " + strings.Join(fields, " ")), nil
	})
	want := managedProcessIdentity{PID: 123, ProcessGroupID: 123, StartToken: "linux:456"}
	if err != nil || identity == nil || *identity != want {
		t.Fatalf("identity = %+v, error = %v", identity, err)
	}
}
