package lingercontext

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestProjectionOwnershipMergeAcceptsZeroValueAndRetainsVersions(t *testing.T) {
	ownership := projectionOwnership{}
	first := projectionFileVersion{SHA256: strings.Repeat("a", 64), SizeBytes: 1}
	second := projectionFileVersion{SHA256: strings.Repeat("b", 64), SizeBytes: 2}
	ownership.merge(projectionOwnership{ReadOnlyFiles: map[string][]projectionFileVersion{"documents/file": {first}}})
	ownership.merge(projectionOwnership{ReadOnlyFiles: map[string][]projectionFileVersion{"documents/file": {first, second}}})
	if len(ownership.ReadOnlyFiles["documents/file"]) != 2 {
		t.Fatal("ownership lost or duplicated a retained file version")
	}
}

func TestProjectionRecoveryAccumulatesOwnershipAcrossMultipleFailures(t *testing.T) {
	for _, restart := range []bool{false, true} {
		t.Run(fmt.Sprintf("restart=%t", restart), func(t *testing.T) {
			fixture := newProjectionRecoveryFixture(t)
			initial := testView("a")
			initial.Mappings = []Mapping{
				fixture.mapping("documents", "documents", "read_only", "a.txt", "source-a"),
				{Kind: "playground", TargetPath: "playground", Access: "read_write"},
			}
			first := requireProjection(t, fixture, initial)
			workspaceInfo, err := os.Stat(first.WorkspacePath)
			if err != nil {
				t.Fatal(err)
			}
			localPath := filepath.Join(first.WorkspacePath, "playground", "unpublished.txt")
			if err := os.WriteFile(localPath, []byte("unpublished-local"), 0o600); err != nil {
				t.Fatal(err)
			}
			blocker := filepath.Join(first.WorkspacePath, "inbox")
			if err := os.WriteFile(blocker, []byte("block-directory"), 0o600); err != nil {
				t.Fatal(err)
			}
			for _, generation := range []string{"b", "c"} {
				command := testView(generation)
				command.Mappings = []Mapping{
					fixture.mapping("documents", "documents", "read_only", generation+".txt", "source-"+generation),
					fixture.mapping("skills", ".agents/skills", "read_only", "package-"+generation+"/SKILL.md", "skill-"+generation),
					{Kind: "inbox_view", TargetPath: "inbox", Access: "read_only"},
					{Kind: "playground", TargetPath: "playground", Access: "read_write"},
				}
				if _, err := fixture.store.applyTestView(context.Background(), command, fixture.server.URL); err == nil {
					t.Fatal("publication failure was not injected")
				}
				if _, err := os.Stat(filepath.Join(first.WorkspacePath, "documents", generation+".txt")); err != nil {
					t.Fatal("the requested generation was not partially published", err)
				}
				if _, err := fixture.store.CurrentView(context.Background(), initial.ExecutionContextKey, ""); !errors.Is(err, ErrContextConflict) {
					t.Fatal("partial publication remained ready", err)
				}
				if restart {
					fixture.restart(t)
				}
			}
			if err := os.Remove(blocker); err != nil {
				t.Fatal(err)
			}
			final := testView("d")
			final.Mappings = []Mapping{
				fixture.mapping("documents", "documents", "read_only", "d.txt", "source-d"),
				{Kind: "playground", TargetPath: "playground", Access: "read_write"},
			}
			ready := requireProjection(t, fixture, final)
			for _, relative := range []string{"documents/a.txt", "documents/b.txt", "documents/c.txt", ".agents/skills/package-b", ".agents/skills/package-c", ".agents/skills"} {
				if _, err := os.Lstat(filepath.Join(ready.WorkspacePath, relative)); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("D is ready with stale owned path %s: %v", relative, err)
				}
			}
			content, err := os.ReadFile(localPath)
			if err != nil || string(content) != "unpublished-local" {
				t.Fatal("recovery removed unpublished local work", err)
			}
			after, err := os.Stat(ready.WorkspacePath)
			if err != nil || !os.SameFile(workspaceInfo, after) {
				t.Fatal("recovery replaced the provider cwd", err)
			}
			var pending any
			if err := fixture.store.db.QueryRow(`SELECT pending_projection_json FROM context_views_v3 WHERE execution_context_key=?`, initial.ExecutionContextKey).Scan(&pending); err != nil || pending != nil {
				t.Fatal("a ready View retained pending ownership", err)
			}
		})
	}
}

func TestProjectionPendingCommitFailureDoesNotTouchWorkspace(t *testing.T) {
	fixture := newProjectionRecoveryFixture(t)
	initial := testView("a")
	initial.Mappings = []Mapping{fixture.mapping("documents", "documents", "read_only", "same.txt", "source-a")}
	first := requireProjection(t, fixture, initial)
	if _, err := fixture.store.db.Exec(`CREATE TRIGGER reject_pending BEFORE UPDATE OF pending_projection_json ON context_views_v3 WHEN NEW.pending_projection_json IS NOT NULL BEGIN SELECT RAISE(FAIL,'injected pending failure'); END`); err != nil {
		t.Fatal(err)
	}
	next := testView("b")
	next.Mappings = []Mapping{fixture.mapping("documents", "documents", "read_only", "same.txt", "source-b")}
	if _, err := fixture.store.applyTestView(context.Background(), next, fixture.server.URL); err == nil {
		t.Fatal("pending commit failure did not reject publication")
	}
	content, err := os.ReadFile(filepath.Join(first.WorkspacePath, "documents/same.txt"))
	if err != nil || string(content) != "source-a" {
		t.Fatal("workspace changed before pending ownership committed", err)
	}
	if _, err := fixture.store.CurrentView(context.Background(), initial.ExecutionContextKey, initial.ViewDigest); err != nil {
		t.Fatal("failed pending commit invalidated the previous View", err)
	}
}

func TestProjectionFinalCommitFailureRetainsOwnershipAcrossRestart(t *testing.T) {
	fixture := newProjectionRecoveryFixture(t)
	first := requireProjection(t, fixture, testView("a"))
	next := testView("b")
	if _, err := fixture.store.db.Exec(`CREATE TRIGGER reject_ready BEFORE UPDATE OF ready ON context_views_v3 WHEN NEW.ready=1 AND json_extract(NEW.view_json,'$.view_digest')='` + next.ViewDigest + `' BEGIN SELECT RAISE(FAIL,'injected ready failure'); END`); err != nil {
		t.Fatal(err)
	}
	next.Mappings = []Mapping{fixture.mapping("documents", "documents", "read_only", "b.txt", "source-b")}
	if _, err := fixture.store.applyTestView(context.Background(), next, fixture.server.URL); err == nil {
		t.Fatal("ready commit failure did not fail")
	}
	if _, err := os.Stat(filepath.Join(first.WorkspacePath, "documents/b.txt")); err != nil {
		t.Fatal("files were not published before the injected commit failure", err)
	}
	fixture.restart(t)
	if _, err := fixture.store.CurrentView(context.Background(), next.ExecutionContextKey, ""); !errors.Is(err, ErrContextConflict) {
		t.Fatal("failed receipt commit remained ready", err)
	}
	final := testView("c")
	ready := requireProjection(t, fixture, final)
	if _, err := os.Stat(filepath.Join(ready.WorkspacePath, "documents/b.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("failed receipt commit lost file ownership", err)
	}
}

type projectionRecoveryFixture struct {
	store        *ViewStore
	databasePath string
	viewsPath    string
	server       *httptest.Server
	mu           sync.Mutex
	bodies       map[string]string
}

func newProjectionRecoveryFixture(t *testing.T) *projectionRecoveryFixture {
	t.Helper()
	root := t.TempDir()
	fixture := &projectionRecoveryFixture{databasePath: filepath.Join(root, "views.sqlite"), viewsPath: filepath.Join(root, "views"), bodies: map[string]string{}}
	fixture.server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		fixture.mu.Lock()
		body := fixture.bodies[strings.TrimPrefix(request.URL.Path, "/files/")]
		fixture.mu.Unlock()
		_, _ = writer.Write([]byte(body))
	}))
	var err error
	fixture.store, err = OpenViewStore(fixture.databasePath, fixture.viewsPath, fixture.server.Client())
	if err != nil {
		fixture.server.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = fixture.store.Close()
		fixture.server.Close()
		if err := filepath.WalkDir(fixture.viewsPath, func(path string, entry fs.DirEntry, err error) error {
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			if err != nil {
				return err
			}
			if entry.IsDir() {
				return os.Chmod(path, 0o700)
			}
			return nil
		}); err != nil {
			t.Error(err)
		}
	})
	return fixture
}

func (fixture *projectionRecoveryFixture) restart(t *testing.T) {
	t.Helper()
	if err := fixture.store.Close(); err != nil {
		t.Fatal(err)
	}
	var err error
	fixture.store, err = OpenViewStore(fixture.databasePath, fixture.viewsPath, fixture.server.Client())
	if err != nil {
		t.Fatal(err)
	}
}

func (fixture *projectionRecoveryFixture) mapping(kind, root, access, relative, content string) Mapping {
	digest := sha256.Sum256([]byte(content))
	input := FileInput{RelativePath: relative, SizeBytes: int64(len(content)), SHA256: hex.EncodeToString(digest[:])}
	fixture.mu.Lock()
	fixture.bodies[input.SHA256] = content
	fixture.mu.Unlock()
	return Mapping{Kind: kind, TargetPath: root, Access: access, Files: []FileInput{input}}
}

func requireProjection(t *testing.T, fixture *projectionRecoveryFixture, command View) ViewRecord {
	t.Helper()
	record, err := fixture.store.applyTestView(context.Background(), command, fixture.server.URL)
	if err != nil {
		t.Fatal(err)
	}
	return record
}
