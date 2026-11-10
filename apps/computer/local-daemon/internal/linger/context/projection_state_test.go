package lingercontext

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestNewViewAfterRestartKeepsWorkspaceAndUnpublishedFiles(t *testing.T) {
	fixture := newProjectionRecoveryFixture(t)
	initial := testView("a")
	initial.Mappings = []Mapping{
		fixture.mapping("documents", "documents", "read_only", "seed.txt", "original"),
		{Kind: "playground", TargetPath: "playground", Access: "read_write"},
	}
	first := requireProjection(t, fixture, initial)
	localPath := filepath.Join(first.WorkspacePath, "playground", "unpublished.txt")
	if err := os.WriteFile(localPath, []byte("unpublished"), 0o600); err != nil {
		t.Fatal(err)
	}
	fixture.restart(t)
	next := testView("b")
	next.Mappings = []Mapping{
		fixture.mapping("documents", "documents", "read_only", "seed.txt", "latest"),
		{Kind: "playground", TargetPath: "playground", Access: "read_write"},
	}
	ready := requireProjection(t, fixture, next)
	if ready.WorkspacePath != first.WorkspacePath || ready.View.ViewDigest == first.View.ViewDigest {
		t.Fatal("a new View must retain the workspace and replace its digest")
	}
	for relative, expected := range map[string]string{"documents/seed.txt": "latest", "playground/unpublished.txt": "unpublished"} {
		content, err := os.ReadFile(filepath.Join(ready.WorkspacePath, filepath.FromSlash(relative)))
		if err != nil || string(content) != expected {
			t.Fatalf("new activation changed %s: %v", relative, err)
		}
	}
}

func TestProjectionModeChangesPreserveWritableFiles(t *testing.T) {
	fixture := newProjectionRecoveryFixture(t)
	initial := testView("ro")
	initial.Mappings = []Mapping{fixture.mapping("documents", "playground", "read_only", "seed.txt", "seed")}
	requireProjection(t, fixture, initial)
	writable := testView("rw")
	writable.Mappings = []Mapping{{Kind: "playground", TargetPath: "playground", Access: "read_write"}}
	second := requireProjection(t, fixture, writable)
	file := filepath.Join(second.WorkspacePath, "playground/seed.txt")
	if content, err := os.ReadFile(file); err != nil || string(content) != "seed" {
		t.Fatal("RO to RW deleted the previous file", err)
	}
	if info, err := os.Stat(file); err != nil || info.Mode().Perm()&0o200 == 0 {
		t.Fatal("RO to RW did not restore owner write permission", err)
	}
	if err := os.WriteFile(file, []byte("unpublished edit"), 0o600); err != nil {
		t.Fatal(err)
	}
	readonly := testView("ro-next")
	readonly.Mappings = []Mapping{fixture.mapping("documents", "playground", "read_only", "seed.txt", "replacement")}
	if _, err := fixture.store.applyTestView(context.Background(), readonly, fixture.server.URL); !errors.Is(err, ErrContextConflict) {
		t.Fatal("destructive RW to RO mode change was accepted", err)
	}
	if content, err := os.ReadFile(file); err != nil || string(content) != "unpublished edit" {
		t.Fatal("mode change destroyed unpublished work", err)
	}
	if _, err := fixture.store.CurrentView(context.Background(), second.View.ExecutionContextKey, second.View.ViewDigest); err != nil {
		t.Fatal("rejected mode change modified the active View", err)
	}
}

func TestSkillRefreshPreservesExecutableModeAndUnmanagedLocalFiles(t *testing.T) {
	fixture := newProjectionRecoveryFixture(t)
	initial := testView("a")
	initial.Mappings = []Mapping{fixture.mapping("skills", ".agents/skills", "read_only", "package/tool.sh", "first")}
	first := requireProjection(t, fixture, initial)
	path := filepath.Join(first.WorkspacePath, ".agents/skills/package/tool.sh")
	if info, err := os.Stat(path); err != nil || (runtime.GOOS == "windows" && info.Mode().Perm()&0o200 != 0) || (runtime.GOOS != "windows" && info.Mode().Perm() != 0o400) {
		t.Fatal("read-only file mode changed during staging cleanup", err)
	}
	next := testView("b")
	next.Mappings = []Mapping{fixture.mapping("skills", ".agents/skills", "read_only", "package/tool.sh", "second")}
	next.Mappings[0].Files[0].Executable = true
	second := requireProjection(t, fixture, next)
	if info, err := os.Stat(path); err != nil || (runtime.GOOS == "windows" && info.Mode().Perm()&0o200 != 0) || (runtime.GOOS != "windows" && info.Mode().Perm() != 0o500) {
		t.Fatal("normal Skill update lost executable/read-only mode", err)
	}
	skillRoot := filepath.Join(second.WorkspacePath, ".agents/skills")
	if err := os.Chmod(skillRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	local := filepath.Join(skillRoot, "local-note.txt")
	if err := os.WriteFile(local, []byte("local note"), 0o600); err != nil {
		t.Fatal(err)
	}
	requireProjection(t, fixture, testView("c"))
	if _, err := os.Stat(filepath.Join(skillRoot, "package")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("retired Skill directory survived cleanup", err)
	}
	if content, err := os.ReadFile(local); err != nil || string(content) != "local note" {
		t.Fatal("Skill cleanup removed an unowned local file", err)
	}
	conflicting := testView("d")
	conflicting.Mappings = []Mapping{fixture.mapping("skills", ".agents/skills", "read_only", "local-note.txt", "remote")}
	if _, err := fixture.store.applyTestView(context.Background(), conflicting, fixture.server.URL); !errors.Is(err, ErrContextConflict) {
		t.Fatal("new managed path overwrote local data", err)
	}
}

func TestProjectionMissingOrCorruptRecoveryMetadataPreservesFiles(t *testing.T) {
	for _, metadata := range []any{nil, `{"target":{}}`, `null`, `not-json`} {
		t.Run(fmt.Sprint(metadata), func(t *testing.T) {
			fixture := newProjectionRecoveryFixture(t)
			first := requireProjection(t, fixture, testView("a"))
			local := filepath.Join(first.WorkspacePath, "untracked-from-old-refresh.txt")
			if err := os.WriteFile(local, []byte("must preserve"), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := fixture.store.db.Exec(`UPDATE context_views_v3 SET ready=0,pending_projection_json=?`, metadata); err != nil {
				t.Fatal(err)
			}
			fixture.restart(t)
			_, err := fixture.store.applyTestView(context.Background(), testView("c"), fixture.server.URL)
			if !errors.Is(err, ErrProjectionRecoveryRequired) || errors.Is(err, ErrContextConflict) {
				t.Fatalf("unknown historic recovery state was not explicitly blocked: %v", err)
			}
			if _, err := fixture.store.CurrentView(context.Background(), first.View.ExecutionContextKey, first.View.ViewDigest); !errors.Is(err, ErrProjectionRecoveryRequired) {
				t.Fatal("inspection hid the recovery classification", err)
			}
			if content, err := os.ReadFile(local); err != nil || string(content) != "must preserve" {
				t.Fatal("metadata failure changed local files", err)
			}
		})
	}
}

func TestProjectionPendingMetadataContainsNoDownloadCapabilities(t *testing.T) {
	fixture := newProjectionRecoveryFixture(t)
	first := requireProjection(t, fixture, testView("a"))
	if err := os.WriteFile(filepath.Join(first.WorkspacePath, "inbox"), []byte("block"), 0o600); err != nil {
		t.Fatal(err)
	}
	command := testView("b")
	command.Mappings = []Mapping{fixture.mapping("documents", "documents", "read_only", "b", "b"), {Kind: "inbox_view", TargetPath: "inbox", Access: "read_only"}}
	if _, err := fixture.store.applyTestView(context.Background(), command, fixture.server.URL); err == nil {
		t.Fatal("partial failure was not injected")
	}
	var encoded string
	if err := fixture.store.db.QueryRow(`SELECT pending_projection_json FROM context_views_v3`).Scan(&encoded); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(encoded, fixture.server.URL) || strings.Contains(encoded, "download") {
		t.Fatal("pending metadata stored a download credential")
	}
	var pending pendingProjection
	if err := json.Unmarshal([]byte(encoded), &pending); err != nil || len(pending.Ownership.ReadOnlyFiles) != 1 {
		t.Fatal("pending metadata omitted the publication ownership", err)
	}
}

func TestProjectionPendingWritableTransitionPreservesFilesAfterRestart(t *testing.T) {
	fixture := newProjectionRecoveryFixture(t)
	initial := testView("a")
	initial.Mappings = []Mapping{fixture.mapping("documents", "playground", "read_only", "seed.txt", "original")}
	first := requireProjection(t, fixture, initial)
	blocker := filepath.Join(first.WorkspacePath, "inbox")
	if err := os.WriteFile(blocker, []byte("block"), 0o600); err != nil {
		t.Fatal(err)
	}
	transition := testView("b")
	transition.Mappings = []Mapping{
		fixture.mapping("playground", "playground", "read_write", "new.txt", "seeded"),
		{Kind: "inbox_view", TargetPath: "inbox", Access: "read_only"},
	}
	if _, err := fixture.store.applyTestView(context.Background(), transition, fixture.server.URL); err == nil {
		t.Fatal("mode transition did not partially fail")
	}
	local := filepath.Join(first.WorkspacePath, "playground/new.txt")
	if err := os.WriteFile(local, []byte("unpublished"), 0o600); err != nil {
		t.Fatal(err)
	}
	fixture.restart(t)
	if err := os.Remove(blocker); err != nil {
		t.Fatal(err)
	}
	next := testView("c")
	next.Mappings = []Mapping{{Kind: "playground", TargetPath: "playground", Access: "read_write"}}
	requireProjection(t, fixture, next)
	for relative, expected := range map[string]string{"seed.txt": "original", "new.txt": "unpublished"} {
		path := filepath.Join(first.WorkspacePath, "playground", relative)
		if content, err := os.ReadFile(path); err != nil || string(content) != expected {
			t.Fatalf("pending writable ownership lost %s: %v", relative, err)
		}
		if info, err := os.Stat(path); err != nil || info.Mode().Perm()&0o200 == 0 {
			t.Fatalf("recovered writable path is not writable: %s: %v", relative, err)
		}
	}
}

func TestProjectionRecoveryDoesNotRemoveModifiedPendingFile(t *testing.T) {
	fixture := newProjectionRecoveryFixture(t)
	first := requireProjection(t, fixture, testView("a"))
	blocker := filepath.Join(first.WorkspacePath, "inbox")
	if err := os.WriteFile(blocker, []byte("block"), 0o600); err != nil {
		t.Fatal(err)
	}
	next := testView("b")
	next.Mappings = []Mapping{fixture.mapping("documents", "documents", "read_only", "b.txt", "source"), {Kind: "inbox_view", TargetPath: "inbox", Access: "read_only"}}
	if _, err := fixture.store.applyTestView(context.Background(), next, fixture.server.URL); err == nil {
		t.Fatal("publication did not partially fail")
	}
	path := filepath.Join(first.WorkspacePath, "documents/b.txt")
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("edited"), 0o600); err != nil {
		t.Fatal(err)
	}
	fixture.restart(t)
	if err := os.Remove(blocker); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.store.applyTestView(context.Background(), testView("c"), fixture.server.URL); !errors.Is(err, ErrContextConflict) {
		t.Fatal("modified pending path was treated as disposable input", err)
	}
	if content, err := os.ReadFile(path); err != nil || string(content) != "edited" {
		t.Fatal("recovery removed a locally modified pending path", err)
	}
	if _, err := fixture.store.CurrentView(context.Background(), next.ExecutionContextKey, ""); !errors.Is(err, ErrContextConflict) {
		t.Fatal("modified pending path became ready with a stale file", err)
	}
}

func TestProjectionPendingOwnershipRejectsUnsafeMetadataPaths(t *testing.T) {
	for _, mutate := range []func(*pendingProjection){
		func(pending *pendingProjection) { pending.Ownership.ReadOnlyRoots = []string{"../outside"} },
		func(pending *pendingProjection) { pending.Ownership.WritableRoots = []string{"/outside"} },
		func(pending *pendingProjection) {
			pending.Ownership.ReadOnlyFiles["../outside/file"] = []projectionFileVersion{{SHA256: strings.Repeat("a", 64), SizeBytes: 0}}
		},
	} {
		fixture := newProjectionRecoveryFixture(t)
		first := requireProjection(t, fixture, testView("a"))
		if err := os.WriteFile(filepath.Join(first.WorkspacePath, "inbox"), []byte("block"), 0o600); err != nil {
			t.Fatal(err)
		}
		next := testView("b")
		next.Mappings = []Mapping{fixture.mapping("documents", "documents", "read_only", "b.txt", "b"), {Kind: "inbox_view", TargetPath: "inbox", Access: "read_only"}}
		if _, err := fixture.store.applyTestView(context.Background(), next, fixture.server.URL); err == nil {
			t.Fatal("publication did not partially fail")
		}
		record, err := fixture.store.read(context.Background(), next.ExecutionContextKey)
		if err != nil {
			t.Fatal(err)
		}
		mutate(record.Pending)
		encoded, err := json.Marshal(record.Pending)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := fixture.store.db.Exec(`UPDATE context_views_v3 SET pending_projection_json=?`, string(encoded)); err != nil {
			t.Fatal(err)
		}
		fixture.restart(t)
		if _, err := fixture.store.applyTestView(context.Background(), next, fixture.server.URL); !errors.Is(err, ErrProjectionRecoveryRequired) {
			t.Fatal("unsafe recovery metadata was not blocked", err)
		}
	}
}

// An upgraded Agent may omit every Tenant projection. Ownership survives the
// daemon restart, so obsolete managed input is removed while private work stays.
func TestTenantProjectionRemovalPreservesCommentsUserAndSkills(t *testing.T) {
	fixture := newProjectionRecoveryFixture(t)
	initial := testView("old")
	initial.Mappings = []Mapping{
		fixture.mapping("inbox_view", "room-old", "read_only", "members.json", "old-members"),
		fixture.mapping("inbox_view", "room-old", "read_only", "documents/old.html", "old-fragment"),
		fixture.mapping("inbox_view", "document-comments", "read_only", "comments.md", "comments"),
		fixture.mapping("skills", ".agents/skills", "read_only", "collaborate/SKILL.md", "skills"),
		{Kind: "playground", TargetPath: "playground", Access: "read_write"},
	}
	first := requireProjection(t, fixture, initial)
	if err := os.Chmod(filepath.Join(first.WorkspacePath, ".agents/skills"), 0o700); err != nil {
		t.Fatal(err)
	}
	for relative, content := range map[string]string{"user/notes.md": "user", "playground/output.md": "output", ".agents/skills/local/SKILL.md": "private-skill"} {
		targetPath := filepath.Join(first.WorkspacePath, filepath.FromSlash(relative))
		if err := os.MkdirAll(filepath.Dir(targetPath), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(targetPath, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	fixture.restart(t)
	next := testView("new")
	next.RuntimeInstanceID = "runtime-after-tenant-removal"
	next.Mappings = initial.Mappings[2:]
	ready := requireProjection(t, fixture, next)
	if ready.WorkspacePath != first.WorkspacePath {
		t.Fatal("upgrade changed workspace identity")
	}
	for _, relative := range []string{"room-old/members.json", "room-old/documents/old.html"} {
		if _, err := os.Stat(filepath.Join(ready.WorkspacePath, filepath.FromSlash(relative))); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("legacy Tenant file survived %s: %v", relative, err)
		}
	}
	for relative, content := range map[string]string{"document-comments/comments.md": "comments", ".agents/skills/collaborate/SKILL.md": "skills", "user/notes.md": "user", "playground/output.md": "output", ".agents/skills/local/SKILL.md": "private-skill"} {
		actual, err := os.ReadFile(filepath.Join(ready.WorkspacePath, filepath.FromSlash(relative)))
		if err != nil || string(actual) != content {
			t.Fatalf("upgrade changed retained file %s: %v", relative, err)
		}
	}
}
