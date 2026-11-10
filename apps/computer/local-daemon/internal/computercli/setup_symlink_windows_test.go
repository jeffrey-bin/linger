//go:build windows

package computercli

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// The link is provisioned separately because an ordinary user may not create symlinks.
func TestWindowsSetupRejectsPrecreatedFileSymlink(t *testing.T) {
	root := os.Getenv("LINGER_TEST_WINDOWS_SYMLINK_FIXTURE")
	if root == "" {
		t.Skip("requires an administrator-provisioned symlink fixture")
	}
	link := filepath.Join(root, "config-link.json")
	target := filepath.Join(root, "target.json")
	info, err := os.Lstat(link)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("fixture is not a file symlink: %v", err)
	}
	resolvedLink, err := filepath.EvalSymlinks(link)
	if err != nil {
		t.Fatal(err)
	}
	resolvedTarget, err := filepath.EvalSymlinks(target)
	if err != nil || resolvedLink != resolvedTarget {
		t.Fatalf("fixture link does not point to the target: %v", err)
	}
	before, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	server := newExchangeServer(t, "runner-unsafe")
	f := newSetupFixture(t, server)
	f.options.configPath = link
	if _, err := runComputerSetup(context.Background(), f.options, f.deps); err == nil || asCLIError(err).message != "Local Computer state file is unsafe" {
		t.Fatalf("setup accepted symlink or returned an unexpected error: %v", err)
	}
	after, err := os.ReadFile(target)
	if err != nil || string(after) != string(before) {
		t.Fatalf("symlink target changed: %v", err)
	}
	if len(server.requests) != 0 {
		t.Fatalf("setup contacted the server before rejecting the symlink: %d requests", len(server.requests))
	}
}
