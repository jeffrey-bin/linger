package lingercontext

import (
	"os"
	"path/filepath"
	"testing"
)

func TestProjectionRefreshPreservesDotUnderscoreFiles(t *testing.T) {
	fixture := newProjectionRecoveryFixture(t)
	initial := testView("a")
	initial.Mappings = []Mapping{fixture.mapping("skills", ".agents/skills", "read_only", "demo/__MACOSX/._SKILL.md", "retained metadata")}
	current := requireProjection(t, fixture, initial)
	directory := filepath.Join(current.WorkspacePath, ".agents/skills/demo/__MACOSX")
	if err := os.Chmod(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "._local"), []byte("unowned metadata"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, generation := range []string{"b", "c"} {
		refresh := testView(generation)
		refresh.Mappings = initial.Mappings
		requireProjection(t, fixture, refresh)
		for name, want := range map[string]string{"._SKILL.md": "retained metadata", "._local": "unowned metadata"} {
			got, err := os.ReadFile(filepath.Join(directory, name))
			if err != nil || string(got) != want {
				t.Fatalf("refresh %s removed %s: %q, %v", generation, name, got, err)
			}
		}
	}
	remove := testView("d")
	remove.Mappings = nil
	requireProjection(t, fixture, remove)
	if _, err := os.Stat(filepath.Join(directory, "._SKILL.md")); !os.IsNotExist(err) {
		t.Fatalf("obsolete owned file retained: %v", err)
	}
	if got, err := os.ReadFile(filepath.Join(directory, "._local")); err != nil || string(got) != "unowned metadata" {
		t.Fatalf("pruning deleted unowned metadata: %q, %v", got, err)
	}
}

// A page renamed only in letter case keeps working on a case-insensitive file
// system, where the new name finds the previous file.
func TestProjectionRefreshRenamesAFileByLetterCase(t *testing.T) {
	fixture := newProjectionRecoveryFixture(t)
	initial := testView("a")
	initial.Mappings = []Mapping{fixture.mapping("memory", "memory", "read_only", "people/Scarlett Y N CHEN.md", "old page")}
	current := requireProjection(t, fixture, initial)
	renamed := testView("b")
	renamed.Mappings = []Mapping{fixture.mapping("memory", "memory", "read_only", "people/Scarlett Y N Chen.md", "new page")}
	next := requireProjection(t, fixture, renamed)
	if next.WorkspacePath != current.WorkspacePath {
		t.Fatal("refresh moved the workspace")
	}
	got, err := os.ReadFile(filepath.Join(next.WorkspacePath, "memory/people/Scarlett Y N Chen.md"))
	if err != nil || string(got) != "new page" {
		t.Fatalf("renamed page = %q, %v", got, err)
	}
	entries, err := os.ReadDir(filepath.Join(next.WorkspacePath, "memory/people"))
	if err != nil || len(entries) != 1 || entries[0].Name() != "Scarlett Y N Chen.md" {
		t.Fatalf("people = %v, %v", entries, err)
	}
	back := testView("c")
	back.Mappings = initial.Mappings
	requireProjection(t, fixture, back)
}
