package lingercontext

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

type localCopyServer struct {
	mu       sync.Mutex
	requests map[string]int
	bodies   map[string][]byte
	server   *httptest.Server
}

// newLocalCopyServer serves files/<sha256> for the named bodies and counts
// requests by name.
func newLocalCopyServer(t *testing.T, bodies map[string][]byte) *localCopyServer {
	t.Helper()
	fixture := &localCopyServer{requests: make(map[string]int), bodies: bodies}
	names := make(map[string]string, len(bodies))
	for name, body := range bodies {
		sum := sha256.Sum256(body)
		names[hex.EncodeToString(sum[:])] = name
	}
	fixture.server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		name := names[strings.TrimPrefix(request.URL.Path, "/files/")]
		fixture.mu.Lock()
		fixture.requests[name]++
		fixture.mu.Unlock()
		_, _ = writer.Write(bodies[name])
	}))
	t.Cleanup(fixture.server.Close)
	return fixture
}

func (f *localCopyServer) count(path string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.requests[path]
}

func openLocalCopyStore(t *testing.T, client *http.Client) (*ViewStore, string, *bytes.Buffer) {
	t.Helper()
	views := filepath.Join(t.TempDir(), "views")
	store, err := OpenViewStore(filepath.Join(t.TempDir(), "state.sqlite"), views, client)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	cleanupReadOnlyWorkspace(t, filepath.Join(views, "unused"))
	var logs bytes.Buffer
	store.logger = slog.New(slog.NewJSONHandler(&logs, nil))
	return store, views, &logs
}

func lastTimingEvent(t *testing.T, logs *bytes.Buffer) map[string]any {
	t.Helper()
	lines := strings.Split(strings.TrimSpace(logs.String()), "\n")
	var event map[string]any
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &event); err != nil {
		t.Fatalf("decode timing log: %v", err)
	}
	logs.Reset()
	return event
}

func applyLocalCopyCommand(t *testing.T, store *ViewStore, logs *bytes.Buffer, contentURL string, command View) (ViewRecord, map[string]any) {
	t.Helper()
	logs.Reset()
	record, err := store.applyTestView(context.Background(), command, contentURL)
	if err != nil {
		t.Fatal(err)
	}
	return record, lastTimingEvent(t, logs)
}

func localCopyContextCommand(id, key string, mappings ...Mapping) View {
	command := testView("view-" + id)
	command.ExecutionContextKey = key
	command.Mappings = mappings
	return command
}

func requireLocalCopyTiming(t *testing.T, event map[string]any, local, download float64) {
	t.Helper()
	if event["outcome"] != "success" || event["local_copy_file_count"] != local || event["download_file_count"] != download {
		t.Fatalf("timing=%v, want local_copy_file_count=%v download_file_count=%v", event, local, download)
	}
}

func fileMode(t *testing.T, path string) os.FileMode {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Mode().Perm()
}

func TestLocalCopyReusesSameAgentReadOnlyFileWithoutHTTP(t *testing.T) {
	skillBody := []byte("skill body\n")
	toolBody := []byte("#!/bin/sh\necho tool\n")
	fixture := newLocalCopyServer(t, map[string][]byte{"/skill": skillBody, "/tool": toolBody})
	store, _, logs := openLocalCopyStore(t, fixture.server.Client())
	skill := mappingFile("skills", "skill.md", skillBody)
	tool := mappingFile("memory", "tool.sh", toolBody)
	tool.Files[0].Executable = true

	first, _ := applyLocalCopyCommand(t, store, logs, fixture.server.URL, localCopyContextCommand("apply-a", "context-a", skill, tool))
	if fixture.count("/skill") != 1 || fixture.count("/tool") != 1 {
		t.Fatalf("first apply requests skill=%d tool=%d", fixture.count("/skill"), fixture.count("/tool"))
	}
	wantSkillMode := fileMode(t, filepath.Join(first.WorkspacePath, "skills", "skill.md"))
	wantToolMode := fileMode(t, filepath.Join(first.WorkspacePath, "documents", "tool.sh"))

	secondRecord, event := applyLocalCopyCommand(t, store, logs, fixture.server.URL, localCopyContextCommand("apply-b", "context-b", skill))
	requireLocalCopyTiming(t, event, 1, 0)
	if fixture.count("/skill") != 1 {
		t.Fatalf("second Context downloaded the shared skill again: requests=%d", fixture.count("/skill"))
	}
	got, err := os.ReadFile(filepath.Join(secondRecord.WorkspacePath, "skills", "skill.md"))
	if err != nil || string(got) != string(skillBody) {
		t.Fatalf("copied skill=%q err=%v", got, err)
	}
	if mode := fileMode(t, filepath.Join(secondRecord.WorkspacePath, "skills", "skill.md")); mode != wantSkillMode {
		t.Fatalf("copied skill mode=%o, want %o", mode, wantSkillMode)
	}

	executableRecord, event := applyLocalCopyCommand(t, store, logs, fixture.server.URL, localCopyContextCommand("apply-c", "context-c", tool))
	requireLocalCopyTiming(t, event, 1, 0)
	if fixture.count("/tool") != 1 {
		t.Fatalf("executable copy downloaded again: requests=%d", fixture.count("/tool"))
	}
	got, err = os.ReadFile(filepath.Join(executableRecord.WorkspacePath, "documents", "tool.sh"))
	if err != nil || string(got) != string(toolBody) {
		t.Fatalf("copied tool=%q err=%v", got, err)
	}
	if mode := fileMode(t, filepath.Join(executableRecord.WorkspacePath, "documents", "tool.sh")); mode != wantToolMode {
		t.Fatalf("copied executable mode=%o, want %o", mode, wantToolMode)
	}
}

func TestLocalCopyReusesSameTenantOtherAgentReadOnlyFileWithoutHTTP(t *testing.T) {
	body := []byte("shared body\n")
	fixture := newLocalCopyServer(t, map[string][]byte{"/skill": body})
	store, _, logs := openLocalCopyStore(t, fixture.server.Client())
	skill := mappingFile("skills", "skill.md", body)
	applyLocalCopyCommand(t, store, logs, fixture.server.URL, localCopyContextCommand("apply-a", "context-a", skill))

	otherAgent := localCopyContextCommand("apply-other-agent", "context-other-agent", skill)
	otherAgent.AgentID = "agent-2"
	record, event := applyLocalCopyCommand(t, store, logs, fixture.server.URL, otherAgent)
	requireLocalCopyTiming(t, event, 1, 0)
	if got := fixture.count("/skill"); got != 1 {
		t.Fatalf("requests=%d, want the same-tenant source reused", got)
	}
	got, err := os.ReadFile(filepath.Join(record.WorkspacePath, "skills", "skill.md"))
	if err != nil || string(got) != string(body) {
		t.Fatalf("copied skill=%q err=%v", got, err)
	}
}

func TestLocalCopyNeverUsesOtherTenant(t *testing.T) {
	body := []byte("shared body\n")
	fixture := newLocalCopyServer(t, map[string][]byte{"/skill": body})
	store, _, logs := openLocalCopyStore(t, fixture.server.Client())
	skill := mappingFile("skills", "skill.md", body)
	applyLocalCopyCommand(t, store, logs, fixture.server.URL, localCopyContextCommand("apply-a", "context-a", skill))

	otherTenant := localCopyContextCommand("apply-other-tenant", "context-other-tenant", skill)
	otherTenant.TenantID = "tenant-2"
	_, event := applyLocalCopyCommand(t, store, logs, fixture.server.URL, otherTenant)
	requireLocalCopyTiming(t, event, 0, 1)
	if got := fixture.count("/skill"); got != 2 {
		t.Fatalf("requests=%d, want HTTP for the other-tenant Context", got)
	}
}

func TestLocalCopyFallsBackWhenOtherAgentSourceWasModified(t *testing.T) {
	body := []byte("trusted body\n")
	fixture := newLocalCopyServer(t, map[string][]byte{"/skill": body})
	store, _, logs := openLocalCopyStore(t, fixture.server.Client())
	skill := mappingFile("skills", "skill.md", body)
	first, _ := applyLocalCopyCommand(t, store, logs, fixture.server.URL, localCopyContextCommand("apply-a", "context-a", skill))
	source := filepath.Join(first.WorkspacePath, "skills", "skill.md")
	if err := os.Chmod(source, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte("tampered body\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	otherAgent := localCopyContextCommand("apply-other-agent", "context-other-agent", skill)
	otherAgent.AgentID = "agent-2"
	record, event := applyLocalCopyCommand(t, store, logs, fixture.server.URL, otherAgent)
	requireLocalCopyTiming(t, event, 0, 1)
	if got := fixture.count("/skill"); got != 2 {
		t.Fatalf("requests=%d, want a download replacing the modified source", got)
	}
	got, err := os.ReadFile(filepath.Join(record.WorkspacePath, "skills", "skill.md"))
	if err != nil || string(got) != string(body) {
		t.Fatalf("modified-source fallback=%q err=%v", got, err)
	}
}

func TestLocalCopyIgnoresReadWriteSources(t *testing.T) {
	body := []byte("writable body\n")
	fixture := newLocalCopyServer(t, map[string][]byte{"/notes": body})
	store, _, logs := openLocalCopyStore(t, fixture.server.Client())
	writable := mappingFile("memory", "notes.md", body)
	writable.Access = "read_write"
	applyLocalCopyCommand(t, store, logs, fixture.server.URL, localCopyContextCommand("apply-a", "context-a", writable))

	readOnly := mappingFile("memory", "notes.md", body)
	_, event := applyLocalCopyCommand(t, store, logs, fixture.server.URL, localCopyContextCommand("apply-b", "context-b", readOnly))
	requireLocalCopyTiming(t, event, 0, 1)
	if got := fixture.count("/notes"); got != 2 {
		t.Fatalf("requests=%d, want the read-write source ignored", got)
	}
}

func TestLocalCopyFallsBackWhenSourceFailsVerification(t *testing.T) {
	body := []byte("trusted body\n")
	fixture := newLocalCopyServer(t, map[string][]byte{"/skill": body})
	store, _, logs := openLocalCopyStore(t, fixture.server.Client())
	skill := mappingFile("skills", "skill.md", body)
	first, _ := applyLocalCopyCommand(t, store, logs, fixture.server.URL, localCopyContextCommand("apply-a", "context-a", skill))
	source := filepath.Join(first.WorkspacePath, "skills", "skill.md")

	t.Run("tampered same size", func(t *testing.T) {
		if err := os.Chmod(source, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(source, []byte("tampered body\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		before := fixture.count("/skill")
		record, event := applyLocalCopyCommand(t, store, logs, fixture.server.URL, localCopyContextCommand("apply-tampered", "context-tampered", skill))
		requireLocalCopyTiming(t, event, 0, 1)
		if fixture.count("/skill") != before+1 {
			t.Fatalf("tampered source was not replaced by a download")
		}
		got, err := os.ReadFile(filepath.Join(record.WorkspacePath, "skills", "skill.md"))
		if err != nil || string(got) != string(body) {
			t.Fatalf("tampered fallback=%q err=%v", got, err)
		}
	})
}

func TestLocalCopyFallsBackWhenSourceWasDeleted(t *testing.T) {
	body := []byte("deleted body\n")
	fixture := newLocalCopyServer(t, map[string][]byte{"/skill": body})
	store, _, logs := openLocalCopyStore(t, fixture.server.Client())
	skill := mappingFile("skills", "skill.md", body)
	first, _ := applyLocalCopyCommand(t, store, logs, fixture.server.URL, localCopyContextCommand("apply-a", "context-a", skill))
	source := filepath.Join(first.WorkspacePath, "skills", "skill.md")
	if err := os.Chmod(filepath.Dir(source), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(source); err != nil {
		t.Fatal(err)
	}

	record, event := applyLocalCopyCommand(t, store, logs, fixture.server.URL, localCopyContextCommand("apply-b", "context-b", skill))
	requireLocalCopyTiming(t, event, 0, 1)
	if fixture.count("/skill") != 2 {
		t.Fatalf("deleted source requests=%d, want a download", fixture.count("/skill"))
	}
	got, err := os.ReadFile(filepath.Join(record.WorkspacePath, "skills", "skill.md"))
	if err != nil || string(got) != string(body) {
		t.Fatalf("deleted fallback=%q err=%v", got, err)
	}
}

func TestLocalCopyNeverFollowsSymbolicLinkSource(t *testing.T) {
	body := []byte("linked body\n")
	if root := os.Getenv("LINGER_TEST_WINDOWS_SYMLINK_FIXTURE"); root != "" {
		var err error
		body, err = os.ReadFile(filepath.Join(root, "target.json"))
		if err != nil {
			t.Fatal(err)
		}
	}
	fixture := newLocalCopyServer(t, map[string][]byte{"/skill": body})
	store, _, logs := openLocalCopyStore(t, fixture.server.Client())
	skill := mappingFile("skills", "skill.md", body)
	first, _ := applyLocalCopyCommand(t, store, logs, fixture.server.URL, localCopyContextCommand("apply-a", "context-a", skill))
	source := filepath.Join(first.WorkspacePath, "skills", "skill.md")
	outside := filepath.Join(t.TempDir(), "outside.md")
	if err := os.WriteFile(outside, body, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Dir(source), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(source); err != nil {
		t.Fatal(err)
	}
	if err := createTestFileLink(t, outside, source); err != nil {
		t.Fatal(err)
	}

	before := fixture.count("/skill")
	_, event := applyLocalCopyCommand(t, store, logs, fixture.server.URL, localCopyContextCommand("apply-b", "context-b", skill))
	requireLocalCopyTiming(t, event, 0, 1)
	if fixture.count("/skill") != before+1 {
		t.Fatalf("symlink source was not bypassed by a download")
	}
}
