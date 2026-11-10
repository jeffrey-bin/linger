package workspace

import (
	"errors"
	"os"
	"path/filepath"
)

// ensureSymlink only replaces the destination entry. An absent source removes
// stale credentials or cache links, rather than keeping a previous snapshot.
func ensureSymlink(source, destination string) error {
	info, err := os.Stat(source)
	if errors.Is(err, os.ErrNotExist) {
		err = os.Remove(destination)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	if err != nil {
		return err
	}
	absolute, err := filepath.Abs(source)
	if err != nil {
		return err
	}
	if linked, err := os.Readlink(destination); err == nil && linked == absolute {
		return nil
	}
	if err := os.Remove(destination); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if linkErr := os.Symlink(absolute, destination); linkErr != nil {
		return recoverProjectionLink(absolute, destination, info.IsDir(), linkErr)
	}
	return nil
}
