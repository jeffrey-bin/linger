package privatefs

import (
	"os"
)

// OpenLock opens a private lock file for non-blocking OS locks. Locks are
// released when their file descriptor closes, including after process failure.
func OpenLock(path string, exclusive bool) (*os.File, error) {
	file, err := openLock(path, exclusive)
	if err != nil {
		return nil, err
	}
	if err := CheckFile(file, "file", false); err != nil {
		_ = file.Close()
		return nil, err
	}
	return file, nil
}

// AcquireLock opens a private lock file and takes its exclusive lock without
// blocking. It reports false when another holder owns the lock.
func AcquireLock(path string) (*os.File, bool, error) {
	file, err := OpenLock(path, false)
	if err != nil {
		return nil, false, err
	}
	acquired, err := TryLock(file)
	if !acquired || err != nil {
		_ = file.Close()
		return nil, false, err
	}
	return file, true, nil
}

// ReleaseLock closes a lock file, which releases its lock. A nil file is ignored.
func ReleaseLock(file *os.File) {
	if file != nil {
		_ = file.Close()
	}
}
