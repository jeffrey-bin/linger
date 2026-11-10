//go:build darwin || linux

package privatefs

import (
	"errors"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

// Some filesystems implement ordinary rename but not no-replace rename. Keep
// their publishers serialized with a kernel-released lock; checking existence
// followed by rename without this lock could overwrite a concurrent identity.
func publishWithFallback(source, destination string, renameErr error) error {
	if !errors.Is(renameErr, unix.ENOSYS) && !errors.Is(renameErr, unix.EINVAL) && !errors.Is(renameErr, unix.ENOTSUP) {
		return renameErr
	}
	lock, err := openWrite(filepath.Join(filepath.Dir(destination), ".linger-privatefs-publish.lock"), false)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := unix.Flock(int(lock.Fd()), unix.LOCK_EX); err != nil {
		return err
	}
	defer unix.Flock(int(lock.Fd()), unix.LOCK_UN)
	// Never remove the lock file: another process may already be waiting on its
	// inode. Closing the handle releases it, including when a publisher crashes.
	if _, err := os.Lstat(destination); err == nil {
		return &os.LinkError{Op: "rename", Old: source, New: destination, Err: os.ErrExist}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return os.Rename(source, destination)
}
