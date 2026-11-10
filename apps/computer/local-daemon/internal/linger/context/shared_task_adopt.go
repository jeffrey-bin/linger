package lingercontext

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

// errLegacyTaskDirectory marks a real playground/<taskID> directory that an
// alter_ego wrote before shared Tasks existed.
var errLegacyTaskDirectory = errors.New("Task directory predates shared Tasks")

// adoptLegacyTaskDirectory moves what an alter_ego wrote to a real
// playground/<taskID> before shared Tasks into its shared Task directory, so a
// Task that spans the upgrade keeps its files where its Meta can read them.
// It never replaces an entry the Task directory already holds. A copy across
// file systems lands under a temporary name first, so a retry after a crash
// resumes with the entries that have not moved yet.
func adoptLegacyTaskDirectory(source, target string) error {
	entries, err := os.ReadDir(source)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		from, to := filepath.Join(source, entry.Name()), filepath.Join(target, entry.Name())
		if _, err := os.Lstat(to); err == nil {
			return fmt.Errorf("Task directory already holds %s", entry.Name())
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if os.Rename(from, to) == nil {
			continue
		}
		staged := filepath.Join(target, ".adopting-"+entry.Name())
		if err := os.RemoveAll(staged); err != nil {
			return err
		}
		if err := copyTaskTree(from, staged); err != nil {
			_ = os.RemoveAll(staged)
			return err
		}
		if err := os.Rename(staged, to); err != nil {
			_ = os.RemoveAll(staged)
			return err
		}
		if err := os.RemoveAll(from); err != nil {
			return err
		}
	}
	return os.Remove(source)
}

// copyTaskTree copies directories, regular files and links without following
// a link; any other entry stops the copy.
func copyTaskTree(source, target string) error {
	return filepath.WalkDir(source, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		destination := filepath.Join(target, relative)
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		switch {
		case directoryLink(info) || info.Mode()&os.ModeSymlink != 0:
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			if err := os.Symlink(link, destination); err != nil {
				return err
			}
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		case info.IsDir():
			return os.Mkdir(destination, info.Mode().Perm()|0o700)
		case info.Mode().IsRegular():
			return copyTaskFile(path, destination, info.Mode().Perm())
		default:
			return fmt.Errorf("cannot move %s into the shared Task directory", path)
		}
	})
}

func copyTaskFile(source, target string, mode os.FileMode) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode|0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(output, input); err != nil {
		_ = output.Close()
		return err
	}
	if err := output.Sync(); err != nil {
		_ = output.Close()
		return err
	}
	return output.Close()
}
