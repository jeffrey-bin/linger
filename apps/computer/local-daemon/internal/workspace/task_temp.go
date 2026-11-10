package workspace

import (
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

// TaskTempDirPrefix names every Operation temp directory. The sweep only
// considers directories carrying it.
const TaskTempDirPrefix = "linger-operation-"

// taskTempClaimFile exists only while LockTaskTempDir is publishing ownership.
const taskTempClaimFile = ".operation_claim"

// LockTaskTempDir publishes a held lock inside a freshly created Operation
// temp directory. The directory becomes sweepable only once the published
// marker is locked, and exclusive claim creation keeps a second owner out.
func LockTaskTempDir(dir string) (*os.File, error) {
	claim := filepath.Join(dir, taskTempClaimFile)
	marker := filepath.Join(dir, envRootLockFile)
	file, err := privatefs.OpenLock(claim, true)
	if err != nil {
		return nil, err
	}
	fail := func(err error) (*os.File, error) {
		privatefs.ReleaseLock(file)
		_ = os.Remove(claim)
		return nil, err
	}
	if _, err := os.Lstat(marker); err == nil {
		return fail(fmt.Errorf("operation temp directory is already owned: %w", os.ErrExist))
	} else if !errors.Is(err, fs.ErrNotExist) {
		return fail(err)
	}
	acquired, err := privatefs.TryLock(file)
	if err != nil {
		return fail(err)
	}
	if !acquired {
		return fail(fmt.Errorf("operation temp claim is held elsewhere: %w", os.ErrExist))
	}
	if err := os.Rename(claim, marker); err != nil {
		return fail(err)
	}
	return file, nil
}

// ReleaseTaskTempLock drops ownership; the directory may be swept afterwards.
func ReleaseTaskTempLock(file *os.File) { privatefs.ReleaseLock(file) }

// RemoveTaskTempDir deletes the directory while keeping the marker until the
// very end, so a partial failure stays recognizable to a later sweep.
func RemoveTaskTempDir(dir string) error {
	info, err := os.Lstat(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return errors.New("operation temp root is not a directory")
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Name() == envRootLockFile {
			continue
		}
		// RemoveAll removes a symlink itself and never descends into its target.
		if err := os.RemoveAll(filepath.Join(dir, entry.Name())); err != nil {
			return err
		}
	}
	marker := filepath.Join(dir, envRootLockFile)
	if err := os.Remove(marker); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if err := os.Remove(dir); err != nil {
		if file, markErr := privatefs.OpenLock(marker, false); markErr == nil {
			privatefs.ReleaseLock(file)
		}
		return err
	}
	return nil
}

// PruneTaskTempDirs removes Operation temp directories under base whose
// published marker is no longer locked. Age never matters: only an unlocked
// marker proves that the owner is gone.
func PruneTaskTempDirs(base string, logger *slog.Logger) (removed int, freedBytes int64) {
	entries, err := os.ReadDir(base)
	if err != nil {
		return 0, 0
	}
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), TaskTempDirPrefix) {
			continue
		}
		dir := filepath.Join(base, entry.Name())
		marker := filepath.Join(dir, envRootLockFile)
		if info, err := os.Lstat(marker); err != nil || !info.Mode().IsRegular() {
			continue
		}
		lock, acquired, err := privatefs.AcquireLock(marker)
		if err != nil || !acquired {
			continue
		}
		size := regularFileBytes(dir)
		// Windows cannot finish deleting a directory with an open handle. A
		// published directory is never claimed again, so this cannot race.
		privatefs.ReleaseLock(lock)
		if err := RemoveTaskTempDir(dir); err != nil {
			if logger != nil {
				logger.Debug("operation temp removal failed", "error", err)
			}
			continue
		}
		removed++
		freedBytes += size
	}
	return removed, freedBytes
}

func regularFileBytes(dir string) int64 {
	var total int64
	// The size is best effort: entries that cannot be read are left out and
	// the walk goes on.
	_ = filepath.WalkDir(dir, func(_ string, entry fs.DirEntry, walkErr error) error {
		if walkErr == nil && entry.Type().IsRegular() {
			if info, err := entry.Info(); err == nil {
				total += info.Size()
			}
		}
		return nil
	})
	return total
}
