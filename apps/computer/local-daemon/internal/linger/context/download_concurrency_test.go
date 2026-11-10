package lingercontext

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestContextApplyDownloadsSixteenSmallFilesInParallel(t *testing.T) {
	const fileCount = 16
	started := make(chan struct{}, fileCount)
	release := make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	var inflight, maxInflight atomic.Int64
	bodies := map[string][]byte{}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		current := inflight.Add(1)
		recordMax(&maxInflight, current)
		started <- struct{}{}
		<-release
		inflight.Add(-1)
		_, _ = writer.Write(bodies[strings.TrimPrefix(request.URL.Path, "/files/")])
	}))
	defer server.Close()

	store, err := OpenViewStore(filepath.Join(t.TempDir(), "state.sqlite"), filepath.Join(t.TempDir(), "views"), server.Client())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	cleanupReadOnlyWorkspace(t, store.root)
	view := testView("view-sixteen")
	for index := range fileCount {
		body := []byte(fmt.Sprintf("file %02d", index))
		mapping := mappingFile("memory", fmt.Sprintf("file-%02d.txt", index), body)
		bodies[mapping.Files[0].SHA256] = body
		view.Mappings = append(view.Mappings, mapping)
	}
	type applyResult struct {
		record ViewRecord
		err    error
	}
	done := make(chan applyResult, 1)
	go func() {
		record, err := store.applyTestView(context.Background(), view, server.URL)
		done <- applyResult{record: record, err: err}
	}()

	for index := 0; index < fileCount; index++ {
		select {
		case <-started:
		case <-time.After(2 * time.Second):
			releaseOnce.Do(func() { close(release) })
			result := <-done
			t.Fatalf("only %d small downloads started before release (max=%d, err=%v)", index, maxInflight.Load(), result.err)
		}
	}
	releaseOnce.Do(func() { close(release) })
	result := <-done
	if result.err != nil {
		t.Fatal(result.err)
	}
	if maxInflight.Load() != fileCount {
		t.Fatalf("max inflight=%d, want %d", maxInflight.Load(), fileCount)
	}
}

func TestContextDownloadsKeepLargeFileAdvertisedBytesWithinExistingBudget(t *testing.T) {
	const (
		jobCount = 9
		fileSize = 50 << 20
	)
	started := make(chan struct{}, jobCount)
	release := make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	var inflight, maxInflight atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		current := inflight.Add(1)
		recordMax(&maxInflight, current)
		started <- struct{}{}
		<-release
		inflight.Add(-1)
	}))
	defer server.Close()

	root := t.TempDir()
	store := &ViewStore{httpClient: server.Client(), now: time.Now}
	jobs := make([]downloadJob, 0, jobCount)
	for index := range jobCount {
		input := FileInput{SizeBytes: fileSize, SHA256: strings.Repeat("a", 64)}
		jobs = append(jobs, downloadJob{input: input, target: filepath.Join(root, fmt.Sprintf("file-%02d", index)), contentURL: server.URL})
	}
	done := make(chan error, 1)
	go func() { done <- store.downloadAll(context.Background(), jobs) }()

	for index := 0; index < 8; index++ {
		select {
		case <-started:
		case <-time.After(2 * time.Second):
			t.Fatalf("only %d large downloads started", index)
		}
	}
	select {
	case <-started:
		t.Fatal("ninth 50 MiB download exceeded the existing 400 MiB in-flight budget")
	case <-time.After(250 * time.Millisecond):
	}
	releaseOnce.Do(func() { close(release) })
	if err := <-done; err == nil {
		t.Fatal("size mismatch downloads unexpectedly succeeded")
	}
	if maxInflight.Load() != 8 {
		t.Fatalf("max inflight=%d, want 8", maxInflight.Load())
	}
}

func recordMax(maximum *atomic.Int64, candidate int64) {
	for {
		observed := maximum.Load()
		if candidate <= observed || maximum.CompareAndSwap(observed, candidate) {
			return
		}
	}
}

func cleanupReadOnlyWorkspace(t *testing.T, root string) {
	t.Helper()
	t.Cleanup(func() {
		_ = filepath.Walk(filepath.Dir(root), func(targetPath string, _ os.FileInfo, err error) error {
			if err == nil {
				_ = os.Chmod(targetPath, 0o700)
			}
			return nil
		})
	})
}
