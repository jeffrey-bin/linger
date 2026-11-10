package lingercontext

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/workspace"
)

const (
	testMetaKey  = `["meta","agent-1","room","room-1"]`
	testAlterKey = `["alter_ego","agent-1","task-1"]`
)

type sharedTaskFixture struct {
	database string
	views    string
	tasks    string
	store    *ViewStore
}

func openSharedTaskFixture(t *testing.T) *sharedTaskFixture {
	t.Helper()
	root := t.TempDir()
	fixture := &sharedTaskFixture{
		database: filepath.Join(root, "context-views.sqlite"),
		views:    filepath.Join(root, "context-views"),
		tasks:    filepath.Join(root, "task-workspaces"),
	}
	fixture.reopen(t)
	return fixture
}

func (f *sharedTaskFixture) reopen(t *testing.T) {
	t.Helper()
	store, err := OpenViewStore(f.database, f.views, nil)
	if err != nil {
		t.Fatal(err)
	}
	store.shared.poll = 50 * time.Millisecond
	if err := store.UseSharedTaskStorage(LocalSharedTaskStorage(f.tasks)); err != nil {
		t.Fatal(err)
	}
	f.store = store
	t.Cleanup(func() { _ = store.Close() })
}

func (f *sharedTaskFixture) roomTasks() string {
	return filepath.Join(f.tasks, "tenants", SharedTaskKey("tenant-1"), "agents", SharedTaskKey("agent-1"), "rooms", SharedTaskKey("room-1"), "tasks")
}

func metaScope() *SharedTaskScope {
	return &SharedTaskScope{Version: 1, TenantID: "tenant-1", AgentID: "agent-1", OriginRoomID: "room-1", Role: "meta"}
}

func alterScope(taskID, roomID string) *SharedTaskScope {
	return &SharedTaskScope{Version: 1, TenantID: "tenant-1", AgentID: "agent-1", OriginRoomID: roomID, Role: "alter_ego", TaskID: taskID}
}

func scopedView(generation, key string, scope *SharedTaskScope) View {
	view := testView(generation)
	view.ExecutionContextKey = key
	view.SharedTaskScope = scope
	return view
}

func applyScoped(t *testing.T, store *ViewStore, view View) ViewRecord {
	t.Helper()
	record, err := store.applyTestView(context.Background(), view, "")
	if err != nil {
		t.Fatalf("apply %s: %v", view.ExecutionContextKey, err)
	}
	return record
}

func waitFor(t *testing.T, timeout time.Duration, what string, ready func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !ready() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func readsAs(path, content string) func() bool {
	return func() bool {
		data, err := os.ReadFile(path)
		return err == nil && string(data) == content
	}
}

func TestSharedTaskKeyHashesIdentity(t *testing.T) {
	// Node: createHash("sha256").update(value).digest("hex").slice(0, 48)
	for value, expected := range map[string]string{
		"tenant-1": "0a96abb33b07ff0e8f48bcc4893e0e7346bff899dd316979",
		"Größe":    "aedc3f80989a6546962705852b2f4a481dbd1e4907606935",
	} {
		if got := SharedTaskKey(value); got != expected {
			t.Fatalf("SharedTaskKey(%q) = %s, want %s", value, got, expected)
		}
	}
}

func TestSharedTaskLinksShareOneTaskBetweenTwoContexts(t *testing.T) {
	fixture := openSharedTaskFixture(t)
	meta := applyScoped(t, fixture.store, scopedView("meta-1", testMetaKey, metaScope()))
	alter := applyScoped(t, fixture.store, scopedView("alter-1", testAlterKey, alterScope("task-1", "room-1")))

	taskRoot := filepath.Join(fixture.roomTasks(), "task-1")
	info, err := os.Lstat(taskRoot)
	if err != nil || !realDirectory(info) {
		t.Fatalf("alter_ego Task directory: %v %v", info, err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o700 {
		t.Fatalf("Task directory mode = %v", info.Mode().Perm())
	}
	alterLink := filepath.Join(alter.WorkspacePath, "playground", "task-1")
	if target, err := os.Readlink(alterLink); err != nil || target != taskRoot {
		t.Fatalf("alter_ego link = %q %v", target, err)
	}
	if err := os.WriteFile(filepath.Join(alterLink, "report.md"), []byte("first"), 0o600); err != nil {
		t.Fatal(err)
	}
	metaReport := filepath.Join(meta.WorkspacePath, "playground", "task-1", "report.md")
	// The alter_ego activation kicks the Meta; the periodic check is a backstop.
	waitFor(t, time.Second, "Meta to read the alter_ego report", readsAs(metaReport, "first"))
	// A complete replacement on the same file system is visible on reopen.
	temporary := filepath.Join(alterLink, ".report.md.tmp")
	if err := os.WriteFile(temporary, []byte("second"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(temporary, filepath.Join(alterLink, "report.md")); err != nil {
		t.Fatal(err)
	}
	if !readsAs(metaReport, "second")() {
		t.Fatal("Meta did not read the replaced report")
	}
	// Ordinary playground files stay private to each Context.
	if err := os.WriteFile(filepath.Join(alter.WorkspacePath, "playground", "scratch.txt"), []byte("own"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(meta.WorkspacePath, "playground", "scratch.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("ordinary playground file leaked: %v", err)
	}
	access, err := fixture.store.SharedTaskAccess(context.Background(), testAlterKey, alter.View.ViewDigest)
	if err != nil || access.WritableTaskRoot != taskRoot || access.WritableTaskLink != filepath.Join("playground", "task-1") || access.ReadableTasksRoot != "" {
		t.Fatalf("alter_ego access = %+v %v", access, err)
	}
	access, err = fixture.store.SharedTaskAccess(context.Background(), testMetaKey, meta.View.ViewDigest)
	if err != nil || access.ReadableTasksRoot != fixture.roomTasks() || access.WritableTaskRoot != "" {
		t.Fatalf("Meta access = %+v %v", access, err)
	}
}

func TestMetaDiscoversConcurrentlyCreatedTasksWithinPollInterval(t *testing.T) {
	fixture := openSharedTaskFixture(t)
	fixture.store.shared.poll = 200 * time.Millisecond
	meta := applyScoped(t, fixture.store, scopedView("meta-1", testMetaKey, metaScope()))
	// Tasks created by another daemon (a Worker on the same volume) arrive
	// without a local kick.
	var group sync.WaitGroup
	const count = 20
	for index := range count {
		group.Add(1)
		go func() {
			defer group.Done()
			if err := os.Mkdir(filepath.Join(fixture.roomTasks(), fmt.Sprintf("task-%02d", index)), 0o700); err != nil {
				t.Error(err)
			}
		}()
	}
	group.Wait()
	for _, invalid := range []string{".hidden", "bad name"} {
		if err := os.Mkdir(filepath.Join(fixture.roomTasks(), invalid), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(fixture.roomTasks(), "not-a-task"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	playground := filepath.Join(meta.WorkspacePath, "playground")
	waitFor(t, 2*time.Second, "every concurrent Task link", func() bool {
		for index := range count {
			if _, err := os.Stat(filepath.Join(playground, fmt.Sprintf("task-%02d", index))); err != nil {
				return false
			}
		}
		return true
	})
	for _, name := range []string{".hidden", "bad name", "not-a-task"} {
		if _, err := os.Lstat(filepath.Join(playground, name)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%q was linked: %v", name, err)
		}
	}
	for index := range count {
		name := fmt.Sprintf("task-%02d", index)
		if target, err := os.Readlink(filepath.Join(playground, name)); err != nil || target != filepath.Join(fixture.roomTasks(), name) {
			t.Fatalf("%s link = %q %v", name, target, err)
		}
	}
}

func TestSharedTaskLinksAndDiscoveryRestoreAfterRestart(t *testing.T) {
	fixture := openSharedTaskFixture(t)
	meta := applyScoped(t, fixture.store, scopedView("meta-1", testMetaKey, metaScope()))
	alter := applyScoped(t, fixture.store, scopedView("alter-1", testAlterKey, alterScope("task-1", "room-1")))
	if err := os.WriteFile(filepath.Join(alter.WorkspacePath, "playground", "task-1", "report.md"), []byte("kept"), 0o600); err != nil {
		t.Fatal(err)
	}
	waitFor(t, time.Second, "Meta link", readsAs(filepath.Join(meta.WorkspacePath, "playground", "task-1", "report.md"), "kept"))
	if err := fixture.store.Close(); err != nil {
		t.Fatal(err)
	}
	fixture.reopen(t)
	if err := os.Mkdir(filepath.Join(fixture.roomTasks(), "task-2"), 0o700); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 2*time.Second, "restored Meta discovery", func() bool {
		_, err := os.Stat(filepath.Join(meta.WorkspacePath, "playground", "task-2"))
		return err == nil
	})
	if !readsAs(filepath.Join(meta.WorkspacePath, "playground", "task-1", "report.md"), "kept")() {
		t.Fatal("Meta lost the Task link across restart")
	}
	// A newer View with the same scope reuses the registered link.
	restored := scopedView("alter-2", testAlterKey, alterScope("task-1", "room-1"))
	record := applyScoped(t, fixture.store, restored)
	if !readsAs(filepath.Join(record.WorkspacePath, "playground", "task-1", "report.md"), "kept")() {
		t.Fatal("restored alter_ego lost its Task")
	}
}

func TestSharedTaskScopeMustMatchContextAndRegistration(t *testing.T) {
	fixture := openSharedTaskFixture(t)
	store := fixture.store
	for name, command := range map[string]View{
		"meta on alter_ego key":  scopedView("bad", testAlterKey, metaScope()),
		"other task":             scopedView("bad", testAlterKey, alterScope("task-2", "room-1")),
		"other room meta":        scopedView("bad", `["meta","agent-1","room","room-2"]`, metaScope()),
		"cross-room meta key":    scopedView("bad", `["meta","agent-1"]`, metaScope()),
		"meta with task":         scopedView("bad", testMetaKey, &SharedTaskScope{Version: 1, TenantID: "tenant-1", AgentID: "agent-1", OriginRoomID: "room-1", Role: "meta", TaskID: "task-1"}),
		"other tenant":           scopedView("bad", testAlterKey, &SharedTaskScope{Version: 1, TenantID: "tenant-2", AgentID: "agent-1", OriginRoomID: "room-1", Role: "alter_ego", TaskID: "task-1"}),
		"other agent":            scopedView("bad", `["alter_ego","agent-2","task-1"]`, &SharedTaskScope{Version: 1, TenantID: "tenant-1", AgentID: "agent-2", OriginRoomID: "room-1", Role: "alter_ego", TaskID: "task-1"}),
		"version 2":              scopedView("bad", testAlterKey, &SharedTaskScope{Version: 2, TenantID: "tenant-1", AgentID: "agent-1", OriginRoomID: "room-1", Role: "alter_ego", TaskID: "task-1"}),
		"path segment task":      scopedView("bad", `["alter_ego","agent-1",".."]`, alterScope("..", "room-1")),
		"read-only playground":   withMapping(scopedView("bad", testAlterKey, alterScope("task-1", "room-1")), "playground", "read_only"),
		"read-only parent above": withMapping(scopedView("bad", testAlterKey, alterScope("task-1", "room-1")), "playground/task-1/x", "read_only"),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := store.applyTestView(context.Background(), command, ""); err == nil {
				t.Fatal("invalid scope accepted")
			}
		})
	}
	if _, err := os.Stat(fixture.tasks); err == nil {
		if entries, _ := os.ReadDir(fixture.tasks); len(entries) != 0 {
			t.Fatalf("an invalid scope created shared directories: %v", entries)
		}
	}

	applyScoped(t, store, scopedView("alter-1", testAlterKey, alterScope("task-1", "room-1")))
	refresh := scopedView("alter-2", testAlterKey, alterScope("task-1", "room-2"))
	if _, err := store.applyTestView(context.Background(), refresh, ""); !errors.Is(err, ErrSharedTaskScopeConflict) {
		t.Fatalf("refresh with another origin = %v", err)
	}
	refresh.SharedTaskScope = nil
	if _, err := store.applyTestView(context.Background(), refresh, ""); !errors.Is(err, ErrSharedTaskScopeConflict) {
		t.Fatalf("refresh without the scope = %v", err)
	}
	refresh.SharedTaskScope = alterScope("task-1", "room-1")
	refreshed := applyScoped(t, store, refresh)
	moved := scopedView("alter-3", testAlterKey, alterScope("task-1", "room-2"))
	if _, err := store.applyTestView(context.Background(), moved, ""); !errors.Is(err, ErrSharedTaskScopeConflict) {
		t.Fatalf("restore with another origin = %v", err)
	}
	if _, err := os.Stat(filepath.Join(fixture.tasks, "tenants", SharedTaskKey("tenant-1"), "agents", SharedTaskKey("agent-1"), "rooms", SharedTaskKey("room-2"))); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a refused scope created the other origin: %v", err)
	}
	moved.SharedTaskScope = nil
	if _, err := store.applyTestView(context.Background(), moved, ""); !errors.Is(err, ErrSharedTaskScopeConflict) {
		t.Fatalf("restore without the registered scope = %v", err)
	}
	if target, err := os.Readlink(filepath.Join(refreshed.WorkspacePath, "playground", "task-1")); err != nil || target != filepath.Join(fixture.roomTasks(), "task-1") {
		t.Fatalf("refused restore changed the link: %q %v", target, err)
	}
}

func withMapping(view View, target, access string) View {
	view.Mappings = []Mapping{{Kind: "memory", TargetPath: target, Access: access}}
	return view
}

func TestAlterEgoAdoptsItsPreUpgradeTaskDirectory(t *testing.T) {
	fixture := openSharedTaskFixture(t)
	legacy := filepath.Join(contextWorkspace(fixture.views, testAlterKey), "playground", "task-1")
	if err := os.MkdirAll(filepath.Join(legacy, "notes"), 0o700); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{"report.md": "draft", "notes/a.txt": "a"} {
		if err := os.WriteFile(filepath.Join(legacy, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	alter := applyScoped(t, fixture.store, scopedView("alter-1", testAlterKey, alterScope("task-1", "room-1")))
	taskRoot := filepath.Join(fixture.roomTasks(), "task-1")
	link := filepath.Join(alter.WorkspacePath, "playground", "task-1")
	if info, err := os.Lstat(link); err != nil || !directoryLink(info) {
		t.Fatalf("Task entry after adoption = %v %v", info, err)
	}
	for name, content := range map[string]string{"report.md": "draft", "notes/a.txt": "a"} {
		if !readsAs(filepath.Join(taskRoot, name), content)() || !readsAs(filepath.Join(link, name), content)() {
			t.Fatalf("%s was not adopted", name)
		}
	}
}

func TestAlterEgoNeverAdoptsOverSharedTaskFiles(t *testing.T) {
	fixture := openSharedTaskFixture(t)
	taskRoot := filepath.Join(fixture.roomTasks(), "task-1")
	if err := os.MkdirAll(taskRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(taskRoot, "report.md"), []byte("shared"), 0o600); err != nil {
		t.Fatal(err)
	}
	legacy := filepath.Join(contextWorkspace(fixture.views, testAlterKey), "playground", "task-1")
	if err := os.MkdirAll(legacy, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(legacy, "report.md"), []byte("legacy"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.store.applyTestView(context.Background(), scopedView("alter-1", testAlterKey, alterScope("task-1", "room-1")), ""); !errors.Is(err, ErrSharedTaskPathConflict) {
		t.Fatalf("adoption over a shared file = %v", err)
	}
	if !readsAs(filepath.Join(taskRoot, "report.md"), "shared")() || !readsAs(filepath.Join(legacy, "report.md"), "legacy")() {
		t.Fatal("a refused adoption changed either file")
	}
}

func TestRefreshAddsScopeToAViewPublishedBeforeSharedTasks(t *testing.T) {
	fixture := openSharedTaskFixture(t)
	if err := os.MkdirAll(filepath.Join(fixture.roomTasks(), "task-1"), 0o700); err != nil {
		t.Fatal(err)
	}
	applyScoped(t, fixture.store, scopedView("meta-1", testMetaKey, nil))
	refreshed := applyScoped(t, fixture.store, scopedView("meta-2", testMetaKey, metaScope()))
	if info, err := os.Lstat(filepath.Join(refreshed.WorkspacePath, "playground", "task-1")); err != nil || !directoryLink(info) {
		t.Fatalf("refreshed Meta entry = %v %v", info, err)
	}
	unscoped := scopedView("meta-3", testMetaKey, nil)
	if _, err := fixture.store.applyTestView(context.Background(), unscoped, ""); !errors.Is(err, ErrSharedTaskScopeConflict) {
		t.Fatalf("refresh that drops the scope = %v", err)
	}
}

func TestSharedTaskEntryOccupiedByUserContentIsAConflict(t *testing.T) {
	fixture := openSharedTaskFixture(t)
	occupied := filepath.Join(contextWorkspace(fixture.views, testAlterKey), "playground", "task-1")
	if err := os.MkdirAll(filepath.Dir(occupied), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(occupied, []byte("user"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.store.applyTestView(context.Background(), scopedView("alter-1", testAlterKey, alterScope("task-1", "room-1")), ""); !errors.Is(err, ErrSharedTaskPathConflict) {
		t.Fatalf("occupied alter_ego entry = %v", err)
	}
	if !readsAs(occupied, "user")() {
		t.Fatal("user content was overwritten")
	}

	meta := applyScoped(t, fixture.store, scopedView("meta-1", testMetaKey, metaScope()))
	userEntry := filepath.Join(meta.WorkspacePath, "playground", "task-2")
	if err := os.WriteFile(userEntry, []byte("user file"), 0o600); err != nil {
		t.Fatal(err)
	}
	foreign := t.TempDir()
	foreignLink := filepath.Join(meta.WorkspacePath, "playground", "task-4")
	if err := workspace.CreateDirectoryLink(foreign, foreignLink); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"task-2", "task-3", "task-4"} {
		if err := os.Mkdir(filepath.Join(fixture.roomTasks(), name), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	waitFor(t, 2*time.Second, "the unoccupied Task link", func() bool {
		_, err := os.Stat(filepath.Join(meta.WorkspacePath, "playground", "task-3"))
		return err == nil
	})
	if !readsAs(userEntry, "user file")() {
		t.Fatal("Meta replaced a user file")
	}
	if target, err := os.Readlink(foreignLink); err != nil || target != foreign {
		t.Fatalf("Meta replaced an unknown link: %q %v", target, err)
	}
}

func TestMetaDiscoveryKeepsLinksWhileTasksDirectoryIsUnreadable(t *testing.T) {
	fixture := openSharedTaskFixture(t)
	meta := applyScoped(t, fixture.store, scopedView("meta-1", testMetaKey, metaScope()))
	if err := os.Mkdir(filepath.Join(fixture.roomTasks(), "task-1"), 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(meta.WorkspacePath, "playground", "task-1")
	waitFor(t, time.Second, "first link", func() bool { _, err := os.Lstat(link); return err == nil })
	// The storage disappears: listing fails, which must not read as empty.
	hidden := fixture.roomTasks() + ".unavailable"
	if err := os.Rename(fixture.roomTasks(), hidden); err != nil {
		t.Fatal(err)
	}
	time.Sleep(5 * fixture.store.shared.poll)
	if info, err := os.Lstat(link); err != nil || !directoryLink(info) {
		t.Fatalf("an unreadable tasks directory removed a link: %v", err)
	}
	if err := os.Rename(hidden, fixture.roomTasks()); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(fixture.roomTasks(), "task-2"), 0o700); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 2*time.Second, "discovery after recovery", func() bool {
		_, err := os.Stat(filepath.Join(meta.WorkspacePath, "playground", "task-2"))
		return err == nil
	})
}

func TestMetaDiscoveryRestoresARemovedTaskLink(t *testing.T) {
	fixture := openSharedTaskFixture(t)
	meta := applyScoped(t, fixture.store, scopedView("meta-1", testMetaKey, metaScope()))
	if err := os.Mkdir(filepath.Join(fixture.roomTasks(), "task-1"), 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(meta.WorkspacePath, "playground", "task-1")
	waitFor(t, time.Second, "first link", func() bool { _, err := os.Lstat(link); return err == nil })
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 2*time.Second, "restored link", func() bool {
		info, err := os.Lstat(link)
		return err == nil && directoryLink(info)
	})

	// A crash inside a Windows junction creation leaves an empty directory.
	// Discovery may relink between the two steps, so retry until the
	// directory takes the place.
	for attempt := 0; ; attempt++ {
		if err := os.Remove(link); err != nil && !errors.Is(err, os.ErrNotExist) {
			t.Fatal(err)
		}
		err := os.Mkdir(link, 0o700)
		if err == nil {
			break
		}
		if !errors.Is(err, os.ErrExist) || attempt == 10 {
			t.Fatal(err)
		}
	}
	waitFor(t, 2*time.Second, "link over a half-created junction", func() bool {
		info, err := os.Lstat(link)
		return err == nil && directoryLink(info)
	})
}

func TestForgottenAgentAndGenerationCleanupKeepSharedTaskFiles(t *testing.T) {
	fixture := openSharedTaskFixture(t)
	applyScoped(t, fixture.store, scopedView("meta-1", testMetaKey, metaScope()))
	alter := applyScoped(t, fixture.store, scopedView("alter-1", testAlterKey, alterScope("task-1", "room-1")))
	report := filepath.Join(fixture.roomTasks(), "task-1", "report.md")
	if err := os.WriteFile(report, []byte("kept"), 0o600); err != nil {
		t.Fatal(err)
	}
	fixture.store.ForgetAgent("tenant-1", "agent-1")
	if !readsAs(report, "kept")() || !readsAs(filepath.Join(alter.WorkspacePath, "playground", "task-1", "report.md"), "kept")() {
		t.Fatal("forgetting the Agent removed shared Task files or links")
	}
	fixture.store.shared.mu.Lock()
	loops := len(fixture.store.shared.loops)
	fixture.store.shared.mu.Unlock()
	if loops != 0 {
		t.Fatalf("a forgotten Agent's Meta still has %d discovery loops", loops)
	}

	generation := filepath.Join(t.TempDir(), ".generation-1")
	if err := os.MkdirAll(generation, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := workspace.CreateDirectoryLink(filepath.Dir(report), filepath.Join(generation, "task-1")); err != nil {
		t.Fatal(err)
	}
	if err := removeGeneration(generation); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(report)
	if err != nil || !readsAs(report, "kept")() || (runtime.GOOS != "windows" && info.Mode().Perm() != 0o600) {
		t.Fatalf("generation cleanup touched the Task: %v %v", info, err)
	}
}

func TestSharedTaskScopeNeedsConfiguredStorage(t *testing.T) {
	store, err := OpenViewStore(filepath.Join(t.TempDir(), "views.sqlite"), filepath.Join(t.TempDir(), "views"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	command := scopedView("alter-1", testAlterKey, alterScope("task-1", "room-1"))
	if _, err := store.applyTestView(context.Background(), command, ""); !errors.Is(err, ErrSharedTaskStorageUnavailable) {
		t.Fatalf("scope without storage = %v", err)
	}
}
