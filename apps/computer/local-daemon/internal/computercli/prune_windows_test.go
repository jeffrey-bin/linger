//go:build windows

package computercli

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
	"golang.org/x/sys/windows"
)

// privateStateRoot creates an owner-only data root and state directory, as
// enrollment does, so the prune ownership checks accept them.
func privateStateRoot(t *testing.T) (string, string) {
	t.Helper()
	dataRoot := filepath.Join(t.TempDir(), "data")
	state := filepath.Join(dataRoot, "state")
	if err := privatefs.EnsureDir(state); err != nil {
		t.Fatal(err)
	}
	return dataRoot, state
}

// openExclusive holds a handle that shares nothing, as an editor may.
func openExclusive(t *testing.T, path string) {
	t.Helper()
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateFile(name, windows.GENERIC_READ, 0, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = windows.CloseHandle(handle) })
}

// An editor an Agent left open in an old Context workspace must not block
// switching accounts; the state stores beside it are still removed.
func TestPruneDuringSetupLeavesDirectoryWithOpenFile(t *testing.T) {
	dataRoot, state := privateStateRoot(t)
	workspace := filepath.Join(state, "context-views", "0123", "workspace")
	if err := os.MkdirAll(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{
		filepath.Join(workspace, "notes.txt"),
		filepath.Join(workspace, "other.txt"),
		filepath.Join(state, "context-views.sqlite"),
		filepath.Join(state, "computer-tools", "action.json"),
		filepath.Join(state, "workspaces", "project.txt"),
	} {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	locked := filepath.Join(workspace, "notes.txt")
	openExclusive(t, locked)
	configPath := filepath.Join(dataRoot, "config.json")
	if err := os.WriteFile(configPath, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	target := pruneTarget{configPath: configPath, dataRoot: dataRoot, setupRevisionsPath: filepath.Join(dataRoot, "setup-revisions"), stateDirectory: state}

	leftovers, err := target.pruneDuringSetup()
	if err != nil {
		t.Fatalf("prune failed: %v", err)
	}
	if len(leftovers) != 1 || leftovers[0] != filepath.Join(state, "context-views") {
		t.Fatalf("leftovers = %v", leftovers)
	}
	for _, removed := range []string{configPath, filepath.Join(state, "context-views.sqlite"), filepath.Join(state, "computer-tools"), filepath.Join(workspace, "other.txt")} {
		if _, err := os.Lstat(removed); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%s survived: %v", removed, err)
		}
	}
	for _, kept := range []string{locked, filepath.Join(state, "workspaces", "project.txt")} {
		if _, err := os.Lstat(kept); err != nil {
			t.Fatalf("%s is missing: %v", kept, err)
		}
	}
}

// A full prune is an explicit request to delete everything, so it stops and
// names the open file instead of leaving it behind.
func TestPruneNamesOpenFile(t *testing.T) {
	dataRoot, state := privateStateRoot(t)
	locked := filepath.Join(state, "context-views", "0123", "workspace", "notes.txt")
	if err := os.MkdirAll(filepath.Dir(locked), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(locked, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	openExclusive(t, locked)
	target := pruneTarget{configPath: filepath.Join(dataRoot, "config.json"), dataRoot: dataRoot, setupRevisionsPath: filepath.Join(dataRoot, "setup-revisions"), stateDirectory: state}
	err := target.prune()
	if err == nil || asCLIError(err).category != categoryConfiguration {
		t.Fatalf("prune error = %v", err)
	}
}
