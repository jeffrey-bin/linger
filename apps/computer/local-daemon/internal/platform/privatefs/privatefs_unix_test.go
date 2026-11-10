//go:build !windows

package privatefs

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPrivateWritePreservesExistingParentPermissions(t *testing.T) {
	parent := t.TempDir()
	if err := os.Chmod(parent, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(parent, "credential")
	if err := WriteFile(path, []byte("private"), true); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(parent)
	if err != nil || info.Mode().Perm() != 0o755 {
		t.Fatalf("parent permissions changed: %v %v", info, err)
	}
	if err := CheckPath(path, "file", true); err != nil {
		t.Fatal(err)
	}
}
