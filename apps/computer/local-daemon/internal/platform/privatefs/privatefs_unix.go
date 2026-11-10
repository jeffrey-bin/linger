//go:build !windows

package privatefs

import (
	"errors"
	"os"
	"syscall"
)

func safe(file *os.File, kind string, ownerOnly bool) error {
	info, err := file.Stat()
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || uint64(stat.Uid) != uint64(os.Getuid()) {
		return errors.New("path is not owned by the current user")
	}
	if kind == "directory" {
		if !info.IsDir() {
			return errors.New("path is not a directory")
		}
	} else if !info.Mode().IsRegular() || stat.Nlink != 1 {
		return errors.New("path is not a single regular file")
	}
	mask := os.FileMode(0o022)
	if ownerOnly {
		mask = 0o077
	}
	if info.Mode().Perm()&mask != 0 {
		return errors.New("path permissions are unsafe")
	}
	return nil
}
func CheckPath(path, kind string, ownerOnly bool) error {
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return err
	}
	defer file.Close()
	return safe(file, kind, ownerOnly)
}

// CheckFile validates the identity and permissions of an already opened object.
func CheckFile(file *os.File, kind string, ownerOnly bool) error {
	return safe(file, kind, ownerOnly)
}
func OpenRead(path string, ownerOnly bool) (*os.File, error) {
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	if err := safe(file, "file", ownerOnly); err != nil {
		_ = file.Close()
		return nil, err
	}
	return file, nil
}
func EnsureDir(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || uint64(stat.Uid) != uint64(os.Getuid()) {
		return errors.New("private directory is unsafe")
	}
	return file.Chmod(0o700)
}
func openWrite(path string, exclusive bool) (*os.File, error) {
	flags := os.O_WRONLY | os.O_CREATE | syscall.O_NOFOLLOW | syscall.O_NONBLOCK
	if exclusive {
		flags |= os.O_EXCL
	} else {
		flags |= os.O_APPEND
	}
	file, err := os.OpenFile(path, flags, 0o600)
	if err != nil {
		return nil, err
	}
	if err := safe(file, "file", true); err != nil {
		_ = file.Close()
		return nil, err
	}
	return file, nil
}
func OpenLog(path string) (*os.File, error) { return openWrite(path, false) }
