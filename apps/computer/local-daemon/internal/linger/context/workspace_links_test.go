package lingercontext

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestRepositoryLinksSurviveRefreshAndRecovery(t *testing.T) {
	for _, invalid := range []string{"cycle", "dangling", "escape"} {
		t.Run(invalid, func(t *testing.T) {
			directory := t.TempDir()
			database := filepath.Join(directory, "views.sqlite")
			views := filepath.Join(directory, "views")
			store, err := OpenViewStore(database, views, nil)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = store.Close() })
			command := testView("view-1")
			command.Mappings = []Mapping{{Kind: "playground", TargetPath: "playground", Access: "read_write"}}
			first, err := store.applyTestView(context.Background(), command, "")
			if err != nil {
				t.Fatal(err)
			}
			repository := filepath.Join(first.WorkspacePath, "playground", "repo")
			for _, relative := range []string{".claude/skills", ".agents"} {
				if err := os.MkdirAll(filepath.Join(repository, relative), 0o700); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.WriteFile(filepath.Join(repository, "AGENTS.md"), []byte("repository rules"), 0o600); err != nil {
				t.Fatal(err)
			}
			for relative, target := range map[string]string{"CLAUDE.md": "AGENTS.md", ".agents/skills": "../.claude/skills", "absolute": filepath.Join(repository, "AGENTS.md")} {
				if relative == ".agents/skills" {
					if err := createTestDirectoryLink(filepath.Join(repository, ".claude", "skills"), filepath.Join(repository, relative)); err != nil {
						t.Fatal(err)
					}
				} else if err := createTestRepositoryLink(t, target, filepath.Join(repository, relative)); err != nil {
					t.Fatal(err)
				}
			}
			refresh := testView("view-2")
			refresh.Mappings = command.Mappings
			current, err := store.applyTestView(context.Background(), refresh, "")
			if err != nil {
				t.Fatal(err)
			}
			_ = store.Close()
			store, err = OpenViewStore(database, views, nil)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := store.CurrentView(context.Background(), command.ExecutionContextKey, current.View.ViewDigest); err != nil {
				t.Fatal(err)
			}
			if content, err := os.ReadFile(filepath.Join(repository, "CLAUDE.md")); err != nil || string(content) != "repository rules" {
				t.Fatalf("lost repository link: %q %v", content, err)
			}
			target := map[string]string{"cycle": "unsafe", "dangling": "missing", "escape": t.TempDir()}[invalid]
			unsafe := filepath.Join(repository, "unsafe")
			if invalid == "escape" {
				if err := createTestDirectoryLink(target, unsafe); err != nil {
					t.Fatal(err)
				}
			} else if err := createTestRepositoryLink(t, target, unsafe); err != nil {
				t.Fatal(err)
			}
			encoded, err := json.Marshal(ViewRef{ViewDigest: refresh.ViewDigest})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := store.CurrentView(context.Background(), command.ExecutionContextKey, current.View.ViewDigest); err != nil {
				t.Fatalf("playground repository blocked the Context: %v", err)
			}
			if _, err := store.ValidatedWorkspace(context.Background(), command.ExecutionContextKey, encoded); err != nil {
				t.Fatalf("playground repository blocked input: %v", err)
			}
			refresh = testView("view-3")
			refresh.Mappings = command.Mappings
			if _, err := store.applyTestView(context.Background(), refresh, ""); err != nil {
				t.Fatalf("playground repository blocked refresh: %v", err)
			}
		})
	}
}

func TestReadOnlyProjectionLinkBlocksRefresh(t *testing.T) {
	directory := t.TempDir()
	store, err := OpenViewStore(filepath.Join(directory, "views.sqlite"), filepath.Join(directory, "views"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	command := testView("view-1")
	command.Mappings = []Mapping{
		{Kind: "inbox_view", TargetPath: "inbox", Access: "read_only"},
		{Kind: "playground", TargetPath: "playground", Access: "read_write"},
	}
	first, err := store.applyTestView(context.Background(), command, "")
	if err != nil {
		t.Fatal(err)
	}
	inbox := filepath.Join(first.WorkspacePath, "inbox")
	if err := os.MkdirAll(inbox, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(inbox, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := createTestDirectoryLink(filepath.Join(first.WorkspacePath, "playground"), filepath.Join(inbox, "alias")); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(ViewRef{ViewDigest: first.View.ViewDigest})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CurrentView(context.Background(), command.ExecutionContextKey, first.View.ViewDigest); err == nil {
		t.Fatal("read-only projection link admitted")
	}
	if _, err := store.ValidatedWorkspace(context.Background(), command.ExecutionContextKey, encoded); err == nil {
		t.Fatal("read-only projection link admitted as input")
	}
	refresh := testView("view-2")
	refresh.Mappings = command.Mappings
	if _, err := store.applyTestView(context.Background(), refresh, ""); err == nil {
		t.Fatal("read-only projection link admitted on refresh")
	}
	if err := os.Chmod(inbox, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(inbox, "alias")); err != nil {
		t.Fatal(err)
	}
	if _, err := store.applyTestView(context.Background(), refresh, ""); err != nil {
		t.Fatalf("repaired projection did not recover: %v", err)
	}
}

func TestWorkspaceLinksRejectReadonlyAndIndirectEscapes(t *testing.T) {
	workspace := t.TempDir()
	if err := os.MkdirAll(filepath.Join(workspace, "inbox"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "rules"), []byte("rules"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(workspace, "inbox", "rules")
	if err := createTestRepositoryLink(t, "../rules", link); err != nil {
		t.Fatal(err)
	}
	if err := validateWorkspaceLinks(workspace, []Mapping{{TargetPath: "inbox", Access: "read_only"}}); err == nil {
		t.Fatal("local link replaced a managed readonly input")
	}
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	if err := createTestDirectoryLink(t.TempDir(), filepath.Join(workspace, "outside")); err != nil {
		t.Fatal(err)
	}
	if err := createTestDirectoryLink(filepath.Join(workspace, "outside"), link); err != nil {
		t.Fatal(err)
	}
	if err := validateWorkspaceLinks(workspace, []Mapping{{TargetPath: "inbox", Access: "read_only"}}); err == nil {
		t.Fatal("indirect escaping link admitted inside a read-only projection")
	}
}

func TestWorkspaceLinksTolerateUnresolvableRepositoryLinks(t *testing.T) {
	workspace := t.TempDir()
	repository := filepath.Join(workspace, "repo")
	if err := os.MkdirAll(filepath.Join(repository, "apps", "agent"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repository, "README"), []byte("file"), 0o600); err != nil {
		t.Fatal(err)
	}
	for relative, target := range map[string]string{
		"apps/agent/.env": "../.env",                          // gitignored developer file
		"generated":       "dist/missing/output",              // not yet built
		"absolute":        filepath.Join(t.TempDir(), "none"), // outside target that does not exist
		"loop":            "loop",                             // self-referential
		"through-file":    "README/inner",                     // crosses a regular file
	} {
		if err := createTestRepositoryLink(t, target, filepath.Join(repository, relative)); err != nil {
			t.Fatal(err)
		}
	}
	if err := validateWorkspaceLinks(workspace, []Mapping{{TargetPath: "inbox", Access: "read_only"}}); err != nil {
		t.Fatalf("incomplete repository content must not block activation: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(workspace, "inbox"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := createTestRepositoryLink(t, "../missing", filepath.Join(workspace, "inbox", "dangling")); err != nil {
		t.Fatal(err)
	}
	if err := validateWorkspaceLinks(workspace, []Mapping{{TargetPath: "inbox", Access: "read_only"}}); err == nil {
		t.Fatal("dangling link admitted inside a read-only projection")
	}
	if err := os.Remove(filepath.Join(workspace, "inbox", "dangling")); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(repository, "absolute")); err != nil {
		t.Fatal(err)
	}
	if err := createTestRepositoryLink(t, outside, filepath.Join(repository, "absolute")); err != nil {
		t.Fatal(err)
	}
	if err := validateWorkspaceLinks(workspace, []Mapping{
		{TargetPath: "inbox", Access: "read_only"},
		{TargetPath: "repo", Access: "read_write"},
	}); err != nil {
		t.Fatalf("writable host link blocked the Context: %v", err)
	}
}

func TestWorkspaceLinksIgnoreWritableHostLinks(t *testing.T) {
	workspace := t.TempDir()
	if err := os.MkdirAll(filepath.Join(workspace, "playground", "deployed"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(workspace, "inbox"), 0o700); err != nil {
		t.Fatal(err)
	}
	host := t.TempDir()
	if err := createTestDirectoryLink(host, filepath.Join(workspace, "playground", "deployed", "yauzl")); err != nil {
		t.Fatal(err)
	}
	mappings := []Mapping{
		{TargetPath: "inbox", Access: "read_only"},
		{TargetPath: "playground", Access: "read_write"},
	}
	if err := validateWorkspaceLinks(workspace, mappings); err != nil {
		t.Fatalf("playground host link blocked the Context: %v", err)
	}
}
