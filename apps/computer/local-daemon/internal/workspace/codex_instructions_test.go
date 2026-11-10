package workspace

import (
	"log/slog"
	"os"
	"path/filepath"
	"testing"
)

func TestCodexPersonalInstructionsAreIsolatedAndRefreshed(t *testing.T) {
	root := t.TempDir()
	shared, home := filepath.Join(root, ".codex"), filepath.Join(root, "runtime")
	if err := os.MkdirAll(shared, 0700); err != nil {
		t.Fatal(err)
	}
	opts := CodexHomeOptions{SharedHome: shared, UserHome: root, CodexVersion: "0.153.4"}
	for _, name := range []string{"AGENTS.md", "AGENTS.override.md"} {
		if err := os.WriteFile(filepath.Join(shared, name), []byte("personal rule"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := PrepareCodexHome(home, opts, slog.Default()); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"AGENTS.md", "AGENTS.override.md"} {
		target := filepath.Join(home, name)
		if data, err := os.ReadFile(target); err != nil || string(data) != "personal rule" {
			t.Fatalf("missing inherited %s: %v", name, err)
		}
		if err := os.WriteFile(target, []byte("local edit"), 0600); err != nil {
			t.Fatal(err)
		}
		if data, _ := os.ReadFile(filepath.Join(shared, name)); string(data) != "personal rule" {
			t.Fatal("modified personal source")
		}
	}
	if err := os.Remove(filepath.Join(shared, "AGENTS.override.md")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(shared, "AGENTS.md"), []byte("new rule"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := PrepareCodexHome(home, opts, slog.Default()); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(filepath.Join(home, "AGENTS.md")); string(data) != "new rule" {
		t.Fatal("stale personal instructions")
	}
	if _, err := os.Lstat(filepath.Join(home, "AGENTS.override.md")); !os.IsNotExist(err) {
		t.Fatal("stale override still masks AGENTS.md")
	}
}
