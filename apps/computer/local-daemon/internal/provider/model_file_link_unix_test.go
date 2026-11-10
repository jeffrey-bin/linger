//go:build !windows

package provider

import (
	"os"
	"path/filepath"
	"testing"
)

func createTestModelFileLink(_ *testing.T, link string) error { return os.Symlink("/etc/hosts", link) }

func assertProviderFixtureLink(t *testing.T, link, target string) {
	t.Helper()
	info, err := os.Lstat(link)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("fixture link %s: %v", link, err)
	}
	actual, err := filepath.EvalSymlinks(link)
	if err != nil {
		t.Fatal(err)
	}
	expected, err := filepath.EvalSymlinks(target)
	if err != nil {
		t.Fatal(err)
	}
	if actual != expected {
		t.Fatalf("fixture target = %q, want %q", actual, expected)
	}
}
