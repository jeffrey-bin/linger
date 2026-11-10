//go:build windows

package lingercontext

import (
	"context"
	"path/filepath"
	"testing"
)

func TestWindowsContextRejectsFilenameAliasesBeforePublication(t *testing.T) {
	store, err := OpenViewStore(filepath.Join(t.TempDir(), "state.sqlite"), filepath.Join(t.TempDir(), "views"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	reject := func(mappings []Mapping) {
		t.Helper()
		command := testView("view-invalid")
		command.Mappings = mappings
		if _, err := store.applyTestView(context.Background(), command, ""); err == nil {
			t.Fatalf("published unsafe Windows paths: %+v", mappings)
		}
	}
	for _, path := range []string{"notes/a:stream", "notes/CON.txt", "notes/file.", "notes/file ", "notes/AUX", "notes/a?b", "notes/..", "notes/COM¹.log", "notes/LPT².txt", "notes/COM³", "notes/LPT³"} {
		reject([]Mapping{{TargetPath: path, Access: "read_only"}})
	}
	if err := validatePlatformRelativePath("Données/normal file.md"); err != nil {
		t.Fatal(err)
	}
	for _, names := range [][2]string{{"File.md", "file.md"}, {"σ.md", "ς.md"}} {
		mappings := []Mapping{{TargetPath: "docs", Files: []FileInput{{RelativePath: names[0]}, {RelativePath: names[1]}}}}
		mappings[0].Access = "read_only"
		reject(mappings)
	}
}
