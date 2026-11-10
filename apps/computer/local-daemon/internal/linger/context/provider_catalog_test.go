package lingercontext

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestProviderCatalogRejectsChangedEntryUntilDiscoveryReplacesInstallation(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX executable fixture")
	}
	root := t.TempDir()
	entry, previous, next := filepath.Join(root, "claude"), filepath.Join(root, "v1"), filepath.Join(root, "v2")
	for _, path := range []string{previous, next} {
		if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(previous, entry); err != nil {
		t.Fatal(err)
	}
	resolved, err := filepath.EvalSymlinks(entry)
	if err != nil {
		t.Fatal(err)
	}
	catalog := NewProviderCatalog(map[string]ProviderInstallation{"claude": {Type: "claude", EntryPath: entry, ExecutablePath: resolved}})
	if _, ok, err := catalog.Lookup(context.Background(), "claude"); err != nil || !ok {
		t.Fatalf("initial lookup: %v %v", ok, err)
	}
	if err := os.Remove(entry); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(next, entry); err != nil {
		t.Fatal(err)
	}
	// Reject stale paths even while the previous binary still exists.
	if _, ok, err := catalog.Lookup(context.Background(), "claude"); err == nil || ok {
		t.Fatal("unprobed upgrade admitted")
	}
	if err := os.Remove(previous); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := catalog.Lookup(context.Background(), "claude"); err == nil || ok {
		t.Fatal("deleted cached binary admitted")
	}
	resolved, err = filepath.EvalSymlinks(entry)
	if err != nil {
		t.Fatal(err)
	}
	catalog.Replace(map[string]ProviderInstallation{"claude": {Type: "claude", EntryPath: entry, ExecutablePath: resolved}})
	got, ok, err := catalog.Lookup(context.Background(), "claude")
	if err != nil || !ok || got.ExecutablePath != resolved {
		t.Fatalf("refreshed lookup: %+v %v %v", got, ok, err)
	}
}
