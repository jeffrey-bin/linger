package workspace

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestRemoveTaskTempDirKeepsSymlinkTargets(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation needs elevated rights on Windows")
	}
	base := t.TempDir()
	outside := filepath.Join(base, "outside")
	if err := os.Mkdir(outside, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "keep"), []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	dir, err := os.MkdirTemp(base, TaskTempDirPrefix)
	if err != nil {
		t.Fatal(err)
	}
	lock, err := LockTaskTempDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	ReleaseTaskTempLock(lock)
	if err := os.Symlink(outside, filepath.Join(dir, "link")); err != nil {
		t.Fatal(err)
	}
	if err := RemoveTaskTempDir(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(outside, "keep")); err != nil {
		t.Fatalf("symlink target was touched: %v", err)
	}
	if err := RemoveTaskTempDir(dir); err != nil {
		t.Fatalf("missing directory must count as removed: %v", err)
	}
	rootLink := filepath.Join(base, TaskTempDirPrefix+"link")
	if err := os.Symlink(outside, rootLink); err != nil {
		t.Fatal(err)
	}
	if err := RemoveTaskTempDir(rootLink); err == nil || err.Error() != "operation temp root is not a directory" {
		t.Fatalf("symlink root error = %v", err)
	}
}

func TestLockTaskTempDirRejectsPublishedMarker(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, envRootLockFile), nil, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := LockTaskTempDir(dir); !errors.Is(err, os.ErrExist) {
		t.Fatalf("error = %v, want ErrExist", err)
	}
	if _, err := os.Lstat(filepath.Join(dir, taskTempClaimFile)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("claim file left behind: %v", err)
	}
}
