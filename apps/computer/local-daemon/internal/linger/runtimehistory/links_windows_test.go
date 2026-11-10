//go:build windows

package runtimehistory

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/workspace"
)

func createTestDirectoryLink(target, link string) error {
	return workspace.CreateDirectoryLink(target, link)
}

func createTestFileLink(t *testing.T, target, link string) error {
	t.Helper()
	root := os.Getenv("LINGER_TEST_WINDOWS_HISTORY_LINK")
	if root == "" {
		return os.Symlink(target, link)
	}
	fixture := filepath.Join(root, "config-link.json")
	info, err := os.Lstat(fixture)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink == 0 {
		t.Fatal("history fixture is not a symbolic link")
	}
	if err := os.Rename(fixture, link); err != nil {
		return err
	}
	t.Cleanup(func() {
		if err := os.Rename(link, fixture); err != nil {
			t.Errorf("restore history link: %v", err)
		}
	})
	return nil
}
