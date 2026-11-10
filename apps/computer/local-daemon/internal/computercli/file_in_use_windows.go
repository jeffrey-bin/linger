//go:build windows

package computercli

import (
	"errors"

	"golang.org/x/sys/windows"
)

// fileInUse reports whether another process holds a handle that forbids
// deleting the file, as an editor holding a document or a working directory does.
func fileInUse(err error) bool {
	return errors.Is(err, windows.ERROR_SHARING_VIOLATION) || errors.Is(err, windows.ERROR_LOCK_VIOLATION)
}
