//go:build windows

package control

import (
	"context"
	"errors"
	"os"
	"path/filepath"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/winprocess"
	"golang.org/x/sys/windows"
)

// OwnerStopped reports whether the Daemon generation recorded for
// stateDirectory has exited. A missing record means no Daemon owns it.
func OwnerStopped(_ context.Context, stateDirectory string) (bool, error) {
	_, live, err := liveOwner(stateDirectory)
	if errors.Is(err, os.ErrNotExist) {
		return true, nil
	}
	return !live, err
}

// StopOwner terminates the recorded Daemon generation and reports whether it
// was still running.
func StopOwner(ctx context.Context, stateDirectory string) (bool, error) {
	owner, live, err := liveOwner(stateDirectory)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil || !live {
		return false, err
	}
	return true, winprocess.Terminate(ctx, owner.Identity)
}

func liveOwner(stateDirectory string) (controlOwner, bool, error) {
	if !filepath.IsAbs(stateDirectory) {
		return controlOwner{}, false, errors.New("state directory must be absolute")
	}
	if err := privatefs.CheckPath(stateDirectory, "directory", true); err != nil {
		return controlOwner{}, false, err
	}
	owner, err := readControlOwner(stateDirectory)
	if err != nil {
		return controlOwner{}, false, err
	}
	handle, identity, err := winprocess.OpenMatching(owner.Identity, 0)
	if handle != 0 {
		defer windows.CloseHandle(handle)
	}
	if err != nil {
		return controlOwner{}, false, err
	}
	return owner, identity != nil && *identity == owner.Identity, nil
}
