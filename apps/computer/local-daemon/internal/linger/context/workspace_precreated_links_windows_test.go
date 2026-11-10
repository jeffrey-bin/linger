//go:build windows

package lingercontext

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestWindowsPrecreatedWorkspaceLinks(t *testing.T) {
	fixture := os.Getenv("LINGER_TEST_WINDOWS_WORKSPACE_LINK_FIXTURE")
	if fixture == "" {
		t.Skip("requires administrator-provisioned links")
	}
	for _, name := range []string{"cycle", "dangling", "escape", "readonly", "valid"} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			database, views := filepath.Join(dir, "views.sqlite"), filepath.Join(dir, "views")
			store, err := OpenViewStore(database, views, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = store.Close() }()
			firstView := testView("view-1")
			firstView.Mappings = []Mapping{{Kind: "inbox_view", TargetPath: "inbox", Access: "read_only"}, {Kind: "playground", TargetPath: "playground", Access: "read_write"}}
			first, err := store.applyTestView(context.Background(), firstView, "")
			if err != nil {
				t.Fatal(err)
			}
			folder := filepath.Join(first.WorkspacePath, "playground", "repo")
			linkName := "unsafe"
			if name == "readonly" {
				folder, linkName = filepath.Join(first.WorkspacePath, "inbox"), "alias"
			}
			if name == "valid" {
				linkName = "CLAUDE.md"
			}
			if err := os.MkdirAll(folder, 0o700); err != nil {
				t.Fatal(err)
			}
			if name == "valid" {
				if err := os.WriteFile(filepath.Join(folder, "AGENTS.md"), []byte("repository rules"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			link := filepath.Join(folder, linkName)
			source := filepath.Join(fixture, name)
			info, err := os.Lstat(source)
			if err != nil || info.Mode()&os.ModeSymlink == 0 {
				t.Fatalf("fixture is not a symlink: %v", err)
			}
			target, err := os.Readlink(source)
			if err != nil {
				t.Fatal(err)
			}
			want := map[string]string{"cycle": "unsafe", "dangling": "missing", "escape": filepath.Join(fixture, "outside"), "readonly": filepath.Join("..", "playground"), "valid": "AGENTS.md"}[name]
			if filepath.Clean(target) != filepath.Clean(want) {
				t.Fatalf("fixture target = %q, want %q", target, want)
			}
			if err := os.Rename(source, link); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.Rename(link, source) })
			ref, err := json.Marshal(ViewRef{ViewDigest: first.View.ViewDigest})
			if err != nil {
				t.Fatal(err)
			}
			_, currentErr := store.CurrentView(context.Background(), firstView.ExecutionContextKey, first.View.ViewDigest)
			_, workspaceErr := store.ValidatedWorkspace(context.Background(), firstView.ExecutionContextKey, ref)
			refresh := testView("view-2")
			refresh.Mappings = firstView.Mappings
			_, refreshErr := store.applyTestView(context.Background(), refresh, "")
			if name == "readonly" {
				if currentErr == nil || workspaceErr == nil || refreshErr == nil {
					t.Fatalf("read-only link accepted: current=%v workspace=%v refresh=%v", currentErr, workspaceErr, refreshErr)
				}
				if err := os.Rename(link, source); err != nil {
					t.Fatal(err)
				}
				if _, err := store.applyTestView(context.Background(), refresh, ""); err != nil {
					t.Fatalf("refresh after repair: %v", err)
				}
				return
			}
			if currentErr != nil || workspaceErr != nil || refreshErr != nil {
				t.Fatalf("repository link blocked activation: current=%v workspace=%v refresh=%v", currentErr, workspaceErr, refreshErr)
			}
			if err := store.Close(); err != nil {
				t.Fatal(err)
			}
			store, err = OpenViewStore(database, views, nil)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := store.CurrentView(context.Background(), firstView.ExecutionContextKey, refresh.ViewDigest); err != nil {
				t.Fatalf("recovery with repository link: %v", err)
			}
			if got, err := os.Readlink(link); err != nil || filepath.Clean(got) != filepath.Clean(want) {
				t.Fatalf("repository link changed after recovery: target=%q error=%v", got, err)
			}
			if name == "valid" {
				if content, err := os.ReadFile(link); err != nil || string(content) != "repository rules" {
					t.Fatalf("repository link content after recovery: %q %v", content, err)
				}
			}
		})
	}
}
