package workspace

import (
	"os"
	"path/filepath"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

const envRootLockFile = ".operation_lock"

// LockRuntimeHome takes the exclusive runtime-home lock without blocking. It
// returns os.ErrExist when another holder owns it.
func LockRuntimeHome(dir string) (*os.File, error) {
	file, acquired, err := privatefs.AcquireLock(filepath.Join(dir, ".runtime_lock"))
	if err == nil && !acquired {
		err = os.ErrExist
	}
	return file, err
}

// ReleaseRuntimeHomeLock releases a lock taken by LockRuntimeHome.
func ReleaseRuntimeHomeLock(file *os.File) { privatefs.ReleaseLock(file) }
