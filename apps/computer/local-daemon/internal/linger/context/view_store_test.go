package lingercontext

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func openTestStore(t *testing.T) *ViewStore {
	t.Helper()
	store, err := OpenViewStore(filepath.Join(t.TempDir(), "state.sqlite"), filepath.Join(t.TempDir(), "views"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = store.Close()
		makeWritable(store.root)
	})
	return store
}

func makeWritable(root string) {
	_ = filepath.Walk(root, func(path string, _ os.FileInfo, err error) error {
		if err == nil {
			_ = os.Chmod(path, 0o700)
		}
		return nil
	})
}

func TestEnsureFetchesTheNamedViewOnceAndReusesIt(t *testing.T) {
	content := newTestContent(t)
	store := openTestStore(t)
	message := content.file("message.txt", []byte("hello context\n"))
	digest := content.publish(t, "context-1", "runtime-1", []Mapping{
		{Kind: "inbox_view", TargetPath: "inbox", Access: "read_only", Files: []FileInput{message}},
	}, nil, nil)
	source := ContentSource{ContentURL: content.url()}
	record, err := store.Ensure(t.Context(), testRequest("context-1", digest), source)
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(record.WorkspacePath, "inbox", "message.txt"))
	if err != nil || string(got) != "hello context\n" {
		t.Fatalf("content=%q err=%v", got, err)
	}
	if requests := content.takeRequests(); len(requests) != 2 {
		t.Fatalf("first Ensure requests=%v, want the manifest and one file", requests)
	}
	again, err := store.Ensure(t.Context(), testRequest("context-1", digest), source)
	if err != nil || again.WorkspacePath != record.WorkspacePath {
		t.Fatalf("repeat Ensure=%+v err=%v", again, err)
	}
	if requests := content.takeRequests(); len(requests) != 0 {
		t.Fatalf("a View at its digest made requests: %v", requests)
	}
	if path, err := store.ValidatedWorkspace(t.Context(), "context-1", json.RawMessage(`{"view_digest":"`+digest+`"}`)); err != nil || path != record.WorkspacePath {
		t.Fatalf("validated=%q err=%v", path, err)
	}
	other := strings.Repeat("a", 64)
	if _, err := store.ValidatedWorkspace(t.Context(), "context-1", json.RawMessage(`{"view_digest":"`+other+`"}`)); !errors.Is(err, ErrContextConflict) {
		t.Fatalf("another digest validated: %v", err)
	}
}

func TestEnsureDownloadsOnlyChangedFilesAndKeepsLocalWork(t *testing.T) {
	content := newTestContent(t)
	store := openTestStore(t)
	kept := content.file("kept.md", []byte("unchanged\n"))
	first := content.file("note.md", []byte("first\n"))
	removed := content.file("old.md", []byte("removed later\n"))
	digest := content.publish(t, "context-1", "runtime-1", []Mapping{
		{Kind: "memory", TargetPath: "memory", Access: "read_only", Files: []FileInput{kept, first, removed}},
		{Kind: "playground", TargetPath: "playground", Access: "read_write"},
	}, nil, nil)
	source := ContentSource{ContentURL: content.url()}
	record, err := store.Ensure(t.Context(), testRequest("context-1", digest), source)
	if err != nil {
		t.Fatal(err)
	}
	local := filepath.Join(record.WorkspacePath, "playground", "work.txt")
	if err := os.WriteFile(local, []byte("agent work"), 0o600); err != nil {
		t.Fatal(err)
	}
	content.takeRequests()
	second := content.file("note.md", []byte("second\n"))
	next := content.publish(t, "context-1", "runtime-1", []Mapping{
		{Kind: "memory", TargetPath: "memory", Access: "read_only", Files: []FileInput{kept, second}},
		{Kind: "playground", TargetPath: "playground", Access: "read_write"},
	}, nil, nil)
	if _, err := store.Ensure(t.Context(), testRequest("context-1", next), source); err != nil {
		t.Fatal(err)
	}
	requests := content.takeRequests()
	if len(requests) != 2 || requests[1] != "files/"+second.SHA256 {
		t.Fatalf("refresh requests=%v, want the manifest and the changed file only", requests)
	}
	if got, err := os.ReadFile(filepath.Join(record.WorkspacePath, "memory", "note.md")); err != nil || string(got) != "second\n" {
		t.Fatalf("changed file=%q err=%v", got, err)
	}
	if _, err := os.Stat(filepath.Join(record.WorkspacePath, "memory", "old.md")); !os.IsNotExist(err) {
		t.Fatalf("removed read-only file remains: %v", err)
	}
	if got, err := os.ReadFile(local); err != nil || string(got) != "agent work" {
		t.Fatalf("local work=%q err=%v", got, err)
	}
}

func TestEnsureRejectsAManifestThatIsNotItsDigest(t *testing.T) {
	content := newTestContent(t)
	store := openTestStore(t)
	digest := content.publish(t, "context-1", "runtime-1", nil, nil, nil)
	content.mu.Lock()
	content.manifests[digest] = []byte(`{"version":1,"execution_context_key":"context-1","runtime_instance_id":"runtime-1","mappings":[],"skills":[]} `)
	content.mu.Unlock()
	if _, err := store.Ensure(t.Context(), testRequest("context-1", digest), ContentSource{ContentURL: content.url()}); err == nil || !strings.Contains(err.Error(), "does not match its digest") {
		t.Fatalf("a manifest that is not its digest was accepted: %v", err)
	}
}

func TestEnsureRejectsAManifestOfAnotherContext(t *testing.T) {
	content := newTestContent(t)
	store := openTestStore(t)
	digest := content.publish(t, "context-2", "runtime-1", nil, nil, nil)
	if _, err := store.Ensure(t.Context(), testRequest("context-1", digest), ContentSource{ContentURL: content.url()}); err == nil {
		t.Fatal("a manifest of another Context was accepted")
	}
}

func TestEnsureReportsAChangedOrMissingSourceAsRetryable(t *testing.T) {
	content := newTestContent(t)
	store := openTestStore(t)
	file := content.file("note.md", []byte("note\n"))
	digest := content.publish(t, "context-1", "runtime-1", []Mapping{
		{Kind: "memory", TargetPath: "memory", Access: "read_only", Files: []FileInput{file}},
	}, nil, nil)
	content.mu.Lock()
	content.status["files/"+file.SHA256] = http.StatusConflict
	content.mu.Unlock()
	source := ContentSource{ContentURL: content.url()}
	if _, err := store.Ensure(t.Context(), testRequest("context-1", digest), source); !errors.Is(err, ErrInputDownloadUnavailable) {
		t.Fatalf("changed source error=%v, want retryable", err)
	}
	if _, err := store.Ensure(t.Context(), testRequest("context-1", strings.Repeat("b", 64)), source); !errors.Is(err, ErrInputDownloadUnavailable) {
		t.Fatalf("unknown View error=%v, want retryable", err)
	}
	if _, err := store.Ensure(t.Context(), testRequest("context-1", digest), ContentSource{}); !errors.Is(err, ErrInputDownloadUnavailable) {
		t.Fatalf("missing content URL error=%v, want retryable", err)
	}
	content.mu.Lock()
	delete(content.status, "files/"+file.SHA256)
	content.mu.Unlock()
	if _, err := store.Ensure(t.Context(), testRequest("context-1", digest), source); err != nil {
		t.Fatalf("retry after the source recovered: %v", err)
	}
}

func TestViewStoreSkipsIdenticalDuplicateFiles(t *testing.T) {
	content := []byte("shared document\n")
	digest := sha256.Sum256(content)
	sha := hex.EncodeToString(digest[:])
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) { _, _ = writer.Write(content) }))
	defer server.Close()
	file := func(relative, digest string) FileInput {
		return FileInput{RelativePath: relative, MediaType: "text/markdown", SizeBytes: int64(len(content)), SHA256: digest}
	}
	view := testView("view-dup")
	view.Mappings = []Mapping{
		{Kind: "inbox_view", TargetPath: "room-1", Access: "read_only", Files: []FileInput{file("documents/note.md", sha)}},
		{Kind: "memory", TargetPath: "room-1/documents", Access: "read_only", Files: []FileInput{file("note.md", sha)}},
	}
	store := openTestStore(t)
	record, err := store.applyTestView(t.Context(), view, server.URL)
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(record.WorkspacePath, "room-1", "documents", "note.md"))
	if err != nil || string(got) != string(content) {
		t.Fatalf("content=%q err=%v", got, err)
	}

	otherDigest := sha256.Sum256([]byte("other document\n"))
	other := hex.EncodeToString(otherDigest[:])
	conflict := testView("view-conflict")
	conflict.Mappings = []Mapping{
		{Kind: "inbox_view", TargetPath: "room-1", Access: "read_only", Files: []FileInput{file("documents/note.md", sha)}},
		{Kind: "memory", TargetPath: "room-1/documents", Access: "read_only", Files: []FileInput{file("note.md", other)}},
	}
	conflictStore := openTestStore(t)
	if _, err := conflictStore.applyTestView(t.Context(), conflict, server.URL); err == nil || !strings.Contains(err.Error(), "maps multiple files to one path") {
		t.Fatalf("different duplicate=%v", err)
	}
}

func TestValidatedWorkspaceRejectsMalformedReferences(t *testing.T) {
	store := openTestStore(t)
	view := testView("view-1")
	if _, err := store.applyTestView(t.Context(), view, ""); err != nil {
		t.Fatal(err)
	}
	for name, ref := range map[string]string{
		"bad JSON":       `{invalid`,
		"empty digest":   `{"view_digest":""}`,
		"invalid digest": `{"view_digest":"wrong"}`,
	} {
		if _, err := store.ValidatedWorkspace(t.Context(), "context-1", json.RawMessage(ref)); err == nil {
			t.Fatalf("%s was validated", name)
		}
	}
	if _, err := store.ValidatedWorkspace(t.Context(), "", json.RawMessage(`{"view_digest":"`+view.ViewDigest+`"}`)); err == nil {
		t.Fatal("an empty Context key was validated")
	}
	if _, err := store.ValidatedWorkspace(t.Context(), "missing", json.RawMessage(`{"view_digest":"`+view.ViewDigest+`"}`)); err == nil {
		t.Fatal("a missing Context was validated")
	}
}

func TestViewStoreRequiresTheViewOwner(t *testing.T) {
	for _, clear := range []func(*View){
		func(view *View) { view.TenantID = "" },
		func(view *View) { view.AgentID = "" },
		func(view *View) { view.WorkspaceGrantID = "" },
		func(view *View) { view.ViewDigest = "view" },
	} {
		view := testView("view-1")
		clear(&view)
		if err := validateView(view); !errors.Is(err, ErrContextConflict) {
			t.Fatalf("incomplete View accepted: %v", err)
		}
	}
	store := openTestStore(t)
	if _, err := store.applyTestView(t.Context(), testView("view-1"), ""); err != nil {
		t.Fatal(err)
	}
	other := testView("view-2")
	other.AgentID = "agent-2"
	if _, err := store.applyTestView(t.Context(), other, ""); !errors.Is(err, ErrContextConflict) {
		t.Fatalf("another owner's View replaced the Context: %v", err)
	}
}

func TestStoreDropsViewsWrittenBeforeDigestsWithTheirWorkspaces(t *testing.T) {
	directory := t.TempDir()
	database := filepath.Join(directory, "views.sqlite")
	root := filepath.Join(directory, "views")
	content := newTestContent(t)
	store, err := OpenViewStore(database, root, nil)
	if err != nil {
		t.Fatal(err)
	}
	stale := content.file("note.md", []byte("old\n"))
	view := testView("view-before")
	view.Mappings = []Mapping{{Kind: "memory", TargetPath: "memory", Access: "read_only", Files: []FileInput{stale}}}
	record, err := store.applyTestView(t.Context(), view, content.url())
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(record.View)
	if err != nil {
		t.Fatal(err)
	}
	// The shape a store kept before Views were named by digest.
	for _, statement := range []string{
		`DROP TABLE context_views_v3`,
		`CREATE TABLE context_views_v2 (execution_context_key TEXT PRIMARY KEY, command_id TEXT NOT NULL, command_digest TEXT NOT NULL, command_json TEXT NOT NULL, receipt_ref TEXT NOT NULL, workspace_path TEXT NOT NULL, released INTEGER NOT NULL, ready INTEGER NOT NULL DEFAULT 1, pending_projection_json TEXT) STRICT`,
		`CREATE TABLE context_command_outcomes (command_id TEXT PRIMARY KEY, command_digest TEXT NOT NULL, record_json TEXT NOT NULL) STRICT`,
	} {
		if _, err := store.db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.db.Exec(`INSERT INTO context_views_v2 VALUES('context-1','command-1','digest',?,'receipt-1',?,1,1,NULL)`, string(encoded), record.WorkspacePath); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenViewStore(database, root, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = reopened.Close()
		makeWritable(root)
	}()
	var tables int
	if err := reopened.db.QueryRow(`SELECT count(*) FROM sqlite_master WHERE name IN ('context_views_v2','context_command_outcomes')`).Scan(&tables); err != nil || tables != 0 {
		t.Fatalf("old tables=%d err=%v", tables, err)
	}
	if _, err := reopened.CurrentView(t.Context(), "context-1", ""); err == nil {
		t.Fatal("an old row survived the hard cut")
	}
	if _, err := os.Lstat(record.WorkspacePath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("old workspace survived: %v", err)
	}
	fresh := content.file("note.md", []byte("new\n"))
	digest := content.publish(t, "context-1", "runtime-1", []Mapping{
		{Kind: "memory", TargetPath: "memory", Access: "read_only", Files: []FileInput{fresh}},
	}, nil, nil)
	ensured, err := reopened.Ensure(t.Context(), testRequest("context-1", digest), ContentSource{ContentURL: content.url()})
	if err != nil {
		t.Fatalf("fetch the View into a fresh workspace: %v", err)
	}
	if got, err := os.ReadFile(filepath.Join(ensured.WorkspacePath, "memory", "note.md")); err != nil || string(got) != "new\n" {
		t.Fatalf("fresh file=%q err=%v", got, err)
	}
}

func TestEnsureSerializesOneContextAndFetchesOnce(t *testing.T) {
	content := newTestContent(t)
	store := openTestStore(t)
	file := content.file("note.md", []byte("note\n"))
	digest := content.publish(t, "context-1", "runtime-1", []Mapping{
		{Kind: "memory", TargetPath: "memory", Access: "read_only", Files: []FileInput{file}},
	}, nil, nil)
	source := ContentSource{ContentURL: content.url()}
	errs := make(chan error, 4)
	for range 4 {
		go func() {
			_, err := store.Ensure(context.Background(), testRequest("context-1", digest), source)
			errs <- err
		}()
	}
	for range 4 {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
	if requests := content.takeRequests(); len(requests) != 2 {
		t.Fatalf("concurrent Ensure requests=%v, want one fetch", requests)
	}
}

func TestOpenClearsTheSkillPackageCache(t *testing.T) {
	directory := t.TempDir()
	root := filepath.Join(directory, "views")
	leftover := filepath.Join(root, ".skill-packages", ".package-crashed", "files", "SKILL.md")
	if err := os.MkdirAll(filepath.Dir(leftover), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(leftover, []byte("stale\n"), 0o400); err != nil {
		t.Fatal(err)
	}
	store, err := OpenViewStore(filepath.Join(directory, "views.sqlite"), root, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	if _, err := os.Lstat(filepath.Join(root, ".skill-packages")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("Skill package cache survived open: %v", err)
	}
}
