//go:build !windows

package native

import (
	"io/fs"
	"os"
)

// Unix directories are created 0700, so protection is the mode itself.
func protectPrivateDir(string) error { return nil }

// privateModeMatches requires the permission bits to equal want exactly.
func privateModeMatches(info fs.FileInfo, want fs.FileMode) bool {
	return info.Mode().Perm() == want
}

// syncDirectory makes a completed rename durable.
func syncDirectory(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
