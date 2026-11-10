package lingercontext

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestContextRefreshReusesUnchangedFilesAndDownloadsDeltas(t *testing.T) {
	unchanged := []byte("skill body\n")
	updated := []byte("inbox v2\n")
	originalInbox := []byte("inbox v1\n")
	var hits atomic.Int64
	server := fileServer(t, &hits, unchanged, updated, originalInbox)
	store, err := OpenViewStore(filepath.Join(t.TempDir(), "state.sqlite"), filepath.Join(t.TempDir(), "views"), server.Client())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	skill := mappingFile("skills", "skill.md", unchanged)
	inbox := mappingFile("inbox_view", "comments.md", originalInbox)
	apply := testView("view-a")
	apply.Mappings = []Mapping{skill, inbox}
	first, err := store.applyTestView(context.Background(), apply, server.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = filepath.Walk(first.WorkspacePath, func(path string, _ os.FileInfo, err error) error {
			if err == nil {
				_ = os.Chmod(path, 0o700)
			}
			return nil
		})
	})
	if got := hits.Load(); got != 2 {
		t.Fatalf("apply downloads=%d, want 2", got)
	}
	if got := store.projectionDigestReads; got != 0 {
		t.Fatalf("apply digest reads=%d, want 0 after verified downloads", got)
	}
	store.now = func() time.Time { return time.Now().Add(2 * projectionIdentityReuseDelay) }
	refreshSame := testView("view-b")
	refreshSame.Mappings = apply.Mappings
	if _, err := store.applyTestView(context.Background(), refreshSame, server.URL); err != nil {
		t.Fatal(err)
	}
	if got := hits.Load(); got != 2 {
		t.Fatalf("unchanged refresh downloads=%d, want 2", got)
	}
	if got := store.projectionDigestReads; got != 0 {
		t.Fatalf("unchanged refresh digest reads=%d, want 0", got)
	}
	inboxV2 := mappingFile("inbox_view", "comments.md", updated)
	delta := testView("view-c")
	delta.Mappings = []Mapping{skill, inboxV2}
	record, err := store.applyTestView(context.Background(), delta, server.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = filepath.Walk(record.WorkspacePath, func(path string, _ os.FileInfo, err error) error {
			if err == nil {
				_ = os.Chmod(path, 0o700)
			}
			return nil
		})
	})
	if got := hits.Load(); got != 3 {
		t.Fatalf("delta refresh downloads=%d, want 3", got)
	}
	if got := len(store.verifiedProjectionFiles); got != 2 {
		t.Fatalf("verified projection cache entries=%d, want one current entry per file", got)
	}
	got, err := os.ReadFile(filepath.Join(record.WorkspacePath, "inbox", "comments.md"))
	if err != nil || string(got) != string(updated) {
		t.Fatalf("inbox=%q err=%v", got, err)
	}
	got, err = os.ReadFile(filepath.Join(record.WorkspacePath, "skills", "skill.md"))
	if err != nil || string(got) != string(unchanged) {
		t.Fatalf("skill=%q err=%v", got, err)
	}
}

func TestProjectionIdentityReuseWaitsPastTimestampResolutionWindow(t *testing.T) {
	changedAt := time.Now()
	identity := projectionFileIdentity{
		ModifiedNsec: changedAt.UnixNano(),
		ChangedNsec:  changedAt.UnixNano(),
		Cacheable:    true,
	}
	if projectionIdentityCanBeReused(identity, changedAt.Add(projectionIdentityReuseDelay-time.Nanosecond)) {
		t.Fatal("fresh file identity was reused before the safety window elapsed")
	}
	if !projectionIdentityCanBeReused(identity, changedAt.Add(projectionIdentityReuseDelay)) {
		t.Fatal("stable file identity was not reused after the safety window elapsed")
	}
}

func TestContextRefreshRevalidatesAChangedReadOnlyFile(t *testing.T) {
	content := []byte("trusted content\n")
	var hits atomic.Int64
	server := fileServer(t, &hits, content)
	store, err := OpenViewStore(filepath.Join(t.TempDir(), "state.sqlite"), filepath.Join(t.TempDir(), "views"), server.Client())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	command := testView("view-a")
	command.Mappings = []Mapping{mappingFile("inbox_view", "comments.md", content)}
	first, err := store.applyTestView(context.Background(), command, server.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = filepath.Walk(first.WorkspacePath, func(path string, _ os.FileInfo, err error) error {
			if err == nil {
				_ = os.Chmod(path, 0o700)
			}
			return nil
		})
	})
	target := filepath.Join(first.WorkspacePath, "inbox", "comments.md")
	if err := os.Chmod(target, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("changed content\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(target, 0o400); err != nil {
		t.Fatal(err)
	}
	refresh := testView("view-b")
	refresh.Mappings = command.Mappings
	if _, err := store.applyTestView(context.Background(), refresh, server.URL); err != nil {
		t.Fatal(err)
	}
	if got := hits.Load(); got != 2 {
		t.Fatalf("downloads=%d, want changed file to be downloaded again", got)
	}
	if got := store.projectionDigestReads; got != 1 {
		t.Fatalf("digest reads=%d, want one revalidation", got)
	}
}

func TestContextApplyDownloadsDistinctFilesInParallel(t *testing.T) {
	var hits, inflight, maxInflight atomic.Int64
	files := []Mapping{
		mappingFile("memory", "a.txt", []byte("/a")),
		mappingFile("memory", "b.txt", []byte("/b")),
		mappingFile("memory", "c.txt", []byte("/c")),
	}
	bodies := map[string][]byte{}
	for _, mapping := range files {
		bodies[mapping.Files[0].SHA256] = []byte("/" + strings.TrimSuffix(mapping.Files[0].RelativePath, ".txt"))
	}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		hits.Add(1)
		current := inflight.Add(1)
		for {
			seen := maxInflight.Load()
			if current <= seen || maxInflight.CompareAndSwap(seen, current) {
				break
			}
		}
		time.Sleep(40 * time.Millisecond)
		inflight.Add(-1)
		_, _ = writer.Write(bodies[strings.TrimPrefix(request.URL.Path, "/files/")])
	}))
	defer server.Close()
	store, err := OpenViewStore(filepath.Join(t.TempDir(), "state.sqlite"), filepath.Join(t.TempDir(), "views"), server.Client())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	command := testView("view-p")
	command.Mappings = files
	record, err := store.applyTestView(context.Background(), command, server.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = filepath.Walk(record.WorkspacePath, func(path string, _ os.FileInfo, err error) error {
			if err == nil {
				_ = os.Chmod(path, 0o700)
			}
			return nil
		})
	})
	if hits.Load() != 3 {
		t.Fatalf("downloads=%d", hits.Load())
	}
	if maxInflight.Load() < 2 {
		t.Fatalf("downloads stayed serial (max inflight=%d)", maxInflight.Load())
	}
}

func mappingFile(kind, relative string, content []byte) Mapping {
	digest := sha256.Sum256(content)
	sha := hex.EncodeToString(digest[:])
	target := "documents"
	if kind == "skills" {
		target = "skills"
	}
	if kind == "inbox_view" {
		target = "inbox"
	}
	return Mapping{
		Kind: kind, TargetPath: target, Access: "read_only",
		Files: []FileInput{{
			RelativePath: relative, MediaType: "text/plain", SizeBytes: int64(len(content)), SHA256: sha,
		}},
	}
}
