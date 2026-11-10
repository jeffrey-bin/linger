//go:build windows

package workspace

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWindowsRuntimeDirectoryLinkPreservesUnicodeAndMetacharacters(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "Café & %PATH% source")
	target := filepath.Join(root, "linked directory")
	if err := os.Mkdir(source, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "session.json"), []byte("Session native é\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := ensureSymlink(source, target); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(target, "session.json"))
	if err != nil || string(data) != "Session native é\n" {
		t.Fatalf("linked content=%s err=%v", data, err)
	}
	if err := os.WriteFile(filepath.Join(target, "new-session.json"), []byte("new"), 0o600); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(filepath.Join(source, "new-session.json")); err != nil || string(data) != "new" {
		t.Fatalf("link copied instead of sharing: %s %v", data, err)
	}
}
