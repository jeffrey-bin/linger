package workspace

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOperationSweepRequiresPublishedReleasedOwnership(t *testing.T) {
	base := t.TempDir()
	directory, err := os.MkdirTemp(base, TaskTempDirPrefix)
	if err != nil {
		t.Fatal(err)
	}
	if count, _ := PruneTaskTempDirs(base, nil); count != 0 {
		t.Fatal("sweep removed unpublished directory")
	}
	lock, err := LockTaskTempDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer ReleaseTaskTempLock(lock)
	if _, err := LockTaskTempDir(directory); err == nil {
		t.Fatal("same directory acquired twice")
	}
	if err := os.WriteFile(filepath.Join(directory, "payload"), []byte("owned data"), 0600); err != nil {
		t.Fatal(err)
	}
	if count, _ := PruneTaskTempDirs(base, nil); count != 0 {
		t.Fatal("sweep removed live directory")
	}
	ReleaseTaskTempLock(lock)
	count, bytes := PruneTaskTempDirs(base, nil)
	if count != 1 || bytes != 10 {
		t.Fatalf("sweep count=%d bytes=%d", count, bytes)
	}
	if _, err := os.Stat(directory); !os.IsNotExist(err) {
		t.Fatalf("directory survived: %v", err)
	}
}

func TestOperationSweepIgnoresUnownedPaths(t *testing.T) {
	base := t.TempDir()
	for _, name := range []string{"other-project", TaskTempDirPrefix + "unpublished"} {
		directory := filepath.Join(base, name)
		if err := os.Mkdir(directory, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(directory, "payload"), []byte("keep"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if count, _ := PruneTaskTempDirs(base, nil); count != 0 {
		t.Fatal("unowned directory deleted")
	}
}
