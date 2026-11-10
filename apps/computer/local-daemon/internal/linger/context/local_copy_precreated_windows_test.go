//go:build windows

package lingercontext

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWindowsLocalCopyNeverFollowsPrecreatedSymlink(t *testing.T) {
	root := os.Getenv("LINGER_TEST_WINDOWS_SYMLINK_FIXTURE")
	if root == "" {
		t.Skip("requires an administrator-provisioned symlink fixture")
	}
	link, target := filepath.Join(root, "config-link.json"), filepath.Join(root, "target.json")
	info, err := os.Lstat(link)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("fixture is not a symlink: %v", err)
	}
	resolved, err := filepath.EvalSymlinks(link)
	if err != nil {
		t.Fatal(err)
	}
	expected, err := filepath.EvalSymlinks(target)
	if err != nil || resolved != expected {
		t.Fatalf("fixture target mismatch: %v", err)
	}
	body, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	server := newLocalCopyServer(t, map[string][]byte{"/skill": body})
	store, _, logs := openLocalCopyStore(t, server.server.Client())
	skill := mappingFile("skills", "skill.md", body)
	first, _ := applyLocalCopyCommand(t, store, logs, server.server.URL, localCopyContextCommand("apply-a", "context-a", skill))
	source := filepath.Join(first.WorkspacePath, "skills", "skill.md")
	if err := os.Chmod(filepath.Dir(source), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(source); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(link, source); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Rename(source, link); err != nil {
			t.Errorf("restore fixture: %v", err)
		}
	})
	before := server.count("/skill")
	_, event := applyLocalCopyCommand(t, store, logs, server.server.URL, localCopyContextCommand("apply-b", "context-b", skill))
	requireLocalCopyTiming(t, event, 0, 1)
	if server.count("/skill") != before+1 {
		t.Fatal("symlink source did not fall back to download")
	}
	after, err := os.ReadFile(target)
	if err != nil || string(after) != string(body) {
		t.Fatalf("link target changed: %v", err)
	}
}
