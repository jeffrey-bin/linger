//go:build !windows

package privatefs

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

func openLock(path string, exclusive bool) (*os.File, error) {
	flags := unix.O_RDWR | unix.O_CREAT | unix.O_CLOEXEC | unix.O_NOFOLLOW
	if exclusive {
		flags |= unix.O_EXCL
	}
	fd, err := unix.Open(path, flags, 0600)
	if err != nil {
		return nil, &os.PathError{Op: "open lock", Path: path, Err: err}
	}
	return os.NewFile(uintptr(fd), path), nil
}

// TryLock takes the exclusive lock of an open lock file without blocking.
func TryLock(file *os.File) (bool, error) {
	err := unix.Flock(int(file.Fd()), unix.LOCK_NB|unix.LOCK_EX)
	if errors.Is(err, unix.EAGAIN) || errors.Is(err, unix.EWOULDBLOCK) {
		return false, nil
	}
	return err == nil, err
}

// Unlock releases the lock held on an open lock file.
func Unlock(file *os.File) error { return unix.Flock(int(file.Fd()), unix.LOCK_UN) }
