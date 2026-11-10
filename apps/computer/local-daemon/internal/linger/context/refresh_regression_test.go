package lingercontext

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestRefreshPreservesWorkspaceAndLocalWork(t *testing.T) {
	root := t.TempDir()
	store, err := OpenViewStore(filepath.Join(root, "views.sqlite"), filepath.Join(root, "views"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	command := testView("view-1")
	command.Mappings = []Mapping{{Kind: "playground", TargetPath: "playground", Access: "read_write"}}
	first, err := store.applyTestView(context.Background(), command, "")
	if err != nil {
		t.Fatal(err)
	}
	localFile := filepath.Join(first.WorkspacePath, "playground", "unpublished.txt")
	if err := os.WriteFile(localFile, []byte("local work"), 0o600); err != nil {
		t.Fatal(err)
	}
	for index, generation := range []string{"view-1", "view-2"} {
		refresh := testView(generation)
		refresh.Mappings = command.Mappings
		next, err := store.applyTestView(context.Background(), refresh, "")
		if err != nil {
			t.Fatalf("refresh %d: %v", index, err)
		}
		if next.WorkspacePath != first.WorkspacePath {
			t.Fatal("provider cwd moved")
		}
		content, err := os.ReadFile(localFile)
		if err != nil || string(content) != "local work" {
			t.Fatalf("local work lost: %q %v", content, err)
		}
		first = next
	}
}

func TestInterruptedRefreshBlocksAdmissionUntilRepaired(t *testing.T) {
	root := t.TempDir()
	store, err := OpenViewStore(filepath.Join(root, "views.sqlite"), filepath.Join(root, "views"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	first, err := store.applyTestView(context.Background(), testView("view-1"), "")
	if err != nil {
		t.Fatal(err)
	}
	blocked := filepath.Join(first.WorkspacePath, "inbox")
	if err := os.WriteFile(blocked, []byte("blocking file"), 0o600); err != nil {
		t.Fatal(err)
	}
	refresh := testView("view-2")
	refresh.Mappings = []Mapping{{Kind: "inbox_view", TargetPath: "inbox", Access: "read_only"}}
	if _, err := store.applyTestView(context.Background(), refresh, ""); err == nil {
		t.Fatal("invalid directory did not fail publication")
	}
	if _, err := store.CurrentView(context.Background(), refresh.ExecutionContextKey, ""); !errors.Is(err, ErrContextConflict) {
		t.Fatal("incomplete publication remained ready")
	}
	if err := os.Remove(blocked); err != nil {
		t.Fatal(err)
	}
	next, err := store.applyTestView(context.Background(), refresh, "")
	if err != nil {
		t.Fatalf("refresh retry failed: %v", err)
	}
	if _, err := store.CurrentView(context.Background(), refresh.ExecutionContextKey, next.View.ViewDigest); err != nil {
		t.Fatal(err)
	}
}

func TestContextFileRejectsIntermediateSymlink(t *testing.T) {
	workspace, outside := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "private.txt"), []byte("private"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := createTestDirectoryLink(outside, filepath.Join(workspace, "escape")); err != nil {
		t.Fatal(err)
	}
	if file, err := openContextFile(workspace, "escape/private.txt"); err == nil {
		_ = file.Close()
		t.Fatal("intermediate symlink escaped the Context workspace")
	}
}
